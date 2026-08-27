// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from 'drizzle-orm';
import { APP_STATE_KEYS, appState, createDatabase } from '@impressive-ocr/db';
import { APP_VERSION,
  SESSION_IDLE_TIMEOUT_MINUTES,
  type AppSettings,
  type BindAddress,
} from '@impressive-ocr/shared';
import { ensureDirectory } from './infra/fs/file-ops';
import {
  defaultMigrationsDir,
  defaultSidecarDir,
  defaultUvBinary,
  defaultWebRoot,
} from './infra/module-paths';
import { resolveSafePath } from './infra/fs/safe-path';
import { createAuthToken } from './infra/ids';
import { RotatingLogFile } from './infra/log-file';
import { ResourceMonitor } from './modules/runtime/resource-usage';
import { createLogger, type Logger } from './infra/logger';
import { resolveAppPaths, vlServerPaths, type AppPaths } from './infra/paths';
import { ensureCertificate } from './infra/tls/self-signed';
import { EventBus } from './modules/events/event-bus';
import { SidecarPool } from './modules/ocr/sidecar-pool';
import { isInstalled, resolveVlServer } from './modules/ocr/vl-server-availability';
import { QUANTISATION } from './modules/ocr/vl-server-index';
import { PipelineRepository } from './modules/pipelines/pipeline-repository';
import { PipelineService } from './modules/pipelines/pipeline-service';
import { JobExecutor } from './modules/queue/job-executor';
import { JobRepository } from './modules/queue/job-repository';
import { Scheduler } from './modules/queue/scheduler';
import { RuntimeInstaller } from './modules/runtime/runtime-installer';
import { RuntimeService } from './modules/runtime/runtime-service';
import { AuthService } from './modules/auth/auth-service';
/** The licence service, overridable so a staging instance can be used without a rebuild. */
const DEFAULT_LICENSE_URL = 'https://license.speedbits.io';

import { ConsentService } from './modules/consent/consent-service';
import { HttpLicenseClient } from './modules/license/license-client';
import { LicenseService } from './modules/license/license-service';
import { createSessionStore } from './modules/auth/session-store';
import { QuickRunService } from './modules/quick/quick-run-service';
import { QuickRunStore } from './modules/quick/quick-run-store';
import { SettingsService } from './modules/settings/settings-service';
import { WatcherManager } from './modules/watcher/watcher-manager';
import { createHttpServer } from './http/server';
import type { AppServices } from './app-services';
import type { AppFastify } from './http/fastify-types';

/**
 * The composition root: the one place that constructs and wires everything.
 *
 * Deliberately Electron-agnostic. `main.ts` calls this for headless server mode, and the
 * Electron main process calls the same function in-process — which is what keeps a single
 * backend serving both without a second code path.
 */

export interface CreateAppOptions {
  /** Override the data directory. Used by tests and portable installs. */
  dataDir?: string | undefined;
  /**
   * Override the configured port. For service deployments where the port comes from the
   * unit file rather than the UI, and for tests that must not collide with a real install.
   */
  port?: number | undefined;
  /**
   * Override the configured bind address at startup.
   *
   * Exists for containers, which have no other option: inside its own network namespace a
   * container that binds loopback is unreachable even from the host, so there would be no
   * way to open the UI and configure anything.
   *
   * Deliberately **not** a way around `assertSafeExposure`. That guard governs the settings
   * API — what a remote caller may flip at runtime — and still refuses to store a network
   * binding without authentication and TLS. This is the operator's own decision, made once
   * at startup on the machine itself, and `listen()` warns loudly if it leaves an
   * unauthenticated server on a network interface.
   */
  bindAddress?: BindAddress | undefined;
  /** Directory holding the built SPA. */
  webRoot?: string | undefined;
  /** Path to the bundled `uv` binary. */
  uvBinary?: string | undefined;
  /**
   * Explicit locations for the packaged layout.
   *
   * A packaged app does not sit inside the repository, so it cannot derive these — and a
   * wrong guess does not crash, it migrates the database into a directory nobody looks at.
   * The Electron host and the server tarball both pass them.
   */
  migrationsDir?: string | undefined;
  sidecarDir?: string | undefined;
  pretty?: boolean | undefined;
  /** Override the stored log level. Tests pass `silent`; the Electron shell passes nothing. */
  logLevel?: string | undefined;
}

export interface AppHandle {
  services: AppServices;
  paths: AppPaths;
  settings: AppSettings;
  /**
   * The configured Fastify instance, before it binds a port.
   *
   * Exposed so integration tests can drive the real routing, validation and error handling
   * through `inject()` without opening a socket — which on a developer machine means no port
   * clashes and no flaky teardown.
   */
  http: AppFastify;
  /** Bind and start serving. Returns the URL the UI is reachable at. */
  listen: () => Promise<string>;
  /** Graceful shutdown: stop accepting work, drain, close everything. */
  shutdown: () => Promise<void>;
  logger: Logger;
}

