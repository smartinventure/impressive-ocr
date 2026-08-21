// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { MIN_VRAM_BYTES_FOR_VL } from '@impressive-ocr/shared';
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
      name: 'NVIDIA T400',
      vramBytes: 4 * 1024 ** 3,
      computeCapability: 7.5,
      driverVersion: '550.54',
    });

    expect(message).toContain('NVIDIA T400');
    expect(message).toContain('4.0 GB');
    expect(message).toContain(`${(MIN_VRAM_BYTES_FOR_VL / 1024 ** 3).toFixed(1)} GB`);
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
