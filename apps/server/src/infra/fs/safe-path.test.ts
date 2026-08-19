// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { PathNotAllowedError, isInside, resolveSafePath } from './safe-path';

/**
 * This is the check standing between a pipeline definition and arbitrary file access, so it
 * gets the most adversarial tests in the codebase.
 */

let root: string;
let allowed: string;
let outside: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'impressive-ocr-safe-path-'));
  allowed = join(root, 'allowed');
  outside = join(root, 'outside');
  await mkdir(join(allowed, 'nested'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(allowed, 'doc.pdf'), 'x');
  await writeFile(join(outside, 'secret.txt'), 'x');
});

describe('isInside', () => {
  it('accepts a direct child', () => {
    expect(isInside('/data', '/data/input')).toBe(true);
  });

  it('accepts the folder itself', () => {
    expect(isInside('/data', '/data')).toBe(true);
  });

  it('rejects a sibling that merely shares a name prefix', () => {
    // The bug a naive startsWith() check would have.
    expect(isInside('/data', '/data-secret')).toBe(false);
  });

  it('rejects a parent', () => {
    expect(isInside('/data/input', '/data')).toBe(false);
  });

  it('rejects traversal back out of the folder', () => {
    expect(isInside('/data', '/data/../etc')).toBe(false);
  });
});

describe('resolveSafePath', () => {
  it('returns the canonical path for a file inside the allowlist', async () => {
    const result = await resolveSafePath(join(allowed, 'doc.pdf'), { allowlist: [allowed] });

    expect(result).toBe(resolve(join(allowed, 'doc.pdf')));
  });

  it('rejects everything when the allowlist is empty', async () => {
    // Fail-closed: a fresh install has authorised nothing, so nothing may be read.
    await expect(
      resolveSafePath(join(allowed, 'doc.pdf'), { allowlist: [] }),
    ).rejects.toThrow(PathNotAllowedError);
  });

  it('rejects a path outside the allowlist', async () => {
    await expect(
      resolveSafePath(join(outside, 'secret.txt'), { allowlist: [allowed] }),
    ).rejects.toMatchObject({ reason: 'outside-allowlist' });
  });

  it('rejects traversal that escapes the allowlisted folder', async () => {
    await expect(
      resolveSafePath(join(allowed, '..', 'outside', 'secret.txt'), { allowlist: [allowed] }),
    ).rejects.toMatchObject({ reason: 'outside-allowlist' });
  });

  it('rejects a relative path', async () => {
    await expect(
      resolveSafePath('relative/path.pdf', { allowlist: [allowed] }),
    ).rejects.toMatchObject({ reason: 'not-absolute' });
  });

  it('rejects a null byte', async () => {
    await expect(
      resolveSafePath(`${allowed}\0.pdf`, { allowlist: [allowed] }),
    ).rejects.toMatchObject({ reason: 'contains-null-byte' });
  });

  it('rejects a missing path when it must exist', async () => {
    await expect(
      resolveSafePath(join(allowed, 'absent.pdf'), { allowlist: [allowed] }),
    ).rejects.toMatchObject({ reason: 'does-not-exist' });
  });

  it('accepts a not-yet-created folder inside the allowlist', async () => {
    // Output folders are created on demand, so they must pass before they exist.
    const target = join(allowed, 'nested', 'new-output');

    const result = await resolveSafePath(target, { allowlist: [allowed], mustExist: false });

    expect(result).toBe(resolve(target));
  });

  it('still rejects a not-yet-created path outside the allowlist', async () => {
    await expect(
      resolveSafePath(join(outside, 'new-output'), { allowlist: [allowed], mustExist: false }),
    ).rejects.toMatchObject({ reason: 'outside-allowlist' });
  });

  it('accepts a path under any one of several allowlist entries', async () => {
    const result = await resolveSafePath(join(outside, 'secret.txt'), {
      allowlist: [allowed, outside],
    });

    expect(result).toBe(resolve(join(outside, 'secret.txt')));
  });
});
