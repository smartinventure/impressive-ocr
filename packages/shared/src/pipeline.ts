// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { idSchema, isoTimestampSchema } from './common';
import { pipelineOptionsSchema } from './pipeline-options';
import { pipelineKindSchema } from './quick-run';

/**
 * `paused` is a user decision; `blocked` is the system's — no runtime installed, input folder
 * gone, outside the active-hours window. Keeping them apart means the UI can explain itself.
 */
export const pipelineStatusSchema = z.enum(['running', 'idle', 'paused', 'blocked', 'error']);
export type PipelineStatus = z.infer<typeof pipelineStatusSchema>;

export const pipelineSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(1000).default(''),
  enabled: z.boolean(),
  /**
   * Defaults to `watched` so every pipeline written before Quick Mode existed still parses.
   * See `pipelineKindSchema` for what a hidden one is for.
   */
  kind: pipelineKindSchema.default('watched'),
  options: pipelineOptionsSchema,
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});

export type Pipeline = z.infer<typeof pipelineSchema>;

/** Live counters the overview screen renders. Derived, never stored. */
export const pipelineStatsSchema = z.object({
  queued: z.number().int().min(0),
  running: z.number().int().min(0),
  succeeded: z.number().int().min(0),
  failed: z.number().int().min(0),
  quarantined: z.number().int().min(0),
  /** succeeded + failed + quarantined, i.e. everything this pipeline has finished with. */
  processed: z.number().int().min(0),
  total: z.number().int().min(0),
  pagesPerMinute: z.number().min(0).nullable(),
});

export type PipelineStats = z.infer<typeof pipelineStatsSchema>;

export const pipelineWithStatusSchema = pipelineSchema.extend({
  status: pipelineStatusSchema,
  /** Human-readable reason, present when status is `blocked` or `error`. */
  statusReason: z.string().max(500).nullable(),
  stats: pipelineStatsSchema,
});

export type PipelineWithStatus = z.infer<typeof pipelineWithStatusSchema>;

export const createPipelineRequestSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  enabled: z.boolean().default(true),
  options: pipelineOptionsSchema,
});

export type CreatePipelineRequest = z.infer<typeof createPipelineRequestSchema>;

export const updatePipelineRequestSchema = createPipelineRequestSchema.partial();

export type UpdatePipelineRequest = z.infer<typeof updatePipelineRequestSchema>;
