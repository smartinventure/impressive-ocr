// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { GpuInfo, HardwareCapabilities } from '@impressive-ocr/shared';
import { pipInstallArgs, selectCudaBuild, selectWheel } from './wheel-index';

function hardware(overrides: Partial<HardwareCapabilities> = {}): HardwareCapabilities {
  return {
    platform: 'win32',
    arch: 'x64',
    cpuModel: 'Test CPU',
    cpuCores: 8,
    totalMemoryBytes: 32 * 1024 ** 3,
    gpu: null,
    gpuUnavailableReason: 'no-nvidia-driver',
    canUseGpu: false,
    availableProfiles: ['fast'],
    probedAt: '2026-08-19T00:00:00.000Z',
    ...overrides,
  };
}

function gpu(overrides: Partial<GpuInfo> = {}): GpuInfo {
  return {
    name: 'NVIDIA GeForce RTX 4070',
    vramBytes: 12 * 1024 ** 3,
    computeCapability: 8.9,
    driverVersion: '566.03',
    ...overrides,
  };
}

describe('selectWheel', () => {
  it('picks the CPU wheel when no GPU qualifies', () => {
    const selection = selectWheel(hardware());

    expect(selection.flavor).toBe('cpu');
    expect(selection.packageName).toBe('paddlepaddle');
    expect(selection.indexUrl).toBeUndefined();
  });

  it('picks a GPU wheel from PaddlePaddle own index for a qualifying card', () => {
    const selection = selectWheel(
      hardware({ gpu: gpu(), canUseGpu: true, gpuUnavailableReason: null }),
    );

    expect(selection.flavor).toBe('gpu');
    expect(selection.packageName).toBe('paddlepaddle-gpu');
    expect(selection.indexUrl).toContain('paddlepaddle.org.cn');
    expect(selection.description).toContain('bundled CUDA');
  });

  it('falls back to CPU when the driver is too old for any bundled CUDA', () => {
    // A capable card behind an ancient driver: downloading gigabytes that cannot load
    // would be worse than quietly using the CPU build.
    const selection = selectWheel(
      hardware({
        gpu: gpu({ driverVersion: '390.77' }),
        canUseGpu: true,
        gpuUnavailableReason: null,
      }),
    );

    expect(selection.flavor).toBe('cpu');
  });
});

describe('selectCudaBuild', () => {
  it('prefers the newest CUDA a modern driver supports', () => {
    expect(selectCudaBuild(gpu({ driverVersion: '566.03' }), 'win32')?.cuda).toBe('12.9');
  });

  it('drops to CUDA 11.8 for a driver that predates the 12.x series', () => {
    expect(selectCudaBuild(gpu({ driverVersion: '470.82' }), 'linux')?.cuda).toBe('11.8');
  });

  it('applies the lower Linux driver floor', () => {
    // Driver 525 clears Linux CUDA 12.x but not the Windows floor of 527.
    expect(selectCudaBuild(gpu({ driverVersion: '525.60' }), 'linux')?.cuda).toBe('12.9');
    expect(selectCudaBuild(gpu({ driverVersion: '525.60' }), 'win32')?.cuda).toBe('11.8');
  });

  it('chooses the most conservative build when the driver version is unreadable', () => {
    expect(selectCudaBuild(gpu({ driverVersion: 'unknown' }), 'win32')?.cuda).toBe('11.8');
  });

  it('returns null when even the oldest build is out of reach', () => {
    expect(selectCudaBuild(gpu({ driverVersion: '390.77' }), 'win32')).toBeNull();
  });
});

describe('pipInstallArgs', () => {
  it('installs the CPU wheel from plain PyPI', () => {
    expect(pipInstallArgs(selectWheel(hardware()))).toEqual([
      'pip',
      'install',
      '--upgrade',
      'paddlepaddle',
    ]);
  });

  it('pins the GPU index with --index-url, not --extra-index-url', () => {
    // With an extra index pip resolves across both and can silently install the CPU build.
    const args = pipInstallArgs(
      selectWheel(hardware({ gpu: gpu(), canUseGpu: true, gpuUnavailableReason: null })),
    );

    expect(args).toContain('--index-url');
    expect(args).not.toContain('--extra-index-url');
  });

  it('pins an exact version when one is given', () => {
    expect(pipInstallArgs(selectWheel(hardware()), '3.2.2')).toContain('paddlepaddle==3.2.2');
  });
});
