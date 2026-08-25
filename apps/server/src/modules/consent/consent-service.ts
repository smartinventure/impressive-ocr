// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from 'drizzle-orm';
import { APP_STATE_KEYS, appState, type Database_ } from '@impressive-ocr/db';
import {
  CONSENT_TERMS_VERSION,
  consentRecordSchema,
  type ConsentRecord,
  type ConsentStatus,
} from '@impressive-ocr/shared';

/**
 * Records that the user agreed to the terms, the privacy policy and the licence.
 *
 * Server-side rather than in browser storage: the same installation is reached from the
 * desktop shell and from a browser on another machine, and an agreement that evaporates when
 * someone clears their cookies was never an agreement worth recording.
 */

export class ConsentVersionMismatchError extends Error {
  constructor(
    readonly submitted: number,
    readonly required: number,
  ) {
    super(`Consent for version ${submitted} was submitted, but ${required} is required`);
    this.name = 'ConsentVersionMismatchError';
  }
}

export class ConsentService {
  constructor(private readonly db: Database_) {}

  status(): ConsentStatus {
    const record = this.read();
    return {
      acceptedVersion: record.acceptedVersion,
      acceptedAt: record.acceptedAt,
      requiredVersion: CONSENT_TERMS_VERSION,
      isCurrent: record.acceptedVersion >= CONSENT_TERMS_VERSION,
    };
  }

  /**
   * Record agreement to a specific version.
   *
   * The version is checked rather than trusted: a client that has been open across an update
   * would otherwise record consent to the terms it happens to be holding, which are not the
   * ones on screen.
   */
  accept(version: number): ConsentStatus {
    if (version !== CONSENT_TERMS_VERSION) {
      throw new ConsentVersionMismatchError(version, CONSENT_TERMS_VERSION);
    }

    const record: ConsentRecord = {
      acceptedVersion: version,
      acceptedAt: new Date().toISOString(),
    };

    this.db
      .insert(appState)
      .values({
        key: APP_STATE_KEYS.consent,
        value: record,
        updatedAt: record.acceptedAt ?? new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: appState.key,
        set: { value: record, updatedAt: record.acceptedAt ?? new Date().toISOString() },
      })
      .run();

    return this.status();
  }

  /**
   * Not cached.
   *
   * This is read once per session on a screen the user is already waiting on, and a stale
   * cache here would mean re-prompting someone who has just agreed — or worse, not prompting
   * someone who has not.
   */
  private read(): ConsentRecord {
    const row = this.db
      .select()
      .from(appState)
      .where(eq(appState.key, APP_STATE_KEYS.consent))
      .get();

    // An absent or hand-edited row degrades to "never accepted", which fails closed: the
    // worst outcome is asking a user to agree a second time.
    const parsed = consentRecordSchema.safeParse(row?.value ?? {});
    return parsed.success ? parsed.data : { acceptedVersion: 0, acceptedAt: null };
  }
}
