// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { idSchema, isoTimestampSchema, pageCountSchema } from './common';
import { jobEventSchema, jobSchema } from './job';
import { pipelineStatsSchema, pipelineStatusSchema, pipelineWithStatusSchema } from './pipeline';
import { runtimeStatusSchema, systemStatusSchema } from './system';

/**
 * Server → browser push over SSE. A discriminated union so the client can exhaustively
 * switch on `type` and the compiler catches a forgotten case when a new event is added.
 *
 * Events are advisory: the UI must stay correct if one is dropped (SSE reconnects lose
 * messages), so every screen also has a REST endpoint that returns full state.
 */
export const serverEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('pipeline.upserted'),
    at: isoTimestampSchema,
    pipeline: pipelineWithStatusSchema,
  }),
  z.object({
    type: z.literal('pipeline.deleted'),
    at: isoTimestampSchema,
    pipelineId: idSchema,
  }),
  z.object({
    type: z.literal('pipeline.status'),
    at: isoTimestampSchema,
    pipelineId: idSchema,
    status: pipelineStatusSchema,
    statusReason: z.string().max(500).nullable(),
    stats: pipelineStatsSchema,
  }),
  z.object({
    type: z.literal('job.upserted'),
    at: isoTimestampSchema,
    job: jobSchema,
  }),
  z.object({
    type: z.literal('job.progress'),
    at: isoTimestampSchema,
    jobId: idSchema,
    pipelineId: idSchema,
    pagesDone: pageCountSchema,
    pageCount: pageCountSchema.nullable(),
    pagesPerMinute: z.number().min(0).nullable(),
  }),
  z.object({
    type: z.literal('job.event'),
    at: isoTimestampSchema,
    event: jobEventSchema,
  }),
  z.object({
    type: z.literal('runtime.status'),
    at: isoTimestampSchema,
    runtime: runtimeStatusSchema,
  }),
  z.object({
    type: z.literal('system.status'),
    at: isoTimestampSchema,
    system: systemStatusSchema,
  }),
  z.object({
    type: z.literal('heartbeat'),
    at: isoTimestampSchema,
  }),
]);

export type ServerEvent = z.infer<typeof serverEventSchema>;
export type ServerEventType = ServerEvent['type'];

/** Narrow a `ServerEvent` to one variant — keeps `switch` handlers free of casts. */
export type ServerEventOf<TType extends ServerEventType> = Extract<ServerEvent, { type: TType }>;
