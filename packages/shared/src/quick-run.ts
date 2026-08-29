// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { absolutePathSchema, byteSizeSchema } from './common';
import {
  devicePreferenceSchema,
  engineProfileSchema,
  outputFormatSchema,
  textLayerStrategySchema,
} from './pipeline-options';

/**
 * Quick Mode: OCR a handful of files once, without setting up a watched folder.
 *
 * A pipeline is the right shape for "watch this folder forever" and the wrong shape for "I
 * have three PDFs". Quick Mode is the second case, and nothing more — the pipeline editor
 * remains the place for the full option set.
 */

/**
 * What created a pipeline row.
 *
 * A Quick run is backed by a hidden pipeline so the queue, executor, retry and history all
 * work unchanged; this is what keeps it off the Pipelines screen and away from the watcher.
 */
export const pipelineKindSchema = z.enum(['watched', 'quick']);
export type PipelineKind = z.infer<typeof pipelineKindSchema>;

/**
 * Where a run's files come from, which also decides where its results go.
 *
 * `server` picks paths on the machine running the service and writes to a folder there.
 * `upload` sends bytes from the browser and gets a ZIP back — the only option that works when
 * the UI is not on the same machine as the server.
 */
export const quickSourceKindSchema = z.enum(['server', 'upload']);
export type QuickSourceKind = z.infer<typeof quickSourceKindSchema>;

export const quickRunStateSchema = z.enum(['preparing', 'running', 'completed', 'cancelled']);
export type QuickRunState = z.infer<typeof quickRunStateSchema>;

/**
 * File types the OCR engine can actually read.
 *
 * Mirrors `SUPPORTED_SUFFIXES` in `sidecar/.../pipeline/document.py`, which is the authority —
 * the sidecar rejects anything else outright. Declaring it here as well lets the UI filter the
 * picker and the upload dialog, so a user cannot queue a `.md` and find out only when the job
 * fails.
 */
export const PROCESSABLE_EXTENSIONS = [
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'bmp',
  'webp',
  'tif',
  'tiff',
] as const;

/** For a file input's `accept` attribute. */
export const PROCESSABLE_ACCEPT = PROCESSABLE_EXTENSIONS.map((item) => `.${item}`).join(',');

/** Whether a name looks processable. Case-insensitive, because `SCAN.PDF` is common. */
export function isProcessableFile(fileName: string): boolean {
  const match = /\.([A-Za-z0-9]+)$/.exec(fileName);
  if (match === null) return false;
  return (PROCESSABLE_EXTENSIONS as readonly string[]).includes(match[1]!.toLowerCase());
}

/** The trimmed option set. Everything else comes from the pipeline defaults. */
export const quickOptionsSchema = z.object({
  /**
   * What to do about pages that already carry extractable text.
   *
   * `hybrid` -- the default -- OCRs only the pages without a text layer, so a PDF that is
   * already digital costs almost nothing and a scan of the same length costs full price.
   * `skip-if-text` drops such documents entirely; `always-ocr` ignores the existing text,
   * which is what you want when the embedded layer is itself bad OCR from another tool.
   */
  textLayerStrategy: textLayerStrategySchema.default('hybrid'),
  /** One format minimum, Markdown by default — same rule as a pipeline. */
  formats: z.array(outputFormatSchema).min(1).default(['markdown']),
  profile: engineProfileSchema.default('fast'),
  /**
   * Which device to run on, exposed here as well as on a pipeline.
   *
   * Quick Mode is where someone compares the two: forcing the CPU for one run and the GPU for
   * the next, on the same file, is the only honest way to find out what the GPU is worth on
   * their own documents. `auto` keeps the scheduler's choice.
   */
  device: devicePreferenceSchema.default('auto'),
  /**
   * Off by default here, unlike a pipeline.
   *
   * Table recognition is not one model but five -- a table classifier, two structure models
   * and two cell detectors -- all resolved and made resident when the engine is constructed.
   * On a 16 GB laptop that is the difference between a process that fits in memory and one
   * that swaps. A pipeline processing thousands of invoices earns that cost back; someone
   * running three files once usually has not asked for it.
   */
  tableRecognition: z.boolean().default(false),
  formulaRecognition: z.boolean().default(false),
});

