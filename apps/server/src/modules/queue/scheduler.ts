// SPDX-License-Identifier: AGPL-3.0-or-later
import type { HardwareCapabilities, Job, Pipeline, ResolvedDevice } from '@impressive-ocr/shared';
import type { Logger } from '../../infra/logger';
import { type EventBus, stamp } from '../events/event-bus';
import type { PipelineRepository } from '../pipelines/pipeline-repository';
import type { JobExecutor } from './job-executor';
import type { JobRepository } from './job-repository';
import { deviceCapacity, isPipelineEligible, resolveDevice } from './scheduling-policy';

/**
 * The loop that decides what runs next.
 *
 * Deliberately a simple tick rather than an event-driven cascade: throughput here is bounded
 * by OCR taking seconds to minutes per document, not by scheduling latency, and a tick is far
 * easier to reason about when jobs are being paused, retried and cancelled concurrently.
 */

/** How often to look for work. Well below the time any real job takes. */
const TICK_INTERVAL_MS = 500;

export interface SchedulerOptions {
  pipelines: PipelineRepository;
  jobs: JobRepository;
  executor: JobExecutor;
  events: EventBus;
  logger: Logger;
  hardware: () => HardwareCapabilities;
  isRuntimeReady: () => boolean;
  isGloballyPaused: () => boolean;
  /**
   * Whether the licence permits new work to start.
   *
   * Checked here rather than at the HTTP routes because this is the only place *all* work
   * begins: a watched folder enqueues without anyone calling an endpoint, so a route-level
   * check would let every pipeline through and stop only Quick Mode.
   *
   * It withholds nothing that already exists. Jobs stay queued rather than failing, results
   * already produced stay downloadable, and every screen — registration above all — stays
   * reachable. Read fresh each tick, so activating a licence starts the queue moving without
   * a restart.
   */
  canProcess: () => boolean;
  /** Documents allowed in flight at once. Each costs a warm model set in RAM. */
  maxConcurrentDocuments: () => number;
}

interface RunningJob {
  jobId: string;
  pipelineId: string;
  device: ResolvedDevice;
  controller: AbortController;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly running = new Map<string, RunningJob>();
  private ticking = false;
  private stopped = false;

  constructor(private readonly options: SchedulerOptions) {}

