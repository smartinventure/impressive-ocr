// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { absolutePathSchema } from './common';
import { engineProfileSchema, outputFormatSchema } from './pipeline-options';

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

/** The trimmed option set. Everything else comes from the pipeline defaults. */
export const quickOptionsSchema = z.object({
  formats: z.array(outputFormatSchema).min(1).default(['markdown', 'json']),
  profile: engineProfileSchema.default('fast'),
  language: z.string().min(2).max(16).default('en'),
  tableRecognition: z.boolean().default(true),
  formulaRecognition: z.boolean().default(false),
});

export type QuickOptions = z.infer<typeof quickOptionsSchema>;

export const startQuickRunRequestSchema = z
  .object({
    source: quickSourceKindSchema,
    /** Absolute file paths, for `server` runs. */
    files: z.array(absolutePathSchema).default([]),
    /** Identifier returned by the upload endpoint, for `upload` runs. */
    uploadId: z.string().min(1).optional(),
    /** Where results are written, for `server` runs. Upload runs always download. */
    outputPath: absolutePathSchema.optional(),
    options: quickOptionsSchema.default({}),
  })
  .refine((value) => value.source !== 'server' || value.files.length > 0, {
    message: 'Select at least one file.',
    path: ['files'],
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
