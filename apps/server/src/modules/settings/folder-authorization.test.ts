// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '@impressive-ocr/db';
import { defaultMigrationsDir } from '../../infra/module-paths';
import { SettingsService } from './settings-service';

/**
 * Authorizing a folder is what picking one now means.
 *
 * The allowlist used to start empty and fail closed, so a new user's first screen told them
 * they were not allowed to do anything yet. The boundary stays — only an explicit choice adds
 * to it, and it is still revocable — but the separate setup step is gone.
 */

let settings: SettingsService;
let close: () => void;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'impressive-ocr-allowlist-'));
  const database = createDatabase({
    filePath: join(root, 'test.db'),
    migrationsFolder: defaultMigrationsDir(),
  });
  close = database.close;
  settings = new SettingsService(database.db);
});

afterEach(() => {
  close();
});

describe('authorizeFolder', () => {
  it('starts empty, and fails closed until something is chosen', () => {
    expect(settings.allowlist()).toEqual([]);
  });

  it('adds a chosen folder', () => {
    const list = settings.authorizeFolder(resolve('C:/scans'));

    expect(list).toHaveLength(1);
    expect(list[0]).toBe(resolve('C:/scans'));
  });

  it('does not add the same folder twice', () => {
    settings.authorizeFolder(resolve('C:/scans'));
    const list = settings.authorizeFolder(resolve('C:/scans'));

    expect(list).toHaveLength(1);
  });

  it('ignores a folder a parent already covers', () => {
    settings.authorizeFolder(resolve('C:/scans'));
    const list = settings.authorizeFolder(resolve('C:/scans/invoices'));

    // Already reachable. Adding it would grow the list without granting anything.
    expect(list).toHaveLength(1);
    expect(list[0]).toBe(resolve('C:/scans'));
  });

  it('replaces entries a newly chosen parent makes redundant', () => {
    settings.authorizeFolder(resolve('C:/scans/invoices'));
    settings.authorizeFolder(resolve('C:/scans/receipts'));
    const list = settings.authorizeFolder(resolve('C:/scans'));

    // One entry to reason about later, rather than three that overlap.
    expect(list).toEqual([resolve('C:/scans')]);
  });

  it('keeps siblings, which grant genuinely different access', () => {
    settings.authorizeFolder(resolve('C:/scans'));
    const list = settings.authorizeFolder(resolve('D:/archive'));

    expect(list).toHaveLength(2);
  });

  it('does not treat a name-prefix sibling as a child', () => {
    settings.authorizeFolder(resolve('C:/data'));
    const list = settings.authorizeFolder(resolve('C:/data-secret'));

    // "C:\data-secret" starts with "C:\data" as a string but is not inside it.
    expect(list).toHaveLength(2);
  });
});

describe('revokeFolder', () => {
  it('removes the entry', () => {
    settings.authorizeFolder(resolve('C:/scans'));
    settings.authorizeFolder(resolve('D:/archive'));

    expect(settings.revokeFolder(resolve('C:/scans'))).toEqual([resolve('D:/archive')]);
  });

  it('is unbothered by revoking something that is not there', () => {
    settings.authorizeFolder(resolve('C:/scans'));

    expect(settings.revokeFolder(resolve('E:/nothing'))).toHaveLength(1);
  });

  it('leaves the list empty and closed when the last one goes', () => {
    settings.authorizeFolder(resolve('C:/scans'));

    expect(settings.revokeFolder(resolve('C:/scans'))).toEqual([]);
  });
});
