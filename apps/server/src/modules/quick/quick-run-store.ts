// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { QUICK_RESULT_RETENTION_HOURS } from '@impressive-ocr/shared';
import { ensureDirectory } from '../../infra/fs/file-ops';
import type { Logger } from '../../infra/logger';

/**
 * Scratch space for Quick Mode runs that upload their files.
 *
 * Uploaded documents are the user's own data sitting on a machine that may not be theirs, so
 * the lifetime rules are deliberately asymmetric:
 *
 * - **Inputs** are deleted the moment their job finishes. The user already has them, and
 *   keeping a copy afterwards serves nobody.
 * - **Results** survive a fixed window so a closed tab or a failed download is recoverable,
 *   then go. Without that a shared server slowly fills with other people's documents.
 *
 * A run that picked files from the server's own filesystem uses none of this: its inputs were
 * never copied and its outputs go straight to the folder the user chose.
 */

export interface QuickRunStoreOptions {
  /** Root for run directories, under the app's data directory. */
  root: string;
  logger: Logger;
  /** Injectable so retention can be tested without waiting a day. */
  now?: () => Date;
}

export interface RunDirectories {
  runDir: string;
  inputDir: string;
  outputDir: string;
}

export class QuickRunStore {
  private readonly now: () => Date;

  constructor(private readonly options: QuickRunStoreOptions) {
    this.now = options.now ?? ((): Date => new Date());
  }

  directoriesFor(runId: string): RunDirectories {
    const runDir = join(this.options.root, runId);
    return { runDir, inputDir: join(runDir, 'in'), outputDir: join(runDir, 'out') };
  }

  async create(runId: string): Promise<RunDirectories> {
    const directories = this.directoriesFor(runId);
    await ensureDirectory(directories.inputDir);
    await ensureDirectory(directories.outputDir);
    return directories;
  }

  /**
   * Drop a run's uploaded inputs, keeping its results.
   *
   * Called as soon as the last job for the run finishes.
   */
  async discardInputs(runId: string): Promise<void> {
    const { inputDir } = this.directoriesFor(runId);
    try {
      await rm(inputDir, { recursive: true, force: true });
    } catch (error) {
      // Not worth failing a completed run over; the sweeper will take the whole directory.
      this.options.logger.warn({ err: error, runId }, 'Could not remove Quick Mode inputs');
    }
  }

  /** Remove a run entirely — used by cancel, and by the sweeper. */
  async discard(runId: string): Promise<void> {
    const { runDir } = this.directoriesFor(runId);
    try {
      await rm(runDir, { recursive: true, force: true });
    } catch (error) {
      this.options.logger.warn({ err: error, runId }, 'Could not remove Quick Mode run directory');
    }
  }

  /** When a run finishing now would be swept. */
  expiryFrom(finishedAt: Date): Date {
    return new Date(finishedAt.getTime() + QUICK_RESULT_RETENTION_HOURS * 60 * 60 * 1000);
  }

  /**
   * Delete run directories older than the retention window.
   *
   * Driven by directory mtime rather than by a database column, so a run whose row was lost —
   * a crash mid-write, a pruned history — still gets cleaned up instead of leaking forever.
   */
  async sweep(): Promise<number> {
    const cutoff = this.now().getTime() - QUICK_RESULT_RETENTION_HOURS * 60 * 60 * 1000;

    let entries: string[];
    try {
      entries = await readdir(this.options.root);
    } catch {
      // Nothing has run yet; the root is created on first use.
      return 0;
    }

    let removed = 0;
    for (const entry of entries) {
      const runDir = join(this.options.root, entry);
      try {
        const info = await stat(runDir);
        if (!info.isDirectory() || info.mtimeMs >= cutoff) continue;

        await rm(runDir, { recursive: true, force: true });
        removed += 1;
      } catch (error) {
        this.options.logger.warn({ err: error, runDir }, 'Could not sweep Quick Mode run');
      }
    }

    if (removed > 0) {
      this.options.logger.info({ removed }, 'Swept expired Quick Mode runs');
    }
    return removed;
  }
}
