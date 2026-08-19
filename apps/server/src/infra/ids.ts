// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes, randomUUID } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

/**
 * Lexicographically sortable, time-prefixed id (ULID-shaped).
 *
 * Sortability is the point: job ids double as a stable tiebreaker for arrival order in the
 * scheduler, so two jobs discovered in the same millisecond still have a deterministic
 * order — and a UUIDv4 primary key would scatter SQLite's B-tree inserts.
 */
export function createId(): string {
  return encodeTime(Date.now()) + encodeRandom();
}

function encodeTime(timestamp: number): string {
  let remaining = timestamp;
  let result = '';
  for (let index = 0; index < 10; index += 1) {
    const digit = remaining % 32;
    result = ENCODING[digit] + result;
    remaining = (remaining - digit) / 32;
  }
  return result;
}

function encodeRandom(): string {
  const bytes = randomBytes(16);
  let result = '';
  for (const byte of bytes) {
    result += ENCODING[byte % 32];
  }
  return result;
}

/**
 * Per-launch shared secret for the sidecar API.
 *
 * Regenerated on every start so a token leaked into a log or a crash dump stops working as
 * soon as the app restarts.
 */
export function createAuthToken(): string {
  return randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
}
