// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from 'drizzle-orm';
import { APP_STATE_KEYS, appState, type Database_ } from '@impressive-ocr/db';
import {
  licenseRecordSchema,
  maskLicenseKey,
  type LicenseGate,
  type ActivateLicenseRequest,
  type LicenseRecord,
  type LicenseStatus,
  type RegisterPersonalRequest,
} from '@impressive-ocr/shared';
import type { Logger } from '../../infra/logger';
import { LicenseServerError, type Country, type LicenseClient } from './license-client';
import { evaluateGate } from './license-gate';
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
  /**
   * Where the fallback machine identifier is kept when the OS has none.
   *
   * The data directory rather than anywhere else because in a container it is the mounted
   * volume, and an identifier that does not outlive the container claims a new seat on every
   * restart. See `machine-id.ts`.
   */
  dataDir: string;
  logger: Logger;
}

/** A day. The list of countries is not a fast-moving target. */
const COUNTRY_CACHE_MS = 24 * 60 * 60 * 1000;

export class LicenseService {
  private countryCache: { countries: Country[]; fetchedAt: number } | null = null;

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
      gate: evaluateGate(record, new Date()),
    };
  }

  /** Whether new OCR work may start. The queue asks this and nothing else asks anything. */
  gate(): LicenseGate {
    return evaluateGate(this.read(), new Date());
  }

  /**
   * Start the trial clock, once, on first start.
   *
   * Recorded rather than derived from a file date or an install timestamp, both of which move
   * for reasons that have nothing to do with the user — a reinstall, a restore from backup, a
   * copied directory. Written only when absent, so restarting the app never extends it and
   * never shortens it either.
   */
  noteStarted(): void {
    const record = this.read();
    if (record.firstSeenAt === null) {
      this.store({ ...record, firstSeenAt: new Date().toISOString() });
    }
  }

  /**
   * Re-confirm an activation with the licence server.
   *
   * Called at startup. Failure is deliberately quiet: the offline allowance exists precisely
   * so that an unreachable server is not the user's problem, and logging a warning is the
   * right volume for something that will resolve itself the next time there is a network.
   */
  async revalidate(): Promise<void> {
    const record = this.read();
    const { tier, email, licenseKey } = record;
    if (record.state !== 'active' || tier === null || email === null || licenseKey === null) {
      return;
    }

    try {
      const result = await this.options.client.activate({
        tier,
        email,
        licenseKey,
        machineId: record.machineId ?? (await machineId(this.options.dataDir)),
      });
      if (!result.accepted) {
        // The server now refuses this licence — revoked, or its seat cleared. Recorded as
        // invalid rather than silently kept, but the local record keeps the credentials so
        // the user can see what was refused.
        this.store({ ...record, state: 'invalid', message: result.message });
        return;
      }

      this.store({
        ...record,
        lastValidatedAt: new Date().toISOString(),
        licenseExpires: result.licenseExpires,
        updatesUntil: result.updatesUntil,
        updateAccessExpired: result.updateAccessExpired,
        seatsUsed: result.seatsUsed,
        seatsAllowed: result.seatsAllowed,
      });
    } catch (error) {
      this.options.logger.warn({ err: error }, 'Could not re-confirm the licence; within grace');
    }
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
        country: request.country,
        acceptedTerms: true,
        acceptedPrivacy: true,
        acceptedLicense: true,
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
    const machine = await machineId(this.options.dataDir);

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

    const now = new Date().toISOString();
    return this.store({
      ...this.read(),
      state: 'active',
      tier: request.tier,
      email: request.email,
      licenseKey,
      machineId: machine,
      activatedAt: now,
      lastValidatedAt: now,
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
        record.machineId ?? (await machineId(this.options.dataDir)),
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
   * Hand this machine's seat back and forget the licence locally.
   *
   * Both halves, in that order, and the order matters: the seat is released while the record
   * still holds the credentials needed to do it.
   *
   * **The local record is cleared even when the server call fails.** Someone releasing a seat
   * is usually decommissioning a machine, which is exactly when connectivity is going away —
   * refusing to clear locally because the server was unreachable would leave them with an
   * installation that still claims a licence they have moved on from. The seat is then
   * stranded server-side, which is the lesser harm and the one an administrator can fix.
   *
   * A machine that held no seat comes back as `released: false` on a 200 rather than an
   * error, so running this twice is not a failure.
   */
  async releaseSeat(): Promise<LicenseStatus> {
    const record = this.read();
    // Destructured before the guard so narrowing survives into the call below. Reading the
    // fields off `record` afterwards would widen them back to nullable.
    const { tier, email, licenseKey } = record;

    if (tier !== null && email !== null && licenseKey !== null) {
      try {
        await this.options.client.releaseSeat({
          tier,
          email,
          licenseKey,
          machineId: record.machineId ?? (await machineId(this.options.dataDir)),
        });
      } catch (error) {
        this.options.logger.warn(
          { err: error },
          'Could not release the seat; clearing the local record anyway',
        );
      }
    }

    return this.store(licenseRecordSchema.parse({}));
  }

  /**
   * The countries registration will accept.
   *
   * Cached for a day, because the list changes about as often as the world does and the
   * registration form should not wait on a network round trip to render a dropdown. A
   * failure serves the previous answer if there is one, and null otherwise — the web layer
   * then uses its bundled list, which is what keeps the form usable offline.
   */
  async countries(): Promise<Country[] | null> {
    const now = Date.now();
    if (this.countryCache !== null && now - this.countryCache.fetchedAt < COUNTRY_CACHE_MS) {
      return this.countryCache.countries;
    }

    const countries = await this.options.client.countries();
    if (countries === null) {
      return this.countryCache?.countries ?? null;
    }

    this.countryCache = { countries, fetchedAt: now };
    return countries;
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
