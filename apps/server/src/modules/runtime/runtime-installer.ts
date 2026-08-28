// SPDX-License-Identifier: AGPL-3.0-or-later
import { join } from 'node:path';
import type { HardwareCapabilities, RuntimeStep } from '@impressive-ocr/shared';
import { ensureDirectory, exists } from '../../infra/fs/file-ops';
import type { Logger } from '../../infra/logger';
import { venvPython } from '../../infra/paths';
import { runCommand } from '../../infra/process/run-command';
import { toUserMessage } from './progress-output';
import { assertEnoughSpaceForInstall } from './disk-space';
import { repairModelCache } from './model-cache';
import { PreflightBlockedError, runPreflight } from './preflight';
import { installVlServer } from './vl-server-installer';
import { pipInstallArgs, selectWheel, type WheelSelection } from './wheel-index';

/**
 * Installs the Python side on the user's machine.
 *
 * The app ships without Python or PaddleOCR: the GPU wheel alone is multiple gigabytes and
 * we would have to ship a separate CPU and GPU installer per platform. Instead a bundled
 * `uv` binary fetches a pinned Python, builds a venv, and installs the wheel chosen *after*
 * probing the hardware.
 *
 * Every step streams progress, because a silent multi-gigabyte download is indistinguishable
 * from a hung application.
 */

/** Pinned so an upstream Python release cannot change behaviour under an existing install. */
export const PYTHON_VERSION = '3.12';

/**
 * Pinned for the same reason; upgraded deliberately, with a runtime-version bump.
 *
 * The comment above used to sit over an *unpinned* requirement installed with `--upgrade`,
 * so two people installing a month apart got different inference stacks and the same version
 * of this app. That was always untidy; it became a real hazard once the accurate profile
 * started depending on specifics of PaddleOCR's backend selection — the names in
 * `_SUPPORTED_VL_BACKENDS`, and a genai client that dispatches a page's regions concurrently.
 * A silent minor upgrade could turn the fast path back into the slow one with nothing to see.
 *
 * 3.7.0 is the version every measurement in the README was taken against.
 */
export const PADDLEOCR_REQUIREMENT = 'paddleocr[doc-parser]==3.7.0';

export interface InstallProgress {
  step: RuntimeStep;
  percent: number;
  message: string;
}

export interface RuntimeInstallerOptions {
  uvBinary: string;
  venvDir: string;
  modelCacheDir: string;
  sidecarProjectDir: string;
  /** Where `llama-server` and the accurate profile's weights are installed. */
  vlServerDir: string;
  logger: Logger;
}

export interface InstallRequest {
  hardware: HardwareCapabilities;
  onProgress: (progress: InstallProgress) => void;
  signal?: AbortSignal;
}

/** What the interpreter reports about itself once everything is installed. */
export interface RuntimeVersions {
  python: string | null;
  paddle: string | null;
  paddleocr: string | null;
  /** The sidecar package installed in the venv, which can lag the app that ships it. */
  sidecar: string | null;
}

export interface InstallResult {
  pythonPath: string;
  selection: WheelSelection;
  versions: RuntimeVersions;
}

/**
 * Weight of each step in the overall progress bar.
 *
 * Wall-clock, not step count: installing Paddle is most of the wait, so giving all steps
 * equal weight would park the bar at 40% for several minutes.
 */
const STEP_WEIGHTS: Record<RuntimeStep, number> = {
  'probe-hardware': 2,
  'install-python': 6,
  'create-venv': 2,
  'install-paddle': 35,
  'install-paddleocr': 18,
  'download-models': 13,
  // ~1.9 GB of archives and weights, plus the quantisation pass. Second only to Paddle.
  'download-vl-server': 20,
  verify: 4,
};

export const STEP_ORDER: readonly RuntimeStep[] = [
  'probe-hardware',
  'install-python',
  'create-venv',
  'install-paddle',
  'install-paddleocr',
  'download-models',
  'download-vl-server',
  'verify',
];

/** Percentage already completed once `step` finishes. */
export function progressAfter(step: RuntimeStep): number {
  let total = 0;
  for (const candidate of STEP_ORDER) {
    total += STEP_WEIGHTS[candidate];
    if (candidate === step) {
      break;
    }
  }
  return total;
}

/**
 * Percentage part-way through a step.
 *
 * Steps that report only `progressBefore` freeze the bar for their whole duration, which on
 * anything measured in minutes is indistinguishable from a hang.
 */
