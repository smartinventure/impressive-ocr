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

/**
 * The commercial licence itself — the terms an organisation is buying.
 *
 * A third document alongside the terms and the privacy policy in `consent.ts`, which is where
 * those two live; this file does not restate them. Linked rather than framed in an iframe,
 * and that is a security decision rather than a stylistic one: the UI runs inside Electron,
 * where embedding a remote page pulls third-party content into a window that also hosts the
 * application, which is precisely what `contextIsolation` and the CSP exist to prevent. It
 * would also show whatever is live at that moment, with no record of what was agreed to.
 */
export const COMMERCIAL_LICENCE_URL = 'https://speedbits.io/infinity-license-commercial/';

/**
 * Where a donation goes, for people running the free AGPL build.
 *
 * The plain hosted-button URL rather than PayPal's button SDK. The SDK would need a script and
 * an image from `paypalobjects.com` and calls of its own, which means widening three CSP
 * directives on an application whose policy is `defaultSrc 'self'` because it is local-first --
 * and it would report every launch to PayPal. This link does the same job and tells nobody
 * anything until it is clicked.
 */
export const DONATE_URL = 'https://www.paypal.com/donate/?hosted_button_id=XTDULY8RYRQ4A';

/**
 * Machines one personal registration covers.
 *
 * A courtesy limit rather than a technical one, and worth saying plainly in the UI: someone
 * who reaches it should be told to release a machine they no longer use, not accused of
 * anything.
 */
export const PERSONAL_SEAT_LIMIT = 3;

/**
 * Days a new installation may be used before it has to be registered.
 *
 * Counted from first start rather than from install, because that is the moment the software
 * can observe. Generous on purpose: the point is to give someone time to evaluate and to get
 * their key out of an inbox, not to catch anybody out.
 */
export const REGISTRATION_GRACE_DAYS = 30;

/**
 * Days an activated installation keeps working when the licence server cannot be reached.
 *
 * A separate, longer allowance from the one above, and it exists because the two failures are
 * nothing alike. An unregistered copy has not been paid for or claimed; a registered one has,
 * and its owner has done everything asked of them. Blocking that user because a server was
 * down — or because their laptop spent a fortnight offline — would punish the wrong person
 * for someone else's outage.
 */
export const REVALIDATION_GRACE_DAYS = 60;

export const licenseTierSchema = z.enum(['personal', 'commercial']);
export type LicenseTier = z.infer<typeof licenseTierSchema>;

/**
 * What the installation is currently entitled to.
 *
 * - `unregistered` — nothing has been chosen yet. First run, before the licence step.
 * - `awaiting-key` — a personal registration was submitted. The licence server has emailed a
 *   verification link, and the key itself arrives in a *second* email once that link is
 *   clicked. This state exists because registering does not return a key: without naming
 *   that step the screen would look finished when it is not.
 * - `active` — a key was accepted and this machine holds a seat.
 * - `invalid` — the server refused the key, or every seat is in use.
 */
export const licenseStateSchema = z.enum(['unregistered', 'awaiting-key', 'active', 'invalid']);
export type LicenseState = z.infer<typeof licenseStateSchema>;

/**
 * Whether this installation may currently process documents.
 *
 * - `licensed` — activated, and confirmed within the revalidation window.
 * - `trial` — not registered yet, still inside the initial grace period.
 * - `offline-grace` — activated, but the licence server has not been reachable lately.
 * - `blocked` — the grace period ran out.
 *
 * **`blocked` stops new OCR work and nothing else.** Every screen stays reachable, results
 * already produced stay downloadable, settings stay editable, and registration is obviously
 * still possible — a gate that prevented someone registering would be a bug that locks the
 * user out of the very thing it is asking them to do.
 */
export const licenseGateStateSchema = z.enum(['licensed', 'trial', 'offline-grace', 'blocked']);
export type LicenseGateState = z.infer<typeof licenseGateStateSchema>;

export const licenseGateSchema = z.object({
  state: licenseGateStateSchema,
  /** True when new documents may be processed. The one thing callers usually want. */
  canProcess: z.boolean(),
  /** Whole days left in the current grace period; null when nothing is counting down. */
  daysRemaining: z.number().int().min(0).nullable(),
  /** When the grace period ends, for a screen that wants to say a date. */
  gracePeriodEndsAt: isoTimestampSchema.nullable(),
});

export type LicenseGate = z.infer<typeof licenseGateSchema>;

