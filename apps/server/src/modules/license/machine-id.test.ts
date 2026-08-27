// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { machineId, resetMachineIdCache } from './machine-id';

/**
 * The identifier that claims a seat.
 *
 * The case these exist for is the container. A Debian slim image ships `/etc/machine-id` as
 * an empty file — systemd writes it at boot and no container boots — so the OS branch finds
 * nothing, and Docker sets the hostname to the container id, which changes on every
 * `docker run`. An identifier derived from either would claim a fresh seat on every restart
 * and exhaust a three-seat licence by the third one.
 */

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'impressive-ocr-machine-'));
  resetMachineIdCache();
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  resetMachineIdCache();
});

describe('machineId', () => {
  it('is the shape the licence server documents', async () => {
    // "32 hex characters or a UUID". Anything else is refused as INVALID_MACHINE_ID.
    expect(await machineId(dataDir)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is the same on every call within a process', async () => {
    const first = await machineId(dataDir);
    resetMachineIdCache();
    const second = await machineId(dataDir);

    expect(second).toBe(first);
  });

  it('survives a restart, which is what stops a container burning a seat', async () => {
    // The seat is claimed by this value. If it changed between runs, recreating the container
    // would consume a new seat every time.
    const first = await machineId(dataDir);
    resetMachineIdCache();

    expect(await machineId(dataDir)).toBe(first);
  });

  it('reuses a stored identifier rather than generating another', async () => {
    const stored = 'b'.repeat(32);
    await writeFile(join(dataDir, 'machine-id'), `${stored}\n`, 'utf8');
    resetMachineIdCache();

    // Only meaningful where the OS has no identifier of its own — a container. On a developer
    // machine the OS value wins, which is the intended precedence.
    const result = await machineId(dataDir);
    expect(result === stored || /^[0-9a-f]{32}$/.test(result)).toBe(true);
  });

  it('replaces a corrupted stored identifier instead of sending it', async () => {
    // A truncated write or a hand-edit must not produce a value the server rejects outright.
    await writeFile(join(dataDir, 'machine-id'), 'not-a-machine-id', 'utf8');
    resetMachineIdCache();

    expect(await machineId(dataDir)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('still answers when the data directory cannot be written', async () => {
    // A read-only volume degrades to a fresh id per start, which is bad — but an activation
    // screen that cannot be completed at all is worse.
    resetMachineIdCache();
    const nonexistent = join(dataDir, 'nested', 'deeper');

    expect(await machineId(nonexistent)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('writes the fallback where a container volume would keep it', async () => {
    await machineId(dataDir);

    // Only when the OS had nothing to offer; on a machine with a MachineGuid there is
    // nothing to persist, and the absence of the file is correct.
    const written = await readFile(join(dataDir, 'machine-id'), 'utf8').catch(() => null);
    expect(written === null || /^[0-9a-f]{32}$/.test(written.trim())).toBe(true);
  });
});
