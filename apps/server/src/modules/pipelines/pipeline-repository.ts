// SPDX-License-Identifier: AGPL-3.0-or-later
import { asc, eq } from 'drizzle-orm';
import { pipelines, type Database_, type PipelineRow } from '@impressive-ocr/db';
import { pipelineOptionsSchema, type Pipeline, type PipelineOptions } from '@impressive-ocr/shared';

/**
 * Persistence for pipelines. Pure storage — no validation, no filesystem access, no events.
 * Those belong to the service so this stays trivially testable against an in-memory database.
 */
export class PipelineRepository {
  constructor(private readonly db: Database_) {}

  /**
   * Every pipeline, hidden ones included.
   *
   * The scheduler and the watcher use this: a Quick run's jobs must still be picked up, so
   * filtering here would stop them ever executing.
   */
  listRows(): PipelineRow[] {
    return this.db.select().from(pipelines).orderBy(asc(pipelines.name)).all();
  }

  list(): Pipeline[] {
    return this.listRows().map(toPipeline);
  }

  /**
   * Pipelines the user configured, for the Pipelines screen.
   *
   * Quick runs are backed by a throwaway pipeline each; showing them would turn the list into
   * a log of every ad-hoc run.
   */
  listVisible(): Pipeline[] {
    return this.db
      .select()
      .from(pipelines)
      .where(eq(pipelines.kind, 'watched'))
      .orderBy(asc(pipelines.name))
      .all()
      .map(toPipeline);
  }

  find(id: string): Pipeline | null {
    const row = this.db.select().from(pipelines).where(eq(pipelines.id, id)).get();
    return row === undefined ? null : toPipeline(row);
  }

  insert(row: PipelineRow): Pipeline {
    this.db.insert(pipelines).values(row).run();
    return toPipeline(row);
  }

  update(id: string, changes: Partial<PipelineRow>): Pipeline | null {
    this.db.update(pipelines).set(changes).where(eq(pipelines.id, id)).run();
    return this.find(id);
  }

  /** Jobs cascade via the foreign key, so a delete takes the pipeline's history with it. */
  delete(id: string): boolean {
    const result = this.db.delete(pipelines).where(eq(pipelines.id, id)).run();
    return result.changes > 0;
  }

  nameExists(name: string, exceptId?: string): boolean {
    return this.listRows().some(
      (row) => row.name.toLowerCase() === name.toLowerCase() && row.id !== exceptId,
    );
  }
}

/**
 * Map a stored row to the domain type, re-validating the options JSON.
 *
 * Validating on read is what makes the JSON column safe: a database written by an older
 * release, or edited by hand, fills in new fields with their defaults instead of handing
 * the scheduler a half-shaped object.
 */
export function toPipeline(row: PipelineRow): Pipeline {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    // Rows written before Quick Mode have no value here; the column default covers new
    // inserts, this covers a database that predates the migration having ever run.
    kind: row.kind ?? 'watched',
    options: parseOptions(row.options),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseOptions(value: unknown): PipelineOptions {
  return pipelineOptionsSchema.parse(value);
}
