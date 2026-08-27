// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from 'drizzle-orm';
import { APP_STATE_KEYS, appState, type Database_ } from '@impressive-ocr/db';
import {
  licenseRecordSchema,
  maskLicenseKey,
  type ActivateLicenseRequest,
  type LicenseRecord,
  type LicenseStatus,
  type RegisterPersonalRequest,
} from '@impressive-ocr/shared';
import type { Logger } from '../../infra/logger';
import { LicenseServerError, type LicenseClient } from './license-client';
import { machineId } from './machine-id';

/**
 * Which of the two licences this installation runs under.
 *
 * A registration and entitlement record, not a copy-protection scheme, and the difference is
 * deliberate. Impressive OCR is dual licensed: the personal tier is the AGPL grant everyone
 * already has, the commercial tier is what an organisation buys to be released from the
 * AGPL's obligations. **Neither tier withholds a feature, and nothing here refuses to process
 * a document.** The source is published under a licence that permits deleting this file, so a
 * lock built on it would inconvenience honest users and stop nobody else.
 *
 * The one thing entitlement does gate is **automatic updates**, and only for the commercial
 * tier: past `updatesUntil` the installed version keeps working with every feature, and stops
 * being offered newer releases. That is what was bought, and it is enforced by the licence
 * server rather than by us.
 *
 * The flow has two steps and is worth stating, because it is not the obvious one:
 *
 * - Personal: register an email, verify it from the inbox, receive a key **by email**, then
 *   enter that key. Registration alone does not activate anything.
 * - Commercial: the key came with the purchase, so only the second step applies.
 */

export class LicenseActivationError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LicenseActivationError';
  }
}

export interface LicenseServiceOptions {
  db: Database_;
  client: LicenseClient;
  logger: Logger;
}

export class LicenseService {
  constructor(private readonly options: LicenseServiceOptions) {}

  status(): LicenseStatus {
    const record = this.read();
    return {
      state: record.state,
      tier: record.tier,
      email: record.email,
      maskedKey: record.licenseKey === null ? null : maskLicenseKey(record.licenseKey),
      activatedAt: record.activatedAt,
      licenseExpires: record.licenseExpires,
      updatesUntil: record.updatesUntil,
      updateAccessExpired: record.updateAccessExpired,
      seatsUsed: record.seatsUsed,
      seatsAllowed: record.seatsAllowed,
      message: record.message,
    };
  }

  /**
   * Ask for a free personal licence.
   *
   * Records `awaiting-key` rather than anything more optimistic, because that is exactly what
   * is true: an email is on its way, and no key exists on this machine yet. Presenting this
   * as "registered" would leave the user with no idea that a second step is coming, and the
   * screen has to say so explicitly.
   */
  async registerPersonal(request: RegisterPersonalRequest): Promise<LicenseStatus> {
    await this.callServer(() =>
      this.options.client.register({
        email: request.email,
        acceptedTerms: true,
        acceptedPrivacy: true,
      }),
    );

    return this.store({
      ...licenseRecordSchema.parse({}),
      state: 'awaiting-key',
      tier: 'personal',
      email: request.email,
    });
  }

  /**
   * Activate a key and claim this machine's seat.
   *
   * One method for both tiers: the licence server takes the same call either way, and the
   * tier only decides which product code guards it. A personal key offered against the
   * commercial product — or the reverse — is refused as `EDITION_MISMATCH` rather than
   * silently recording the wrong tier.
   */
  async activate(request: ActivateLicenseRequest): Promise<LicenseStatus> {
    // Users paste these out of emails, so they arrive with stray spaces and mixed case.
    const licenseKey = request.licenseKey.trim().toUpperCase();
    const machine = await machineId();

    const result = await this.callServer(() =>
      this.options.client.activate({
        tier: request.tier,
        email: request.email,
        licenseKey,
        machineId: machine,
      }),
    );

    if (!result.accepted) {
      return this.store({
        ...this.read(),
        state: 'invalid',
        tier: request.tier,
        email: request.email,
        message: result.message ?? 'That licence key was not accepted.',
      });
    }

    return this.store({
      state: 'active',
      tier: request.tier,
      email: request.email,
      licenseKey,
      machineId: machine,
      activatedAt: new Date().toISOString(),
      licenseExpires: result.licenseExpires,
      updatesUntil: result.updatesUntil,
      updateAccessExpired: result.updateAccessExpired,
      seatsUsed: result.seatsUsed,
      seatsAllowed: result.seatsAllowed,
      message: null,
    });
  }

  /**
   * Whether this installation may still be offered a newer release.
   *
   * The only place entitlement changes behaviour. Returns true when nothing is registered:
   * an unregistered copy is running under the AGPL, which carries no update restriction, and
   * withholding updates from it would be inventing a limit nobody agreed to.
   */
  async canReceiveUpdates(): Promise<boolean> {
    const record = this.read();
    if (record.state !== 'active' || record.licenseKey === null) {
      return true;
    }

    try {
      const eligibility = await this.options.client.checkUpdate(
        record.licenseKey,
        record.machineId ?? (await machineId()),
      );
      // Written back so the System page can say when updates lapse without calling out again.
      this.store({
        ...record,
        updatesUntil: eligibility.updatesUntil,
        updateAccessExpired: eligibility.updateAccessExpired,
      });
      return !eligibility.updateAccessExpired;
    } catch (error) {
      // An unreachable licence server must not stop a paying customer updating. Failing
      // closed here would turn every outage into "the app says my licence is invalid".
      this.options.logger.warn({ err: error }, 'Could not check update entitlement; allowing');
      return true;
    }
  }

  /**
   * Forget the licence on this machine.
   *
   * **Local only.** The Speedbits API has no endpoint for handing a seat back, so this
   * releases nothing server-side: the seat stays claimed until an administrator clears the
   * activation. The wording shown to the user has to say that rather than implying a seat was
   * freed, and a `POST /api/installer/release-seat` on the licence server would remove the
   * need for a support ticket every time someone replaces a computer.
   */
  forget(): LicenseStatus {
    return this.store(licenseRecordSchema.parse({}));
  }

  /** True once a key has been activated. For the first-run flow, and nothing else. */
  isActivated(): boolean {
    return this.read().state === 'active';
  }

  private async callServer<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof LicenseServerError) {
        this.options.logger.warn({ code: error.code }, 'The licence server refused a request');
        throw new LicenseActivationError(error.message, error.retryable);
      }
      this.options.logger.error({ err: error }, 'Licence activation failed unexpectedly');
      throw new LicenseActivationError('The licence could not be checked right now.', true);
    }
  }

  private store(record: LicenseRecord): LicenseStatus {
    const updatedAt = new Date().toISOString();
    this.options.db
      .insert(appState)
      .values({ key: APP_STATE_KEYS.license, value: record, updatedAt })
      .onConflictDoUpdate({ target: appState.key, set: { value: record, updatedAt } })
      .run();
    return this.status();
  }

  /** An absent or hand-edited row degrades to unregistered, which asks rather than assumes. */
  private read(): LicenseRecord {
    const row = this.options.db
      .select()
      .from(appState)
      .where(eq(appState.key, APP_STATE_KEYS.license))
      .get();

    const parsed = licenseRecordSchema.safeParse(row?.value ?? {});
    return parsed.success ? parsed.data : licenseRecordSchema.parse({});
  }
}
