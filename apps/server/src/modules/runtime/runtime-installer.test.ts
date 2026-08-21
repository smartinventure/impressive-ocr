// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { progressAfter, progressBefore } from './runtime-installer';

/**
 * The progress weighting is what makes a five-minute install feel honest rather than stuck,
 * so the invariants are worth pinning down.
 */
describe('install progress weighting', () => {
  it('starts at zero', () => {
    expect(progressBefore('probe-hardware')).toBe(0);
  });

  it('ends at one hundred', () => {
    expect(progressAfter('verify')).toBe(100);
  });

  it('never moves backwards across the step order', () => {
    const steps = [
      'probe-hardware',
      'install-python',
      'create-venv',
      'install-paddle',
      'install-paddleocr',
      'download-models',
      'verify',
    ] as const;

    const values = steps.map((step) => progressAfter(step));

    expect(values).toEqual([...values].sort((a, b) => a - b));
  });

  it('gives the Paddle download the largest share of the bar', () => {
    // It is the longest wait by far; equal weighting would strand the bar mid-install.
    const paddleShare = progressAfter('install-paddle') - progressBefore('install-paddle');
    const venvShare = progressAfter('create-venv') - progressBefore('create-venv');

    expect(paddleShare).toBeGreaterThan(venvShare * 5);
  });

  it('has each step begin where the previous one ended', () => {
    expect(progressBefore('install-paddle')).toBe(progressAfter('create-venv'));
    expect(progressBefore('verify')).toBe(progressAfter('download-models'));
  });
});
