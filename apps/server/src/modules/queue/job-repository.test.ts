// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, pipelines, type Database_ } from '@impressive-ocr/db';
import type { JobState, PipelineOptions } from '@impressive-ocr/shared';
import { defaultMigrationsDir } from '../../infra/module-paths';
import { JobRepository } from './job-repository';

/**
 * Queueing a path the pipeline has already processed.
 *
 * `hasActiveJobForPath` matched any row for the path, with no state filter, so a file this
 * pipeline had ever seen could never be queued again — replacing a corrected scan under the
 * same name did nothing, silently and permanently. The method's own name, and the unique
 * index's comment ("while still in flight"), both described a filter that was not there.
 *
 * The index had to change with it: unconditional, it rejected the second row outright.
 */

const PIPELINE_ID = 'pipeline-1';
const OTHER_PIPELINE_ID = 'pipeline-2';
const PATH = 'C:/in/report.pdf';

let db: Database_;
let close: () => void;
let repository: JobRepository;
let counter = 0;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'impressive-ocr-jobs-'));
  const database = createDatabase({
    filePath: join(root, 'test.db'),
    migrationsFolder: defaultMigrationsDir(),
  });
  close = database.close;
  db = database.db;
  repository = new JobRepository(db);

  const now = new Date().toISOString();
  for (const id of [PIPELINE_ID, OTHER_PIPELINE_ID]) {
    db.insert(pipelines)
      .values({
        id,
        name: id,
        options: {} as PipelineOptions,
        priority: 5,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
});

afterEach(() => {
  close();
});

function insertJob(pipelineId: string, sourcePath: string, state: JobState) {
  counter += 1;
  return repository.insert({
    id: `job-${counter}`,
    pipelineId,
    sourcePath,
    fileName: 'report.pdf',
    sizeBytes: 1,
    contentHash: null,
    state,
    priority: 5,
    attempts: 0,
    pagesDone: 0,
    discoveredAt: new Date().toISOString(),
  });
}

describe('JobRepository.hasActiveJobForPath', () => {
  it('reports a job that is still in flight', () => {
    insertJob(PIPELINE_ID, PATH, 'pending');

    expect(repository.hasActiveJobForPath(PIPELINE_ID, PATH)).toBe(true);
  });

  it('does not report one that finished, so the file can be processed again', () => {
    insertJob(PIPELINE_ID, PATH, 'succeeded');

    expect(repository.hasActiveJobForPath(PIPELINE_ID, PATH)).toBe(false);
  });

  it('still reports a failed job, which is waiting on a retry', () => {
    // Not terminal: it goes back to pending until it is quarantined, so it holds its place.
    insertJob(PIPELINE_ID, PATH, 'failed');

    expect(repository.hasActiveJobForPath(PIPELINE_ID, PATH)).toBe(true);
  });

  it('allows a second job once the first is done, which the index used to reject', () => {
    // The unique index is partial for exactly this: unconditional, this insert threw.
    insertJob(PIPELINE_ID, PATH, 'succeeded');

    expect(() => insertJob(PIPELINE_ID, PATH, 'pending')).not.toThrow();
  });

  it('keeps two in-flight jobs for the same path out', () => {
    // The guarantee that must survive: one job per file at a time.
    insertJob(PIPELINE_ID, PATH, 'pending');

    expect(() => insertJob(PIPELINE_ID, PATH, 'running')).toThrow();
  });

  it('does not confuse two pipelines watching the same file', () => {
    insertJob(PIPELINE_ID, PATH, 'pending');

    expect(repository.hasActiveJobForPath(OTHER_PIPELINE_ID, PATH)).toBe(false);
  });
});

/**
 * Clearing the history from the Jobs page.
 *
 * The guarantee is one-sided and absolute: a job that is queued or running must survive, whatever
 * is asked for. Deleting the row of a job the scheduler is about to claim -- or is mid-document
 * on -- leaves the sidecar working on something no longer in the database, and `job_events`
 * cascades away with it.
 *
 * `failed` is clearable even though `ACTIVE_JOB_STATES` contains it. The two sets answer
 * different questions: that one is about holding a place in the queue, this one is about whether
 * anything will run the job again. Only `pending` is ever claimed, and a retryable failure is
 * written back as `pending`, so nothing picks a `failed` row up on its own.
 */
describe('JobRepository.clearFinished', () => {
  it('removes a job that succeeded', () => {
    insertJob(PIPELINE_ID, 'C:/in/a.pdf', 'succeeded');

    expect(repository.clearFinished()).toBe(1);
    expect(repository.list({ limit: 10, offset: 0 }).total).toBe(0);
  });

  it('keeps a running job, which the sidecar is still working on', () => {
    insertJob(PIPELINE_ID, 'C:/in/a.pdf', 'running');

    expect(repository.clearFinished()).toBe(0);
    expect(repository.list({ limit: 10, offset: 0 }).total).toBe(1);
  });

  it('keeps a queued job, which is about to be claimed', () => {
    insertJob(PIPELINE_ID, 'C:/in/a.pdf', 'pending');
    insertJob(PIPELINE_ID, 'C:/in/b.pdf', 'discovered');

    expect(repository.clearFinished()).toBe(0);
    expect(repository.list({ limit: 10, offset: 0 }).total).toBe(2);
  });

  it('clears the finished ones and leaves the live ones alone', () => {
    insertJob(PIPELINE_ID, 'C:/in/a.pdf', 'succeeded');
    insertJob(PIPELINE_ID, 'C:/in/b.pdf', 'quarantined');
    insertJob(PIPELINE_ID, 'C:/in/c.pdf', 'cancelled');
    insertJob(PIPELINE_ID, 'C:/in/d.pdf', 'running');

    expect(repository.clearFinished()).toBe(3);

    const left = repository.list({ limit: 10, offset: 0 });
    expect(left.items.map((job) => job.state)).toEqual(['running']);
  });

  it('clears one state without taking the others', () => {
    // So the failures can be cleared off the page while the successes stay as a record.
    insertJob(PIPELINE_ID, 'C:/in/a.pdf', 'succeeded');
    insertJob(PIPELINE_ID, 'C:/in/b.pdf', 'quarantined');

    expect(repository.clearFinished('quarantined')).toBe(1);
    expect(repository.list({ limit: 10, offset: 0 }).items.map((j) => j.state)).toEqual([
      'succeeded',
    ]);
  });

  it('refuses to clear a live state even when named directly', () => {
    // The route rejects this before it arrives; the repository must not be the only guard.
    insertJob(PIPELINE_ID, 'C:/in/a.pdf', 'running');

    expect(repository.clearFinished('running')).toBe(0);
  });

  it('counts what a clear would take, so the confirmation can name a number', () => {
    insertJob(PIPELINE_ID, 'C:/in/a.pdf', 'succeeded');
    insertJob(PIPELINE_ID, 'C:/in/b.pdf', 'running');

    expect(repository.countFinished()).toBe(1);
    expect(repository.countFinished('succeeded')).toBe(1);
    expect(repository.countFinished('quarantined')).toBe(0);
  });

  it('lets the path be processed again once its finished job is cleared', () => {
    // The partial unique index is keyed on the active states, so a cleared row frees the slot
    // exactly as a finished one did.
    insertJob(PIPELINE_ID, PATH, 'succeeded');
    repository.clearFinished();

    expect(() => insertJob(PIPELINE_ID, PATH, 'pending')).not.toThrow();
  });
});