export function within(step: RuntimeStep, fraction: number): number {
  const clamped = Math.max(0, Math.min(1, fraction));
  return progressBefore(step) + (progressAfter(step) - progressBefore(step)) * clamped;
}

/**
 * Lines after which a step is shown as roughly half done.
 *
 * Tuned to `install-paddle`, which emits a few dozen lines over several minutes and is the
 * step people watch. Too low and the bar sits near the ceiling for most of the wait; too high
 * and it barely leaves the floor.
 */
const LINES_TO_HALFWAY = 14;

/**
 * How far through a step to show, given the number of progress lines seen.
 *
 * Asymptotic: always moving, never arriving. A bar that reached 100% and then stayed there
 * would be a worse lie than one that crawls — and the previous version of this was worse
 * still, pinning `install-paddle` to exactly 11% for its entire multi-gigabyte download,
 * which is why it was reported as a freeze.
 */
export function advance(linesSeen: number): number {
  return 1 - 1 / (1 + linesSeen / LINES_TO_HALFWAY);
}

/** Percentage at which `step` begins. */
export function progressBefore(step: RuntimeStep): number {
  return progressAfter(step) - STEP_WEIGHTS[step];
}

export class RuntimeInstaller {
  constructor(private readonly options: RuntimeInstallerOptions) {}

  async install(request: InstallRequest): Promise<InstallResult> {
    const { hardware, onProgress, signal } = request;
    const selection = selectWheel(hardware);
    const python = venvPython(this.options.venvDir);

    this.options.logger.info(
      { flavor: selection.flavor, gpu: hardware.gpu?.name ?? null },
      'Starting Python runtime installation',
    );

    // Checked before anything is downloaded. A full disk otherwise surfaces as a failure deep
    // inside pip, or a half-written venv, with nothing pointing at the actual cause.
    await ensureDirectory(this.options.venvDir);
    await assertEnoughSpaceForInstall(this.options.venvDir);

    // And the questions no download can answer. A CPU without AVX cannot execute any current
    // PaddlePaddle build, so the alternative to this check is several gigabytes followed by
    // `DLL load failed` — an error naming neither the CPU nor the instruction set.
    await this.assertPreflightPasses();

    await this.step('install-python', onProgress, `Downloading Python ${PYTHON_VERSION}`, () =>
      this.run(['python', 'install', PYTHON_VERSION], onProgress, 'install-python', signal),
    );

    await this.step('create-venv', onProgress, 'Creating the virtual environment', async () => {
      await ensureDirectory(this.options.venvDir);
      await this.run(
        ['venv', '--python', PYTHON_VERSION, this.options.venvDir],
        onProgress,
        'create-venv',
        signal,
      );
    });

    await this.step('install-paddle', onProgress, `Installing ${selection.description}`, () =>
      this.run(
        [...pipInstallArgs(selection), '--python', python],
        onProgress,
        'install-paddle',
        signal,
      ),
    );

    await this.step('install-paddleocr', onProgress, 'Installing PaddleOCR', () =>
      this.run(
        [
          'pip',
          'install',
          '--upgrade',
          PADDLEOCR_REQUIREMENT,
          this.options.sidecarProjectDir,
          '--python',
          python,
        ],
        onProgress,
        'install-paddleocr',
        signal,
      ),
    );

    await this.step('download-models', onProgress, 'Downloading OCR models', async () => {
      // A previous attempt may have been interrupted mid-download. PaddleOCR would then treat
      // the partial weights as a valid cache and fail with an error naming neither the model
      // nor the download, forever.
      // The redirected scratch directory has to exist before Python looks for it.
      await ensureDirectory(join(this.options.modelCacheDir, 'tmp'));
      const repair = await repairModelCache(this.options.modelCacheDir, this.options.logger);
      if (repair.removed.length > 0) {
        onProgress({
          step: 'download-models',
          percent: progressBefore('download-models'),
          message: `Re-downloading ${repair.removed.length} incomplete model(s)`,
        });
      }
      await this.warmModels(python, onProgress, signal);
    });

    let engineInstalled = false;

    // Last, and deliberately not fatal. Everything above is required to OCR anything at all;
    // this only decides whether the accurate profile is fast, and the pool already falls back
    // to PaddleOCR's own backend when it is missing. Failing the whole install here would
    // trade a working slow setup for no setup.
    await this.step(
      'download-vl-server',
      onProgress,
      'Downloading the fast inference engine',
      async () => {
        try {
          await installVlServer({
            vlServerDir: this.options.vlServerDir,
            hardware,
            onMessage: (message: string, fraction: number) =>
              onProgress({
                step: 'download-vl-server',
                percent: within('download-vl-server', fraction),
                message,
              }),
            signal,
            logger: this.options.logger,
          });
          engineInstalled = true;
        } catch (error) {
          this.options.logger.warn(
            { err: error },
            'Could not install the fast inference engine; the accurate profile will use the built-in backend',
          );
        }
      },
    );

    const versions = await this.step('verify', onProgress, 'Verifying the installation', () =>
      this.verify(python, signal),
    );

    // The final word says which of the two outcomes happened. Landing on "Runtime ready"
    // either way is what let an installation finish 28x slower than intended with nothing on
    // screen to say the fast engine had not arrived.
    onProgress({
      step: 'verify',
      percent: 100,
      message: engineInstalled
        ? 'Runtime ready, with the fast inference engine.'
        : 'Runtime ready. The fast inference engine could not be installed; Accurate mode will use the slower built-in backend, and can be retried from this page.',
    });
    return { pythonPath: python, selection, versions };
  }

