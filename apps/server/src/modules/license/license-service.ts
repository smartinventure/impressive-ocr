// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from 'drizzle-orm';
import { APP_STATE_KEYS, appState, type Database_ } from '@impressive-ocr/db';
import {
  licenseRecordSchema,
  maskLicenseKey,
  type ActivateCommercialRequest,
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
 * A registration record, not a copy-protection scheme, and the difference is deliberate.
 * Impressive OCR is dual licensed: the personal tier is the AGPL grant everyone already has,
 * and the commercial tier is what an organisation buys to be released from the AGPL's
 * obligations. **Neither tier withholds a feature, and nothing here refuses to process a
 * document.** The source is published under a licence that permits removing this code, so a
 * lock built on it would inconvenience honest users and stop nobody else.
 *
 * What it does do is record the choice, prove the entitlement once against the licence
 * server, and give support something to look at.
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
  appVersion: string;
  logger: Logger;
}

export class LicenseService {
  constructor(private readonly options: LicenseServiceOptions) {}

  status(): LicenseStatus {
    const record = this.read();
    return {
      state: record.state,
      tier: record.tier,
      email: isEmail(record.email) ? record.email : null,
      maskedKey: record.licenseKey === null ? null : maskLicenseKey(record.licenseKey),
      activatedAt: record.activatedAt,
      updatesUntil: record.updatesUntil,
      seatsUsed: record.seatsUsed,
      seatsAllowed: record.seatsAllowed,
      message: record.message,
    };
  }

  /**
   * Register for the personal tier.
   *
   * Lands in `pending-confirmation` rather than `active`: the address is not proven until the
   * user clicks the link, and recording it as complete before then would let one person
   * register three seats to an address they do not own.
   */
  async registerPersonal(request: RegisterPersonalRequest): Promise<LicenseStatus> {
    const machine = await machineId();
    const result = await this.callServer(() =>
      this.options.client.activate({
        tier: 'personal',
        email: request.email,
        machineId: machine,
        appVersion: this.options.appVersion,
        platform: process.platform,
      }),
    );

    if (!result.accepted) {
      return this.store({
        ...this.read(),
        state: 'invalid',
        tier: 'personal',
        email: request.email,
        seatsUsed: result.seatsUsed,
        seatsAllowed: result.seatsAllowed,
        message: result.message ?? 'That registration was not accepted.',
      });
    }

    return this.store({
      state: result.requiresEmailConfirmation ? 'pending-confirmation' : 'active',
      tier: 'personal',
      email: request.email,
      licenseKey: null,
      machineId: machine,
      activatedAt: new Date().toISOString(),
      updatesUntil: result.updatesUntil,
      seatsUsed: result.seatsUsed,
      seatsAllowed: result.seatsAllowed,
      message: result.message,
    });
  }

  /** Activate a purchased licence. Keys are pasted out of emails, so they arrive untidy. */
  async activateCommercial(request: ActivateCommercialRequest): Promise<LicenseStatus> {
    const licenseKey = request.licenseKey.trim().toUpperCase();
    const machine = await machineId();

    const result = await this.callServer(() =>
      this.options.client.activate({
        tier: 'commercial',
        email: request.email,
        licenseKey,
        machineId: machine,
        appVersion: this.options.appVersion,
        platform: process.platform,
      }),
    );

    if (!result.accepted) {
      return this.store({
        ...this.read(),
        state: 'invalid',
        tier: 'commercial',
        email: request.email,
        message: result.message ?? 'That licence key was not accepted.',
      });
    }

    return this.store({
      state: 'active',
      tier: 'commercial',
      email: request.email,
      licenseKey,
      machineId: machine,
      activatedAt: new Date().toISOString(),
      updatesUntil: result.updatesUntil,
      seatsUsed: result.seatsUsed,
      seatsAllowed: result.seatsAllowed,
      message: null,
    });
  }

  /**
   * Hand this machine's seat back and return to unregistered.
   *
   * The local record is cleared even when the server call fails. The alternative leaves
   * someone who is decommissioning a machine unable to release it because the machine is
   * already offline, which is exactly when they would be doing this.
   */
  async releaseSeat(): Promise<LicenseStatus> {
    const record = this.read();
    if (record.state === 'unregistered' || !isEmail(record.email)) {
      return this.status();
    }

    try {
      await this.options.client.release({
        email: record.email,
        ...(record.licenseKey === null ? {} : { licenseKey: record.licenseKey }),
        machineId: record.machineId ?? (await machineId()),
      });
    } catch (error) {
      this.options.logger.warn(
        { err: error },
        'Could not tell the licence server about the release; clearing locally anyway',
      );
    }

    return this.store(licenseRecordSchema.parse({}));
  }

  /**
   * True once the installation has been registered under either tier.
   *
   * Exposed for the first-run flow to decide whether to ask, and for nothing else. No code
   * path gates processing on it — see the note at the top of this file.
   */
  isRegistered(): boolean {
    const { state } = this.read();
    return state === 'active' || state === 'pending-confirmation';
  }

  private async callServer<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof LicenseServerError) {
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

/** Stored emails come back through zod as plain strings; this is the narrowing. */
function isEmail(value: string | null): value is string {
  return value !== null && value.includes('@');
}

export { machineId };
