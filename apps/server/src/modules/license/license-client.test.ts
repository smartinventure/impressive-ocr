// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../infra/logger';
import { HttpLicenseClient, LicenseServerError } from './license-client';

/**
 * The half that talks to license.speedbits.io.
 *
 * What matters here is the distinction the rest of the app depends on: a licence the server
 * *refused* and a server that could not *answer* need different words in front of the user,
 * and the caller can only tell them apart if `retryable` is right. Getting it backwards means
 * telling someone their key is invalid because a load balancer restarted.
 */

function client(): HttpLicenseClient {
  return new HttpLicenseClient({
    baseUrl: 'https://license.example.com',
    appVersion: '1.0.1',
    logger: createLogger({ level: 'silent', pretty: false }),
  });
}

const request = {
  tier: 'commercial' as const,
  email: 'buyer@example.com',
  licenseKey: 'IMPR-ABCD',
  machineId: 'a'.repeat(32),
  appVersion: '1.0.1',
  platform: 'win32',
};

afterEach(() => vi.unstubAllGlobals());

function respondWith(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      status,
      json: () => Promise.resolve(body),
    }),
  );
}

describe('HttpLicenseClient', () => {
  it('reads a successful activation', async () => {
    respondWith(200, {
      accepted: true,
      requiresEmailConfirmation: false,
      updatesUntil: '2027-08-27T00:00:00.000Z',
      seatsUsed: 1,
      seatsAllowed: 3,
    });

    const result = await client().activate(request);

    expect(result.accepted).toBe(true);
    expect(result.updatesUntil).toBe('2027-08-27T00:00:00.000Z');
    expect(result.seatsAllowed).toBe(3);
  });

  it('treats a refusal as an answer, not a failure', async () => {
    // `accepted: false` on a 200 is the server saying "no". It must not raise, because the
    // caller records it as an invalid licence with the server's own wording.
    respondWith(200, { accepted: false, message: 'That key has been revoked.' });

    const result = await client().activate(request);

    expect(result.accepted).toBe(false);
    expect(result.message).toBe('That key has been revoked.');
  });

  it('treats a 4xx as a permanent refusal', async () => {
    respondWith(400, { message: 'Unknown licence key.' });

    await expect(client().activate(request)).rejects.toMatchObject({
      name: 'LicenseServerError',
      retryable: false,
      message: 'Unknown licence key.',
    });
  });

  it('treats a 5xx as worth retrying', async () => {
    // The regression: this threw with retryable false, so a restarting load balancer told
    // the user their licence key was invalid.
    respondWith(503, {});

    await expect(client().activate(request)).rejects.toMatchObject({ retryable: true });
  });

  it('treats an unreachable server as worth retrying', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ENOTFOUND')));

    await expect(client().activate(request)).rejects.toMatchObject({
      name: 'LicenseServerError',
      retryable: true,
    });
  });

  it('survives a licence server that answers with HTML', async () => {
    // A misconfigured proxy returning an error page is not a licence decision, and must not
    // surface as a JSON parse error the user cannot act on.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ status: 200, json: () => Promise.reject(new Error('bad')) }),
    );

    expect((await client().activate(request)).accepted).toBe(false);
  });

  it('is a LicenseServerError, so the service can map it', async () => {
    respondWith(500, {});
    await expect(client().activate(request)).rejects.toBeInstanceOf(LicenseServerError);
  });
});