  /** True when a usable interpreter already exists, so setup can be skipped. */
  async isInstalled(): Promise<boolean> {
    return exists(venvPython(this.options.venvDir));
  }

  /**
   * Stop before the download when the result could not possibly run.
   *
   * Only `blocked` checks refuse. A `fixable` one — a missing Visual C++ runtime, a tight
   * disk — is reported and allowed through, because the user may well be resolving it in
   * another window and refusing would be presumptuous.
   */
  private async assertPreflightPasses(): Promise<void> {
    const report = await runPreflight({
      dataDirectory: this.options.venvDir,
      uvBinary: this.options.uvBinary,
    });

    for (const check of report.checks) {
      if (check.severity !== 'ok') {
        this.options.logger.warn({ check: check.id, severity: check.severity }, check.detail);
      }
    }

    if (!report.canInstall) {
      throw new PreflightBlockedError(report);
    }
  }

  /**
   * Read the versions of an interpreter that is already installed.
   *
   * Needed because installs that predate version reporting stored nulls, and the System page
   * then shows a dash forever — the alternative being to ask the user to reinstall several
   * gigabytes to populate three strings.
   *
   * Failure is not an error: this is display detail, and an interpreter that cannot answer
   * has bigger problems that `isInstalled` and the first job will surface properly.
   */
  /**
   * Reinstall just the sidecar into an existing venv.
   *
   * `--force-reinstall` because the version usually has not changed: during development the
   * source moves while `pyproject.toml` still says 1.0.0, and pip would consider the copy in
   * the venv already satisfactory. `--no-deps` because Paddle is several gigabytes and is not
   * what changed - this has to be the cheap repair, or nobody will run it.
   */
  /**
   * Install the inference engine into a runtime that already exists.
   *
   * Needed because an installation set up before this engine existed is `ready`, so the
   * installer never runs again and it would otherwise be stuck on the slow backend forever
   * -- with nothing to indicate why. Separate from `install` for the same reason
   * `reinstallSidecar` is: nobody reruns a multi-gigabyte Python setup to pick up one
   * component.
   *
   * Throws, unlike the install step, which swallows failures. There the engine is a bonus on
   * top of a working runtime; here it is the only thing the user asked for, so a failure has
   * to reach them.
   */
  async installVlServerOnly(request: InstallRequest): Promise<void> {
    await installVlServer({
      vlServerDir: this.options.vlServerDir,
      hardware: request.hardware,
      onMessage: (message: string, fraction: number) =>
        request.onProgress({
          step: 'download-vl-server',
          percent: within('download-vl-server', fraction),
          message,
        }),
      signal: request.signal,
      logger: this.options.logger,
    });
  }

  async reinstallSidecar(signal?: AbortSignal): Promise<RuntimeVersions> {
    const python = venvPython(this.options.venvDir);

    await this.run(
      [
        'pip',
        'install',
        '--force-reinstall',
        '--no-deps',
        this.options.sidecarProjectDir,
        '--python',
        python,
      ],
      // A no-op rather than undefined: `run` calls this for every line it recognises, and
      // there is no progress bar to drive here - the whole point is that this takes seconds.
      () => undefined,
      'install-paddleocr',
      signal,
    );

    return this.verify(python, signal);
  }

