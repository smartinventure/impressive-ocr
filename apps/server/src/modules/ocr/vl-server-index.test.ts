// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { HardwareCapabilities } from '@impressive-ocr/shared';
import { LLAMA_CPP_BUILD, selectVlServerBuild, vlServerDownloadBytes } from './vl-server-index';

/**
 * Which inference build a machine gets.
 *
 * Worth testing precisely because it is invisible when wrong: a machine handed the wrong
 * archive does not fail loudly, it falls back to PaddleOCR's own backend and is simply 28x
 * slower than it should be, which reads as "the accurate profile is slow" rather than as a
 * bug.
 */

function hardware(overrides: Partial<HardwareCapabilities> = {}): HardwareCapabilities {
  return {
    platform: 'win32',
    arch: 'x64',
    cpuModel: 'Test CPU',
    cpuCores: 16,
    totalMemoryBytes: 32 * 1024 ** 3,
    gpu: null,
    gpuUnavailableReason: null,
    canUseGpu: false,
    availableProfiles: ['fast'],
    canRunAccurateOnCpu: false,
    probedAt: '2026-08-26T00:00:00.000Z',
    ...overrides,
  };
}

describe('selectVlServerBuild', () => {
  it('gives a Windows machine with a usable GPU the CUDA build and its runtime', () => {
    const build = selectVlServerBuild(hardware({ platform: 'win32', canUseGpu: true }));

    expect(build.accelerator).toBe('cuda');
    // The CUDA DLLs are published as a second archive and nothing starts without them.
    expect(build.assets).toHaveLength(2);
    expect(build.assets.some((asset) => asset.includes('cudart'))).toBe(true);
  });

  it('gives a Windows machine without one the CPU build', () => {
    const build = selectVlServerBuild(hardware({ platform: 'win32', canUseGpu: false }));

    expect(build.accelerator).toBe('cpu');
    expect(build.assets).toHaveLength(1);
  });

  it('gives a Linux GPU machine the Vulkan build, because llama.cpp ships no Linux CUDA', () => {
    const build = selectVlServerBuild(hardware({ platform: 'linux', canUseGpu: true }));

    expect(build.accelerator).toBe('vulkan');
    expect(build.assets[0]).toContain('ubuntu-vulkan');
  });

  it('gives Apple Silicon the Metal build and Intel Macs the CPU one', () => {
    const silicon = selectVlServerBuild(hardware({ platform: 'darwin', arch: 'arm64' }));
    const intel = selectVlServerBuild(hardware({ platform: 'darwin', arch: 'x64' }));

    expect(silicon.accelerator).toBe('metal');
    expect(intel.accelerator).toBe('cpu');
  });

  it('pins every asset to one llama.cpp build', () => {
    // A drifting build would change flags and quantisation formats under a released app.
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      for (const canUseGpu of [true, false]) {
        for (const asset of selectVlServerBuild(hardware({ platform, canUseGpu })).assets) {
          expect(asset).toContain(LLAMA_CPP_BUILD);
        }
      }
    }
  });

  it('counts the model download into the total, not just the archive', () => {
    // The weights are most of the wait; a figure that quoted only the binary would promise a
    // 40 MB download and then spend twenty minutes on 1.7 GB.
    const build = selectVlServerBuild(hardware());

    expect(vlServerDownloadBytes(build)).toBeGreaterThan(build.archiveBytes * 10);
  });
});
