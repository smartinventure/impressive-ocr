// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  MIN_VRAM_BYTES_FOR_GPU,
  MIN_VRAM_GIB_FOR_GPU,
  supportsAccurateProfile,
  type GpuInfo,
} from '@impressive-ocr/shared';
import { describeGpuReason, parseGpuTable } from './gpu-probe';

/**
 * The parsing and messaging are tested here because the machine that runs CI — and the one
 * this was written on — has no NVIDIA GPU, so the happy path can never be exercised live.
 */

describe('parseGpuTable', () => {
  it('parses a single discrete GPU, converting MiB to bytes', () => {
    const gpus = parseGpuTable('NVIDIA GeForce RTX 4070, 12282, 8.9, 566.03\n');

    expect(gpus).toHaveLength(1);
    expect(gpus[0]).toMatchObject({
      name: 'NVIDIA GeForce RTX 4070',
      computeCapability: 8.9,
      driverVersion: '566.03',
    });
    expect(gpus[0]?.vramBytes).toBe(12282 * 1024 * 1024);
  });

  it('parses several GPUs', () => {
    const gpus = parseGpuTable(
      'NVIDIA T400, 4096, 7.5, 550.54\nNVIDIA RTX A5000, 24564, 8.6, 550.54\n',
    );

    expect(gpus.map((gpu) => gpu.name)).toEqual(['NVIDIA T400', 'NVIDIA RTX A5000']);
  });

  it('ignores blank lines', () => {
    expect(parseGpuTable('\n\n')).toEqual([]);
  });

  it('skips a row whose memory column is not a number', () => {
    // A driver in a bad state prints [N/A]; one unreadable row must not lose the others.
    const gpus = parseGpuTable('Broken GPU, [N/A], 8.6, 550.54\nGood GPU, 8192, 8.6, 550.54\n');

    expect(gpus.map((gpu) => gpu.name)).toEqual(['Good GPU']);
  });

  it('defaults a missing compute capability to zero so it fails the threshold', () => {
    const gpus = parseGpuTable('Old GPU, 8192\n');

    expect(gpus[0]?.computeCapability).toBe(0);
    expect(gpus[0]?.driverVersion).toBe('unknown');
  });
});

describe('describeGpuReason', () => {
  it('tells the user a CUDA Toolkit is not needed', () => {
    // The paddlepaddle-gpu wheel bundles CUDA; sending users to the Toolkit installer
    // would be a long, pointless detour.
    const message = describeGpuReason('no-nvidia-driver', null);

    expect(message).toContain('CUDA Toolkit is not required');
  });

  it('names the card and both VRAM figures when there is not enough memory', () => {
    const message = describeGpuReason('insufficient-vram', {
      name: 'NVIDIA GT 1030',
      vramBytes: 2 * 1024 ** 3,
      computeCapability: 7.5,
      driverVersion: '550.54',
    });

    expect(message).toContain('NVIDIA GT 1030');
    expect(message).toContain('2.0 GB');
    // The GPU floor, not the VL floor: this message is about using the card at all.
    expect(message).toContain(`${MIN_VRAM_GIB_FOR_GPU} GB card or larger`);
  });
});

describe('VRAM thresholds', () => {
  /**
   * The regression that prompted all of this: an RTX 4060 Ti 8 GB reports 8188 MiB, and the
   * VL floor was a whole 8 GiB — so the card missed it by 4 MiB, the machine was declared to
   * have no usable GPU, and the installer chose the CPU-only PaddlePaddle wheel. No 8 GB card
   * could ever have passed.
   */
  const rtx4060Ti8Gb: GpuInfo = {
    name: 'NVIDIA GeForce RTX 4060 Ti',
    vramBytes: 8188 * 1024 * 1024,
    computeCapability: 8.9,
    driverVersion: '591.86',
  };

  it('admits an 8 GB card to the accurate profile despite it reporting under 8 GiB', () => {
    expect(rtx4060Ti8Gb.vramBytes).toBeLessThan(8 * 1024 ** 3);
    expect(supportsAccurateProfile(rtx4060Ti8Gb)).toBe(true);
  });

  it('keeps a 4 GB card off the accurate profile but above the GPU floor', () => {
    const t400: GpuInfo = {
      name: 'NVIDIA T400',
      vramBytes: 4096 * 1024 * 1024,
      computeCapability: 7.5,
      driverVersion: '550.54',
    };

    expect(supportsAccurateProfile(t400)).toBe(false);
    expect(t400.vramBytes).toBeGreaterThanOrEqual(MIN_VRAM_BYTES_FOR_GPU);
  });

  it('rejects a card below the GPU floor outright', () => {
    expect(2 * 1024 ** 3).toBeLessThan(MIN_VRAM_BYTES_FOR_GPU);
  });

  it('treats no GPU as unable to run the accurate profile', () => {
    expect(supportsAccurateProfile(null)).toBe(false);
  });

  it('names the compute capability shortfall', () => {
    const message = describeGpuReason('compute-capability-too-low', {
      name: 'NVIDIA GTX 1060',
      vramBytes: 6 * 1024 ** 3,
      computeCapability: 6.1,
      driverVersion: '550.54',
    });

    expect(message).toContain('6.1');
    expect(message).toContain('7');
  });
});
