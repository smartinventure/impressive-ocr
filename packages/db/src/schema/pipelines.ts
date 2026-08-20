// SPDX-License-Identifier: AGPL-3.0-or-later
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { PipelineKind, PipelineOptions } from '@impressive-ocr/shared';

/**
 * A pipeline is user configuration only — no runtime state. Status and counters are derived
 * from `jobs` at read time so a crash can never leave a stale "running" flag behind.
 *
 * `options` is stored as one JSON document rather than ~30 columns: the option set changes
 * every release, and every read validates it against `pipelineOptionsSchema` anyway.
 */
export const pipelines = sqliteTable(
  'pipelines',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /**
     * What created this pipeline.
     *
     * `quick` rows back a single Quick Mode run: they carry that run's options so the whole
     * queue, executor, retry and history path works unchanged, but they have no folder to
     * watch and never appear on the Pipelines screen. Jobs require a pipeline — the foreign
     * key is `NOT NULL` — so a hidden one is far cheaper than making it nullable and teaching
     * every consumer about jobs that belong to nothing.
     */
    kind: text('kind').$type<PipelineKind>().notNull().default('watched'),
    options: text('options', { mode: 'json' }).$type<PipelineOptions>().notNull(),
    /** Denormalized from options.schedule.priority so the scheduler can sort without parsing JSON. */
    priority: integer('priority').notNull().default(5),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('pipelines_enabled_priority_idx').on(table.enabled, table.priority),
    index('pipelines_name_idx').on(table.name),
  ],
);

export type PipelineRow = typeof pipelines.$inferSelect;
export type NewPipelineRow = typeof pipelines.$inferInsert;
