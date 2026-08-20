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
  logger: Logger;
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
}

export class SidecarPool {
  private readonly workers = new Map<string, Worker>();
  /** Guards against two concurrent claims both starting the same worker. */
  private readonly starting = new Map<string, Promise<Worker>>();
  private stopped = false;

  constructor(private readonly options: SidecarPoolOptions) {}

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
    await Promise.all([...this.workers.values()].map((worker) => worker.process.stop()));
    this.workers.clear();
  }
}

export function keyFor(profile: EngineProfile, device: ResolvedDevice): string {
  return `${profile}:${device}`;
}
