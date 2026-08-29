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
