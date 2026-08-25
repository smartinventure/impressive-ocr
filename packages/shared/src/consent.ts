// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { isoTimestampSchema } from './common';

/**
 * First-run agreement to the terms, the privacy policy and the licence.
 *
 * Recorded in the application's own state rather than in an installer, because the installer
 * is not a place every user passes through: the AppImage is run, not installed, the container
 * has no installer at all, and someone using the headless server over a browser never sees
 * one. Consent asked for by the application itself is the only prompt all of them reach — and
 * the only one that can be recorded, and asked again when the terms change.
 */

/**
 * Bumped whenever the terms, the privacy policy or the licensing summary change materially.
 *
 * Acceptance is stored as the version that was agreed to, so raising this re-prompts everyone
 * exactly once. Storing a bare boolean would silently carry an agreement to superseded terms.
 */
export const CONSENT_TERMS_VERSION = 1;

/** The documents a user is agreeing to. Absolute, because they are also opened from email. */
export const TERMS_URL = 'https://speedbits.io/terms-conditions/';
export const PRIVACY_URL = 'https://speedbits.io/privacy-policy/';
export const LICENCE_ENQUIRY_URL = 'https://www.speedbits.io';

export const consentStatusSchema = z.object({
  /** 0 when nothing has ever been accepted, which is the fresh-install case. */
  acceptedVersion: z.number().int().min(0),
  acceptedAt: isoTimestampSchema.nullable(),
  /** What the application currently requires. The client compares rather than hard-coding. */
  requiredVersion: z.number().int().min(1),
  /** Precomputed so no screen has to re-derive the comparison and get it subtly wrong. */
  isCurrent: z.boolean(),
});

export type ConsentStatus = z.infer<typeof consentStatusSchema>;

export const acceptConsentRequestSchema = z.object({
  /**
   * Echoed back by the client, so agreeing to a screen that a background update has since
   * replaced does not silently record consent to terms the user never read.
   */
  version: z.number().int().min(1),
});

export type AcceptConsentRequest = z.infer<typeof acceptConsentRequestSchema>;

/** What is persisted. The status above is derived from this. */
export const consentRecordSchema = z.object({
  acceptedVersion: z.number().int().min(0).default(0),
  acceptedAt: isoTimestampSchema.nullable().default(null),
});

export type ConsentRecord = z.infer<typeof consentRecordSchema>;
