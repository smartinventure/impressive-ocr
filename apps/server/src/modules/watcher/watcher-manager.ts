// SPDX-License-Identifier: AGPL-3.0-or-later
import { basename } from 'node:path';
import type { Pipeline } from '@impressive-ocr/shared';
import { hashFile } from '../../infra/fs/file-ops';
import { createId } from '../../infra/ids';
import type { Logger } from '../../infra/logger';
import { type EventBus, stamp } from '../events/event-bus';
import type { PipelineRepository } from '../pipelines/pipeline-repository';
import type { JobRepository } from '../queue/job-repository';
import { FolderWatcher, type DiscoveredFile } from './folder-watcher';

/**
 * Keeps one :class:`FolderWatcher` per pipeline, in sync with the pipeline list.
 *
 * Watchers are recreated when a pipeline's source options change: chokidar cannot be
 * reconfigured in place, and quietly keeping a watcher on an old folder would be worse than
 * a brief gap while it restarts.
 */

export interface WatcherManagerOptions {
  pipelines: PipelineRepository;
  jobs: JobRepository;
  events: EventBus;
  logger: Logger;
}

export class WatcherManager {
  private readonly watchers = new Map<string, { watcher: FolderWatcher; fingerprint: string }>();
  private stopped = false;

  constructor(private readonly options: WatcherManagerOptions) {}

  /**
   * Bring the running watchers in line with the current pipelines.
   *
   * Called on startup and after any pipeline change. Idempotent, so calling it more often
   * than strictly necessary is safe and cheap.
   */
  async sync(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const pipelines = this.options.pipelines.list();
    const wanted = new Set<string>();

    for (const pipeline of pipelines) {
      wanted.add(pipeline.id);
      const fingerprint = fingerprintOf(pipeline);
      const existing = this.watchers.get(pipeline.id);

      if (existing !== undefined && existing.fingerprint === fingerprint) {
        continue;
      }
      if (existing !== undefined) {
        await existing.watcher.stop();
      }
      this.startWatcher(pipeline, fingerprint);
    }

    for (const [pipelineId, entry] of [...this.watchers]) {
      if (!wanted.has(pipelineId)) {
        await entry.watcher.stop();
        this.watchers.delete(pipelineId);
      }
    }
  }

  private startWatcher(pipeline: Pipeline, fingerprint: string): void {
    const watcher = new FolderWatcher({
      pipelineId: pipeline.id,
      inputPath: pipeline.options.source.inputPath,
      source: pipeline.options.source,
      logger: this.options.logger,
      onFileReady: (file) => {
        void this.enqueue(pipeline, file);
      },
    });

    watcher.start();
    this.watchers.set(pipeline.id, { watcher, fingerprint });
  }

  /**
   * Turn a settled file into a queued job.
   *
   * Watchers keep running while a pipeline is paused — the queue is where pausing takes
   * effect. That way a user who pauses for an hour comes back to a full queue rather than an
   * hour of files the app never noticed.
   */
  private async enqueue(pipeline: Pipeline, file: DiscoveredFile): Promise<void> {
    const { jobs, logger } = this.options;

    if (jobs.hasActiveJobForPath(pipeline.id, file.absolutePath)) {
      return;
    }

    let contentHash: string | null = null;
    if (pipeline.options.source.skipDuplicates) {
      try {
        contentHash = await hashFile(file.absolutePath);
      } catch (error) {
        logger.warn(
          { err: error, path: file.absolutePath },
          'Could not hash file; queueing anyway',
        );
      }
      if (contentHash !== null && jobs.hasSeenHash(pipeline.id, contentHash)) {
        logger.info(
          { pipelineId: pipeline.id, fileName: file.fileName },
          'Skipping a duplicate this pipeline has already processed',
        );
        return;
      }
    }

    const job = jobs.insert({
      id: createId(),
      pipelineId: pipeline.id,
      sourcePath: file.absolutePath,
      fileName: basename(file.absolutePath),
      sizeBytes: file.sizeBytes,
      contentHash,
      state: 'pending',
      priority: pipeline.options.schedule.priority,
      attempts: 0,
      pagesDone: 0,
      discoveredAt: new Date().toISOString(),
    });

    this.options.events.publish(stamp({ type: 'job.upserted', job }));
  }

  /** Files seen but still inside their stability window, across all pipelines. */
  pendingCount(): number {
    let total = 0;
    for (const entry of this.watchers.values()) {
      total += entry.watcher.pendingCount;
    }
    return total;
  }

  async stopAll(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.watchers.values()].map((entry) => entry.watcher.stop()));
    this.watchers.clear();
  }
}

/**
 * Identifies the watcher-relevant part of a pipeline's configuration.
 *
 * Only the source options matter: changing the output format must not tear down and rebuild
 * a watcher, which on a large network share can take seconds and would drop events.
 */
export function fingerprintOf(pipeline: Pipeline): string {
  return JSON.stringify(pipeline.options.source);
}