  async readVersions(signal?: AbortSignal): Promise<RuntimeVersions> {
    try {
      return await this.verify(venvPython(this.options.venvDir), signal);
    } catch {
      return { python: null, paddle: null, paddleocr: null, sidecar: null };
    }
  }

  /**
   * Keep everything `uv` downloads inside the app's own runtime directory.
   *
   * By default uv caches to `%LOCALAPPDATA%\uv` and installs Pythons there too — always on
   * the system drive, whatever the user chose for their data. That is how an install onto a
   * roomy D: still failed with "not enough space on the disk": the venv went to D: while the
   * ~1 GB of staged wheels went to a full C:.
   *
   * Co-locating them also means the space check measures the drive that actually matters, and
   * an uninstall reclaims every byte instead of orphaning a cache the user never knew about.
   */
  private uvEnvironment(): NodeJS.ProcessEnv {
    const runtimeDir = join(this.options.venvDir, '..');
    return {
      UV_CACHE_DIR: join(runtimeDir, 'uv-cache'),
      UV_PYTHON_INSTALL_DIR: join(runtimeDir, 'python'),
    };
  }

  /**
   * Environment for the Python steps, pinning every model cache into our runtime directory.
   *
   * PaddleOCR does not fetch models itself — it delegates to `huggingface_hub`, which caches
   * to `~/.cache/huggingface`, and to ModelScope, which caches to `~/.cache/modelscope`. Both
   * land on the **system drive** regardless of where the user put their data.
   *
   * That is not a tidiness point. It is what made this fail on a machine whose C: was full
   * while D: had 100 GB: PaddleX reported "No valid PaddlePaddle model found", because every
   * download had been truncated into a `.incomplete` file on a disk with no room — an error
   * that mentions neither downloading nor disk space.
   */
  private modelEnvironment(): NodeJS.ProcessEnv {
    const cache = this.options.modelCacheDir;
    const scratch = join(cache, 'tmp');
    return {
      PADDLE_PDX_CACHE_HOME: cache,
      PADDLE_PDX_MODEL_SOURCE: 'huggingface',
      HF_HOME: join(cache, 'huggingface'),
      HF_HUB_CACHE: join(cache, 'huggingface', 'hub'),
      MODELSCOPE_CACHE: join(cache, 'modelscope'),
      XDG_CACHE_HOME: join(cache, 'xdg'),
      /**
       * The scratch directory too, and this is the one that is easy to miss.
       *
       * Both downloaders write to a `tempfile` first and move the finished file into the
       * cache. Redirecting only the caches therefore fixes nothing: the *download* still
       * happens on the system drive. On a full C: that produced `[Errno 28] No space left on
       * device` from inside HuggingFace, then a silent fallback to ModelScope, which failed
       * the same way — and PaddleOCR finally reported "No valid PaddlePaddle model found".
       */
      TMPDIR: scratch,
      TEMP: scratch,
      TMP: scratch,
    };
  }

  private async step<TResult>(
    step: RuntimeStep,
    onProgress: InstallRequest['onProgress'],
    message: string,
    work: () => Promise<TResult>,
  ): Promise<TResult> {
    onProgress({ step, percent: progressBefore(step), message });
    const result = await work();
    onProgress({ step, percent: progressAfter(step), message: `${message} — done` });
    return result;
  }

  private async run(
    args: readonly string[],
    onProgress: InstallRequest['onProgress'],
    step: RuntimeStep,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    // uv reports which package it is working on, never a percentage, so there is no true
    // fraction to show. Each line moves the bar a diminishing distance toward the step's end
    // and never reaches it, which is honest about the one thing the user needs to know:
    // something is still happening. `stepDone` supplies the real 100%.
    let linesSeen = 0;
    await runCommand({
      command: this.options.uvBinary,
      args,
      signal,
      env: { ...process.env, ...this.uvEnvironment() },
      onLine: (line) => {
        // The raw line still goes to the log, where a progress bar is harmless and the
        // detail matters when an install fails.
        this.options.logger.debug({ step, line: line.trim() }, 'runtime installer');

        const message = toUserMessage(line);
        if (message === null) {
          return;
        }
        linesSeen += 1;
        onProgress({ step, percent: within(step, advance(linesSeen)), message });
      },
    });
  }

