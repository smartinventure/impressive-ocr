// SPDX-License-Identifier: AGPL-3.0-or-later
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  InsufficientDiskSpaceError,
  REQUIRED_INSTALL_BYTES,
  assertEnoughSpaceForInstall,
  formatGib,
  measureDiskSpace,
  measureNearestDiskSpace,
} from './disk-space';

/**
 * Added after a full disk crashed the server mid-install: pip failed deep inside its own
 * machinery, the partially-written venv was left behind, and nothing in the output pointed at
 * the actual cause.
 */
/**
 * Found by calling the live preflight endpoint on a machine with 30 GB free and no runtime
 * installed: it reported "could not measure free space". `statfs` fails on a path that does
 * not exist, and the venv directory does not exist until the first install has run -- so the
 * check no-opped in precisely the situation it was written for.
 */
describe('measureNearestDiskSpace', () => {
  it('measures a path that does not exist yet, via its nearest real ancestor', async () => {
    const missing = join(tmpdir(), 'impressive-ocr-not-created', 'runtime', 'venv');

    const space = await measureNearestDiskSpace(missing);

    expect(space).not.toBeNull();
    expect(space?.totalBytes).toBeGreaterThan(0);
  });

  it('agrees with a direct measurement when the path does exist', async () => {
    const direct = await measureDiskSpace(tmpdir());
    const nearest = await measureNearestDiskSpace(tmpdir());

    expect(nearest?.totalBytes).toBe(direct?.totalBytes);
  });
});

describe('measureDiskSpace', () => {
  it('reports free and total bytes for a real path', async () => {
    const space = await measureDiskSpace(tmpdir());

    expect(space).not.toBeNull();
    expect(space?.totalBytes).toBeGreaterThan(0);
    expect(space?.freeBytes).toBeGreaterThanOrEqual(0);
    expect(space?.freeBytes).toBeLessThanOrEqual(space?.totalBytes ?? 0);
  });

  it('returns null rather than throwing for a path that does not exist', async () => {
    // Unmeasurable must mean "carry on and let pip report its own error", never "refuse".
    const missing = process.platform === 'win32' ? 'Q:\\nope\\nowhere' : '/nonexistent/nowhere';

    expect(await measureDiskSpace(missing)).toBeNull();
  });
});

describe('assertEnoughSpaceForInstall', () => {
  it('passes when the disk has more than the requirement', async () => {
    // Derived from the actual free space rather than assuming any: this very check was added
    // because a developer machine ran out of room, and the test must not itself depend on
    // there being some.
    //
    // The margin is 256 MB, not one byte. Free space is read here and again inside the
    // assertion, and on a live machine it moves between the two - a log line, a browser
    // cache write. A one-byte headroom made this fail whenever anything else was running.
    const HEADROOM = 256 * 1024 * 1024;
    const space = await measureDiskSpace(tmpdir());
    const requirement = Math.max(0, (space?.freeBytes ?? 0) - HEADROOM);

    await expect(assertEnoughSpaceForInstall(tmpdir(), requirement)).resolves.toBeUndefined();
  });

  it('refuses when the requirement exceeds the disk', async () => {
    const petabyte = 1024 ** 5;

    await expect(assertEnoughSpaceForInstall(tmpdir(), petabyte)).rejects.toBeInstanceOf(
      InsufficientDiskSpaceError,
    );
  });

  it('names the drive and both figures, so the message is actionable', async () => {
    try {
      await assertEnoughSpaceForInstall(tmpdir(), 1024 ** 5);
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('GB available');
      expect(message).toContain('needed');
    }
  });

  it('budgets for more than the final footprint', () => {
    // pip and uv stage downloads before moving them into place, so peak usage is higher.
    expect(REQUIRED_INSTALL_BYTES).toBeGreaterThan(1_600_000_000);
  });
});

describe('formatGib', () => {
  it('renders bytes as gigabytes with one decimal', () => {
    expect(formatGib(1024 ** 3)).toBe('1.0 GB');
    expect(formatGib(2.5 * 1024 ** 3)).toBe('2.5 GB');
  });
});