export const licenseStatusSchema = z.object({
  state: licenseStateSchema,
  tier: licenseTierSchema.nullable(),
  /** Shown back so the user can see which address the key was sent to. */
  email: z.string().nullable(),
  /**
   * The key with all but its last group masked.
   *
   * Never the whole key: this is served to any browser that can reach the API, and a licence
   * key is a bearer credential for the seats it carries.
   */
  maskedKey: z.string().nullable(),
  activatedAt: isoTimestampSchema.nullable(),
  /**
   * ISO date the licence itself stops working. Null for perpetual, which is what is sold.
   *
   * Kept apart from `updatesUntil` because the licence server tracks two independent clocks
   * and conflating them is the expensive mistake: one ends the licence, the other ends only
   * the update entitlement.
   */
  licenseExpires: isoTimestampSchema.nullable(),
  /**
   * When the update entitlement lapses.
   *
   * Named for what actually ends. Passing this date stops **automatic updates and nothing
   * else**: the licence is perpetual, the installed version keeps working indefinitely, and
   * every feature stays available. Anything that reads this field and behaves as though the
   * software has expired is a bug, and the name is chosen to make that obvious at the call
   * site. Null means updates never expire.
   */
  updatesUntil: isoTimestampSchema.nullable(),
  /** True once the update window has closed. The software is unaffected. */
  updateAccessExpired: z.boolean(),
  /** Seats used and allowed, when the server reported them. */
  seatsUsed: z.number().int().min(0).nullable(),
  seatsAllowed: z.number().int().min(1).nullable(),
  /** Why the last attempt failed, for the user. Never a raw server error. */
  message: z.string().nullable(),
  /**
   * The licence server's own code for the last attempt — `NO_SEATS_AVAILABLE`,
   * `VALIDATION_FAILED`, `LICENSE_EXPIRED` — or null when nothing has been attempted.
   *
   * Shown rather than swallowed. The prose alone is often not enough to act on, and it is
   * the code that a support conversation can be about: "it says my key is wrong" and
   * "NO_SEATS_AVAILABLE" lead to entirely different answers. Kept beside `message` rather
   * than replacing it, because the code is for whoever is helping and the sentence is for
   * whoever is stuck.
   */
  code: z.string().nullable(),
  /** Whether work may proceed, and how long is left if it is on a clock. */
  gate: licenseGateSchema,
});

export type LicenseStatus = z.infer<typeof licenseStatusSchema>;

/**
 * Ask for a free personal licence.
 *
 * The email is the registration: it is where the verification link goes, where the key is
 * sent afterwards, and what ties the three machines together. Nothing else about the user is
 * collected, and no document ever leaves the machine — that promise is not weakened by this.
 */
export const registerPersonalRequestSchema = z.object({
  email: z.string().email().max(254),
  /**
   * ISO 3166-1 alpha-2, e.g. `DE`.
   *
   * Required, despite the licence server's API reference listing it as optional — a
   * registration without it is rejected with `"country" is required`. Documented here rather
   * than discovered again by the next person, and collected by the form rather than guessed
   * from a locale: a browser's locale says what language someone reads, not where they are,
   * and this ends up on a licence record.
   */
  country: z.string().length(2).toUpperCase(),
});

export type RegisterPersonalRequest = z.infer<typeof registerPersonalRequestSchema>;

/**
 * Activate a key. One shape for both tiers, because the licence server takes one call.
 *
 * A personal user reaches this with the key they were emailed; a commercial user with the one
 * from their purchase. The tier is sent so the server can refuse a key belonging to the other
 * product rather than recording the wrong one.
 */
export const activateLicenseRequestSchema = z.object({
  tier: licenseTierSchema,
  email: z.string().email().max(254),
  /** Trimmed and upper-cased before it is sent; users paste these out of emails. */
  licenseKey: z.string().min(8).max(200),
});

export type ActivateLicenseRequest = z.infer<typeof activateLicenseRequestSchema>;

/**
 * Hand this machine's seat back.
 *
 * Releases the seat on the licence server *and* clears the local record, so the machine can
 * be decommissioned and its seat used elsewhere. Idempotent on the server side: a machine
 * that holds no seat is a success, not an error.
 */
export const releaseSeatRequestSchema = z.object({
  /** Guards against a stray click: the caller has to say it means it. */
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
  /**
   * When this installation was first seen, which is when the trial period starts.
   *
   * Defaulted rather than required so an installation that predates this field is treated as
   * new rather than as already expired — the harsher reading of a missing value would block
   * someone on the strength of a schema change.
   */
  firstSeenAt: isoTimestampSchema.nullable().default(null),
  /** Last time the licence server confirmed this activation. Starts the offline allowance. */
  lastValidatedAt: isoTimestampSchema.nullable().default(null),
  licenseExpires: isoTimestampSchema.nullable().default(null),
  updatesUntil: isoTimestampSchema.nullable().default(null),
  updateAccessExpired: z.boolean().default(false),
  seatsUsed: z.number().int().min(0).nullable().default(null),
  seatsAllowed: z.number().int().min(1).nullable().default(null),
  message: z.string().nullable().default(null),
  code: z.string().nullable().default(null),
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
