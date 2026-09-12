// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { APP_STATE_KEYS, appState, createDatabase, type Database_ } from '@impressive-ocr/db';
import { defaultMigrationsDir } from '../../infra/module-paths';
import { createLogger } from '../../infra/logger';
import {
  LicenseServerError,
  type ActivationRequest,
  type ActivationResult,
  type LicenseClient,
  type RegisterRequest,
  type RegisterResult,
  type ReleaseRequest,
  type ReleaseResult,
  type UpdateEligibility,
} from './license-client';
import { LicenseService } from './license-service';

/**
 * Licensing decides which of two licences an installation runs under, and whether it is still
 * entitled to automatic updates. It does **not** gate processing, and this file is where that
 * stays true: there is no assertion here that any licence state prevents work, because no
 * such behaviour exists.
 */

class FakeLicenseClient implements LicenseClient {
  registrations: RegisterRequest[] = [];
  activations: ActivationRequest[] = [];
  updateChecks: { licenseKey: string; machineId: string }[] = [];
  releases: ReleaseRequest[] = [];
  releaseResult: ReleaseResult = { released: true, seatsUsed: 0, seatsAllowed: 3 };

  result: ActivationResult = {
    accepted: true,
    seatsUsed: 1,
    seatsAllowed: 3,
    licenseExpires: null,
    updatesUntil: null,
    updateAccessExpired: false,
    tierName: 'Impressive OCR',
    message: null,
    code: null,
  };
  eligibility: UpdateEligibility = {
    updateAvailable: false,
    latestVersion: '1.0.1',
    updatesUntil: null,
    updateAccessExpired: false,
  };
  failure: Error | null = null;

  countryList: { code: string; name: string }[] | null = [{ code: 'DE', name: 'Germany' }];

  async countries(): Promise<{ code: string; name: string }[] | null> {
    return this.countryList;
  }

  /** What the next register call reports back. Defaults to a first-time registration. */
  registerResult: RegisterResult = { resent: false };

  async register(request: RegisterRequest): Promise<RegisterResult> {
    this.registrations.push(request);
    if (this.failure !== null) throw this.failure;
    return this.registerResult;
  }

  async activate(request: ActivationRequest): Promise<ActivationResult> {
    this.activations.push(request);
    if (this.failure !== null) throw this.failure;
    return this.result;
  }

  async releaseSeat(request: ReleaseRequest): Promise<ReleaseResult> {
    this.releases.push(request);
    if (this.failure !== null) throw this.failure;
    return this.releaseResult;
  }

  async checkUpdate(licenseKey: string, machineId: string): Promise<UpdateEligibility> {
    this.updateChecks.push({ licenseKey, machineId });
    if (this.failure !== null) throw this.failure;
    return this.eligibility;
  }
}

let db: Database_;
let close: () => void;
let client: FakeLicenseClient;
let service: LicenseService;

let dataDir: string;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'impressive-ocr-license-'));
  dataDir = root;
  const database = createDatabase({
    filePath: join(root, 'test.db'),
    migrationsFolder: defaultMigrationsDir(),
  });
  close = database.close;
  db = database.db;
  client = new FakeLicenseClient();
  service = new LicenseService({
    db,
    client,
    dataDir,
    logger: createLogger({ level: 'silent', pretty: false }),
  });
});

afterEach(() => {
  close();
});

const PERSONAL = {
  tier: 'personal' as const,
  email: 'me@example.com',
  licenseKey: 'IMOC-1234-ABCD',
};
const COMMERCIAL = {
  tier: 'commercial' as const,
  email: 'buyer@example.com',
  licenseKey: 'IMOC-9999-ZZZZ',
};

