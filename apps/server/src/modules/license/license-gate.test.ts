// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  REGISTRATION_GRACE_DAYS,
  REVALIDATION_GRACE_DAYS,
  licenseRecordSchema,
  type LicenseRecord,
} from '@impressive-ocr/shared';
import { evaluateGate } from './license-gate';

/**
 * The arithmetic that decides whether someone can work.
 *
 * Worth heavier testing than most of this codebase, because the failure is invisible until a
 * date arrives: a mistake here does nothing at all for a month and then stops a paying
 * customer processing documents on an ordinary Tuesday. Every boundary is pinned, and both
 * directions of every boundary.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-06-01T12:00:00.000Z');

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY).toISOString();
}

function record(overrides: Partial<LicenseRecord> = {}): LicenseRecord {
  return { ...licenseRecordSchema.parse({}), ...overrides };
}

describe('evaluateGate, before registration', () => {
  it('gives a brand-new installation the full period', () => {
    const gate = evaluateGate(record(), NOW);

    expect(gate.state).toBe('trial');
    expect(gate.canProcess).toBe(true);
    expect(gate.daysRemaining).toBe(REGISTRATION_GRACE_DAYS);
  });

  it('counts down from the first start', () => {
    const gate = evaluateGate(record({ firstSeenAt: daysAgo(10) }), NOW);

    expect(gate.state).toBe('trial');
    expect(gate.daysRemaining).toBe(REGISTRATION_GRACE_DAYS - 10);
  });

  it('still works on the last day', () => {
    // Rounding down here would show 0 for the final twenty-three hours of a period that has
    // not ended, and 0 is the number that reads as "you are out of time".
    const gate = evaluateGate(record({ firstSeenAt: daysAgo(REGISTRATION_GRACE_DAYS - 0.5) }), NOW);

    expect(gate.canProcess).toBe(true);
    expect(gate.daysRemaining).toBe(1);
  });

  it('blocks once the period has run out', () => {
    const gate = evaluateGate(record({ firstSeenAt: daysAgo(REGISTRATION_GRACE_DAYS + 1) }), NOW);

    expect(gate.state).toBe('blocked');
    expect(gate.canProcess).toBe(false);
    expect(gate.daysRemaining).toBe(0);
  });

  it('treats a hand-edited start date as a fresh start rather than an expiry', () => {
    // The row is JSON in a file the user owns. Unreadable nonsense must not be the harsher
    // reading: blocking someone because a timestamp was corrupted would be indefensible.
    const gate = evaluateGate(record({ firstSeenAt: 'not-a-date' }), NOW);

    expect(gate.canProcess).toBe(true);
  });
});

describe('evaluateGate, once activated', () => {
  it('lets a recently confirmed licence work with no countdown', () => {
    const gate = evaluateGate(
      record({ state: 'active', tier: 'personal', lastValidatedAt: daysAgo(1) }),
      NOW,
    );

    expect(gate.state).toBe('licensed');
    expect(gate.canProcess).toBe(true);
    // A licence confirmed yesterday should not display a countdown for the next two months.
    expect(gate.daysRemaining).toBeNull();
  });

  it('warns once the confirmation is getting old, without stopping anything', () => {
    const gate = evaluateGate(
      record({ state: 'active', lastValidatedAt: daysAgo(REVALIDATION_GRACE_DAYS - 5) }),
      NOW,
    );

    expect(gate.state).toBe('offline-grace');
    expect(gate.canProcess).toBe(true);
    expect(gate.daysRemaining).toBe(5);
  });

  it('gives an activated installation far longer offline than an unregistered one', () => {
    // The two failures are nothing alike. An unregistered copy has not been claimed; a
    // registered one has, and its owner has done everything asked of them.
    expect(REVALIDATION_GRACE_DAYS).toBeGreaterThan(REGISTRATION_GRACE_DAYS);

    const past = daysAgo(REGISTRATION_GRACE_DAYS + 5);
    expect(evaluateGate(record({ state: 'active', lastValidatedAt: past }), NOW).canProcess).toBe(
      true,
    );
    expect(evaluateGate(record({ firstSeenAt: past }), NOW).canProcess).toBe(false);
  });

  it('blocks only after the offline allowance is exhausted', () => {
    const gate = evaluateGate(
      record({ state: 'active', lastValidatedAt: daysAgo(REVALIDATION_GRACE_DAYS + 1) }),
      NOW,
    );

    expect(gate.state).toBe('blocked');
    expect(gate.canProcess).toBe(false);
  });

  it('falls back to the activation date when no confirmation was recorded', () => {
    const gate = evaluateGate(record({ state: 'active', activatedAt: daysAgo(2) }), NOW);

    expect(gate.canProcess).toBe(true);
  });

  it('does not block a licence recorded before these fields existed', () => {
    // An installation upgraded into this feature has neither timestamp. Blocking it on a
    // schema change would take away something the user already paid for.
    const gate = evaluateGate(record({ state: 'active', tier: 'commercial' }), NOW);

    expect(gate.state).toBe('licensed');
    expect(gate.canProcess).toBe(true);
  });
});

describe('evaluateGate, when a licence is refused', () => {
  it('falls back to the trial clock rather than blocking outright', () => {
    // `invalid` means the server said no — a typo, or a revoked key. That is a reason to ask
    // again, not to stop a machine that is still inside its trial period.
    const gate = evaluateGate(record({ state: 'invalid', firstSeenAt: daysAgo(2) }), NOW);

    expect(gate.state).toBe('trial');
    expect(gate.canProcess).toBe(true);
  });

  it('blocks an invalid licence once the trial has also run out', () => {
    const gate = evaluateGate(
      record({ state: 'invalid', firstSeenAt: daysAgo(REGISTRATION_GRACE_DAYS + 1) }),
      NOW,
    );

    expect(gate.canProcess).toBe(false);
  });
});
