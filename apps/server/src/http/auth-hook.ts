// SPDX-License-Identifier: AGPL-3.0-or-later
import { timingSafeEqual } from 'node:crypto';
import { CSRF_HEADER, SESSION_COOKIE } from '@impressive-ocr/shared';
import type { AuthService } from '../modules/auth/auth-service';
import type { SettingsService } from '../modules/settings/settings-service';
import type { AppFastify } from './fastify-types';
import { HttpError } from './errors';

/**
 * Paths reachable without a session.
 *
 * `/api/auth/*` has to be, or logging in would require being logged in. `/api/health` stays
 * open so a container healthcheck or a reverse proxy does not need credentials — it reports
 * liveness only and reveals nothing about the machine.
 */
const PUBLIC_API_PATHS = new Set(['/api/health', '/api/auth/status', '/api/auth/login']);

/** Methods that only read. Everything else needs the CSRF token as well as the session. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface AuthHookOptions {
  auth: AuthService;
  settings: SettingsService;
}

/**
 * Require a valid session for the API once authentication is switched on.
 *
 * Registered as `onRequest`, the earliest hook Fastify offers, so an unauthenticated request
 * is rejected before its body is parsed and before any route handler runs. A route added
 * later is therefore protected by default: forgetting to opt in is not a way to leak.
 *
 * The SPA itself is *not* gated. It is a static bundle containing no user data, and it needs
 * to load in order to render the login form; every byte of actual content comes from the API
 * behind this hook.
 */
export function registerAuthHook(app: AppFastify, options: AuthHookOptions): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;

    const path = request.url.split('?')[0] ?? request.url;
    if (PUBLIC_API_PATHS.has(path)) return;

    // Enforcement follows the *stored* setting, not a snapshot from boot, so switching
    // authentication on takes effect immediately rather than at the next restart.
    if (!options.settings.get().authEnabled) return;

    // Enabled but with no password would lock every client out of an unprotected server:
    // fail open here and closed in the settings service, which refuses to bind to the
    // network in that state.
    if (!options.auth.hasPassword()) return;

    const session = options.auth.validateSession(request.cookies[SESSION_COOKIE]);
    if (session === null) {
      throw new HttpError(401, 'unauthorized', 'Sign in to continue.');
    }

    if (!SAFE_METHODS.has(request.method)) {
      const presented = request.headers[CSRF_HEADER];
      if (typeof presented !== 'string' || !constantTimeEquals(presented, session.csrfToken)) {
        throw new HttpError(403, 'csrf-failed', 'Missing or invalid CSRF token.');
      }
    }

    reply.header('cache-control', 'no-store');
  });
}

/**
 * Compare two tokens without leaking their contents through timing.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a signal, so the
 * lengths are compared first and the result folded in rather than returned early.
 */
function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}
