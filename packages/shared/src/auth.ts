// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

/**
 * Minimum password length.
 *
 * OWASP puts the floor at 8; this is a single shared secret guarding an API that reads and
 * writes every folder in the allowlist, so it gets 12. No composition rules (upper, digit,
 * symbol): NIST 800-63B dropped them because they push people towards `Password1!` rather
 * than length, which is what actually costs an attacker.
 */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * Upper bound so a request cannot make the server burn CPU on an absurd input. scrypt's cost
 * is dominated by its parameters rather than input length, but an unbounded field is still a
 * free amplification primitive.
 */
export const MAX_PASSWORD_LENGTH = 128;

const passwordSchema = z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH);

export const setPasswordRequestSchema = z
  .object({
    password: passwordSchema,
    confirmPassword: z.string(),
    /**
     * Required once a password already exists, so that someone who walks up to an unlocked
     * browser cannot silently change it and lock the owner out.
     */
    currentPassword: z.string().max(MAX_PASSWORD_LENGTH).optional(),
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: 'passwords-do-not-match',
    path: ['confirmPassword'],
  });

export type SetPasswordRequest = z.infer<typeof setPasswordRequestSchema>;

export const loginRequestSchema = z.object({
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const authStatusSchema = z.object({
  /** Whether the operator asked for authentication at all. */
  authEnabled: z.boolean(),
  /** Whether a password hash actually exists. Enabled without one would be a lock with no key. */
  passwordSet: z.boolean(),
  /** Whether *this* caller currently holds a valid session. */
  authenticated: z.boolean(),
  /**
   * The CSRF token for the current session, when there is one.
   *
   * Returned here as well as from login because the session lives in a cookie that survives a
   * page reload while an in-memory token does not: without this, refreshing the browser would
   * leave a still-valid session unable to make a single mutating request.
   *
   * Safe to expose on a same-origin response. It defends against *cross-site* requests, and
   * an attacker's page cannot read this body precisely because the same-origin policy stops
   * it — which is the whole mechanism.
   */
  csrfToken: z.string().optional(),
});

export type AuthStatus = z.infer<typeof authStatusSchema>;

/** Name of the session cookie. `__Host-` would be stricter but is rejected over plain http. */
export const SESSION_COOKIE = 'impressive_ocr_session';

/**
 * Header carrying the CSRF token on mutating requests.
 *
 * The session cookie is SameSite=Strict, which already blocks cross-site form posts; this is
 * the second half of a double-submit pair, because a custom header cannot be set by a plain
 * HTML form at all.
 */
export const CSRF_HEADER = 'x-impressive-ocr-csrf';

/** How long a session survives without being used. */
export const SESSION_IDLE_TIMEOUT_MINUTES = 12 * 60;
