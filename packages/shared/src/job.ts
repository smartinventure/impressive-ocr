// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { pipelineKindSchema } from './quick-run';
import { byteSizeSchema, idSchema, isoTimestampSchema, pageCountSchema } from './common';
import { outputFormatSchema, resolvedDeviceSchema } from './pipeline-options';

/**
 * Job lifecycle:
 *
 *   discovered → pending → running → succeeded
 *                   ↑         ↓
 *                   └──── failed ────→ quarantined   (after the final attempt)
 *
 * `discovered` covers the stability window: seen on disk but not yet confirmed stable.
 * On startup every `running` row is reset to `pending`; outputs are written to a temp
 * directory and moved atomically, so replaying a job is always safe.
 */
export const jobStateSchema = z.enum([
  'discovered',
  'pending',
  'running',
  'succeeded',
  'failed',
  'quarantined',
  'cancelled',
]);
export type JobState = z.infer<typeof jobStateSchema>;

export const TERMINAL_JOB_STATES = ['succeeded', 'quarantined', 'cancelled'] as const;

export const jobOutputSchema = z.object({
  format: outputFormatSchema,
  path: z.string().min(1),
  bytes: byteSizeSchema,
});

export type JobOutput = z.infer<typeof jobOutputSchema>;

export const jobSchema = z.object({
  id: idSchema,
  pipelineId: idSchema,
  sourcePath: z.string().min(1),
  /** Basename, precomputed so lists do not have to parse paths client-side. */
  fileName: z.string().min(1),
  sizeBytes: byteSizeSchema,
  /** SHA-256 of the source file; null until the stability check completes. */
  contentHash: z.string().length(64).nullable(),
  state: jobStateSchema,
  priority: z.number().int().min(0).max(9),
  attempts: z.number().int().min(0),
  pageCount: pageCountSchema.nullable(),
  pagesDone: pageCountSchema,
  deviceUsed: resolvedDeviceSchema.nullable(),
  /** Set when `auto` could not honour the preferred device, e.g. "GPU has 4 GB, needs 8 GB". */
  deviceFallbackReason: z.string().max(500).nullable(),
  errorCode: z.string().max(120).nullable(),
  errorMessage: z.string().max(2000).nullable(),
  outputs: z.array(jobOutputSchema).default([]),
  discoveredAt: isoTimestampSchema,
  startedAt: isoTimestampSchema.nullable(),
  finishedAt: isoTimestampSchema.nullable(),
  durationMs: z.number().int().min(0).nullable(),
});

export type Job = z.infer<typeof jobSchema>;

export const jobEventLevelSchema = z.enum(['debug', 'info', 'warning', 'error']);
export type JobEventLevel = z.infer<typeof jobEventLevelSchema>;

/** Append-only per-job timeline rendered in the job detail drawer. */
export const jobEventSchema = z.object({
  id: idSchema,
  jobId: idSchema,
  level: jobEventLevelSchema,
  message: z.string().max(2000),
  page: pageCountSchema.nullable(),
  createdAt: isoTimestampSchema,
});

export type JobEvent = z.infer<typeof jobEventSchema>;

/**
 * A job with its pipeline named, for the jobs table.
 *
 * Denormalized on the server rather than resolved in the browser: the client's pipeline list
 * deliberately excludes Quick Mode's hidden pipelines, so looking the name up there produced
 * a dash for exactly the runs a user most wants to find again.
 */
export const jobListItemSchema = jobSchema.extend({
  pipelineName: z.string(),
  pipelineKind: pipelineKindSchema,
});

export type JobListItem = z.infer<typeof jobListItemSchema>;

export const jobQuerySchema = z.object({
  pipelineId: idSchema.optional(),
  state: jobStateSchema.optional(),
  search: z.string().max(200).optional(),
});

export type JobQuery = z.infer<typeof jobQuerySchema>;
