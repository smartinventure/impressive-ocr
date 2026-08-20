// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  loginRequestSchema,
  setPasswordRequestSchema,
  SESSION_COOKIE,
  SESSION_IDLE_TIMEOUT_MINUTES,
  type AuthStatus,
} from '@impressive-ocr/shared';
import { AuthError } from '../../modules/auth/auth-service';
import type { AppServices } from '../../app-services';
import type { AppFastify } from '../fastify-types';
import { HttpError } from '../errors';

/**
 * Sign-in, sign-out and password management.
 *
 * Kept out of `/api/settings` on purpose: settings are read and written as one document, and
 * a password does not belong in anything a client can round-trip.
 */
export function registerAuthRoutes(app: AppFastify, services: AppServices): void {
  const { auth, settings } = services;

  /** Lets the SPA decide between the login screen, the app, and the first-run setup. */
  app.get('/api/auth/status', (request) => {
    const session = auth.validateSession(request.cookies[SESSION_COOKIE]);
    const status: AuthStatus = {
      authEnabled: settings.get().authEnabled,
      passwordSet: auth.hasPassword(),
      authenticated: session !== null,
      // Only ever to a caller who already proved they hold the session.
      ...(session === null ? {} : { csrfToken: session.csrfToken }),
    };
    return status;
  });

  app.post('/api/auth/login', async (request, reply) => {
    const body = loginRequestSchema.parse(request.body);

    let session;
    try {
      session = await auth.login(body.password);
    } catch (error) {
      if (error instanceof AuthError) {
        // One message for both "no password set" and "wrong password". Distinguishing them
        // would tell an unauthenticated caller whether the instance is worth attacking.
        throw new HttpError(401, 'invalid-credentials', 'Incorrect password.');
      }
      throw error;
    }

    reply.setCookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: 'strict',
      // Only over https, otherwise the browser refuses the cookie on a loopback http origin
      // and login silently fails.
      secure: settings.get().scheme === 'https',
      path: '/',
      maxAge: SESSION_IDLE_TIMEOUT_MINUTES * 60,
    });

    // The CSRF token goes in the body, not a cookie: the client has to be able to read it in
    // order to echo it back in a header, which is precisely what a cross-site page cannot do.
    return { csrfToken: session.csrfToken };
  });

  app.post('/api/auth/logout', (request, reply) => {
    auth.logout(request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  /**
   * Set or change the password.
   *
   * Reachable without a session only while none exists yet — the first-run case, where
   * requiring a session would be a chicken and egg. Once set, the auth hook has already
   * demanded a valid session before this handler runs, and the service additionally demands
   * the current password.
   */
  app.put('/api/auth/password', async (request) => {
    const body = setPasswordRequestSchema.parse(request.body);

    try {
      await auth.setPassword(body.password, body.currentPassword);
    } catch (error) {
      if (error instanceof AuthError) {
        const status = error.reason === 'invalid-credentials' ? 401 : 400;
        throw new HttpError(status, error.reason, error.message);
      }
      throw error;
    }

    return { ok: true };
  });

  /**
   * Remove the password.
   *
   * Also switches authentication off: leaving it on with no password would be a lock with no
   * key, and the settings service would then refuse every network binding.
   */
  app.delete('/api/auth/password', () => {
    auth.clearPassword();
    if (settings.get().authEnabled) {
      settings.update({ authEnabled: false });
    }
    return { ok: true };
  });
}
