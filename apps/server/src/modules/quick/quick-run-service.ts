// SPDX-License-Identifier: AGPL-3.0-or-later
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  draftPipelineOptions,
  quickRunSchema,
  type QuickOptions,
  type QuickRun,
  type QuickSourceKind,
  type PipelineOptions,
} from '@impressive-ocr/shared';
import { createId } from '../../infra/ids';
import type { Logger } from '../../infra/logger';
import type { EventBus } from '../events/event-bus';
import type { PipelineRepository } from '../pipelines/pipeline-repository';
import type { JobRepository, QuickOutputRow } from '../queue/job-repository';
import type { SettingsService } from '../settings/settings-service';
import type { QuickRunStore } from './quick-run-store';

/**
 * Runs a handful of files through OCR once, without setting up a watched folder.
 *
 * Each run is backed by a **hidden pipeline**. `jobs.pipelineId` is `NOT NULL` with a foreign
 * key, and the scheduler, executor, retry policy and history all hang off pipelines — making
 * it nullable would ripple through every one of them so that Quick Mode could avoid a single
 * row. A hidden pipeline costs one insert and reuses the entire execution path, so a Quick
 * job retries, reports progress and appears in history exactly like any other.
 *
 * The pipeline has no input folder to watch: `WatcherManager` skips `kind === 'quick'`, and
 * files are enqueued directly here.
 */

export interface QuickRunServiceOptions {
  pipelines: PipelineRepository;
  jobs: JobRepository;
  settings: SettingsService;
  store: QuickRunStore;
  events: EventBus;
  logger: Logger;
  /** Canonicalize and authorise a path, exactly as the pipeline editor does. */
  resolveFolder: (path: string, mustExist: boolean) => Promise<string>;
}

export class QuickRunError extends Error {
  constructor(
    message: string,
    readonly reason: 'no-files' | 'not-found' | 'unreadable',
  ) {
    super(message);
    this.name = 'QuickRunError';
  }
}

export interface StartRunRequest {
  source: QuickSourceKind;
  /** Absolute paths. For uploads these are the staged copies. */
  files: readonly string[];
  /** Where results go. Null for uploads, which are downloaded instead. */
  outputPath: string | null;
  options: QuickOptions;
  /** Reuse the directory the upload was staged into, so inputs can be cleaned up later. */
  runId?: string;
}

export class QuickRunService {
  constructor(private readonly options: QuickRunServiceOptions) {}

  async start(request: StartRunRequest): Promise<QuickRun> {
    if (request.files.length === 0) {
      throw new QuickRunError('Select at least one file.', 'no-files');
    }

    const runId = request.runId ?? createId();
    const now = new Date().toISOString();

    // Uploads land in a run-scoped directory that already exists; server-picked runs write to
    // a folder the user chose, which is validated the same way a pipeline's would be.
    const outputPath =
      request.outputPath === null
        ? this.options.store.directoriesFor(runId).outputDir
        : await this.options.resolveFolder(request.outputPath, false);

    const pipeline = this.options.pipelines.insert({
      id: createId(),
      // Named for the run rather than by the user: it never appears in a list to choose from.
      name: `Quick run ${now}`,
      description: '',
      enabled: true,
      kind: 'quick',
      options: buildOptions(request.options, outputPath),
      priority: QUICK_PRIORITY,
      createdAt: now,
      updatedAt: now,
    });

    let queued = 0;
    for (const file of request.files) {
      const size = await sizeOf(file);
      if (size === null) {
        this.options.logger.warn({ file }, 'Skipping a Quick Mode file that could not be read');
        continue;
      }

      this.options.jobs.insert({
        id: createId(),
        pipelineId: pipeline.id,
        sourcePath: file,
        fileName: basename(file),
        sizeBytes: size,
        contentHash: null,
        state: 'pending',
        priority: QUICK_PRIORITY,
        attempts: 0,
        pagesDone: 0,
        discoveredAt: new Date().toISOString(),
      });
      queued += 1;
    }

    if (queued === 0) {
      // Nothing to do, and a hidden pipeline with no jobs would linger forever.
      this.options.pipelines.delete(pipeline.id);
      throw new QuickRunError('None of the selected files could be read.', 'unreadable');
    }

    this.options.logger.info({ runId, queued, source: request.source }, 'Quick run started');

    return quickRunSchema.parse({
      id: runId,
      pipelineId: pipeline.id,
      source: request.source,
      state: 'running',
      fileCount: queued,
      outputPath: request.source === 'upload' ? null : outputPath,
      downloadable: false,
      createdAt: now,
      expiresAt: null,
    });
  }

