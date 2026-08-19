// SPDX-License-Identifier: AGPL-3.0-or-later
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type {
  JobEventLevel,
  JobState,
  OutputFormat,
  ResolvedDevice,
} from '@impressive-ocr/shared';
import { pipelines } from './pipelines';

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    pipelineId: text('pipeline_id')
      .notNull()
      .references(() => pipelines.id, { onDelete: 'cascade' }),
    sourcePath: text('source_path').notNull(),
    fileName: text('file_name').notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    /** SHA-256; null until the stability check has read the file. */
    contentHash: text('content_hash'),
    state: text('state').$type<JobState>().notNull(),
    priority: integer('priority').notNull().default(5),
    attempts: integer('attempts').notNull().default(0),
    /** Earliest time a failed job may be retried; drives the backoff without a timer per job. */
    nextAttemptAt: text('next_attempt_at'),
    pageCount: integer('page_count'),
    pagesDone: integer('pages_done').notNull().default(0),
    deviceUsed: text('device_used').$type<ResolvedDevice>(),
    deviceFallbackReason: text('device_fallback_reason'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    discoveredAt: text('discovered_at').notNull(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    durationMs: integer('duration_ms'),
  },
  (table) => [
    /** The scheduler's hot path: next runnable job by priority, then arrival order. */
    index('jobs_state_priority_idx').on(table.state, table.priority, table.discoveredAt),
    index('jobs_pipeline_state_idx').on(table.pipelineId, table.state),
    index('jobs_finished_idx').on(table.finishedAt),
    /** A given file path is queued at most once per pipeline while still in flight. */
    uniqueIndex('jobs_pipeline_source_idx').on(table.pipelineId, table.sourcePath),
  ],
);

export type JobRow = typeof jobs.$inferSelect;
export type NewJobRow = typeof jobs.$inferInsert;

/** Append-only timeline. Pruned together with its job by the retention sweep. */
export const jobEvents = sqliteTable(
  'job_events',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    level: text('level').$type<JobEventLevel>().notNull(),
    message: text('message').notNull(),
    page: integer('page'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('job_events_job_idx').on(table.jobId, table.createdAt)],
);

export type JobEventRow = typeof jobEvents.$inferSelect;
export type NewJobEventRow = typeof jobEvents.$inferInsert;

export const jobOutputs = sqliteTable(
  'job_outputs',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    format: text('format').$type<OutputFormat>().notNull(),
    path: text('path').notNull(),
    bytes: integer('bytes').notNull().default(0),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('job_outputs_job_idx').on(table.jobId)],
);

export type JobOutputRow = typeof jobOutputs.$inferSelect;
export type NewJobOutputRow = typeof jobOutputs.$inferInsert;

/**
 * Content hashes this pipeline has already completed, kept after the job row is pruned so
 * `skipDuplicates` still works once history rolls over.
 */
export const processedHashes = sqliteTable(
  'processed_hashes',
  {
    pipelineId: text('pipeline_id')
      .notNull()
      .references(() => pipelines.id, { onDelete: 'cascade' }),
    contentHash: text('content_hash').notNull(),
    firstSeenAt: text('first_seen_at').notNull(),
  },
  (table) => [uniqueIndex('processed_hashes_idx').on(table.pipelineId, table.contentHash)],
);

export type ProcessedHashRow = typeof processedHashes.$inferSelect;