  /**
   * Import the pipelines once so PaddleOCR downloads its weights now rather than during the
   * user's first job — which would otherwise look like a mysteriously slow first document.
   */
  private async warmModels(
    python: string,
    onProgress: InstallRequest['onProgress'],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    await runCommand({
      command: python,
      args: ['-c', WARM_MODELS_SCRIPT],
      signal,
      env: { ...process.env, ...this.modelEnvironment() },
      onLine: (line) => {
        // Hugging Face draws a tqdm bar per model file; unfiltered they were the "weird
        // characters" users saw in the status line.
        const message = toUserMessage(line);
        if (message !== null) {
          onProgress({
            step: 'download-models',
            percent: progressBefore('download-models') + 1,
            message,
          });
        }
      },
    });
  }

  /**
   * Confirm the runtime imports, and read back what was actually installed.
   *
   * The versions come from the interpreter rather than from what we asked for: a resolver
   * can legitimately pick a different build, and reporting our intent instead of the result
   * would make the System page confidently wrong.
   */
  private async verify(python: string, signal: AbortSignal | undefined): Promise<RuntimeVersions> {
    let versions: RuntimeVersions = { python: null, paddle: null, paddleocr: null, sidecar: null };

    await runCommand({
      command: python,
      args: ['-c', VERIFY_SCRIPT],
      signal,
      timeoutMs: 120_000,
      onLine: (line) => {
        const parsed = parseVersions(line);
        if (parsed !== null) {
          versions = parsed;
        }
      },
    });

    return versions;
  }
}

/**
 * Warm the engine through the sidecar's own registry, not `PPStructureV3` directly.
 *
 * Constructing that pipeline bare downloads *every* sub-model it can use — formula, chart,
 * seal and table-cell detection — because PaddleOCR resolves and fetches them in its
 * constructor from the toggles it was given, and bare means "all of them". Hundreds of
 * megabytes, for features the default pipeline has switched off.
 *
 * Going through `create_engine` warms exactly what a job will load, and inherits the oneDNN
 * handling rather than duplicating it here.
 */
const WARM_MODELS_SCRIPT = [
  'from impressive_ocr_sidecar.core.protocol import EngineOptions',
  'from impressive_ocr_sidecar.engines.registry import create_engine',
  'print("Preparing OCR models", flush=True)',
  'options = EngineOptions()',
  'engine = create_engine("fast", "cpu", options.modules)',
  'engine.load()',
  'print("Models ready", flush=True)',
].join('\n');

const VERSION_PREFIX = 'IMPRESSIVE_OCR_VERSIONS ';

/**
 * Confirm every import resolves, and report what was actually installed.
 *
 * One JSON line behind a distinctive prefix, so parsing it cannot collide with anything else
 * a dependency decides to print.
 */
/**
 * Reports the sidecar version too, which it did not before.
 *
 * It imported the package and then never printed anything about it, so `sidecarVersion` was
 * null on every installation. That is not merely a dash in the UI: `engineOutdated` reads
 * `installed !== null && installed !== appVersion`, so a permanent null meant the warning
 * that the venv's Python is older than the app could never fire — and that copy is exactly
 * what silently ignores new settings after an application update.
 *
 * `importlib.metadata` rather than `__version__`, because the package does not define one and
 * reading it returns None, which would have looked like a fix while changing nothing.
 */
const VERIFY_SCRIPT = [
  'import json, sys',
  'from importlib.metadata import PackageNotFoundError, version',
  'import paddle, paddleocr',
  'try:',
  '    sidecar = version("impressive-ocr-sidecar")',
  'except PackageNotFoundError:',
  '    sidecar = None',
  `print("${VERSION_PREFIX}" + json.dumps({`,
  '    "python": sys.version.split()[0],',
  '    "paddle": paddle.__version__,',
  '    "paddleocr": paddleocr.__version__,',
  '    "sidecar": sidecar,',
  '}), flush=True)',
].join('\n');

/** Pull the version payload out of a stdout line, or null when this is not that line. */
export function parseVersions(line: string): RuntimeVersions | null {
  const index = line.indexOf(VERSION_PREFIX);
  if (index === -1) return null;

  try {
    const payload: unknown = JSON.parse(line.slice(index + VERSION_PREFIX.length).trim());
    if (typeof payload !== 'object' || payload === null) return null;

    const record = payload as Record<string, unknown>;
    return {
      python: asVersion(record.python),
      paddle: asVersion(record.paddle),
      paddleocr: asVersion(record.paddleocr),
      sidecar: asVersion(record.sidecar),
    };
  } catch {
    // A truncated line is not worth failing an otherwise successful install over.
    return null;
  }
}

function asVersion(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
