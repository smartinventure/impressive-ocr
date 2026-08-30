// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Probing the machine's drives at most once a minute.
 *
 * A disconnected network drive does not fail fast. Windows took 63 seconds to answer `access`
 * for a stale `L:` mapping on a machine here, and while `withTimeout` gives up on the promise
 * after three seconds so the browse still returns, nothing cancels the syscall: the libuv
 * thread stays pinned for the whole minute. libuv has four threads by default, so a handful of
 * root listings starves every other file operation in the process -- which is exactly how this
 * was found, as `mkdtemp` in an unrelated test's `beforeEach` timing out after 30 seconds.
 *
 * The cache is what holds that to one pinned thread instead of one per listing, so it is worth
 * a test of its own rather than being left as an invisible optimisation someone later removes.
 */

const access = vi.hoisted(() => vi.fn());
const lstat = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', () => ({
  access: (...args: unknown[]) => access(...args),
  lstat: (...args: unknown[]) => lstat(...args),
  readdir: vi.fn().mockResolvedValue([]),
  mkdir: vi.fn(),
  realpath: (path: string) => Promise.resolve(path),
}));

const { browseFolders, resetSystemRootsCache } = await import('./folder-browser');

const realPlatform = process.platform;

function pretendWindows(): void {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSystemRootsCache();
  pretendWindows();
  // Only C: is mapped. Every other letter rejects, as an unmapped one does.
  access.mockImplementation((path: string) =>
    path.startsWith('C:') ? Promise.resolve() : Promise.reject(new Error('ENOENT')),
  );
  lstat.mockResolvedValue({
    isDirectory: () => true,
    isSymbolicLink: () => false,
    mtime: new Date(0),
  });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  resetSystemRootsCache();
});

async function listRoots(): Promise<void> {
  await browseFolders({ path: null, scope: 'system', allowlist: [] });
}

describe('system root probing', () => {
  it('probes every drive letter the first time', async () => {
    await listRoots();

    // 26 letters. Nothing else in this path calls `access`.
    expect(access).toHaveBeenCalledTimes(26);
  });

  it('does not probe again on the next listing', async () => {
    await listRoots();
    access.mockClear();

    await listRoots();

    expect(access).not.toHaveBeenCalled();
  });

  it('gives two simultaneous listings one probe between them', async () => {
    // Two browses arriving together must share the probe. Starting two would pin two threads
    // on the same dead drive, which is the failure this cache exists to prevent.
    await Promise.all([listRoots(), listRoots()]);

    expect(access).toHaveBeenCalledTimes(26);
  });

  it('probes again once the cache has been forgotten', async () => {
    await listRoots();
    access.mockClear();
    resetSystemRootsCache();

    await listRoots();

    expect(access).toHaveBeenCalledTimes(26);
  });

  it('still reports the drives it found', async () => {
    const result = await browseFolders({ path: null, scope: 'system', allowlist: [] });

    expect(result.entries.some((entry) => entry.path.startsWith('C:'))).toBe(true);
  });

  it('serves the same answer from the cache, not a re-probe that could differ', async () => {
    const first = await browseFolders({ path: null, scope: 'system', allowlist: [] });
    // A drive appearing between the two listings must not change the cached answer, or the
    // cache would be doing nothing.
    access.mockResolvedValue(undefined);
    const second = await browseFolders({ path: null, scope: 'system', allowlist: [] });

    expect(second.entries.map((entry) => entry.path)).toEqual(
      first.entries.map((entry) => entry.path),
    );
  });
});
