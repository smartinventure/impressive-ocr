// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from 'drizzle-orm';
import { APP_STATE_KEYS, appState, createDatabase } from '@impressive-ocr/db';
import { SESSION_IDLE_TIMEOUT_MINUTES, type AppSettings } from '@impressive-ocr/shared';
import { ensureDirectory } from './infra/fs/file-ops';
import {
  defaultMigrationsDir,
  defaultSidecarDir,
  defaultUvBinary,
  defaultWebRoot,
} from './infra/module-paths';
import { resolveSafePath } from './infra/fs/safe-path';
import { createAuthToken } from './infra/ids';
import { createLogger, type Logger } from './infra/logger';
import { resolveAppPaths, type AppPaths } from './infra/paths';
import { ensureCertificate } from './infra/tls/self-signed';
import { EventBus } from './modules/events/event-bus';
import { SidecarPool } from './modules/ocr/sidecar-pool';
import { PipelineRepository } from './modules/pipelines/pipeline-repository';
import { PipelineService } from './modules/pipelines/pipeline-service';
import { JobExecutor } from './modules/queue/job-executor';
import { JobRepository } from './modules/queue/job-repository';
import { Scheduler } from './modules/queue/scheduler';
import { RuntimeInstaller } from './modules/runtime/runtime-installer';
import { RuntimeService } from './modules/runtime/runtime-service';
import { AuthService } from './modules/auth/auth-service';
import { createSessionStore } from './modules/auth/session-store';
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
  const stored = settingsService.get();
  const settings: AppSettings =
    options.port === undefined ? stored : { ...stored, port: options.port };

  const logger = createLogger({
    level: options.logLevel ?? settings.logLevel,
    pretty: options.pretty ?? process.env.NODE_ENV !== 'production',
  });

  const events = new EventBus();
  const pipelineRepository = new PipelineRepository(db);
  const jobs = new JobRepository(db);

  const runtime = new RuntimeService({
    db,
    events,
    logger,
    venvDir: paths.venvDir,
    installer: new RuntimeInstaller({
      uvBinary: options.uvBinary ?? defaultUvBinary(),
      venvDir: paths.venvDir,
      modelCacheDir: paths.modelCacheDir,
      sidecarProjectDir: options.sidecarDir ?? defaultSidecarDir(),
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
    executor: new JobExecutor({
      jobs,
      pool,
      events,
      logger,
      workRoot: paths.workDir,
      hardware: () => runtime.getHardware(),
    }),
  });

  const services: AppServices = {
    pipelines,
    jobs,
    settings: settingsService,
    auth: authService,
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
      await watchers.stopAll();
      await scheduler.stop();
      await pool.stopAll();
      await http.close();
      closeDatabase();
    },
  };
}

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
