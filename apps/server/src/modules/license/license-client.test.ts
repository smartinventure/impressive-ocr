// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../infra/logger';
import { HttpLicenseClient, LicenseServerError, type LicenseServerConfig } from './license-client';

/**
 * The half that talks to license.speedbits.io.
 *
 * Two things matter here. First, the distinction the rest of the app depends on: a licence
 * the server *refused* and a server that could not *answer* need different words in front of
 * the user, and the caller can only tell them apart if `retryable` is right. Second, the
 * request shape — this API takes snake_case fields and reports failure as `success: false`
 * on a 200, neither of which is what a JSON API usually does.
 */

const CONFIG: LicenseServerConfig = {
  baseUrl: 'https://license.example.com',
  personal: { productCode: 'impressiveocrcommunity', installerApiKey: 'IMC_test' },
  commercial: { productCode: 'impressiveocrcommercial', installerApiKey: 'IMP_test' },
  appVersion: '1.0.1',
};

function client(): HttpLicenseClient {
  return new HttpLicenseClient(CONFIG, createLogger({ level: 'silent', pretty: false }));
}

const ACTIVATION = {
  tier: 'commercial' as const,
  email: 'buyer@example.com',
  licenseKey: 'IMP-ABCD',
  machineId: 'a'.repeat(32),
};

afterEach(() => vi.unstubAllGlobals());

function respondWith(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({ status, json: () => Promise.resolve(body) });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetchMock.mock.calls[0] as [string, { body: string }];
  return JSON.parse(call[1].body) as Record<string, unknown>;
}

describe('HttpLicenseClient', () => {
  describe('activation', () => {
    it('sends the fields the licence server documents', async () => {
      const fetchMock = respondWith(200, { success: true, valid: true });

      await client().activate(ACTIVATION);

      expect(bodyOf(fetchMock)).toEqual({
        email: 'buyer@example.com',
        license_key: 'IMP-ABCD',
        machine_id: 'a'.repeat(32),
        version: '1.0.1',
        api_key: 'IMP_test',
        product_edition: 'impressiveocrcommercial',
      });
    });

    it('uses the community product AND its own key for a personal activation', async () => {
      // The two products have separate installer keys. Sending the commercial key against
      // the community product is refused as INVALID_API_KEY, which reads to the user like a
      // broken licence rather than a wrong build flag.
      const fetchMock = respondWith(200, { success: true, valid: true });

      await client().activate({ ...ACTIVATION, tier: 'personal' });

      expect(bodyOf(fetchMock).product_edition).toBe('impressiveocrcommunity');
      expect(bodyOf(fetchMock).api_key).toBe('IMC_test');
    });

    it('converts seats remaining into seats used', async () => {
      respondWith(200, { success: true, valid: true, seats_total: 3, seats_remaining: 1 });

      const result = await client().activate(ACTIVATION);

      expect(result.seatsAllowed).toBe(3);
      expect(result.seatsUsed).toBe(2);
    });

    it('treats -1 seats as unlimited rather than as a number', async () => {
      // The server spells unlimited as -1. Shown literally it reads as "-1 seats", and any
      // arithmetic on it produces nonsense.
      respondWith(200, { success: true, valid: true, seats_total: -1, seats_remaining: -1 });

      const result = await client().activate(ACTIVATION);

      expect(result.seatsAllowed).toBeNull();
      expect(result.seatsUsed).toBeNull();
    });

    it('keeps the two expiry dates apart', async () => {
      respondWith(200, {
        success: true,
        valid: true,
        license_expires: null,
        update_eligible_until: '2027-08-27',
        update_access_expired: false,
      });

      const result = await client().activate(ACTIVATION);

      expect(result.licenseExpires).toBeNull();
      expect(result.updatesUntil).toBe('2027-08-27');
      expect(result.updateAccessExpired).toBe(false);
    });
  });

  describe('registration', () => {
    it('sends the consents the server requires, and the personal product', async () => {
      const fetchMock = respondWith(200, { success: true });

      await client().register({
        email: 'me@example.com',
        acceptedTerms: true,
        acceptedPrivacy: true,
      });

      expect(bodyOf(fetchMock)).toEqual({
        email: 'me@example.com',
        short_code: 'impressiveocrcommunity',
        accepted_terms: true,
        accepted_privacy: true,
      });
    });
  });

  describe('telling a refusal from an outage', () => {
    it('treats success:false on a 200 as a refusal', async () => {
      // This API reports licence decisions inside a 200, so reading only the status code
      // would record a rejected key as a successful activation.
      respondWith(200, { success: false, message: 'That key has been revoked.' });

      await expect(client().activate(ACTIVATION)).rejects.toMatchObject({
        retryable: false,
        message: 'That key has been revoked.',
      });
    });

    it('treats a 4xx as a permanent refusal', async () => {
      respondWith(403, { success: false, error_code: 'NO_SEATS_AVAILABLE' });

      await expect(client().activate(ACTIVATION)).rejects.toMatchObject({
        retryable: false,
        code: 'NO_SEATS_AVAILABLE',
      });
    });

    it('treats a 5xx as worth retrying', async () => {
      respondWith(503, {});
      await expect(client().activate(ACTIVATION)).rejects.toMatchObject({ retryable: true });
    });

    it('treats an unreachable server as worth retrying', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ENOTFOUND')));

      await expect(client().activate(ACTIVATION)).rejects.toMatchObject({
        name: 'LicenseServerError',
        retryable: true,
      });
    });

    it('prefers the server\'s own wording over ours', async () => {
      respondWith(403, {
        success: false,
        error_code: 'NO_SEATS_AVAILABLE',
        message: 'Free a machine at speedbits.io first.',
      });

      await expect(client().activate(ACTIVATION)).rejects.toMatchObject({
        message: 'Free a machine at speedbits.io first.',
      });
    });

    it('explains a bare error code the user could otherwise not act on', async () => {
      respondWith(403, { success: false, error_code: 'NO_SEATS_AVAILABLE' });

      await expect(client().activate(ACTIVATION)).rejects.toMatchObject({
        message: 'This licence is already in use on the maximum number of machines.',
      });
    });

    it('survives a licence server that answers with HTML', async () => {
      // A misconfigured proxy returning an error page is not a licence decision, and must not
      // surface as a JSON parse error the user cannot act on.
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ status: 502, json: () => Promise.reject(new Error('bad')) }),
      );

      await expect(client().activate(ACTIVATION)).rejects.toBeInstanceOf(LicenseServerError);
    });
  });

  describe('update entitlement', () => {
    it('reports the window closing without needing an update to exist', async () => {
      respondWith(200, {
        success: true,
        update_available: false,
        update_eligible_until: '2026-01-01',
        update_access_expired: true,
      });

      const result = await client().checkUpdate('IMP-ABCD', 'a'.repeat(32));

      expect(result.updateAvailable).toBe(false);
      expect(result.updateAccessExpired).toBe(true);
      expect(result.updatesUntil).toBe('2026-01-01');
    });
  });
});