export async function createApp(options: CreateAppOptions = {}): Promise<AppHandle> {
  const paths = resolveAppPaths(options.dataDir);
  await ensureDirectory(paths.dataDir);
  await ensureDirectory(paths.workDir);

  const { db, close: closeDatabase } = createDatabase({
    filePath: paths.databaseFile,
    migrationsFolder: options.migrationsDir ?? defaultMigrationsDir(),
  });

  // Built before the settings service, which asks it whether a password exists before
  // permitting a network binding. The store is in-memory, so a restart signs everyone out.
  const sessions = createSessionStore({ idleTimeoutMinutes: SESSION_IDLE_TIMEOUT_MINUTES });
  const authService = new AuthService(db, sessions);
  const settingsService = new SettingsService(db, () => authService.hasPassword());
  const consentService = new ConsentService(db);

  const stored = settingsService.get();
  const settings: AppSettings = {
    ...stored,
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.bindAddress === undefined ? {} : { bindAddress: options.bindAddress }),
  };

  // Written to disk as well as the console, so the in-app log viewer has something to read.
  const logFile = new RotatingLogFile({ directory: paths.logsDir });
  const logger = createLogger({
    level: options.logLevel ?? settings.logLevel,
    pretty: options.pretty ?? process.env.NODE_ENV !== 'production',
    file: logFile,
  });
  // The licence server is a URL rather than a constant so a staging instance can be pointed
  // at without a rebuild, and so tests never reach the real one.
  const licenseService = new LicenseService({
    db,
    client: new HttpLicenseClient({
      baseUrl: process.env.IMPRESSIVE_OCR_LICENSE_URL ?? DEFAULT_LICENSE_URL,
      appVersion: APP_VERSION,
      logger,
    }),
    appVersion: APP_VERSION,
    logger,
  });

  const events = new EventBus();
  const pipelineRepository = new PipelineRepository(db);
  const jobs = new JobRepository(db);

  // One value, two consumers: the installer runs it, and preflight reports when it is absent.
  const uvBinary = options.uvBinary ?? defaultUvBinary();

  const runtime = new RuntimeService({
    db,
    events,
    logger,
    venvDir: paths.venvDir,
    uvBinary,
    // Checked on every call rather than cached: it becomes true partway through an install,
    // and a stale `false` would keep offering the Accurate profile as unavailable after it
    // had in fact arrived.
    isVlServerInstalled: () => isInstalled(vlServerPaths(paths.vlServerDir, QUANTISATION)),
    installer: new RuntimeInstaller({
      uvBinary,
      venvDir: paths.venvDir,
      modelCacheDir: paths.modelCacheDir,
      sidecarProjectDir: options.sidecarDir ?? defaultSidecarDir(),
      vlServerDir: paths.vlServerDir,
      logger,
    }),
  });
  await runtime.initialize();

  // The token is regenerated every launch, so one leaked into a log or a crash dump stops
  // working the moment the app restarts.
  const pool = new SidecarPool({
    pythonPath: runtime.pythonPath(),
    authToken: createAuthToken(),
    modelCacheDir: paths.modelCacheDir,
    logLevel: settings.logLevel,
    // A function, not a value: changing the budget in Settings then applies to the next
    // sidecar rather than needing a restart.
    cpuBudgetPercent: () => settingsService.get().cpuBudgetPercent,
    idleMinutes: () => settingsService.get().sidecarIdleMinutes,
    // Read fresh for the same reason: turning the fast backend off, or installing it from
    // the System page, applies to the next worker rather than needing a restart.
    vlServer: () =>
      resolveVlServer(
        settingsService.get(),
        runtime.getHardware(),
        paths.vlServerDir,
        logger,
      ).options,
    logger,
  });

  let globallyPaused = readGloballyPaused(db);
  const isGloballyPaused = (): boolean => globallyPaused;

  const watchers = new WatcherManager({
    pipelines: pipelineRepository,
    jobs,
    events,
    logger,
  });

  const pipelines = new PipelineService({
    repository: pipelineRepository,
    jobs,
    settings: settingsService,
    events,
    logger,
    hardware: () => runtime.getHardware(),
    isRuntimeReady: () => runtime.isReady(),
    isGloballyPaused,
    onPipelinesChanged: () => {
      void watchers.sync();
    },
  });

  const scheduler = new Scheduler({
    pipelines: pipelineRepository,
    jobs,
    events,
    logger,
    hardware: () => runtime.getHardware(),
    isRuntimeReady: () => runtime.isReady(),
    isGloballyPaused,
    maxConcurrentDocuments: () => settingsService.get().maxConcurrentDocuments,
    executor: new JobExecutor({
      jobs,
      pool,
      events,
      logger,
      workRoot: paths.workDir,
      hardware: () => runtime.getHardware(),
    }),
  });

  const quickStore = new QuickRunStore({ root: paths.quickDir, logger });
  const quick = new QuickRunService({
    pipelines: pipelineRepository,
    jobs,
    settings: settingsService,
    store: quickStore,
    events,
    logger,
    resolveFolder: (path, mustExist) =>
      resolveSafePath(path, { allowlist: settingsService.allowlist(), mustExist }),
  });

  let housekeeping: NodeJS.Timeout | undefined;

  const services: AppServices = {
    pipelines,
    jobs,
    settings: settingsService,
    auth: authService,
    consent: consentService,
    license: licenseService,
    paths,
    resources: new ResourceMonitor(),
    quick,
    quickStore,
    runtime,
    scheduler,
    watchers,
    pool,
    events,
    isGloballyPaused,
    setGloballyPaused: (paused) => {
      globallyPaused = paused;
      writeGloballyPaused(db, paused);
      logger.info({ globallyPaused: paused }, 'Global pause toggled');
    },
    resolveFolder: (path, mustExist) =>
      resolveSafePath(path, { allowlist: settingsService.allowlist(), mustExist }),
  };

  // Resolved before the server is constructed: Fastify picks http or https at construction,
  // not at listen(). A self-signed pair is generated on first use and then reused, so the
  // browser warning is a one-off rather than a fresh one on every restart.
  const tls =
    settings.scheme === 'https'
      ? await ensureCertificate({ directory: paths.tlsDir, logger })
      : undefined;

  const http = await createHttpServer({
    services,
    settings,
    logger,
    webRoot: options.webRoot ?? defaultWebRoot(),
    ...(tls === undefined ? {} : { tls: { certificate: tls.certificate, key: tls.key } }),
  });

  return {
    services,
    paths,
    settings,
    logger,
    http,

    listen: async () => {
      // Said once, at the moment it becomes true. An unauthenticated server on a network
      // interface can read and write every folder in the allowlist, and the operator who
      // set the override is the only person who can put a proxy or a firewall in front of
      // it — so this has to be visible in the log they are already watching.
      if (settings.bindAddress === '0.0.0.0' && !settings.authEnabled) {
        logger.warn(
          { port: settings.port },
          'Listening on all interfaces with authentication disabled; ' +
            'publish this port only to a trusted network',
        );
      }

      try {
        await http.listen({ port: settings.port, host: settings.bindAddress });
      } catch (error) {
        // A port clash is the single most likely startup failure on a desktop — another
        // app, a stale instance, or a WSL relay. A raw EADDRINUSE stack tells the user
        // nothing they can act on.
        if (isAddressInUse(error)) {
          throw new PortInUseError(settings.port);
        }
        throw error;
      }
      await watchers.sync();
      scheduler.start();

      // Housekeeping, on one timer rather than one per concern. Runs immediately so a server
      // that is restarted often still clears expired Quick Mode results and old history,
      // then hourly. `unref` so it never holds the process open on shutdown.
      const sweep = (): void => {
        void quickStore.sweep();
        const retentionDays = settingsService.get().historyRetentionDays;
        if (retentionDays > 0) {
          const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
          const pruned = jobs.pruneOlderThan(cutoff);
          if (pruned > 0) logger.info({ pruned }, 'Pruned job history');
        }
      };
      sweep();
      housekeeping = setInterval(sweep, HOUSEKEEPING_INTERVAL_MS);
      housekeeping.unref();

      const url = `${settings.scheme}://${
        settings.bindAddress === '0.0.0.0' ? 'localhost' : settings.bindAddress
      }:${settings.port}`;
      logger.info({ url, runtime: runtime.getStatus().state }, 'Impressive OCR is listening');
      return url;
    },

    shutdown: async () => {
      logger.info('Shutting down');
      // Order matters: stop discovering work, stop scheduling it, then tear down the
      // workers that might still be mid-document.
      if (housekeeping !== undefined) clearInterval(housekeeping);
      await watchers.stopAll();
      await scheduler.stop();
      await pool.stopAll();
      await http.close();
      closeDatabase();
      logFile.close();
    },
  };
}

/** How often expired Quick Mode runs and old job history are cleared. */
const HOUSEKEEPING_INTERVAL_MS = 60 * 60 * 1000;

/** Startup failed because the configured port is taken. Carries the port so the UI can offer another. */
export class PortInUseError extends Error {
  constructor(readonly port: number) {
    super(
      `Port ${port} is already in use. Change the port in Settings, or stop the other program using it.`,
    );
    this.name = 'PortInUseError';
  }
}

export function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EADDRINUSE'
  );
}

function readGloballyPaused(db: ReturnType<typeof createDatabase>['db']): boolean {
  const row = db
    .select()
    .from(appState)
    .where(eq(appState.key, APP_STATE_KEYS.globallyPaused))
    .get();
  return row?.value === true;
}

function writeGloballyPaused(db: ReturnType<typeof createDatabase>['db'], paused: boolean): void {
  const updatedAt = new Date().toISOString();
  db.insert(appState)
    .values({ key: APP_STATE_KEYS.globallyPaused, value: paused, updatedAt })
    .onConflictDoUpdate({ target: appState.key, set: { value: paused, updatedAt } })
    .run();
}