  /**
   * Stop a run.
   *
   * Pending jobs are dropped outright; a job already running is left to the executor's
   * `AbortSignal`, which is what guarantees no half-written output survives — outputs are
   * only moved out of the work directory on success.
   */
  cancel(pipelineId: string): number {
    const cancelled = this.options.jobs.cancelPendingFor(pipelineId);
    this.options.logger.info({ pipelineId, cancelled }, 'Quick run cancelled');
    return cancelled;
  }

  /** Absolute paths of everything a run produced, for the archive. */
  outputsFor(pipelineId: string): QuickOutputRow[] {
    return this.options.jobs.outputsForPipeline(pipelineId);
  }

  /**
   * Called when any job finishes; drops a completed run's uploaded inputs.
   *
   * Uploaded documents are the user's own data sitting on a machine that may not be theirs.
   * They have served their purpose the moment the last job for the run is done, and the user
   * already has the originals — so they go immediately rather than waiting for the retention
   * sweep that the *results* need.
   *
   * Server-picked runs own nothing to clean up: their inputs were never copied.
   */
  async onJobFinished(pipelineId: string, runId: string): Promise<void> {
    const pipeline = this.options.pipelines.find(pipelineId);
    if (pipeline === null || pipeline.kind !== 'quick') return;

    const stats = this.options.jobs.statsFor(pipelineId);
    if (stats.queued > 0 || stats.running > 0) return;

    await this.options.store.discardInputs(runId);
  }
}

/**
 * Quick runs jump the queue.
 *
 * Someone watching a progress bar for three files should not wait behind a backfill of ten
 * thousand. Watched pipelines default to 5.
 */
const QUICK_PRIORITY = 8;

/**
 * Fold the trimmed Quick options into a full pipeline option set.
 *
 * `draftPipelineOptions` supplies the ~30 defaults so there is no second copy to drift, and
 * the source folder is irrelevant — nothing watches a Quick pipeline.
 */
function buildOptions(quick: QuickOptions, outputPath: string): PipelineOptions {
  const defaults = draftPipelineOptions();

  return {
    ...defaults,
    textLayerStrategy: quick.textLayerStrategy,
    source: {
      ...defaults.source,
      // Nothing watches a Quick pipeline, so this is only a base for the output mover's
      // relative-path maths. Mirroring is off because Quick files come from anywhere the user
      // points at: relative() would produce `..` segments and walk the results back out of
      // the folder they chose.
      inputPath: outputPath,
      mirrorFolderStructure: false,
    },
    engine: {
      ...defaults.engine,
      profile: quick.profile,
      device: quick.device,
      modules: {
        ...defaults.engine.modules,
        tableRecognition: quick.tableRecognition,
        formulaRecognition: quick.formulaRecognition,
      },
    },
    output: { ...defaults.output, outputPath, formats: quick.formats },
    // Never touch the user's originals. In server mode they are files the user picked from
    // their own disk; deleting or moving them would be indefensible for a one-off run.
    postProcessing: { ...defaults.postProcessing, onSuccess: 'keep' },
    schedule: { ...defaults.schedule, priority: QUICK_PRIORITY },
  };
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}