export type QuickOptions = z.infer<typeof quickOptionsSchema>;

export const startQuickRunRequestSchema = z
  .object({
    source: quickSourceKindSchema,
    /** Absolute file paths, for `server` runs that name their files individually. */
    files: z.array(absolutePathSchema).default([]),
    /**
     * A folder to take the files from instead, for `server` runs.
     *
     * Expanded on the server rather than in the browser: the picker cannot read a directory,
     * and the desktop's own dialog returns the folder rather than its contents. Not recursive
     * -- a Quick run is a one-off over a folder someone is looking at, and quietly walking a
     * tree of thousands is not what "run this folder" is asking for.
     */
    folderPath: absolutePathSchema.optional(),
    /**
     * Which file types to take from that folder, without the dot.
     *
     * Defaulted to everything the engine reads, so leaving it alone does the obvious thing.
     */
    extensions: z.array(z.string().min(1).max(10)).default([...PROCESSABLE_EXTENSIONS]),
    /** Identifier returned by the upload endpoint, for `upload` runs. */
    uploadId: z.string().min(1).optional(),
    /** Where results are written, for `server` runs. Upload runs always download. */
    outputPath: absolutePathSchema.optional(),
    options: quickOptionsSchema.default({}),
  })
  .refine(
    (value) =>
      value.source !== 'server' || value.files.length > 0 || value.folderPath !== undefined,
    {
      message: 'Select at least one file, or a folder to take them from.',
      path: ['files'],
    },
  )
  // One or the other, not both: two sources for one run would leave the count on screen
  // disagreeing with what actually ran.
  .refine((value) => value.folderPath === undefined || value.files.length === 0, {
    message: 'Choose either files or a folder, not both.',
    path: ['folderPath'],
  })
  .refine((value) => value.folderPath === undefined || value.extensions.length > 0, {
    message: 'Choose at least one file type.',
    path: ['extensions'],
  })
  .refine((value) => value.source !== 'server' || value.outputPath !== undefined, {
    message: 'Choose where the results should go.',
    path: ['outputPath'],
  })
  .refine((value) => value.source !== 'upload' || value.uploadId !== undefined, {
    message: 'Upload the files first.',
    path: ['uploadId'],
  });

export type StartQuickRunRequest = z.infer<typeof startQuickRunRequestSchema>;

/**
 * One file a run produced, offered on its own.
 *
 * A run of ten documents in four formats is forty files, and someone who wanted the Markdown
 * for one of them should not have to take a ZIP of the other thirty-nine. Identified by
 * `index` into the server's own ordered list rather than by path: the client never names a
 * file on disk, so there is nothing to traverse out of.
 */
export const quickRunFileSchema = z.object({
  index: z.number().int().min(0),
  /** Source document the file came from, without its extension. */
  documentName: z.string(),
  fileName: z.string(),
  format: outputFormatSchema,
  bytes: byteSizeSchema,
});

export type QuickRunFile = z.infer<typeof quickRunFileSchema>;

export const quickRunSchema = z.object({
  id: z.string(),
  /** The hidden pipeline backing this run; jobs are queried by it. */
  pipelineId: z.string(),
  source: quickSourceKindSchema,
  state: quickRunStateSchema,
  fileCount: z.number().int().min(0),
  /** Null for uploads, which are downloaded rather than written to a folder the user can open. */
  outputPath: z.string().nullable(),
  /** Whether there is anything to download yet. */
  downloadable: z.boolean(),
  createdAt: z.string(),
  /** When the results are swept. Null while the run is still going. */
  expiresAt: z.string().nullable(),
});

export type QuickRun = z.infer<typeof quickRunSchema>;

/**
 * How long finished results survive.
 *
 * Long enough that a closed tab or a failed download is recoverable, short enough that a
 * shared server does not accumulate other people's documents indefinitely. Uploaded *inputs*
 * are deleted as soon as their job finishes — the user already has those.
 */
export const QUICK_RESULT_RETENTION_HOURS = 24;

/** Per-file and per-request upload ceilings. */
export const QUICK_UPLOAD_MAX_FILE_BYTES = 512 * 1024 * 1024;
export const QUICK_UPLOAD_MAX_FILES = 100;
