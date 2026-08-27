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

  result: ActivationResult = {
    accepted: true,
    seatsUsed: 1,
    seatsAllowed: 3,
    licenseExpires: null,
    updatesUntil: null,
    updateAccessExpired: false,
    tierName: 'Impressive OCR',
    message: null,
  };
  eligibility: UpdateEligibility = {
    updateAvailable: false,
    latestVersion: '1.0.1',
    updatesUntil: null,
    updateAccessExpired: false,
  };
  failure: Error | null = null;

  async register(request: RegisterRequest): Promise<void> {
    this.registrations.push(request);
    if (this.failure !== null) throw this.failure;
  }

  async activate(request: ActivationRequest): Promise<ActivationResult> {
    this.activations.push(request);
    if (this.failure !== null) throw this.failure;
    return this.result;
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
  it('starts unregistered on a fresh install', () => {
    expect(service.status()).toMatchObject({ state: 'unregistered', tier: null, email: null });
    expect(service.isActivated()).toBe(false);
  });

  describe('registering for a personal licence', () => {
    it('lands in awaiting-key, because registering does not return one', async () => {
      // The Speedbits flow emails a verification link, and the key itself arrives in a second
      // email afterwards. Recording this as registered would leave the user with no idea a
      // further step exists, staring at a screen that looks finished.
      const status = await service.registerPersonal({ email: 'me@example.com' });

      expect(status.state).toBe('awaiting-key');
      expect(status.email).toBe('me@example.com');
      expect(status.maskedKey).toBeNull();
      expect(service.isActivated()).toBe(false);
    });

    it('tells the server both consents were given, since it requires them', async () => {
      await service.registerPersonal({ email: 'me@example.com' });

      expect(client.registrations[0]).toMatchObject({
        email: 'me@example.com',
        acceptedTerms: true,
        acceptedPrivacy: true,
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

  describe('forgetting a licence', () => {
    it('clears the local record', async () => {
      await service.activate(PERSONAL);

      const status = service.forget();

      expect(status.state).toBe('unregistered');
      expect(status.email).toBeNull();
      expect(status.maskedKey).toBeNull();
    });

    it('does not pretend to release the seat', async () => {
      // The Speedbits API has no endpoint for handing a seat back. Naming this `forget`
      // rather than `release` is the whole point, and no server call is made.
      await service.activate(PERSONAL);
      const before = client.activations.length;

      service.forget();

      expect(client.activations).toHaveLength(before);
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
