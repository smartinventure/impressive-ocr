// SPDX-License-Identifier: AGPL-3.0-or-later
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { APP_STATE_KEYS, appState, type Database_ } from '@impressive-ocr/db';
import {
  appSettingsSchema,
  type AppSettings,
  type UpdateSettingsRequest,
} from '@impressive-ocr/shared';
import { isInside } from '../../infra/fs/safe-path';

/**
 * Reads and writes application settings.
 *
 * Stored as one JSON document and validated on every read: the option set changes between
 * releases, and a column-per-setting schema would mean a migration each time for no benefit.
 * Validation on read also means a hand-edited or downgraded database degrades to defaults
 * instead of crashing the server.
 */

export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsValidationError';
  }
}

export class SettingsService {
  private cached: AppSettings | null = null;

  /**
   * @param hasPassword Whether a web UI password actually exists. Defaults to "no", so a
   *   caller that forgets to wire it fails closed and refuses network binding rather than
   *   silently serving the API unprotected.
   */
  constructor(
    private readonly db: Database_,
    private readonly hasPassword: () => boolean = () => false,
  ) {}

  get(): AppSettings {
    if (this.cached !== null) {
      return this.cached;
    }
    const row = this.db
      .select()
      .from(appState)
      .where(eq(appState.key, APP_STATE_KEYS.settings))
      .get();

    // `parse` on an empty object yields the full set of defaults, so a fresh install and a
    // partially-written row both land somewhere valid.
    const parsed = appSettingsSchema.safeParse(row?.value ?? {});
    this.cached = parsed.success ? parsed.data : appSettingsSchema.parse({});
    return this.cached;
  }

  update(patch: UpdateSettingsRequest): AppSettings {
    const merged = appSettingsSchema.parse({ ...this.get(), ...patch });
    assertSafeExposure(merged, { hasPassword: this.hasPassword() });

    this.db
      .insert(appState)
      .values({
        key: APP_STATE_KEYS.settings,
        value: merged,
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: appState.key,
        set: { value: merged, updatedAt: new Date().toISOString() },
      })
      .run();

    this.cached = merged;
    return merged;
  }

  /** Folders the user has authorized. Everything filesystem-related checks against this. */
  allowlist(): readonly string[] {
    return this.get().folderAllowlist;
  }

  /**
   * Authorize a folder the user has just chosen.
   *
   * Picking a folder in the browser *is* the act of authorizing it — making people then go to
   * Settings and add the same path again taught them nothing and blocked the first run behind
   * a screen explaining they were not allowed to do anything yet.
   *
   * The boundary itself is unchanged: only an explicit choice authorizes, everything still
   * resolves through `resolveSafePath`, and the list stays revocable.
   *
   * Returns the full list so the caller can reflect it without a second read.
   */
  authorizeFolder(absolutePath: string): readonly string[] {
    const current = this.get().folderAllowlist;
    if (current.some((entry) => isSamePath(entry, absolutePath) || isInside(entry, absolutePath))) {
      // Already covered, by itself or by a parent. Adding it again would only grow the list.
      return current;
    }

    // Drop entries this one now contains, so authorizing D:\ after D:\scans leaves one entry
    // rather than two overlapping ones that both have to be reasoned about later.
    const withoutRedundant = current.filter((entry) => !isInside(absolutePath, entry));

    return this.update({ folderAllowlist: [...withoutRedundant, absolutePath] }).folderAllowlist;
  }

  /** Remove a folder. Anything under it stops resolving immediately. */
  revokeFolder(absolutePath: string): readonly string[] {
    const remaining = this.get().folderAllowlist.filter(
      (entry) => !isSamePath(entry, absolutePath),
    );
    return this.update({ folderAllowlist: remaining }).folderAllowlist;
  }
}

/** Path equality that tolerates case and separator differences on Windows. */
function isSamePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

/** What the rest of the app knows that these rules depend on. */
export interface ExposureCapabilities {
  /** Whether a password hash exists. A tick-box without one protects nothing. */
  hasPassword: boolean;
}

/**
 * Refuse to serve the UI to the network unless it is genuinely protected.
 *
 * Binding `0.0.0.0` exposes an API that reads and writes arbitrary folders on this machine.
 * Making that reachable unauthenticated is not a configuration the user can meaningfully
 * consent to through a checkbox, so the combination is rejected outright.
 *
 * Three separate conditions, because each fails differently:
 *
 * 1. `authEnabled` off entirely - no protection at all.
 * 2. `authEnabled` on but no password stored - the flag once meant nothing more than "let me
 *    bind to the network", which is exactly the hole this closes.
 * 3. `scheme` still http - the password would then cross the network in the clear on every
 *    request, so protecting the API would leak the credential protecting it.
 *
 * Loopback is exempt from the TLS rule: traffic to 127.0.0.1 never reaches a network
 * interface, and forcing a certificate there would only train users to click through
 * warnings.
 */
export function assertSafeExposure(
  settings: AppSettings,
  capabilities: ExposureCapabilities,
): void {
  if (settings.bindAddress === '127.0.0.1') return;

  if (!settings.authEnabled) {
    throw new SettingsValidationError(
      'Enable authentication before binding to a network address; ' +
        'the API can read and write any folder in the allowlist.',
    );
  }

  if (!capabilities.hasPassword) {
    throw new SettingsValidationError(
      'Set a password before binding to a network address; ' +
        'authentication is enabled but no password exists.',
    );
  }

  if (settings.scheme !== 'https') {
    throw new SettingsValidationError(
      'Use https before binding to a network address; ' +
        'over http the password is sent in the clear on every request.',
    );
  }
}
