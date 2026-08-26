// SPDX-License-Identifier: AGPL-3.0-or-later
import { dirname } from 'node:path';
import { eq } from 'drizzle-orm';
import { APP_STATE_KEYS, appState, type Database_ } from '@impressive-ocr/db';
import {
  hardwareCapabilitiesSchema,
  runtimeStatusSchema,
  type HardwareCapabilities,
  type PreflightReport,
  type RuntimeInstallPlan,
  type RuntimeStatus,
} from '@impressive-ocr/shared';
import type { Logger } from '../../infra/logger';
import { venvPython } from '../../infra/paths';
import { type EventBus, stamp } from '../events/event-bus';
import {
  INSTALL_HEADROOM_BYTES,
  INSTALLED_BYTES_BY_FLAVOR,
  measureNearestDiskSpace,
  MODEL_DOWNLOAD_BYTES,
  SUPPORTING_DOWNLOAD_BYTES,
} from './disk-space';
import { probeHardware } from './gpu-probe';
import { runPreflight } from './preflight';
import { type RuntimeInstaller } from './runtime-installer';
import { describeSelection, selectWheel } from './wheel-index';

/**
 * Owns the Python runtime's state: probe the hardware, install on request, report progress.
 *
 * Both the hardware probe and the install result are persisted, so a restart does not
 * re-probe or re-install, and so the setup wizard knows on first paint whether it has
 * anything to do.
 */

const INITIAL_STATUS: RuntimeStatus = {
  // Overwritten on every read by `getStatus`, which checks the disk rather than trusting
  // a value that was true whenever this object was last written.
  vlServerInstalled: false,
  state: 'not-installed',
  currentStep: null,
  progressPercent: 0,
  message: 'The OCR runtime has not been installed yet.',
  pythonVersion: null,
  paddleVersion: null,
  paddleocrVersion: null,
  sidecarVersion: null,
  paddleFlavor: null,
  errorMessage: null,
};

export interface RuntimeServiceOptions {
  db: Database_;
  installer: RuntimeInstaller;
  events: EventBus;
  logger: Logger;
  venvDir: string;
  /** Reported by preflight: without it the OCR runtime cannot be installed at all. */
  uvBinary: string;
  /** Whether the batching inference engine is on disk; see `getHardware`. */
  isVlServerInstalled: () => boolean;
}

/** Fast enough to look live, slow enough that a progress bar cannot flood SQLite. */
const PROGRESS_BROADCAST_INTERVAL_MS = 250;

export class RuntimeService {
  private status: RuntimeStatus = INITIAL_STATUS;
  private hardware: HardwareCapabilities | null = null;
  private install: { promise: Promise<void>; controller: AbortController } | null = null;
  private lastBroadcastMs = 0;

  constructor(private readonly options: RuntimeServiceOptions) {}

  /** Load persisted state and confirm the venv is still where we left it. */
  async initialize(): Promise<void> {
    this.hardware = this.readState(APP_STATE_KEYS.hardware, (value) =>
      hardwareCapabilitiesSchema.parse(value),
    );
    const stored = this.readState(APP_STATE_KEYS.runtime, (value) =>
      runtimeStatusSchema.parse(value),
    );

    if (stored !== null) {
      this.status = stored;
    }
    if (this.hardware === null) {
      await this.probe();
    }

    // The database can claim the runtime is ready while the folder has been deleted by a
    // disk cleanup or an uninstall. Trust the filesystem.
    if (this.status.state === 'ready' && !(await this.options.installer.isInstalled())) {
      this.options.logger.warn('Runtime marked ready but the interpreter is missing; resetting');
      this.setStatus({
        ...INITIAL_STATUS,
        message: 'The OCR runtime is missing and needs to be reinstalled.',
      });
    }
    // An install interrupted by a crash left the status stuck at "installing".
    if (this.status.state === 'installing') {
      this.setStatus({
        ...INITIAL_STATUS,
        message: 'The previous installation did not finish. Please run setup again.',
      });
    }

    await this.backfillVersions();
  }

