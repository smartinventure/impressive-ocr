// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { keyFor, SidecarPool } from './sidecar-pool';

/**
 * Releasing warm workers.
 *
 * A resident worker holds its models — 3.2 GB of VRAM for PP-StructureV3, measured on an 8 GB
 * card — for as long as the application runs. Giving that back is a user-facing promise, and
 * the part that matters is what happens to a worker that is mid-document.
 */

const stop = vi.fn().mockResolvedValue(undefined);

vi.mock('./sidecar-process', () => ({
  SidecarProcess: class {
    isRunning = true;
    pid = 4242;
    async start(): Promise<{ port: number }> {
      return { port: 9999 };
    }
    async stop(): Promise<void> {
      this.isRunning = false;
      await stop();
    }
  },
}));

vi.mock('./sidecar-client', () => ({
  SidecarClient: class {
    async capabilities(): Promise<{ supportedFormats: string[] }> {
      return { supportedFormats: ['markdown'] };
    }
  },
}));

function pool(idleMinutes = 0): SidecarPool {
  return new SidecarPool({
    pythonPath: 'python',
    authToken: 'token',
    modelCacheDir: 'models',
    logLevel: 'info',
    cpuBudgetPercent: () => 50,
    idleMinutes: () => idleMinutes,
    // The native backend, which is what these tests are about: worker lifecycle is the same
    // either way, and starting a real inference server here would make them integration tests.
    vlServer: () => null,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  });
}

describe('SidecarPool.releaseWorkers', () => {
  it('stops an idle worker and frees what it was holding', async () => {
    const subject = pool();
    await subject.acquire('fast', 'gpu');
    subject.release('fast', 'gpu');

    const result = await subject.releaseWorkers();

    expect(result).toEqual({ stopped: 1, busy: 0 });
    expect(subject.health()).toEqual([]);
  });

  it('leaves a worker that is mid-document alone, and says so', async () => {
    // Killing it would throw away work that is often most of a minute in. The count is what
    // lets the UI tell "nothing to do" apart from "not now".
    const subject = pool();
    await subject.acquire('fast', 'gpu');

    const result = await subject.releaseWorkers();

    expect(result).toEqual({ stopped: 0, busy: 1 });
    expect(subject.health()).toHaveLength(1);
  });

  it('stops a busy worker when forced', async () => {
    const subject = pool();
    await subject.acquire('fast', 'gpu');

    const result = await subject.releaseWorkers({ force: true });

    expect(result).toEqual({ stopped: 1, busy: 0 });
    expect(subject.health()).toEqual([]);
  });

  it('reports nothing to do when no worker was ever started', async () => {
    expect(await pool().releaseWorkers()).toEqual({ stopped: 0, busy: 0 });
  });

  it('starts a fresh worker on the next job after a release', async () => {
    const subject = pool();
    await subject.acquire('fast', 'gpu');
    subject.release('fast', 'gpu');
    await subject.releaseWorkers();

    await subject.acquire('fast', 'gpu');

    expect(subject.health().map((worker) => worker.id)).toEqual([keyFor('fast', 'gpu')]);
  });
});
