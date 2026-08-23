// SPDX-License-Identifier: AGPL-3.0-or-later
import { dirname, join, relative } from 'node:path';
import type {
  HardwareCapabilities,
  Job,
  JobEventLevel,
  OutputFormat,
  Pipeline,
  SidecarJobRequest,
} from '@impressive-ocr/shared';
import { ensureDirectory } from '../../infra/fs/file-ops';
import { createId } from '../../infra/ids';
import type { Logger } from '../../infra/logger';
import { type EventBus, stamp } from '../events/event-bus';
import type { SidecarPool } from '../ocr/sidecar-pool';
import { sourceStemOf } from '../outputs/naming-template';
import { applyPostAction, cleanWorkDir, moveOutputs } from '../outputs/output-mover';
import type { JobRepository } from './job-repository';
import { canRetry, nextAttemptAt, resolveDevice } from './scheduling-policy';

/**
 * Runs one claimed job from start to finish.
 *
 * Kept separate from the scheduler so the two concerns stay testable apart: the scheduler
 * decides *what* runs next, this decides what happens *to* one job — including the two
 * outcomes that matter most, retry versus quarantine.
 */

export interface JobExecutorOptions {
  jobs: JobRepository;
  pool: SidecarPool;
  events: EventBus;
  logger: Logger;
  workRoot: string;
  hardware: () => HardwareCapabilities;
}

export class JobExecutor {
  constructor(private readonly options: JobExecutorOptions) {}

  async execute(job: Job, pipeline: Pipeline, signal: AbortSignal): Promise<void> {
    const { logger } = this.options;
    const resolution = resolveDevice(pipeline, this.options.hardware());
    const workDir = join(this.options.workRoot, job.id);
    const outputStem = sourceStemOf(job.sourcePath);
    const startedAt = Date.now();

    this.options.jobs.update(job.id, {
      deviceUsed: resolution.device,
      deviceFallbackReason: resolution.fallbackReason,
    });
    if (resolution.fallbackReason !== null) {
      this.record(job, 'warning', resolution.fallbackReason);
    }

    try {
      await ensureDirectory(workDir);

      const request: SidecarJobRequest = {
        jobId: job.id,
        sourcePath: job.sourcePath,
        workDir,
        outputStem,
        profile: resolution.profile,
        device: resolution.device,
        engine: pipeline.options.engine,
        textLayerStrategy: pipeline.options.textLayerStrategy,
        formats: pipeline.options.output.formats,
        txtEncoding: pipeline.options.output.txtEncoding,
      };

      const produced = await this.stream(job, pipeline, request, resolution.profile, signal);
      await this.finish(job, pipeline, workDir, outputStem, produced, startedAt);
    } catch (error) {
      await this.fail(job, pipeline, error);
    } finally {
      this.options.pool.release(resolution.profile, resolution.device);
      await cleanWorkDir(workDir, logger);
    }
  }

  /**
   * Consume the sidecar's NDJSON stream, updating the job as it goes.
   *
   * Progress is written to the database *and* published as an event: the event drives the
   * live UI, and the database row is what a browser that just connected reads. Relying on
   * events alone would leave a reloaded page showing a stalled progress bar.
   */
  private async stream(
    job: Job,
    pipeline: Pipeline,
    request: SidecarJobRequest,
    profile: SidecarJobRequest['profile'],
    signal: AbortSignal,
  ): Promise<{ format: OutputFormat; relativePath: string }[]> {
    const client = await this.options.pool.acquire(profile, request.device);
    const produced: { format: OutputFormat; relativePath: string }[] = [];
    let pageCount: number | null = null;
    let pagesDone = 0;

    for await (const message of client.runJob(request, signal)) {
      switch (message.type) {
        case 'accepted':
          pageCount = message.pageCount;
          this.options.jobs.update(job.id, { pageCount: message.pageCount });
          break;

        case 'page': {
          pagesDone = message.page;
          pageCount = message.pageCount;
          this.options.jobs.update(job.id, { pagesDone, pageCount });
          this.options.events.publish(
            stamp({
              type: 'job.progress',
              jobId: job.id,
              pipelineId: pipeline.id,
              pagesDone,
              pageCount,
              pagesPerMinute: null,
            }),
          );
          break;
        }

        case 'log':
          this.record(job, message.level, message.message, message.page);
          break;

        case 'output':
          produced.push({ format: message.format, relativePath: message.path });
          break;

        case 'done':
          this.options.jobs.update(job.id, { pageCount: message.pageCount ?? pageCount });
          break;

        case 'error':
          throw new SidecarJobError(message.code, message.message, message.retryable);
      }
    }

    return produced;
  }

