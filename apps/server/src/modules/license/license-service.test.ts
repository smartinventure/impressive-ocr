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
  type ReleaseRequest,
} from './license-client';
import { LicenseService } from './license-service';

/**
 * Licensing decides which of two licences an installation runs under. It does **not** gate
 * processing, and these tests are where that stays true: there is no assertion here that any
 * state prevents work, because no such behaviour exists.
 */

class FakeLicenseClient implements LicenseClient {
  activations: ActivationRequest[] = [];
  releases: ReleaseRequest[] = [];
  result: ActivationResult = {
    accepted: true,
    requiresEmailConfirmation: false,
    updatesUntil: null,
    seatsUsed: 1,
    seatsAllowed: 3,
    message: null,
  };
  failure: Error | null = null;

  async activate(request: ActivationRequest): Promise<ActivationResult> {
    this.activations.push(request);
    if (this.failure !== null) throw this.failure;
    return this.result;
  }

  async release(request: ReleaseRequest): Promise<void> {
    this.releases.push(request);
    if (this.failure !== null) throw this.failure;
  }
}

let db: Database_;
let close: () => void;
let client: FakeLicenseClient;
let service: LicenseService;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'impressive-ocr-license-'));
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
    appVersion: '1.0.1',
    logger: createLogger({ level: 'silent', pretty: false }),
  });
});

afterEach(() => {
  close();
});

describe('LicenseService', () => {
  it('starts unregistered on a fresh install', () => {
    expect(service.status()).toMatchObject({ state: 'unregistered', tier: null, email: null });
    expect(service.isRegistered()).toBe(false);
  });

  describe('the personal tier', () => {
    it('waits for the email to be confirmed before counting as registered', async () => {
      // Recording it as active on the strength of an unconfirmed address would let one person
      // claim three seats against an address they do not own.
      client.result = { ...client.result, requiresEmailConfirmation: true };

      const status = await service.registerPersonal({ email: 'someone@example.com' });

      expect(status.state).toBe('pending-confirmation');
      expect(status.email).toBe('someone@example.com');
      expect(status.seatsAllowed).toBe(3);
    });

    it('is active immediately when the server asks for no confirmation', async () => {
      const status = await service.registerPersonal({ email: 'someone@example.com' });
      expect(status.state).toBe('active');
    });

    it('sends a hashed machine identifier, never a raw one', async () => {
      await service.registerPersonal({ email: 'someone@example.com' });

      const sent = client.activations[0];
      // 128 bits of hex. A raw machine GUID would carry dashes and a recognisable shape, and
      // is a stable global identifier for someone's computer that the server has no use for.
      expect(sent?.machineId).toMatch(/^[0-9a-f]{32}$/);
      expect(sent?.tier).toBe('personal');
      expect(sent?.licenseKey).toBeUndefined();
    });

    it('records a refusal with the server\'s own wording', async () => {
      client.result = {
        ...client.result,
        accepted: false,
        message: 'All three machines are already in use.',
        seatsUsed: 3,
      };

      const status = await service.registerPersonal({ email: 'someone@example.com' });

      expect(status.state).toBe('invalid');
      expect(status.message).toBe('All three machines are already in use.');
    });
  });

  describe('the commercial tier', () => {
    it('activates and remembers the key', async () => {
      const status = await service.activateCommercial({
        email: 'buyer@example.com',
        licenseKey: 'impr-abcd-efgh-7k3d',
      });

      expect(status.state).toBe('active');
      expect(status.tier).toBe('commercial');
      expect(client.activations[0]?.licenseKey).toBe('IMPR-ABCD-EFGH-7K3D');
    });

    it('never sends the whole key back to a client', () => {
      // The status endpoint answers any browser that can reach the API, and a licence key is
      // a bearer credential for the seats it carries.
      return service
        .activateCommercial({ email: 'buyer@example.com', licenseKey: 'IMPR-ABCD-EFGH-7K3D' })
        .then((status) => {
          expect(status.maskedKey).toBe('IMPR-••••-7K3D');
          expect(JSON.stringify(status)).not.toContain('ABCD');
        });
    });

    it('tidies a key pasted out of an email', async () => {
      await service.activateCommercial({
        email: 'buyer@example.com',
        licenseKey: '  impr-abcd-efgh-7k3d  ',
      });
      expect(client.activations[0]?.licenseKey).toBe('IMPR-ABCD-EFGH-7K3D');
    });
  });

  describe('when the licence server cannot be reached', () => {
    it('says so, and marks it worth retrying', async () => {
      client.failure = new LicenseServerError('The licence server could not be reached.', true);

      await expect(
        service.registerPersonal({ email: 'someone@example.com' }),
      ).rejects.toMatchObject({ name: 'LicenseActivationError', retryable: true });
    });

    it('leaves the installation unregistered rather than half-registered', async () => {
      client.failure = new LicenseServerError('unreachable', true);

      await service.registerPersonal({ email: 'someone@example.com' }).catch(() => undefined);

      expect(service.status().state).toBe('unregistered');
    });

    it('distinguishes a refused licence from an unreachable server', async () => {
      client.failure = new LicenseServerError('That key does not exist.', false);

      await expect(
        service.activateCommercial({ email: 'a@example.com', licenseKey: 'IMPR-0000' }),
      ).rejects.toMatchObject({ retryable: false });
    });
  });

  describe('releasing a seat', () => {
    it('tells the server and clears the local record', async () => {
      await service.registerPersonal({ email: 'someone@example.com' });

      const status = await service.releaseSeat();

      expect(client.releases[0]?.email).toBe('someone@example.com');
      expect(status.state).toBe('unregistered');
      expect(status.email).toBeNull();
    });

    it('clears locally even when the server call fails', async () => {
      // Someone decommissioning a machine is doing this precisely when connectivity is going
      // away. Refusing to release because the server is unreachable strands the seat.
      await service.registerPersonal({ email: 'someone@example.com' });
      client.failure = new LicenseServerError('unreachable', true);

      expect((await service.releaseSeat()).state).toBe('unregistered');
    });

    it('does nothing when there is nothing to release', async () => {
      expect((await service.releaseSeat()).state).toBe('unregistered');
      expect(client.releases).toHaveLength(0);
    });
  });

  it('survives a hand-edited record rather than refusing to start', async () => {
    // The row is JSON in a SQLite file the user owns. Garbage in it must degrade to "ask
    // again", never to a crash on a screen the user cannot get past.
    await service.registerPersonal({ email: 'someone@example.com' });
    db.update(appState)
      .set({ value: { state: 'nonsense' } })
      .where(eq(appState.key, APP_STATE_KEYS.license))
      .run();

    expect(() => service.status()).not.toThrow();
    expect(service.status().state).toBe('unregistered');
  });
});
