// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import {
  jobEvents,
  jobOutputs,
  jobs,
  processedHashes,
  type Database_,
  type JobRow,
  type NewJobRow,
} from '@impressive-ocr/db';
import type { Job, JobEvent, JobState, OutputFormat, PipelineStats } from '@impressive-ocr/shared';
import { createId } from '../../infra/ids';

/**
 * Persistence for the job queue.
 *
 * The claim path is the only genuinely subtle part: it must hand the same job to exactly one
 * worker even though the scheduler may be asked for work from several places at once.
 */

export interface ClaimCriteria {
  /** Pipelines currently eligible — enabled, not paused, inside their active hours. */
  pipelineIds: readonly string[];
  now: Date;
}

/** One produced file, with enough about it to offer as its own download. */
export interface QuickOutputRow {
  path: string;
  /** Source document without its extension, so results group by document. */
  documentName: string;
  format: OutputFormat;
  bytes: number;
}

export class JobRepository {
  constructor(private readonly db: Database_) {}

  /**
   * Atomically take the next runnable job.
   *
   * Select-then-update inside one transaction: better-sqlite3 is synchronous and SQLite
   * serialises writers, so nothing can interleave between the two statements. Doing it in
   * two separate calls would let two workers claim the same file and write the same output
   * twice.
   */
  claimNext(criteria: ClaimCriteria): Job | null {
    if (criteria.pipelineIds.length === 0) {
      return null;
    }
    const nowIso = criteria.now.toISOString();

    return this.db.transaction((tx) => {
      const candidate = tx
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.state, 'pending'),
            inArray(jobs.pipelineId, [...criteria.pipelineIds]),
            // A failed job waits out its backoff before becoming eligible again.
            or(isNull(jobs.nextAttemptAt), lte(jobs.nextAttemptAt, nowIso)),
          ),
        )
        // Highest priority first, then arrival order. Job ids are time-prefixed, so
        // discoveredAt plus id is a total, stable ordering with no ties.
        .orderBy(desc(jobs.priority), jobs.discoveredAt, jobs.id)
        .limit(1)
        .get();

      if (candidate === undefined) {
        return null;
      }

      tx.update(jobs)
        .set({
          state: 'running',
          startedAt: nowIso,
          attempts: candidate.attempts + 1,
          errorCode: null,
          errorMessage: null,
        })
        .where(eq(jobs.id, candidate.id))
        .run();

