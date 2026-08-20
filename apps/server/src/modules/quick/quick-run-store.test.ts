// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtemp, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../infra/logger';
import { QuickRunStore } from './quick-run-store';

/**
 * Uploaded documents sit on a machine that may not belong to the person who sent them, so
 * what gets deleted and when is a privacy decision rather than a housekeeping one.
 */

let root: string;
let store: QuickRunStore;
let clock: Date;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'impressive-ocr-quick-'));
  clock = new Date('2026-08-20T12:00:00Z');
  store = new QuickRunStore({
    root,
    logger: createLogger({ level: 'silent', pretty: false }),
    now: () => clock,
  });
});

/** Backdate a run directory so the sweeper sees it as old. */
async function age(runId: string, hours: number): Promise<void> {
  const when = new Date(clock.getTime() - hours * 60 * 60 * 1000);
  await utimes(join(root, runId), when, when);
}

describe('run directories', () => {
  it('creates separate places for inputs and results', async () => {
    const dirs = await store.create('run-1');

    await expect(stat(dirs.inputDir)).resolves.toBeTruthy();
    await expect(stat(dirs.outputDir)).resolves.toBeTruthy();
  });

  it('drops inputs while keeping results', async () => {
    const dirs = await store.create('run-1');
    await writeFile(join(dirs.inputDir, 'scan.pdf'), 'x');
    await writeFile(join(dirs.outputDir, 'scan.md'), '# x');

    await store.discardInputs('run-1');

    // The user already has the originals; the results are the only reason the run existed.
    await expect(stat(dirs.inputDir)).rejects.toThrow();
    await expect(stat(dirs.outputDir)).resolves.toBeTruthy();
  });

  it('removes a whole run when cancelled', async () => {
    const dirs = await store.create('run-1');
    await store.discard('run-1');

    await expect(stat(dirs.runDir)).rejects.toThrow();
  });

  it('does not throw when asked to discard something already gone', async () => {
    await expect(store.discard('never-existed')).resolves.toBeUndefined();
    await expect(store.discardInputs('never-existed')).resolves.toBeUndefined();
  });
});

describe('retention sweep', () => {
  it('keeps a run inside the window', async () => {
    await store.create('fresh');
    await age('fresh', 23);

    expect(await store.sweep()).toBe(0);
    expect(await readdir(root)).toContain('fresh');
  });

  it('removes a run past the window', async () => {
    await store.create('stale');
    await age('stale', 25);

    expect(await store.sweep()).toBe(1);
    expect(await readdir(root)).not.toContain('stale');
  });

  it('sweeps only what has expired', async () => {
    await store.create('fresh');
    await store.create('stale');
    await age('fresh', 1);
    await age('stale', 48);

    expect(await store.sweep()).toBe(1);
    expect(await readdir(root)).toEqual(['fresh']);
  });

  it('removes a run whose database row was lost', async () => {
    // Driven by mtime, not by a row: a crash mid-write must not leak a directory forever.
    await store.create('orphan');
    await age('orphan', 100);

    expect(await store.sweep()).toBe(1);
  });

  it('is quiet when nothing has ever run', async () => {
    const empty = new QuickRunStore({
      root: join(root, 'never-created'),
      logger: createLogger({ level: 'silent', pretty: false }),
      now: () => clock,
    });

    expect(await empty.sweep()).toBe(0);
  });
});

describe('expiry', () => {
  it('is the retention window after finishing', () => {
    const finished = new Date('2026-08-20T12:00:00Z');

    expect(store.expiryFrom(finished).toISOString()).toBe('2026-08-21T12:00:00.000Z');
  });
});
