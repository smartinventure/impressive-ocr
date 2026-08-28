// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { progressFraction } from './use-quick-run';

/**
 * The regression these cover: a one-file run showed an indeterminate bar for its entire
 * duration and then jumped to done, because the fraction counted whole documents and a
 * single document is either 0 or 1. Page events were already arriving from both engines;
 * nothing was using them.
 */
describe('progressFraction', () => {
  it('advances with the pages of the only document', () => {
    const of = (pagesDone: number): number =>
      progressFraction({ finished: 0, total: 1, pagesDone, pageCount: 5 });

    expect(of(0)).toBe(0);
    expect(of(1)).toBeCloseTo(0.2);
    expect(of(3)).toBeCloseTo(0.6);
    expect(of(5)).toBe(1);
  });

  it('gives the in-flight document exactly one slot, so the bar never goes backwards', () => {
    // The moment page 5 of 5 lands and the moment the document is marked finished have to
    // sit at the same place; otherwise the bar visibly retreats between two polls.
    const lastPage = progressFraction({ finished: 1, total: 2, pagesDone: 4, pageCount: 4 });
    const documentDone = progressFraction({ finished: 2, total: 2, pagesDone: 0, pageCount: null });

    expect(lastPage).toBe(documentDone);
  });

  it('stays at zero while the page count is still unknown', () => {
    // The window where the models are loading. Any fraction here would be invented.
    expect(progressFraction({ finished: 0, total: 1, pagesDone: 0, pageCount: null })).toBe(0);
    expect(progressFraction({ finished: 0, total: 1, pagesDone: 3, pageCount: 0 })).toBe(0);
  });

  it('never exceeds one, whatever the sidecar reports', () => {
    expect(progressFraction({ finished: 1, total: 1, pagesDone: 9, pageCount: 5 })).toBe(1);
    expect(progressFraction({ finished: 3, total: 2, pagesDone: 0, pageCount: null })).toBe(1);
  });

  it('is zero for a run with no files rather than dividing by it', () => {
    expect(progressFraction({ finished: 0, total: 0, pagesDone: 2, pageCount: 4 })).toBe(0);
  });
});