      return this.toJob({
        ...candidate,
        state: 'running',
        startedAt: nowIso,
        attempts: candidate.attempts + 1,
      });
    });
  }

  insert(row: NewJobRow): Job {
    this.db.insert(jobs).values(row).run();
    const stored = this.db.select().from(jobs).where(eq(jobs.id, row.id)).get();
    if (stored === undefined) {
      throw new Error(`Job ${row.id} vanished immediately after insert`);
    }
    return this.toJob(stored);
  }

  find(id: string): Job | null {
    const row = this.db.select().from(jobs).where(eq(jobs.id, id)).get();
    return row === undefined ? null : this.toJob(row);
  }

  update(id: string, changes: Partial<JobRow>): Job | null {
    this.db.update(jobs).set(changes).where(eq(jobs.id, id)).run();
    return this.find(id);
  }

  /** True when this exact path is already queued or running for the pipeline. */
  hasActiveJobForPath(pipelineId: string, sourcePath: string): boolean {
    const row = this.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.pipelineId, pipelineId), eq(jobs.sourcePath, sourcePath)))
      .get();
    return row !== undefined;
  }

  /**
   * Reset orphaned work left behind by a crash.
   *
   * Safe to replay because outputs are written to a temp directory and moved into place only
   * on success — a killed job leaves nothing behind for the user to trip over.
   */
  requeueRunning(): number {
    const result = this.db
      .update(jobs)
      .set({ state: 'pending', startedAt: null })
      .where(eq(jobs.state, 'running'))
      .run();
    return result.changes;
  }

  statsFor(pipelineId: string): PipelineStats {
    const rows = this.db
      .select({ state: jobs.state, total: count() })
      .from(jobs)
      .where(eq(jobs.pipelineId, pipelineId))
      .groupBy(jobs.state)
      .all();

    const byState = new Map<JobState, number>(rows.map((row) => [row.state, row.total]));
    const value = (state: JobState): number => byState.get(state) ?? 0;

    const succeeded = value('succeeded');
    const failed = value('failed');
    const quarantined = value('quarantined');

    return {
      // `discovered` files are still inside their stability window but already visible to
      // the user in the input folder, so they count as queued rather than disappearing.
      queued: value('pending') + value('discovered'),
      running: value('running'),
      succeeded,
      failed,
      quarantined,
      processed: succeeded + failed + quarantined,
      total: [...byState.values()].reduce((sum, item) => sum + item, 0),
      pagesPerMinute: null,
    };
  }

  list(options: {
    pipelineId?: string | undefined;
    state?: JobState | undefined;
    limit: number;
    offset: number;
  }): { items: Job[]; total: number } {
    const filters = [
      options.pipelineId === undefined ? undefined : eq(jobs.pipelineId, options.pipelineId),
      options.state === undefined ? undefined : eq(jobs.state, options.state),
    ].filter((item) => item !== undefined);

    const where = filters.length > 0 ? and(...filters) : undefined;

    const rows = this.db
      .select()
      .from(jobs)
      .where(where)
      .orderBy(desc(jobs.discoveredAt), desc(jobs.id))
      .limit(options.limit)
      .offset(options.offset)
      .all();

    const total = this.db.select({ value: count() }).from(jobs).where(where).get();

    return { items: rows.map((row) => this.toJob(row)), total: total?.value ?? 0 };
  }

  addEvent(event: Omit<JobEvent, 'id'>): JobEvent {
    const row = { id: createId(), ...event };
    this.db.insert(jobEvents).values(row).run();
    return row;
  }

  eventsFor(jobId: string, limit = 500): JobEvent[] {
    return this.db
      .select()
      .from(jobEvents)
      .where(eq(jobEvents.jobId, jobId))
      .orderBy(jobEvents.createdAt)
      .limit(limit)
      .all();
  }

  recordOutput(jobId: string, format: string, path: string, bytes: number): void {
    this.db
      .insert(jobOutputs)
      .values({
        id: createId(),
        jobId,
        format: format as never,
        path,
        bytes,
        createdAt: new Date().toISOString(),
      })
      .run();
  }

  /**
   * Drop every job for a pipeline that has not started yet.
   *
   * A job already running is deliberately left alone: the executor owns it and stops it
   * through its `AbortSignal`, which is what guarantees no half-written output escapes the
   * work directory. Marking it here would only desynchronise the two.
   */
  cancelPendingFor(pipelineId: string): number {
    const result = this.db
      .update(jobs)
      .set({
        state: 'cancelled',
        finishedAt: new Date().toISOString(),
      })
      .where(and(eq(jobs.pipelineId, pipelineId), eq(jobs.state, 'pending')))
      .run();

    return result.changes;
  }

  /**
   * Every output a pipeline's jobs produced, with the document each came from.
   *
   * Used to build the Quick Mode download; the document name groups a run's files so four
   * formats across three documents do not arrive as twelve interleaved entries.
   */
  /**
   * Every file a Quick Mode run produced, in the order they were made.
   *
   * Carries the format and size as well as the path, because the results list offers each
   * file individually and a row reading only "output.md" tells the user nothing about
   * whether it is the one they wanted.
   */
  outputsForPipeline(pipelineId: string): QuickOutputRow[] {
    return this.db
      .select({
        path: jobOutputs.path,
        documentName: jobs.fileName,
        format: jobOutputs.format,
        bytes: jobOutputs.bytes,
      })
      .from(jobOutputs)
      .innerJoin(jobs, eq(jobOutputs.jobId, jobs.id))
      .where(eq(jobs.pipelineId, pipelineId))
      .orderBy(jobs.discoveredAt, jobOutputs.createdAt)
      .all()
      .map((row) => ({
        path: row.path,
        // Group by the source document without its extension: `invoice.pdf` produces
        // `invoice/invoice.md`, not `invoice.pdf/invoice.md`.
        documentName: row.documentName.replace(/\.[^.]+$/, ''),
        format: row.format,
        bytes: row.bytes,
      }));
  }

  /**
   * How much has been processed since a moment, across every pipeline.
   *
   * Counted from `finishedAt` rather than `discoveredAt`: the question the dashboard answers
   * is "what did this machine get through", not "what arrived".
   */
  throughputSince(since: Date): {
    succeeded: number;
    failed: number;
    quarantined: number;
    pages: number;
  } {
    const rows = this.db
      .select({ state: jobs.state, pages: jobs.pagesDone })
      .from(jobs)
      .where(and(isNotNull(jobs.finishedAt), gte(jobs.finishedAt, since.toISOString())))
      .all();

    let succeeded = 0;
    let failed = 0;
    let quarantined = 0;
    let pages = 0;

    for (const row of rows) {
      if (row.state === 'succeeded') succeeded += 1;
      else if (row.state === 'quarantined') quarantined += 1;
      else if (row.state === 'failed') failed += 1;
      pages += row.pages;
    }

    return { succeeded, failed, quarantined, pages };
  }

  rememberHash(pipelineId: string, contentHash: string): void {
    this.db
      .insert(processedHashes)
      .values({ pipelineId, contentHash, firstSeenAt: new Date().toISOString() })
      .onConflictDoNothing()
      .run();
  }

  hasSeenHash(pipelineId: string, contentHash: string): boolean {
    const row = this.db
      .select({ hash: processedHashes.contentHash })
      .from(processedHashes)
      .where(
        and(
          eq(processedHashes.pipelineId, pipelineId),
          eq(processedHashes.contentHash, contentHash),
        ),
      )
      .get();
    return row !== undefined;
  }

  /** Delete finished jobs older than the retention window. Returns the number removed. */
  pruneOlderThan(cutoff: Date): number {
    const result = this.db
      .delete(jobs)
      .where(
        and(
          inArray(jobs.state, ['succeeded', 'failed', 'quarantined', 'cancelled']),
          sql`${jobs.finishedAt} IS NOT NULL AND ${jobs.finishedAt} < ${cutoff.toISOString()}`,
        ),
      )
      .run();
    return result.changes;
  }

  private toJob(row: JobRow): Job {
    return {
      id: row.id,
      pipelineId: row.pipelineId,
      sourcePath: row.sourcePath,
      fileName: row.fileName,
      sizeBytes: row.sizeBytes,
      contentHash: row.contentHash,
      state: row.state,
      priority: row.priority,
      attempts: row.attempts,
      pageCount: row.pageCount,
      pagesDone: row.pagesDone,
      deviceUsed: row.deviceUsed,
      deviceFallbackReason: row.deviceFallbackReason,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      outputs: this.db
        .select()
        .from(jobOutputs)
        .where(eq(jobOutputs.jobId, row.id))
        .all()
        .map((output) => ({
          format: output.format,
          path: output.path,
          bytes: output.bytes,
        })),
      discoveredAt: row.discoveredAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      durationMs: row.durationMs,
    };
  }
}
