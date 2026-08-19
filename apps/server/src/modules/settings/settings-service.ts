// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from 'drizzle-orm';
import {
  APP_STATE_KEYS,
  appState,
  type Database_,
} from '@impressive-ocr/db';
import {
  appSettingsSchema,
  type AppSettings,
  type UpdateSettingsRequest,
} from '@impressive-ocr/shared';

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

  constructor(private readonly db: Database_) {}

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
    assertSafeExposure(merged);

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

  /** Folders the user has authorised. Everything filesystem-related checks against this. */
  allowlist(): readonly string[] {
    return this.get().folderAllowlist;
  }
}

/**
 * Refuse to serve the UI to the network without authentication.
 *
 * Binding `0.0.0.0` exposes an API that reads and writes arbitrary folders on this machine.
 * Making that reachable unauthenticated is not a configuration the user can meaningfully
 * consent to through a checkbox, so the combination is rejected outright.
 */
export function assertSafeExposure(settings: AppSettings): void {
  if (settings.bindAddress !== '127.0.0.1' && !settings.authEnabled) {
    throw new SettingsValidationError(
      'Enable authentication before binding to a network address; ' +
        'the API can read and write any folder in the allowlist.',
    );
  }
}
