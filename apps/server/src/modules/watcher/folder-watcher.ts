// SPDX-License-Identifier: AGPL-3.0-or-later
import { basename, relative } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { SourceOptions } from '@impressive-ocr/shared';
import { readStability } from '../../infra/fs/file-ops';
import type { Logger } from '../../infra/logger';
import { beginTracking, looksTemporary, observe, type StabilityCandidate } from './file-stability';
import { matchesFilters } from './file-filters';

/**
 * Watches one pipeline's input folder and reports files once they are complete.
 *
 * Two things make this less trivial than "call chokidar":
 *
 * 1. A file that has just appeared may still be copying, so nothing is reported until it has
 *    stopped changing for the stability window.
 * 2. Network shares (UNC, NFS) do not deliver reliable filesystem events at all, so those
 *    have to be polled — which is why the watch mode is an explicit pipeline setting rather
 *    than something we try to guess.
 */

export interface FolderWatcherOptions {
  pipelineId: string;
  /** Already canonicalized and allowlist-checked. */
  inputPath: string;
  source: SourceOptions;
  logger: Logger;
  onFileReady: (file: DiscoveredFile) => void;
}

export interface DiscoveredFile {
  pipelineId: string;
  absolutePath: string;
  fileName: string;
  /** Path relative to the input folder, used to mirror the tree into the output folder. */
  relativePath: string;
  sizeBytes: number;
}

/** How often pending candidates are re-checked. Fast enough to feel instant, cheap enough to ignore. */
const SWEEP_INTERVAL_MS = 500;

export class FolderWatcher {
  private watcher: FSWatcher | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly pending = new Map<string, StabilityCandidate>();

  constructor(private readonly options: FolderWatcherOptions) {}

  start(): void {
    if (this.watcher !== null) {
      return;
    }
    const { source, inputPath } = this.options;

    this.watcher = chokidar.watch(inputPath, {
      persistent: true,
      // We run our own stability check, which understands the pipeline's window and can
      // report *why* a file is still waiting. chokidar's awaitWriteFinish would hide that.
      awaitWriteFinish: false,
      ignoreInitial: false,
      // Omitted entirely for a recursive watch — chokidar treats an absent depth as
      // unlimited but rejects an explicit undefined.
      ...(source.recursive ? {} : { depth: 0 }),
      usePolling: source.watchMode === 'polling',
      interval: source.pollIntervalMs,
      binaryInterval: source.pollIntervalMs,
    });

    this.watcher
      .on('add', (path) => this.consider(path))
      .on('change', (path) => this.consider(path))
      .on('unlink', (path) => this.pending.delete(path))
      .on('error', (error) => {
        this.options.logger.error(
          { err: error, pipelineId: this.options.pipelineId, inputPath },
          'Folder watcher error',
        );
      });

    this.sweepTimer = setInterval(() => {
      void this.sweep();
    }, SWEEP_INTERVAL_MS);

    this.options.logger.info(
      { pipelineId: this.options.pipelineId, inputPath, mode: source.watchMode },
      'Watching input folder',
    );
  }

  async stop(): Promise<void> {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.watcher !== null) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.pending.clear();
  }

  /** Files seen but still inside their stability window. Shown as "queued" in the UI. */
  get pendingCount(): number {
    return this.pending.size;
  }

  private async consider(absolutePath: string): Promise<void> {
    const fileName = basename(absolutePath);
    if (looksTemporary(fileName)) {
      return;
    }
    const relativePath = relative(this.options.inputPath, absolutePath);
    if (!matchesFilters(relativePath, this.options.source)) {
      return;
    }

    const stat = await readStability(absolutePath);
    if (stat === null) {
      return;
    }
    if (stat.sizeBytes > this.options.source.maxFileSizeBytes) {
      this.options.logger.warn(
        { pipelineId: this.options.pipelineId, fileName, sizeBytes: stat.sizeBytes },
        'Skipping file above the pipeline size limit',
      );
      return;
    }

    const existing = this.pending.get(absolutePath);
    this.pending.set(
      absolutePath,
      existing === undefined
        ? beginTracking(absolutePath, stat, Date.now())
        : observe(existing, stat, Date.now(), this.options.source.stabilityWindowMs).next,
    );
  }

  /** Re-stat every pending candidate and release the ones that have settled. */
  private async sweep(): Promise<void> {
    if (this.pending.size === 0) {
      return;
    }
    const now = Date.now();
    const window = this.options.source.stabilityWindowMs;

    for (const [path, candidate] of [...this.pending]) {
      const stat = await readStability(path);
      const { verdict, next } = observe(candidate, stat, now, window);

      if (verdict.kind === 'vanished') {
        this.pending.delete(path);
        continue;
      }
      if (verdict.kind !== 'stable') {
        this.pending.set(path, next);
        continue;
      }

      this.pending.delete(path);
      this.options.onFileReady({
        pipelineId: this.options.pipelineId,
        absolutePath: path,
        fileName: basename(path),
        relativePath: relative(this.options.inputPath, path),
        sizeBytes: next.last.sizeBytes,
      });
    }
  }
}