  /**
   * Fill in versions for a runtime installed before they were recorded.
   *
   * Those installs stored nulls, and the System page shows a dash for each — so a perfectly
   * working runtime looks half-broken. Asking the interpreter costs one short subprocess at
   * startup, and only when something is actually missing.
   */
  private async backfillVersions(): Promise<void> {
    const missing =
      this.status.state === 'ready' &&
      (this.status.pythonVersion === null ||
        this.status.paddleocrVersion === null ||
        // Every runtime installed before this field existed reports null here, which would
        // otherwise read as "unknown" forever and hide precisely the mismatch it is for.
        this.status.sidecarVersion === null);
    if (!missing) return;

    const versions = await this.options.installer.readVersions();
    if (versions.python === null && versions.paddleocr === null) return;

    this.setStatus({
      ...this.status,
      pythonVersion: versions.python,
      paddleVersion: versions.paddle,
      paddleocrVersion: versions.paddleocr,
      sidecarVersion: versions.sidecar,
    });
    this.options.logger.info({ versions }, 'Backfilled runtime versions');
  }

  /**
   * Computed fresh rather than stored, like `getHardware`: the engine appears partway through
   * its own install, and a cached `false` would leave the System page still offering a
   * download that had already finished.
   */
  getStatus(): RuntimeStatus {
    return { ...this.status, vlServerInstalled: this.options.isVlServerInstalled() };
  }

  /**
   * What this machine can run.
   *
   * The probe answers for the *hardware*; whether the Accurate profile is offered also
   * depends on something the probe cannot see -- whether the batching inference engine is
   * installed. With it, that profile runs on a CPU at a usable speed; without it, PaddleOCR
   * recognises one layout region at a time and a CPU run is effectively stalled.
   *
   * Combined here rather than in the probe so the probe stays a pure hardware question, and
   * every caller sees one consistent answer.
   */
  getHardware(): HardwareCapabilities {
    if (this.hardware === null) {
      throw new Error('Hardware has not been probed yet');
    }
    if (!this.options.isVlServerInstalled()) {
      return this.hardware;
    }
    return {
      ...this.hardware,
      // Both, and for different reasons: the profile becomes offerable at all, and it becomes
      // routable to the CPU. A machine with a big card gains only the second.
      availableProfiles: this.hardware.availableProfiles.includes('accurate')
        ? this.hardware.availableProfiles
        : ['accurate', ...this.hardware.availableProfiles],
      canRunAccurateOnCpu: true,
    };
  }

  isReady(): boolean {
    return this.status.state === 'ready';
  }

  pythonPath(): string {
    return venvPython(this.options.venvDir);
  }

  /**
   * What `startInstall` would download, without starting it.
   *
   * Separate from the install itself so the UI can put a size in front of the user and wait
   * for an answer. The numbers come from the same wheel selection the installer will make,
   * not from a second guess at it.
   */
  async planInstall(): Promise<RuntimeInstallPlan> {
    const hardware = this.hardware ?? (await this.probe());
    const selection = selectWheel(hardware);
    const downloadBytes = selection.wheelBytes + SUPPORTING_DOWNLOAD_BYTES + MODEL_DOWNLOAD_BYTES;
    const installedBytes = INSTALLED_BYTES_BY_FLAVOR[selection.flavor];
    const targetPath = dirname(this.options.venvDir);
    const space = await measureNearestDiskSpace(targetPath);

    return {
      flavor: selection.flavor,
      packageName: selection.packageName,
      description: selection.description,
      rationale: describeSelection(selection, hardware),
      downloadBytes,
      installedBytes,
      targetPath,
      freeBytes: space?.freeBytes ?? null,
      // Unmeasurable free space must not block the install; the installer checks again and
      // fails with a precise message if the disk really is too full.
      enoughSpace: space === null || space.freeBytes >= installedBytes + INSTALL_HEADROOM_BYTES,
    };
  }

