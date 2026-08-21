// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EngineProfile, ResolvedDevice, SidecarHealth } from '@impressive-ocr/shared';
import type { Logger } from '../../infra/logger';
import { SidecarClient } from './sidecar-client';
import { SidecarProcess } from './sidecar-process';

/**
 * Keeps one warm sidecar per profile/device pair.
 *
 * Model load dominates the cost of a job — seconds on CPU, far longer for the vision-language
 * model — so a process-per-job design would spend most of its time loading weights. Workers
 * are therefore started lazily on first use and kept alive.
 *
 * One worker per pair, not a pool of many: the GPU can only hold one copy of the VLM anyway,
 * and CPU parallelism is handled by running several *jobs* through the scheduler rather than
 * several interpreters each holding their own copy of the weights.
 */

export interface SidecarPoolOptions {
  pythonPath: string;
  authToken: string;
  modelCacheDir: string;
  logLevel: string;
  /** Share of the machine's cores OCR may use; read fresh so a settings change applies. */
  cpuBudgetPercent: () => number;
  /** Minutes an idle worker may keep its models; 0 keeps them until shutdown. Read fresh. */
  idleMinutes: () => number;
  logger: Logger;
}

/** How often idle workers are checked. Minutes-scale timeouts do not need finer than this. */
const IDLE_SWEEP_INTERVAL_MS = 30_000;

export interface SidecarRelease {
  stopped: number;
  busy: number;
}

interface Worker {
  key: string;
  profile: EngineProfile;
  device: ResolvedDevice;
  process: SidecarProcess;
  client: SidecarClient;
  restarts: number;
  startedAt: Date;
  busy: boolean;
  /** When this worker last finished a job. Null while it has never run one. */
  idleSince: Date | null;
}

export class SidecarPool {
  private readonly workers = new Map<string, Worker>();
  /** Guards against two concurrent claims both starting the same worker. */
  private readonly starting = new Map<string, Promise<Worker>>();
  private stopped = false;
  private readonly idleSweep: NodeJS.Timeout;

  constructor(private readonly options: SidecarPoolOptions) {
    this.idleSweep = setInterval(() => this.sweepIdle(), IDLE_SWEEP_INTERVAL_MS);
    // Never hold the process open for a sweep: a headless server that has finished should
    // exit, not linger because a timer is pending.
    this.idleSweep.unref();
  }

  /** Get a ready client for the pair, starting or restarting the worker if necessary. */
  async acquire(profile: EngineProfile, device: ResolvedDevice): Promise<SidecarClient> {
    const worker = await this.ensureWorker(profile, device);
    worker.busy = true;
    return worker.client;
  }

  release(profile: EngineProfile, device: ResolvedDevice): void {
    const worker = this.workers.get(keyFor(profile, device));
    if (worker !== undefined) {
      worker.busy = false;
      worker.idleSince = new Date();
    }
  }

  /**
   * Stop the warm workers and give their memory back.
   *
   * A resident worker holds its models — measured at 3.2 GB of VRAM for PP-StructureV3 on the
   * GPU — for as long as the application runs. That is the right trade while someone is
   * working and the wrong one when they want the card for something else.
   *
   * Without `force`, a worker that is mid-document is left alone and counted: killing it
   * would throw away work that is often most of a minute in, and the caller can decide
   * whether that matters.
   */
  async releaseWorkers({ force = false }: { force?: boolean } = {}): Promise<SidecarRelease> {
    const workers = [...this.workers.values()];
    const toStop = workers.filter((worker) => force || !worker.busy);
    const busy = workers.length - toStop.length;

    await Promise.all(
      toStop.map(async (worker) => {
        this.options.logger.info(
          { key: worker.key, busy: worker.busy, forced: force },
          'Releasing sidecar worker',
        );
        await worker.process.stop();
        this.workers.delete(worker.key);
      }),
    );

    return { stopped: toStop.length, busy };
  }

