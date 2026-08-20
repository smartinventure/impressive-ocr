// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  browseFolders,
  createFolder,
  FolderBrowseError,
  isWithinAllowlist,
} from './folder-browser';

let root: string;
let allowed: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'impressive-ocr-browse-'));
  allowed = join(root, 'allowed');
  outside = join(root, 'outside');
  await mkdir(join(allowed, 'scans', '2024'), { recursive: true });
  await mkdir(join(allowed, 'output'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(allowed, 'invoice.pdf'), 'x');
});

describe('browseFolders in allowlist scope', () => {
  it('lists the authorised folders as the root', async () => {
    const result = await browseFolders({ path: null, scope: 'allowlist', allowlist: [allowed] });

    expect(result.isRoot).toBe(true);
    expect(result.currentPath).toBeNull();
    expect(result.entries.map((entry) => entry.path)).toEqual([allowed]);
  });

  it('lists subfolders of an authorised folder', async () => {
    const result = await browseFolders({ path: allowed, scope: 'allowlist', allowlist: [allowed] });

    expect(result.entries.map((entry) => entry.name)).toEqual(['output', 'scans']);
    expect(result.selectable).toBe(true);
  });

  it('omits files, because this browser only picks folders', async () => {
    const result = await browseFolders({ path: allowed, scope: 'allowlist', allowlist: [allowed] });

    expect(result.entries.map((entry) => entry.name)).not.toContain('invoice.pdf');
  });

  it('refuses a folder outside the allowlist', async () => {
    await expect(
      browseFolders({ path: outside, scope: 'allowlist', allowlist: [allowed] }),
    ).rejects.toMatchObject({ code: 'not-allowed' });
  });

  it('refuses traversal out of an authorised folder', async () => {
    await expect(
      browseFolders({
        path: join(allowed, '..', 'outside'),
        scope: 'allowlist',
        allowlist: [allowed],
      }),
    ).rejects.toMatchObject({ code: 'not-allowed' });
  });

  it('reports a missing folder as not-found rather than failing opaquely', async () => {
    await expect(
      browseFolders({ path: join(allowed, 'nope'), scope: 'allowlist', allowlist: [allowed] }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('offers a parent path for navigating back up', async () => {
    const result = await browseFolders({
      path: join(allowed, 'scans'),
      scope: 'allowlist',
      allowlist: [allowed],
    });

    expect(result.parentPath).toBe(allowed);
  });

  it('marks entries as selectable only inside the allowlist', async () => {
    const result = await browseFolders({
      path: root,
      scope: 'system',
      allowlist: [allowed],
    });

    const byName = new Map(result.entries.map((entry) => [entry.name, entry]));
    expect(byName.get('allowed')?.selectable).toBe(true);
    expect(byName.get('outside')?.selectable).toBe(true); // system scope selects anything
  });
});

describe('browseFolders in system scope', () => {
  it('lists the machine roots when no path is given', async () => {
    const result = await browseFolders({ path: null, scope: 'system', allowlist: [] });

    // Windows has no single `/`, so this must be drives plus home; POSIX gets `/` plus home.
    expect(result.isRoot).toBe(true);
    expect(result.entries.length).toBeGreaterThan(0);
  });

  it('browses outside the allowlist', async () => {
    const result = await browseFolders({ path: outside, scope: 'system', allowlist: [allowed] });

    expect(result.currentPath).toBe(outside);
  });
});

describe('createFolder', () => {
  it('creates a folder inside the allowlist', async () => {
    const target = join(allowed, 'new-output');

    const created = await createFolder(target, { scope: 'allowlist', allowlist: [allowed] });

    expect(created.toLowerCase()).toContain('new-output');
    const listing = await browseFolders({
      path: allowed,
      scope: 'allowlist',
      allowlist: [allowed],
    });
    expect(listing.entries.map((entry) => entry.name)).toContain('new-output');
  });

  it('creates intermediate folders in one step', async () => {
    // "Type a path that does not exist, then create it" is the common flow when setting up
    // a new pipeline's output folder.
    const target = join(allowed, 'a', 'b', 'c');

    await expect(
      createFolder(target, { scope: 'allowlist', allowlist: [allowed] }),
    ).resolves.toBeTruthy();
  });

  it('refuses to create outside the allowlist', async () => {
    await expect(
      createFolder(join(outside, 'nope'), { scope: 'allowlist', allowlist: [allowed] }),
    ).rejects.toBeInstanceOf(FolderBrowseError);
  });

  it('refuses to create a filesystem root', async () => {
    const driveRoot = process.platform === 'win32' ? 'C:\\' : '/';

    await expect(createFolder(driveRoot, { scope: 'system', allowlist: [] })).rejects.toMatchObject(
      { code: 'not-allowed' },
    );
  });
});

describe('isWithinAllowlist', () => {
  it('accepts the authorised folder itself', () => {
    expect(isWithinAllowlist(allowed, [allowed])).toBe(true);
  });

  it('accepts a descendant', () => {
    expect(isWithinAllowlist(join(allowed, 'scans', '2024'), [allowed])).toBe(true);
  });

  it('rejects a sibling that shares a name prefix', () => {
    expect(isWithinAllowlist(`${allowed}-other`, [allowed])).toBe(false);
  });

  it('rejects everything when nothing is authorised', () => {
    expect(isWithinAllowlist(allowed, [])).toBe(false);
  });
});