  /**
   * Whether this machine can run the engine, and what to do about it if not.
   *
   * Not cached: the interesting answers change while the user is looking at the page — they
   * install the Visual C++ runtime, or free up a drive, and want to see it clear.
   */
  async preflight(): Promise<PreflightReport> {
    return runPreflight({
      dataDirectory: this.options.venvDir,
      uvBinary: this.options.uvBinary,
    });
  }

  /**
   * Reinstall the sidecar into the existing venv, and report what is now there.
   *
   * The sidecar is copied into the venv once, during setup, and never touched again. So an
   * app update ships new Python while the engine keeps running the old copy, and the change
   * simply has no effect - silently, with a healthy-looking runtime. This is the repair for
   * that, and it is deliberately cheap: seconds, no Paddle download, no model download.
   *
   * Not folded into `startInstall`, because that is a multi-gigabyte operation nobody will
   * run to pick up a Python fix.
   */
  async refreshSidecar(): Promise<RuntimeStatus> {
    if (this.status.state !== 'ready') {
      throw new Error('The OCR runtime is not installed yet.');
    }

    const versions = await this.options.installer.reinstallSidecar();
    this.setStatus({
      ...this.status,
      pythonVersion: versions.python ?? this.status.pythonVersion,
      paddleVersion: versions.paddle ?? this.status.paddleVersion,
      paddleocrVersion: versions.paddleocr ?? this.status.paddleocrVersion,
      sidecarVersion: versions.sidecar,
      message: 'The OCR engine was updated.',
    });
    this.options.logger.info({ sidecar: versions.sidecar }, 'Sidecar reinstalled');

    return this.status;
  }

  /**
   * Add the fast inference engine to a runtime installed before it existed.
   *
   * Without this such an installation is permanently on the slow backend: it is already
   * `ready`, so the installer never runs again, and nothing on screen would explain why the
   * accurate profile takes a minute a page here and two seconds elsewhere.
   *
   * Reuses the install progress channel, so the System page shows the same bar it shows for
   * everything else rather than needing a second kind of progress.
   */
  async installVlServer(): Promise<RuntimeStatus> {
    if (this.status.state !== 'ready') {
      throw new Error('The OCR runtime is not installed yet.');
    }

    const hardware = this.getHardware();
    this.setStatus({
      ...this.status,
      state: 'installing',
      currentStep: 'download-vl-server',
      message: 'Downloading the fast inference engine',
    });

    try {
      await this.options.installer.installVlServerOnly({
        hardware,
        onProgress: (progress) =>
          this.setStatus({ ...this.status, currentStep: progress.step, message: progress.message }),
      });
      this.setStatus({
        ...this.status,
        state: 'ready',
        currentStep: null,
        progressPercent: 100,
        message: 'The fast inference engine is ready.',
      });
      this.options.logger.info('Inference engine installed');
    } catch (error) {
      // Back to `ready`, not `failed`: the OCR runtime itself is untouched and still works.
      // Only the fast path is missing, which is exactly what the fallback exists for.
      this.setStatus({
        ...this.status,
        state: 'ready',
        currentStep: null,
        message: 'The fast inference engine could not be installed.',
      });
      this.options.logger.error({ err: error }, 'Could not install the inference engine');
      throw error;
    }

    return this.status;
  }

  async probe(): Promise<HardwareCapabilities> {
    const hardware = await probeHardware();
    this.hardware = hardware;
    this.writeState(APP_STATE_KEYS.hardware, hardware);
    this.options.logger.info(
      { gpu: hardware.gpu?.name ?? null, reason: hardware.gpuUnavailableReason },
      'Hardware probed',
    );
    return hardware;
  }

  /**
   * Start (or join) the runtime installation.
   *
   * Concurrent calls share one install rather than racing: two `uv` processes writing the
   * same venv is a reliable way to produce a broken one.
   */
  startInstall(): Promise<void> {
    if (this.install !== null) {
      return this.install.promise;
    }
    const controller = new AbortController();
    const promise = this.runInstall(controller.signal).finally(() => {
      this.install = null;
    });
    this.install = { promise, controller };
    return promise;
  }

