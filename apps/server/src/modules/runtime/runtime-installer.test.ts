// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { STEP_ORDER, advance, progressAfter, progressBefore, within } from './runtime-installer';

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
    // Walked rather than spot-checked: naming two steps only tests the gap between them, and
    // the bar silently jumped when a new step was inserted somewhere else in the order.
    for (let index = 1; index < STEP_ORDER.length; index += 1) {
      const previous = STEP_ORDER[index - 1];
      const step = STEP_ORDER[index];
      if (previous === undefined || step === undefined) {
        continue;
      }
      expect(progressBefore(step)).toBe(progressAfter(previous));
    }
  });

  it('moves the bar inside a step rather than parking it at the start', () => {
    // A step reporting only `progressBefore` freezes the bar for its whole duration. The
    // engine download did exactly that: six minutes motionless at 76%, reported as a hang.
    const start = progressBefore('download-vl-server');
    const end = progressAfter('download-vl-server');

    expect(within('download-vl-server', 0)).toBe(start);
    expect(within('download-vl-server', 1)).toBe(end);
    expect(within('download-vl-server', 0.5)).toBeGreaterThan(start);
    expect(within('download-vl-server', 0.5)).toBeLessThan(end);
  });

  it('never reports outside its own step, whatever fraction it is handed', () => {
    // Bytes received over an estimated total can exceed one; the bar must not run past the
    // step that owns it and start claiming another step's progress.
    expect(within('download-vl-server', 5)).toBe(progressAfter('download-vl-server'));
    expect(within('download-vl-server', -1)).toBe(progressBefore('download-vl-server'));
  });
});

/**
 * The bar during a step that takes minutes.
 *
 * Reported as "freezes at 11% installing PaddlePaddle". It was not frozen: `install-paddle`
 * begins at 10% and the bar was pinned to `floor + 1` for the whole step, so every one of the
 * several gigabytes it downloads was displayed as the same number.
 */
describe('install progress within a long step', () => {
  it('moves on every line rather than sitting on one number', () => {
    const early = within('install-paddle', advance(1));
    const later = within('install-paddle', advance(10));
    const muchLater = within('install-paddle', advance(60));

    expect(later).toBeGreaterThan(early);
    expect(muchLater).toBeGreaterThan(later);
  });

  it('never leaves the step it belongs to', () => {
    // A bar that ran past its own step would jump backwards when the next one started.
    const floor = progressBefore('install-paddle');
    const ceiling = progressAfter('install-paddle');

    for (const lines of [0, 1, 5, 50, 5_000]) {
      const percent = within('install-paddle', advance(lines));
      expect(percent).toBeGreaterThanOrEqual(floor);
      expect(percent).toBeLessThan(ceiling);
    }
  });

  it('does not claim a step is finished before it is', () => {
    // `stepDone` supplies the real 100%. Arriving early and then waiting is a worse lie than
    // crawling, because it tells the user the wait is over when it is not.
    expect(advance(1_000_000)).toBeLessThan(1);
  });

  it('starts at the floor rather than jumping', () => {
    expect(advance(0)).toBe(0);
    expect(within('install-paddle', advance(0))).toBe(progressBefore('install-paddle'));
  });
});
