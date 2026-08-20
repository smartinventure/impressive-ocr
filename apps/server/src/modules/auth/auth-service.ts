// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from 'drizzle-orm';
import { APP_STATE_KEYS, appState, type Database_ } from '@impressive-ocr/db';
import { z } from 'zod';
import { hashPassword, needsRehash, verifyPassword } from './password-hash';
import type { Session, SessionStore } from './session-store';

/**
 * Owns the web UI password and the sessions it grants.
 *
 * The hash lives under its own `app_state` key rather than inside the settings document,
 * because settings are returned wholesale by `GET /api/settings`. Keeping the two apart means
 * no future field added to that response can accidentally carry the hash to a browser.
 */

/** Stored shape. Versioned so a future format change can be migrated rather than guessed at. */
const authStateSchema = z.object({
  version: z.literal(1),
  passwordHash: z.string().min(1),
  updatedAt: z.string(),
});

export class AuthError extends Error {
  constructor(
    message: string,
    readonly reason: 'no-password-set' | 'invalid-credentials' | 'password-required',
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export class AuthService {
  constructor(
    private readonly db: Database_,
    private readonly sessions: SessionStore,
  ) {}

  /** Whether a password hash exists. Auth cannot be enforced without one. */
  hasPassword(): boolean {
    return this.readHash() !== null;
  }

  /**
   * Set or replace the password.
   *
   * Once a password exists the current one must be supplied: otherwise anyone reaching an
   * unattended, already-authenticated browser could change it and lock the owner out.
   */
  async setPassword(password: string, currentPassword?: string): Promise<void> {
    const existing = this.readHash();

    if (existing !== null) {
      if (currentPassword === undefined || currentPassword === '') {
        throw new AuthError('The current password is required.', 'password-required');
      }
      if (!(await verifyPassword(currentPassword, existing))) {
        throw new AuthError('The current password is incorrect.', 'invalid-credentials');
      }
    }

    this.writeHash(await hashPassword(password));

    // Every existing session was granted by the old password. Changing it because of a
    // suspected compromise has to actually evict whoever might be holding one.
    this.sessions.destroyAll();
  }

  /** Remove the password entirely, which also disables authentication. */
  clearPassword(): void {
    this.db.delete(appState).where(eq(appState.key, APP_STATE_KEYS.auth)).run();
    this.sessions.destroyAll();
  }

  /**
   * Exchange a password for a session.
   *
   * Transparently re-hashes on success when the stored parameters have fallen behind — the
   * only moment the plaintext is available to do it with.
   */
  async login(password: string): Promise<Session> {
    const stored = this.readHash();
    if (stored === null) {
      throw new AuthError('No password has been set.', 'no-password-set');
    }

    if (!(await verifyPassword(password, stored))) {
      throw new AuthError('Incorrect password.', 'invalid-credentials');
    }

    if (needsRehash(stored)) {
      this.writeHash(await hashPassword(password));
    }

    return this.sessions.create();
  }

  logout(token: string | undefined): void {
    this.sessions.destroy(token);
  }

  validateSession(token: string | undefined): Session | null {
    return this.sessions.validate(token);
  }

  private readHash(): string | null {
    const row = this.db.select().from(appState).where(eq(appState.key, APP_STATE_KEYS.auth)).get();

    if (row === undefined) return null;

    // A corrupted or downgraded row reads as "no password", which fails closed: the server
    // then refuses to bind anywhere but loopback rather than serving unprotected.
    const parsed = authStateSchema.safeParse(row.value);
    return parsed.success ? parsed.data.passwordHash : null;
  }

  private writeHash(passwordHash: string): void {
    const value = { version: 1 as const, passwordHash, updatedAt: new Date().toISOString() };
    this.db
      .insert(appState)
      .values({ key: APP_STATE_KEYS.auth, value, updatedAt: value.updatedAt })
      .onConflictDoUpdate({
        target: appState.key,
        set: { value, updatedAt: value.updatedAt },
      })
      .run();
  }
}