  cancelInstall(): boolean {
    if (this.install === null) {
      return false;
    }
    this.install.controller.abort();
    return true;
  }

  private async runInstall(signal: AbortSignal): Promise<void> {
    const hardware = this.hardware ?? (await this.probe());

    this.setStatus({
      ...this.status,
      state: 'installing',
      currentStep: 'probe-hardware',
      progressPercent: 0,
      message: 'Preparing to install the OCR runtime',
      errorMessage: null,
    });

    try {
      const result = await this.options.installer.install({
        hardware,
        signal,
        onProgress: (progress) => {
          this.setStatus({
            ...this.status,
            state: 'installing',
            currentStep: progress.step,
            progressPercent: progress.percent,
            message: progress.message,
          });
        },
      });

      this.setStatus({
        ...this.status,
        state: 'ready',
        currentStep: null,
        progressPercent: 100,
        message: 'The OCR runtime is ready.',
        paddleFlavor: result.selection.flavor,
        pythonVersion: result.versions.python,
        paddleVersion: result.versions.paddle,
        paddleocrVersion: result.versions.paddleocr,
        sidecarVersion: result.versions.sidecar,
        errorMessage: null,
      });
      this.options.logger.info({ flavor: result.selection.flavor }, 'Runtime installed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const aborted = error instanceof Error && error.name === 'AbortError';

      this.setStatus({
        ...this.status,
        state: aborted ? 'not-installed' : 'failed',
        currentStep: null,
        message: aborted ? 'Installation cancelled.' : 'Installation failed.',
        errorMessage: aborted ? null : message,
      });
      if (!aborted) {
        this.options.logger.error({ err: error }, 'Runtime installation failed');
      }
    }
  }

  /**
   * Update the status, persisting and broadcasting at a bounded rate.
   *
   * The installer reports a line at a time, and `uv` and the model fetcher both draw progress
   * bars — tens of thousands of updates over a single install. Writing each one to SQLite and
   * pushing it down every SSE connection was pure waste; a progress bar that updates a few
   * times a second is indistinguishable to a human from one that updates a thousand.
   *
   * A change of *step*, or any terminal state, always goes through immediately: those are
   * the transitions the UI must not miss.
   */
  private setStatus(status: RuntimeStatus): void {
    const previous = this.status;
    this.status = status;

    const stepChanged = previous.currentStep !== status.currentStep;
    const stateChanged = previous.state !== status.state;
    const isTerminal = status.state !== 'installing';
    const dueForUpdate = Date.now() - this.lastBroadcastMs >= PROGRESS_BROADCAST_INTERVAL_MS;

    if (!stepChanged && !stateChanged && !isTerminal && !dueForUpdate) {
      return;
    }

    this.lastBroadcastMs = Date.now();
    this.writeState(APP_STATE_KEYS.runtime, status);
    this.options.events.publish(stamp({ type: 'runtime.status', runtime: status }));
  }

  private readState<TValue>(
    key: (typeof APP_STATE_KEYS)[keyof typeof APP_STATE_KEYS],
    parse: (value: unknown) => TValue,
  ): TValue | null {
    const row = this.options.db.select().from(appState).where(eq(appState.key, key)).get();
    if (row === undefined) {
      return null;
    }
    try {
      return parse(row.value);
    } catch {
      // A row written by an older release no longer matches the schema. Treat it as absent
      // rather than crashing the server on startup.
      return null;
    }
  }

  private writeState(
    key: (typeof APP_STATE_KEYS)[keyof typeof APP_STATE_KEYS],
    value: unknown,
  ): void {
    const updatedAt = new Date().toISOString();
    this.options.db
      .insert(appState)
      .values({ key, value, updatedAt })
      .onConflictDoUpdate({ target: appState.key, set: { value, updatedAt } })
      .run();
  }
}