describe('LicenseService', () => {
  describe('the trial clock watermark', () => {
    /** Whatever is actually in the database, rather than what the service reports. */
    function storedRecord(): Record<string, unknown> {
      const row = db.select().from(appState).where(eq(appState.key, APP_STATE_KEYS.license)).get();
      return (row?.value ?? {}) as Record<string, unknown>;
    }

    it('records a watermark the first time the status is read', () => {
      // Without this the field stays null for an installation that is used but never
      // registered, which is exactly the installation the trial applies to.
      expect(storedRecord().clockHighWaterAt ?? null).toBeNull();

      service.status();

      expect(typeof storedRecord().clockHighWaterAt).toBe('string');
    });

    it('records one from the gate too, not only from the status', () => {
      // The queue asks the gate and nothing else. If only `status` advanced the watermark, a
      // headless server processing documents with no browser attached would never record one.
      service.gate();

      expect(typeof storedRecord().clockHighWaterAt).toBe('string');
    });

    it('never moves the watermark backwards', () => {
      service.status();
      const future = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString();
      db.update(appState)
        .set({ value: { ...storedRecord(), clockHighWaterAt: future } })
        .where(eq(appState.key, APP_STATE_KEYS.license))
        .run();

      // Reading now, with the machine clock far behind that mark, must leave it alone -
      // rewriting it to "now" is precisely what would make winding a clock back work.
      service.status();

      expect(storedRecord().clockHighWaterAt).toBe(future);
    });

    it('reports a clock sitting well behind the watermark', () => {
      const future = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString();
      service.status();
      db.update(appState)
        .set({ value: { ...storedRecord(), clockHighWaterAt: future } })
        .where(eq(appState.key, APP_STATE_KEYS.license))
        .run();

      expect(service.status().clockBehind).toBe(true);
    });

    it('does not cry tampering over ordinary drift', () => {
      service.status();

      // A clock that agrees with the watermark is the normal case and must stay quiet.
      expect(service.status().clockBehind).toBe(false);
    });
  });

  it('starts unregistered on a fresh install', () => {
    expect(service.status()).toMatchObject({ state: 'unregistered', tier: null, email: null });
    expect(service.isActivated()).toBe(false);
  });

  describe('registering for a personal licence', () => {
    it('lands in awaiting-key, because registering does not return one', async () => {
      // The Speedbits flow emails a verification link, and the key itself arrives in a second
      // email afterwards. Recording this as registered would leave the user with no idea a
      // further step exists, staring at a screen that looks finished.
      const status = await service.registerPersonal({ email: 'me@example.com', country: 'DE' });

      expect(status.state).toBe('awaiting-key');
      expect(status.email).toBe('me@example.com');
      expect(status.maskedKey).toBeNull();
      expect(service.isActivated()).toBe(false);
    });

    it('records that the key was resent, so the screen can drop the verification step', async () => {
      // The licence server resends an existing key when the address already holds a licence
      // for the product. There is then no verification link, and a screen still describing
      // one sends the user to wait for mail that never arrives.
      client.registerResult = { resent: true };

      const status = await service.registerPersonal({ email: 'me@example.com', country: 'DE' });

      expect(status.state).toBe('awaiting-key');
      expect(status.keyResent).toBe(true);
    });

    it('leaves keyResent false for a first registration', async () => {
      const status = await service.registerPersonal({ email: 'new@example.com', country: 'DE' });

      expect(status.keyResent).toBe(false);
    });

    it('carries the rate-limit wait through to the caller', async () => {
      // Registration is capped per address per hour. The wait is the actionable part: without
      // it the screen can only say "too many attempts", which invites another attempt.
      client.failure = new LicenseServerError('Too many attempts.', true, 'RATE_LIMITED', 240);

      await expect(
        service.registerPersonal({ email: 'me@example.com', country: 'DE' }),
      ).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true, retryAfterSeconds: 240 });
    });

    it('tells the server both consents were given, since it requires them', async () => {
      await service.registerPersonal({ email: 'me@example.com', country: 'DE' });

      // All three consents, plus the country. Every one of them is required by the licence
      // server, and two of them are documented as optional — a registration missing either is
      // rejected outright.
      expect(client.registrations[0]).toMatchObject({
        email: 'me@example.com',
        country: 'DE',
        acceptedTerms: true,
        acceptedPrivacy: true,
        acceptedLicense: true,
      });
    });
  });

  describe('activating a key', () => {
    it('claims a seat and records the entitlement', async () => {
      client.result = { ...client.result, seatsUsed: 2, seatsAllowed: 3 };

      const status = await service.activate(PERSONAL);

      expect(status.state).toBe('active');
      expect(status.tier).toBe('personal');
      expect(status.seatsUsed).toBe(2);
      expect(status.seatsAllowed).toBe(3);
      expect(service.isActivated()).toBe(true);
    });

    it('sends a hashed machine identifier, never a raw one', async () => {
      await service.activate(COMMERCIAL);

      // 32 hex characters, the shape the licence server documents. A raw MachineGuid would
      // carry dashes and is a stable global identifier for someone's computer.
      expect(client.activations[0]?.machineId).toMatch(/^[0-9a-f]{32}$/);
    });

    it('tidies a key pasted out of an email', async () => {
      await service.activate({ ...COMMERCIAL, licenseKey: '  imoc-9999-zzzz  ' });
      expect(client.activations[0]?.licenseKey).toBe('IMOC-9999-ZZZZ');
    });

    it('survives a key copied across a wrapped line', async () => {
      // A key copied out of an email is as likely to carry a newline through the middle as a
      // space at the end, and neither is something the user can see.
      await service.activate({ ...COMMERCIAL, licenseKey: 'IMOC-9999\n-ZZZZ' });
      expect(client.activations[0]?.licenseKey).toBe('IMOC-9999-ZZZZ');
    });

    it('survives non-breaking spaces, which look like nothing at all', async () => {
      // What a key copied out of a PDF or a rendered email arrives with. `\s` does not match
      // U+00A0, so trimming alone leaves the key invalid for a reason nobody can see.
      await service.activate({ ...COMMERCIAL, licenseKey: '\u00a0IMOC-9999-ZZZZ\u00a0' });
      expect(client.activations[0]?.licenseKey).toBe('IMOC-9999-ZZZZ');
    });

    it('passes the tier through, so the server can refuse the wrong product', async () => {
      await service.activate(COMMERCIAL);
      expect(client.activations[0]?.tier).toBe('commercial');
    });

    it('never sends the whole key back to a client', async () => {
      // The status endpoint answers any browser that can reach the API, and a licence key is
      // a bearer credential for the seats it holds.
      const status = await service.activate(COMMERCIAL);

      expect(status.maskedKey).toBe('IMOC-••••-ZZZZ');
      expect(JSON.stringify(status)).not.toContain('9999');
    });

    it('keeps the error code the licence server sent', async () => {
      // `NO_SEATS_AVAILABLE` and `VALIDATION_FAILED` need different actions from the user and
      // different answers from support. Flattened to one generic code they are the same
      // screen, and the person reading it cannot tell which problem they have.
      client.result = {
        ...client.result,
        accepted: false,
        code: 'NO_SEATS_AVAILABLE',
        message: 'All three machines are in use.',
      };

      const status = await service.activate(COMMERCIAL);

      expect(status.code).toBe('NO_SEATS_AVAILABLE');
      expect(status.message).toBe('All three machines are in use.');
    });

    it('clears the code once a licence is accepted', async () => {
      // A stale code beside a working licence reads as a problem that is still happening.
      client.result = { ...client.result, accepted: false, code: 'VALIDATION_FAILED' };
      await service.activate(COMMERCIAL);
      expect(service.status().code).toBe('VALIDATION_FAILED');

      client.result = { ...client.result, accepted: true, code: null };
      const status = await service.activate(COMMERCIAL);

      expect(status.code).toBeNull();
      expect(status.state).toBe('active');
    });

    it("records a refusal with the server's own wording", async () => {
      client.result = {
        ...client.result,
        accepted: false,
        message: 'This licence is already in use on the maximum number of machines.',
      };

      const status = await service.activate(PERSONAL);

      expect(status.state).toBe('invalid');
      expect(status.message).toContain('maximum number of machines');
    });

    it('keeps the two expiry dates apart', async () => {
      // One ends the licence, the other ends only automatic updates. Conflating them would
      // stop a perpetual licence a year after purchase.
      client.result = {
        ...client.result,
        licenseExpires: null,
        updatesUntil: '2027-08-27T00:00:00.000Z',
      };

      const status = await service.activate(COMMERCIAL);

      expect(status.licenseExpires).toBeNull();
      expect(status.updatesUntil).toBe('2027-08-27T00:00:00.000Z');
    });
  });

  describe('when the licence server cannot be reached', () => {
    it('says so, and marks it worth retrying', async () => {
      client.failure = new LicenseServerError('The licence server could not be reached.', true);

      await expect(service.activate(PERSONAL)).rejects.toMatchObject({
        name: 'LicenseActivationError',
        retryable: true,
      });
    });

    it('leaves the installation unregistered rather than half-registered', async () => {
      client.failure = new LicenseServerError('unreachable', true);

      await service.activate(PERSONAL).catch(() => undefined);

      expect(service.status().state).toBe('unregistered');
    });

    it('distinguishes a refused key from an unreachable server', async () => {
      client.failure = new LicenseServerError('That key does not exist.', false);

      await expect(service.activate(COMMERCIAL)).rejects.toMatchObject({ retryable: false });
    });
  });

  describe('update entitlement', () => {
    it('is the one thing a licence actually gates', async () => {
      await service.activate(COMMERCIAL);
      client.eligibility = { ...client.eligibility, updateAccessExpired: true };

      expect(await service.canReceiveUpdates()).toBe(false);
      // And the software is otherwise untouched: still active, still every feature.
      expect(service.status().state).toBe('active');
    });

    it('allows updates while the window is open', async () => {
      await service.activate(COMMERCIAL);
      expect(await service.canReceiveUpdates()).toBe(true);
    });

    it('allows updates for an unregistered copy', async () => {
      // An unregistered installation runs under the AGPL, which carries no update
      // restriction. Withholding one would be inventing a limit nobody agreed to.
      expect(await service.canReceiveUpdates()).toBe(true);
      expect(client.updateChecks).toHaveLength(0);
    });

    it('allows updates when the licence server is unreachable', async () => {
      // Failing closed here turns every outage into "the app says my licence is invalid" for
      // a paying customer.
      await service.activate(COMMERCIAL);
      client.failure = new LicenseServerError('unreachable', true);

      expect(await service.canReceiveUpdates()).toBe(true);
    });

    it('remembers what the check said, so the screen need not ask again', async () => {
      await service.activate(COMMERCIAL);
      client.eligibility = {
        ...client.eligibility,
        updatesUntil: '2027-01-01T00:00:00.000Z',
        updateAccessExpired: true,
      };

      await service.canReceiveUpdates();

      expect(service.status().updatesUntil).toBe('2027-01-01T00:00:00.000Z');
      expect(service.status().updateAccessExpired).toBe(true);
    });
  });

  describe('releasing a seat', () => {
    it('tells the server and clears the local record', async () => {
      await service.activate(PERSONAL);

      const status = await service.releaseSeat();

      expect(client.releases[0]).toMatchObject({
        tier: 'personal',
        email: 'me@example.com',
        licenseKey: 'IMOC-1234-ABCD',
      });
      expect(status.state).toBe('unregistered');
      expect(status.maskedKey).toBeNull();
    });

    it('releases against the product the licence belongs to', async () => {
      // Each product has its own installer key, so releasing a commercial seat with the
      // community credentials would be refused.
      await service.activate(COMMERCIAL);

      await service.releaseSeat();

      expect(client.releases[0]?.tier).toBe('commercial');
    });

    it('clears locally even when the server cannot be reached', async () => {
      // Someone releasing a seat is usually decommissioning a machine, which is exactly when
      // connectivity is going away. Refusing to clear would leave them with an installation
      // still claiming a licence they have moved on from.
      await service.activate(PERSONAL);
      client.failure = new LicenseServerError('unreachable', true);

      expect((await service.releaseSeat()).state).toBe('unregistered');
    });

    it('is a success when this machine held no seat', async () => {
      // The endpoint is idempotent: running an uninstaller twice must not report a failure
      // to someone who is removing the software anyway.
      client.releaseResult = { released: false, seatsUsed: 0, seatsAllowed: 3 };
      await service.activate(PERSONAL);

      expect((await service.releaseSeat()).state).toBe('unregistered');
    });

    it('asks nothing of the server when there is no licence to release', async () => {
      await service.releaseSeat();
      expect(client.releases).toHaveLength(0);
    });
  });

  it('survives a hand-edited record rather than refusing to start', async () => {
    // The row is JSON in a SQLite file the user owns. Garbage in it must degrade to "ask
    // again", never to a crash on a screen the user cannot get past.
    await service.activate(PERSONAL);
    db.update(appState)
      .set({ value: { state: 'nonsense' } })
      .where(eq(appState.key, APP_STATE_KEYS.license))
      .run();

    expect(() => service.status()).not.toThrow();
    expect(service.status().state).toBe('unregistered');
  });
});