  /**
   * Release workers that have been idle longer than the configured number of minutes.
   *
   * Polled rather than scheduled per worker: one timer for the pool is easier to reason about
   * than a timer per worker that has to be cancelled and recreated around every job, and the
   * granularity of a sweep is irrelevant against a timeout measured in minutes.
   */
  private sweepIdle(): void {
    const minutes = this.options.idleMinutes();
    if (minutes <= 0) {
      return;
    }
    const cutoff = Date.now() - minutes * 60_000;

    for (const worker of [...this.workers.values()]) {
      if (worker.busy || worker.idleSince === null || worker.idleSince.getTime() > cutoff) {
        continue;
      }
      this.options.logger.info(
        { key: worker.key, idleMinutes: minutes },
        'Releasing an idle sidecar worker',
      );
      // Fire and forget: the sweep must not block, and a stop that fails leaves the worker in
      // the map to be retried on the next pass.
      void worker.process.stop().then(() => {
        this.workers.delete(worker.key);
      });
    }
  }

  private async ensureWorker(profile: EngineProfile, device: ResolvedDevice): Promise<Worker> {
    if (this.stopped) {
      throw new Error('Sidecar pool is shutting down');
    }
    const key = keyFor(profile, device);

    const existing = this.workers.get(key);
    if (existing !== undefined && existing.process.isRunning) {
      return existing;
    }

    // A crashed worker is replaced rather than reused, but the restart count carries over so
    // a worker that keeps dying is visible in the UI instead of silently looping.
    const inFlight = this.starting.get(key);
    if (inFlight !== undefined) {
      return inFlight;
    }

    const promise = this.startWorker(profile, device, existing?.restarts ?? 0);
    this.starting.set(key, promise);
    try {
      const worker = await promise;
      this.workers.set(key, worker);
      return worker;
    } finally {
      this.starting.delete(key);
    }
  }

  private async startWorker(
    profile: EngineProfile,
    device: ResolvedDevice,
    previousRestarts: number,
  ): Promise<Worker> {
    const process_ = new SidecarProcess({
      pythonPath: this.options.pythonPath,
      profile,
      device,
      authToken: this.options.authToken,
      modelCacheDir: this.options.modelCacheDir,
      logLevel: this.options.logLevel,
      cpuBudgetPercent: this.options.cpuBudgetPercent(),
      logger: this.options.logger,
    });

    const handshake = await process_.start();
    const client = new SidecarClient({
      port: handshake.port,
      authToken: this.options.authToken,
    });

    // Verifies the protocol version. A mismatch throws here, at startup, rather than
    // producing a stream of silently-undefined fields on every job.
    await client.capabilities();

    return {
      key: keyFor(profile, device),
      profile,
      device,
      process: process_,
      client,
      restarts: previousRestarts + (previousRestarts > 0 ? 1 : 0),
      startedAt: new Date(),
      busy: false,
      idleSince: new Date(),
    };
  }

  /** Drop a worker so the next job starts a fresh one. Used after a crash or a hung job. */
  async recycle(profile: EngineProfile, device: ResolvedDevice): Promise<void> {
    const key = keyFor(profile, device);
    const worker = this.workers.get(key);
    if (worker === undefined) {
      return;
    }
    this.options.logger.warn({ key, restarts: worker.restarts }, 'Recycling sidecar');
    await worker.process.stop();
    this.workers.set(key, { ...worker, restarts: worker.restarts + 1, busy: false });
  }

  health(): SidecarHealth[] {
    return [...this.workers.values()].map((worker) => ({
      id: worker.key,
      pid: worker.process.pid,
      device: worker.device,
      profile: worker.profile,
      state: !worker.process.isRunning ? 'stopped' : worker.busy ? 'busy' : 'ready',
      restarts: worker.restarts,
      lastHeartbeatAt: worker.startedAt.toISOString(),
    }));
  }

  async stopAll(): Promise<void> {
    this.stopped = true;
    clearInterval(this.idleSweep);
    await Promise.all([...this.workers.values()].map((worker) => worker.process.stop()));
    this.workers.clear();
  }
}

export function keyFor(profile: EngineProfile, device: ResolvedDevice): string {
  return `${profile}:${device}`;
}