  start(): void {
    if (this.timer !== null) {
      return;
    }
    this.stopped = false;

    // Anything left `running` belongs to a previous process that died. Outputs are only
    // moved into place on success, so replaying those jobs is safe.
    const requeued = this.options.jobs.requeueRunning();
    if (requeued > 0) {
      this.options.logger.warn({ requeued }, 'Requeued jobs orphaned by a previous shutdown');
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Aborting closes the HTTP stream to the sidecar, which abandons the document. The job
    // row goes back to `pending`, so it resumes on the next start.
    for (const job of this.running.values()) {
      job.controller.abort();
    }
    this.running.clear();
  }

  get runningCount(): number {
    return this.running.size;
  }

  /**
   * Cancel one in-flight job.
   *
   * Used when a pipeline is paused mid-document and the user chose not to let it finish.
   */
  cancel(jobId: string): boolean {
    const running = this.running.get(jobId);
    if (running === undefined) {
      return false;
    }
    running.controller.abort();
    return true;
  }

  /**
   * One scheduling pass.
   *
   * Re-entrancy guard rather than a queue: a tick that overruns its interval should be
   * skipped, not stacked, or a slow database would build an unbounded backlog of ticks.
   */
  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) {
      return;
    }
    this.ticking = true;
    try {
      await this.fillCapacity();
    } catch (error) {
      this.options.logger.error({ err: error }, 'Scheduler tick failed');
    } finally {
      this.ticking = false;
    }
  }

  private async fillCapacity(): Promise<void> {
    // Nothing is claimed while the licence gate is closed. Deliberately before any other
    // work: claiming a job and handing it back counts an attempt against it.
    if (!this.options.canProcess()) {
      return;
    }

    const hardware = this.options.hardware();
    // Read fresh each tick, so changing the limit in Settings takes effect immediately
    // rather than at the next restart.
    const capacity = deviceCapacity(hardware, this.options.maxConcurrentDocuments());
    const now = new Date();

    const eligible = this.eligiblePipelines(now);
    if (eligible.size === 0) {
      return;
    }

    // Keep claiming while any device still has a free slot. The loop breaks as soon as a
    // claim comes back empty, so an idle queue costs one query per tick.
    for (;;) {
      const free = this.freeCapacity(capacity);
      if (free.gpu <= 0 && free.cpu <= 0) {
        return;
      }

      // Only offer the claim pipelines whose device still has a slot.
      //
      // Claiming a job and handing it straight back looks harmless and is not: `claimNext`
      // counts an attempt, so every tick spent waiting for a busy GPU used to burn one of
      // the job's three retries. A document queued behind a long accurate run accumulated
      // hundreds of "attempts" without being touched, and was then quarantined by its first
      // real failure, with no retry left to spend.
      const claimable = new Map<string, Pipeline>();
      for (const [id, pipeline] of eligible) {
        if (free[resolveDevice(pipeline, hardware).device] > 0) {
          claimable.set(id, pipeline);
        }
      }
      if (claimable.size === 0) {
        return;
      }

      const job = this.options.jobs.claimNext({
        pipelineIds: [...claimable.keys()],
        now: new Date(),
      });
      if (job === null) {
        return;
      }

      const pipeline = claimable.get(job.pipelineId);
      if (pipeline === undefined) {
        // The pipeline changed between building the list and claiming. Put it back, and
        // give back the attempt with it — nothing was tried.
        this.options.jobs.update(job.id, {
          state: 'pending',
          startedAt: null,
          attempts: Math.max(0, job.attempts - 1),
        });
        return;
      }

      this.launch(job, pipeline, resolveDevice(pipeline, hardware).device);
    }
  }

  private launch(job: Job, pipeline: Pipeline, device: ResolvedDevice): void {
    const controller = new AbortController();
    this.running.set(job.id, {
      jobId: job.id,
      pipelineId: pipeline.id,
      device,
      controller,
    });

    this.options.events.publish(stamp({ type: 'job.upserted', job }));

    void this.options.executor
      .execute(job, pipeline, controller.signal)
      .catch((error: unknown) => {
        this.options.logger.error({ err: error, jobId: job.id }, 'Job executor threw');
      })
      .finally(() => {
        this.running.delete(job.id);
        this.publishPipelineStatus(pipeline);
      });
  }

  private eligiblePipelines(now: Date): Map<string, Pipeline> {
    const globallyPaused = this.options.isGloballyPaused();
    const runtimeReady = this.options.isRuntimeReady();
    const eligible = new Map<string, Pipeline>();

    for (const pipeline of this.options.pipelines.list()) {
      const verdict = isPipelineEligible(pipeline, { globallyPaused, now, runtimeReady });
      if (verdict.eligible) {
        eligible.set(pipeline.id, pipeline);
      }
    }
    return eligible;
  }

  private freeCapacity(capacity: Record<ResolvedDevice, number>): Record<ResolvedDevice, number> {
    let gpuInUse = 0;
    let cpuInUse = 0;
    for (const job of this.running.values()) {
      if (job.device === 'gpu') {
        gpuInUse += 1;
      } else {
        cpuInUse += 1;
      }
    }
    return {
      gpu: capacity.gpu - gpuInUse,
      cpu: capacity.cpu - cpuInUse,
    };
  }

  private publishPipelineStatus(pipeline: Pipeline): void {
    const stats = this.options.jobs.statsFor(pipeline.id);
    const running = [...this.running.values()].some((job) => job.pipelineId === pipeline.id);
    const verdict = isPipelineEligible(pipeline, {
      globallyPaused: this.options.isGloballyPaused(),
      now: new Date(),
      runtimeReady: this.options.isRuntimeReady(),
    });

    this.options.events.publish(
      stamp({
        type: 'pipeline.status',
        pipelineId: pipeline.id,
        status: running ? 'running' : verdict.eligible ? 'idle' : 'blocked',
        statusReason: verdict.reason,
        stats,
      }),
    );
  }
}
