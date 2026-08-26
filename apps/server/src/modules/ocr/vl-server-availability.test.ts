// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appSettingsSchema,
  type AppSettings,
  type HardwareCapabilities,
} from '@impressive-ocr/shared';
import type { Logger } from '../../infra/logger';
import { vlServerPaths } from '../../infra/paths';
import { resolveVlServer } from './vl-server-availability';
import { QUANTISATION } from './vl-server-index';

/**
 * Whether the accurate profile gets the batching engine.
 *
 * Both "no" answers must be quiet and safe: a machine without it still OCRs, just on
 * PaddleOCR's own backend. The failure worth preventing is the opposite -- claiming the
 * engine is there when the files are half-downloaded, which fails at the first document
 * rather than at startup.
 */

let logger: Logger;

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return appSettingsSchema.parse({ ...overrides });
}

function hardware(canUseGpu: boolean): HardwareCapabilities {
  return {
    platform: 'win32',
    arch: 'x64',
    cpuModel: 'Test CPU',
    cpuCores: 16,
    totalMemoryBytes: 32 * 1024 ** 3,
    gpu: null,
    gpuUnavailableReason: null,
    canUseGpu,
    availableProfiles: ['fast'],
    canRunAccurateOnCpu: false,
    probedAt: '2026-08-26T00:00:00.000Z',
  };
}

/** Lay down the three files a complete install has, or a subset of them. */
async function install(files: readonly ('executable' | 'model' | 'projector')[]) {
  const root = await mkdtemp(join(tmpdir(), 'impressive-ocr-vl-'));
  const paths = vlServerPaths(root, QUANTISATION);
  await mkdir(join(root, 'bin'), { recursive: true });
  for (const file of files) {
    await writeFile(paths[file], 'x');
  }
  return root;
}

beforeEach(() => {
  logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
});

describe('resolveVlServer', () => {
  it('declines when the user has chosen the built-in backend', async () => {
    const root = await install(['executable', 'model', 'projector']);

    const result = resolveVlServer(settings({ vlBackend: 'native' }), hardware(true), root, logger);

    expect(result.options).toBeNull();
    expect(result.reason).toBe('disabled-in-settings');
  });

  it('declines when nothing is installed', async () => {
    const root = await install([]);

    const result = resolveVlServer(settings(), hardware(true), root, logger);

    expect(result.options).toBeNull();
    expect(result.reason).toBe('not-installed');
  });

  it('declines when the download only half finished', async () => {
    // The one state that looks valid from a distance: the server is there, the weights are
    // not, and the failure lands on the first document instead of at startup.
    const root = await install(['executable', 'projector']);

    const result = resolveVlServer(settings(), hardware(true), root, logger);

    expect(result.options).toBeNull();
    expect(result.reason).toBe('not-installed');
  });

  it('offers it with every layer on the GPU when there is one', async () => {
    const root = await install(['executable', 'model', 'projector']);

    const result = resolveVlServer(settings(), hardware(true), root, logger);

    expect(result.reason).toBeNull();
    expect(result.options?.gpuLayers).toBeGreaterThan(0);
  });

  it('offers it on a CPU-only machine with nothing offloaded', async () => {
    // Not a fallback: measured at ~11 s/page against ~103 s for the fast profile on the same
    // machine. A partial offload would be slower than either extreme.
    const root = await install(['executable', 'model', 'projector']);

    const result = resolveVlServer(settings(), hardware(false), root, logger);

    expect(result.reason).toBeNull();
    expect(result.options?.gpuLayers).toBe(0);
  });

  it('passes the configured concurrency straight through', async () => {
    // It has to match the server's own slot count, so anything that quietly substituted a
    // different number here would leave half the slots idle.
    const root = await install(['executable', 'model', 'projector']);

    const result = resolveVlServer(settings({ vlConcurrency: 4 }), hardware(true), root, logger);

    expect(result.options?.concurrency).toBe(4);
  });
});
