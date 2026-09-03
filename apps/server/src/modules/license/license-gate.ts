// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  REGISTRATION_GRACE_DAYS,
  REVALIDATION_GRACE_DAYS,
  type LicenseGate,
  type LicenseRecord,
} from '@impressive-ocr/shared';

/**
 * Whether an installation may process documents, and how long is left if it is on a clock.
 *
 * A pure function of the stored record and the current time, which is the point: every rule
 * about who is allowed to work is in one place, decided by arithmetic, and testable without
 * a database, a clock or a network. Scattering `if (licence...)` through the queue is how a
 * licence check becomes a source of bugs that only appear on somebody else's calendar.
 *
 * **What `blocked` means is deliberately narrow.** It stops *new* OCR work. It does not hide
 * screens, does not touch results already produced, and does not interfere with registering —
 * a gate that stopped someone registering would lock them out of the one action it is asking
 * for. Nothing here deletes or withholds anything the user already has.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export function evaluateGate(record: LicenseRecord, now: Date): LicenseGate {
  if (record.state === 'active') {
    return activatedGate(record, now);
  }
  return trialGate(record, now);
}

/**
 * An activated installation, which is expected to check in occasionally.
 *
 * The clock runs from the last successful confirmation rather than from activation, so a
 * machine that talks to the licence server regularly never approaches the limit and one that
 * has been offline for two months is asked to reconnect rather than cut off silently.
 */
function activatedGate(record: LicenseRecord, now: Date): LicenseGate {
  // No recorded confirmation means the record predates the field. Treated as confirmed now
  // rather than as never — the alternative blocks a paying customer over a schema change.
  const since = parseDate(record.lastValidatedAt) ?? parseDate(record.activatedAt);
  if (since === null) {
    return { state: 'licensed', canProcess: true, daysRemaining: null, gracePeriodEndsAt: null };
  }

  const deadline = new Date(since.getTime() + REVALIDATION_GRACE_DAYS * DAY_MS);
  const remaining = daysBetween(now, deadline);

  if (remaining <= 0) {
    return {
      state: 'blocked',
      canProcess: false,
      daysRemaining: 0,
      gracePeriodEndsAt: deadline.toISOString(),
    };
  }

  // Only worth mentioning once it is close. A licence confirmed this morning should not
  // display a countdown for the next two months.
  const isStale = now.getTime() - since.getTime() > (REVALIDATION_GRACE_DAYS / 2) * DAY_MS;
  return {
    state: isStale ? 'offline-grace' : 'licensed',
    canProcess: true,
    daysRemaining: isStale ? remaining : null,
    gracePeriodEndsAt: isStale ? deadline.toISOString() : null,
  };
}

/** Not registered yet: usable for the trial period, counted from the first start. */
function trialGate(record: LicenseRecord, now: Date): LicenseGate {
  const started = parseDate(record.firstSeenAt);
  if (started === null) {
    // Nothing recorded yet, so this is the first start and the full period is ahead.
    return {
      state: 'trial',
      canProcess: true,
      daysRemaining: REGISTRATION_GRACE_DAYS,
      gracePeriodEndsAt: new Date(now.getTime() + REGISTRATION_GRACE_DAYS * DAY_MS).toISOString(),
    };
  }

  const deadline = new Date(started.getTime() + REGISTRATION_GRACE_DAYS * DAY_MS);
  const remaining = daysBetween(now, deadline);

  return remaining <= 0
    ? {
        state: 'blocked',
        canProcess: false,
        daysRemaining: 0,
        gracePeriodEndsAt: deadline.toISOString(),
      }
    : {
        state: 'trial',
        canProcess: true,
        daysRemaining: remaining,
        gracePeriodEndsAt: deadline.toISOString(),
      };
}

/**
 * Whole days from `now` until `deadline`, never negative.
 *
 * Rounded up, so "1 day left" means there is still some of it: rounding down would show 0 for
 * the last twenty-three hours of a period that has not actually ended, and 0 is the number
 * that reads as "you are out of time".
 */
function daysBetween(now: Date, deadline: Date): number {
  const ms = deadline.getTime() - now.getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / DAY_MS);
}

/** A stored timestamp, or null if it is absent or was hand-edited into nonsense. */
function parseDate(value: string | null): Date | null {
  if (value === null) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
