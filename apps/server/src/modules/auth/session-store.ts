// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';

/**
 * In-memory session store.
 *
 * Deliberately not persisted. This is a local-first application with a single shared
 * password; sessions surviving a restart buys nothing, while writing them to disk would put
 * live bearer tokens in the same SQLite file users copy around to move their job history.
 * A restart logging everybody out is the safer default.
 */

export interface Session {
  readonly token: string;
  /** Double-submit token; sent to the client in a readable form, unlike the session cookie. */
  readonly csrfToken: string;
  readonly createdAt: number;
  expiresAt: number;
}

export interface SessionStore {
  create(): Session;
  /** Returns the session and extends its idle window, or null if unknown or expired. */
  validate(token: string | undefined): Session | null;
  destroy(token: string | undefined): void;
  /** Drops every session; used when the password changes. */
  destroyAll(): void;
  readonly size: number;
}

export interface SessionStoreOptions {
  idleTimeoutMinutes: number;
  /** Injectable so tests can advance time without sleeping. */
  now?: () => number;
}

const TOKEN_BYTES = 32;

export function createSessionStore(options: SessionStoreOptions): SessionStore {
  const sessions = new Map<string, Session>();
  const now = options.now ?? Date.now;
  const idleWindow = options.idleTimeoutMinutes * 60 * 1000;

  function purgeExpired(at: number): void {
    for (const [token, session] of sessions) {
      if (session.expiresAt <= at) sessions.delete(token);
    }
  }

  return {
    create(): Session {
      const at = now();
      // Opportunistic sweep: without a timer, expired entries would otherwise accumulate for
      // as long as the process lives.
      purgeExpired(at);

      const session: Session = {
        token: randomBytes(TOKEN_BYTES).toString('base64url'),
        csrfToken: randomBytes(TOKEN_BYTES).toString('base64url'),
        createdAt: at,
        expiresAt: at + idleWindow,
      };
      sessions.set(session.token, session);
      return session;
    },

    validate(token: string | undefined): Session | null {
      if (token === undefined || token === '') return null;

      const session = sessions.get(token);
      if (session === undefined) return null;

      const at = now();
      if (session.expiresAt <= at) {
        sessions.delete(token);
        return null;
      }

      // Sliding expiry: activity keeps a session alive, idleness ends it.
      session.expiresAt = at + idleWindow;
      return session;
    },

    destroy(token: string | undefined): void {
      if (token === undefined) return;
      sessions.delete(token);
    },

    destroyAll(): void {
      sessions.clear();
    },

    get size(): number {
      purgeExpired(now());
      return sessions.size;
    },
  };
}
