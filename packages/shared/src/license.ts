// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { isoTimestampSchema } from './common';

/**
 * Licensing: which of the two licences this installation is running under, and the record
 * proving it.
 *
 * Impressive OCR is dual licensed. Anyone may run it under the AGPL-3.0, which is what makes
 * it free for personal use; an organisation that does not want the AGPL's obligations —
 * §13 in particular, which requires offering complete corresponding source to anyone
 * interacting with it over a network — buys a commercial licence instead. The two tiers here
 * are those two choices, not a feature split: **nothing is withheld from either**. What
 * differs is the legal basis and, for the personal tier, a courtesy limit on how many
 * machines one registration covers.
 *
 * That distinction matters for how this is built. This is a registration and entitlement
 * record, not a copy-protection scheme, and it should not grow into one: the source is
 * published under a licence that permits removing it.
 */

/** Where a licence is bought, and where a personal registration is confirmed. */
export const LICENSE_PORTAL_URL = 'https://www.speedbits.io';

/**
 * Machines one personal registration covers.
 *
 * A courtesy limit rather than a technical one, and worth saying plainly in the UI: someone
 * who reaches it should be told to release a machine they no longer use, not accused of
 * anything.
 */
export const PERSONAL_SEAT_LIMIT = 3;

export const licenseTierSchema = z.enum(['personal', 'commercial']);
export type LicenseTier = z.infer<typeof licenseTierSchema>;

/**
 * What the installation is currently entitled to.
 *
 * - `unregistered` — nothing has been chosen yet. First run, before the licence step.
 * - `pending-confirmation` — a personal registration exists but the email has not been
 *   confirmed. The product works; the registration is not yet complete.
 * - `active` — registered and confirmed, or a commercial key that activated.
 * - `invalid` — the server rejected the key, or the seat limit was reached.
 */
export const licenseStateSchema = z.enum([
  'unregistered',
  'pending-confirmation',
  'active',
  'invalid',
]);
export type LicenseState = z.infer<typeof licenseStateSchema>;

export const licenseStatusSchema = z.object({
  state: licenseStateSchema,
  tier: licenseTierSchema.nullable(),
  /** Shown back to the user so they can see which address needs confirming. */
  email: z.string().email().nullable(),
  /**
   * The key with all but its last group masked.
   *
   * Never the whole key: this is served to any browser that can reach the API, and a licence
   * key is a bearer credential for the seats it carries.
   */
  maskedKey: z.string().nullable(),
  activatedAt: isoTimestampSchema.nullable(),
  /**
   * When the update entitlement lapses, for a commercial licence.
   *
   * Named for what actually ends. Passing this date stops **automatic updates and nothing
   * else**: the licence is perpetual, the installed version keeps working indefinitely, and
   * every feature stays available. Anything that reads this field and behaves as though the
   * software has expired is a bug, and the name is chosen to make that obvious at the call
   * site. Null means no update entitlement was recorded.
   */
  updatesUntil: isoTimestampSchema.nullable(),
  /** Seats used and allowed, when the server reported them. */
  seatsUsed: z.number().int().min(0).nullable(),
  seatsAllowed: z.number().int().min(1).nullable(),
  /** Why the last attempt failed, for the user. Never a raw server error. */
  message: z.string().nullable(),
});

export type LicenseStatus = z.infer<typeof licenseStatusSchema>;

/**
 * Register for the personal tier.
 *
 * The email is the registration: it is what a confirmation is sent to and what ties the three
 * machines together. Nothing else about the user is collected, and no document ever leaves
 * the machine — that promise is not weakened by this.
 */
export const registerPersonalRequestSchema = z.object({
  email: z.string().email().max(254),
});

export type RegisterPersonalRequest = z.infer<typeof registerPersonalRequestSchema>;

/** Activate a purchased commercial licence. */
export const activateCommercialRequestSchema = z.object({
  email: z.string().email().max(254),
  /** Trimmed and upper-cased before it is sent; users paste these out of emails. */
  licenseKey: z.string().min(8).max(200),
});

export type ActivateCommercialRequest = z.infer<typeof activateCommercialRequestSchema>;

/**
 * Hand this machine's seat back.
 *
 * Present from the start deliberately. Activation happens once and the app never contacts the
 * server again, so without a way to release a seat, replacing a computer would consume one of
 * three permanently — with the only remedy being a support ticket. Adding this afterwards
 * would mean changing a contract already deployed to users.
 */
export const releaseSeatRequestSchema = z.object({
  /** Guards against a stray click: the caller has to name what it is releasing. */
  confirm: z.literal(true),
});

export type ReleaseSeatRequest = z.infer<typeof releaseSeatRequestSchema>;

/** What is persisted locally. The status above is derived from it. */
export const licenseRecordSchema = z.object({
  state: licenseStateSchema.default('unregistered'),
  tier: licenseTierSchema.nullable().default(null),
  email: z.string().nullable().default(null),
  licenseKey: z.string().nullable().default(null),
  /** This machine's identifier as the server knows it, so a release can name it. */
  machineId: z.string().nullable().default(null),
  activatedAt: isoTimestampSchema.nullable().default(null),
  updatesUntil: isoTimestampSchema.nullable().default(null),
  seatsUsed: z.number().int().min(0).nullable().default(null),
  seatsAllowed: z.number().int().min(1).nullable().default(null),
  message: z.string().nullable().default(null),
});

export type LicenseRecord = z.infer<typeof licenseRecordSchema>;

/**
 * Show a key without handing it over: `IMPR-…-7K3D`.
 *
 * Enough to tell two licences apart in a support conversation, useless to anyone who
 * intercepts it.
 */
export function maskLicenseKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 8) {
    return '••••';
  }
  const groups = trimmed.split('-');
  const last = groups[groups.length - 1] ?? trimmed.slice(-4);
  return `${trimmed.slice(0, 4)}-••••-${last}`;
}