  /** Move outputs into place, tidy the source, and mark the job succeeded. */
  private async finish(
    job: Job,
    pipeline: Pipeline,
    workDir: string,
    outputStem: string,
    produced: { format: OutputFormat; relativePath: string }[],
    startedAt: number,
  ): Promise<void> {
    const { source, output, postProcessing } = pipeline.options;

    const relativeDirectory = source.mirrorFolderStructure
      ? dirname(relative(source.inputPath, job.sourcePath)).replace(/^\.$/, '')
      : '';

    const moved = await moveOutputs(produced, {
      workDir,
      outputRoot: output.outputPath,
      relativeDirectory,
      outputStem,
      output,
      logger: this.options.logger,
    });

    for (const file of moved) {
      this.options.jobs.recordOutput(job.id, file.format, file.path, file.bytes);
    }

    await applyPostAction({
      sourcePath: job.sourcePath,
      inputRoot: source.inputPath,
      outputRoot: output.outputPath,
      archivePath: postProcessing.archivePath,
      action: postProcessing.onSuccess,
      logger: this.options.logger,
    });

    if (job.contentHash !== null && source.skipDuplicates) {
      this.options.jobs.rememberHash(pipeline.id, job.contentHash);
    }

    const finished = this.options.jobs.update(job.id, {
      state: 'succeeded',
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    });

    this.options.logger.info(
      { jobId: job.id, pipelineId: pipeline.id, outputs: moved.length },
      'Job succeeded',
    );
    if (finished !== null) {
      this.options.events.publish(stamp({ type: 'job.upserted', job: finished }));
    }
  }

  /**
   * Decide between a retry and quarantine.
   *
   * A corrupt PDF will still be corrupt in thirty seconds, so retrying it only blocks the
   * queue behind a file that can never succeed. A GPU that was briefly out of memory, or a
   * network share that blinked, is the opposite. That is why the sidecar reports a
   * `retryable` flag rather than leaving the backend to guess from an error string.
   */
  private async fail(job: Job, pipeline: Pipeline, error: unknown): Promise<void> {
    const { code, message, retryable } = describeFailure(error);
    const attempts = job.attempts;
    const maxAttempts = pipeline.options.reliability.maxAttempts;
    const now = new Date();

    this.record(job, 'error', message);

    if (canRetry(attempts, maxAttempts, retryable)) {
      const retryAt = nextAttemptAt(attempts, pipeline.options.reliability.retryBackoffMs, now);
      const updated = this.options.jobs.update(job.id, {
        state: 'pending',
        errorCode: code,
        errorMessage: message,
        nextAttemptAt: retryAt.toISOString(),
        startedAt: null,
      });
      this.options.logger.warn(
        { jobId: job.id, attempts, maxAttempts, retryAt: retryAt.toISOString(), code },
        'Job failed; scheduled for retry',
      );
      if (updated !== null) {
        this.options.events.publish(stamp({ type: 'job.upserted', job: updated }));
      }
      return;
    }

    const updated = this.options.jobs.update(job.id, {
      state: 'quarantined',
      errorCode: code,
      errorMessage: message,
      finishedAt: now.toISOString(),
    });

    this.options.logger.error({ jobId: job.id, attempts, code, retryable }, 'Job quarantined');

    await this.quarantineSource(job, pipeline);

    if (updated !== null) {
      this.options.events.publish(stamp({ type: 'job.upserted', job: updated }));
    }
  }

  /**
   * Move a permanently failed file out of the input folder.
   *
   * Without this the watcher would rediscover it on every restart, and the same failure
   * would fill the log forever.
   */
  private async quarantineSource(job: Job, pipeline: Pipeline): Promise<void> {
    const quarantinePath = pipeline.options.reliability.quarantinePath;
    if (quarantinePath === undefined) {
      return;
    }
    await applyPostAction({
      sourcePath: job.sourcePath,
      inputRoot: pipeline.options.source.inputPath,
      outputRoot: quarantinePath,
      archivePath: quarantinePath,
      action: 'move-to-archive',
      logger: this.options.logger,
    });
  }

  private record(job: Job, level: JobEventLevel, message: string, page?: number | null): void {
    const event = this.options.jobs.addEvent({
      jobId: job.id,
      level,
      message,
      page: page ?? null,
      createdAt: new Date().toISOString(),
    });
    this.options.events.publish(stamp({ type: 'job.event', event }));
  }
}

/** An error the sidecar reported over the stream, carrying its retry decision. */
export class SidecarJobError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'SidecarJobError';
  }
}

/**
 * Normalise any thrown value into a code, a message and a retry decision.
 *
 * Exported for testing. The default for an unrecognised error is *retryable*: an unknown
 * fault is more likely to be transient infrastructure than a permanently broken document,
 * and a wrongly-quarantined file is worse for a user than a wasted retry.
 */
export function describeFailure(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof SidecarJobError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return { code: 'cancelled', message: 'Job cancelled', retryable: true };
    }
    return { code: 'internal-error', message: error.message, retryable: true };
  }
  return { code: 'internal-error', message: String(error), retryable: true };
}

/** Unique scratch directory for a job. Exported so tests can predict it. */
export function workDirFor(workRoot: string, jobId: string): string {
  return join(workRoot, jobId);
}

export { createId };
