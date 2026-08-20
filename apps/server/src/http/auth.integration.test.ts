// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER, SESSION_COOKIE } from '@impressive-ocr/shared';
import { createApp, type AppHandle } from '../app';

/**
 * The authentication flow through the real HTTP stack.
 *
 * `authEnabled` used to be a flag that unlocked network binding while protecting nothing —
 * there was no password, no session and no hook anywhere in the server. These tests exist to
 * make sure it can never quietly become decorative again.
 */

const PASSWORD = 'a-sufficiently-long-password';

let app: AppHandle;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'impressive-ocr-auth-'));
  app = await createApp({
    dataDir: join(root, 'data'),
    webRoot: undefined,
    pretty: false,
    logLevel: 'silent',
  });
});

afterEach(async () => {
  await app.shutdown();
});

/** Set a password and switch authentication on, the state everything else here assumes. */
async function protect(): Promise<void> {
  await app.http.inject({
    method: 'PUT',
    url: '/api/auth/password',
    payload: { password: PASSWORD, confirmPassword: PASSWORD },
  });
  await app.http.inject({
    method: 'PATCH',
    url: '/api/settings',
    payload: { authEnabled: true },
  });
}

async function login(password = PASSWORD) {
  const response = await app.http.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password },
  });
  return {
    status: response.statusCode,
    cookie: response.cookies.find((entry) => entry.name === SESSION_COOKIE),
    csrfToken:
      response.statusCode === 200 ? (response.json() as { csrfToken: string }).csrfToken : '',
  };
}

describe('auth status', () => {
  it('reports an unprotected instance on first run', async () => {
    const response = await app.http.inject({ method: 'GET', url: '/api/auth/status' });

    expect(response.json()).toEqual({
      authEnabled: false,
      passwordSet: false,
      authenticated: false,
    });
  });

  it('reports a password once one is set', async () => {
    await protect();
    const response = await app.http.inject({ method: 'GET', url: '/api/auth/status' });

    expect(response.json()).toMatchObject({ authEnabled: true, passwordSet: true });
  });
});

describe('setting a password', () => {
  it('rejects one that is too short', async () => {
    const response = await app.http.inject({
      method: 'PUT',
      url: '/api/auth/password',
      payload: { password: 'short', confirmPassword: 'short' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a mismatched confirmation', async () => {
    const response = await app.http.inject({
      method: 'PUT',
      url: '/api/auth/password',
      payload: { password: PASSWORD, confirmPassword: `${PASSWORD}-typo` },
    });

    expect(response.statusCode).toBe(400);
  });

  it('requires the current password once one exists', async () => {
    await protect();
    const session = await login();

    const response = await app.http.inject({
      method: 'PUT',
      url: '/api/auth/password',
      payload: { password: 'a-brand-new-password', confirmPassword: 'a-brand-new-password' },
      cookies: { [SESSION_COOKIE]: session.cookie?.value ?? '' },
      headers: { [CSRF_HEADER]: session.csrfToken },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'password-required' });
  });
});

describe('logging in', () => {
  it('rejects the wrong password', async () => {
    await protect();
    expect((await login('definitely-the-wrong-one')).status).toBe(401);
  });

  it('issues an httpOnly, SameSite=Strict session cookie', async () => {
    await protect();
    const session = await login();

    expect(session.status).toBe(200);
    expect(session.cookie?.httpOnly).toBe(true);
    expect(session.cookie?.sameSite).toBe('Strict');
    // Not `secure` here: the test instance is http, and a secure cookie would be dropped.
    expect(session.csrfToken).not.toBe('');
  });

  it('gives the same answer whether or not a password exists', async () => {
    // Telling an unauthenticated caller "no password is set" would advertise which instances
    // are worth attacking.
    await app.http.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { authEnabled: true },
    });
    const withoutPassword = await app.http.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: PASSWORD },
    });

    expect(withoutPassword.statusCode).toBe(401);
    expect(withoutPassword.json()).toMatchObject({ code: 'invalid-credentials' });
  });
});

describe('the guard', () => {
  it('lets everything through while authentication is off', async () => {
    expect((await app.http.inject({ method: 'GET', url: '/api/pipelines' })).statusCode).toBe(200);
  });

  it('rejects an anonymous API request once protected', async () => {
    await protect();
    const response = await app.http.inject({ method: 'GET', url: '/api/pipelines' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'unauthorized' });
  });

  it('admits a request carrying a valid session', async () => {
    await protect();
    const session = await login();

    const response = await app.http.inject({
      method: 'GET',
      url: '/api/pipelines',
      cookies: { [SESSION_COOKIE]: session.cookie?.value ?? '' },
    });

    expect(response.statusCode).toBe(200);
  });

  it('keeps the login and health endpoints reachable', async () => {
    await protect();

    for (const url of ['/api/health', '/api/auth/status']) {
      expect((await app.http.inject({ method: 'GET', url })).statusCode).toBe(200);
    }
  });

  it('rejects a forged session cookie', async () => {
    await protect();
    const response = await app.http.inject({
      method: 'GET',
      url: '/api/pipelines',
      cookies: { [SESSION_COOKIE]: 'not-a-real-token' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('stops honouring a session after logout', async () => {
    await protect();
    const session = await login();
    const cookies = { [SESSION_COOKIE]: session.cookie?.value ?? '' };

    await app.http.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies,
      headers: { [CSRF_HEADER]: session.csrfToken },
    });

    expect(
      (await app.http.inject({ method: 'GET', url: '/api/pipelines', cookies })).statusCode,
    ).toBe(401);
  });
});

describe('CSRF', () => {
  it('refuses a mutating request with no token, even with a valid session', async () => {
    await protect();
    const session = await login();

    const response = await app.http.inject({
      method: 'POST',
      url: '/api/pipelines',
      payload: { name: 'x', options: {} },
      cookies: { [SESSION_COOKIE]: session.cookie?.value ?? '' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'csrf-failed' });
  });

  it('refuses a wrong token', async () => {
    await protect();
    const session = await login();

    const response = await app.http.inject({
      method: 'POST',
      url: '/api/pipelines',
      payload: { name: 'x', options: {} },
      cookies: { [SESSION_COOKIE]: session.cookie?.value ?? '' },
      headers: { [CSRF_HEADER]: 'a-token-of-the-right-shape-but-wrong-value' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('does not demand one for reads', async () => {
    await protect();
    const session = await login();

    const response = await app.http.inject({
      method: 'GET',
      url: '/api/jobs',
      cookies: { [SESSION_COOKIE]: session.cookie?.value ?? '' },
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('changing the password', () => {
  it('signs every existing session out', async () => {
    await protect();
    const session = await login();
    const cookies = { [SESSION_COOKIE]: session.cookie?.value ?? '' };

    const changed = await app.http.inject({
      method: 'PUT',
      url: '/api/auth/password',
      payload: {
        password: 'an-entirely-new-password',
        confirmPassword: 'an-entirely-new-password',
        currentPassword: PASSWORD,
      },
      cookies,
      headers: { [CSRF_HEADER]: session.csrfToken },
    });
    expect(changed.statusCode).toBe(200);

    // Changing a password because it may be compromised has to evict whoever holds a session.
    expect(
      (await app.http.inject({ method: 'GET', url: '/api/pipelines', cookies })).statusCode,
    ).toBe(401);
    expect((await login('an-entirely-new-password')).status).toBe(200);
  });
});
