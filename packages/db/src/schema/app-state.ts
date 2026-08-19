// SPDX-License-Identifier: AGPL-3.0-or-later
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Singleton application state, one JSON document per key.
 *
 * Deliberately schemaless: settings, the hardware probe result and the runtime install status
 * all change shape between releases, and every read validates against a zod schema from
 * `@impressive-ocr/shared`. A typed column per setting would mean a migration per release for
 * no gain.
 */
export const appState = sqliteTable('app_state', {
  key: text('key').primaryKey().$type<AppStateKey>(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const APP_STATE_KEYS = {
  settings: 'settings',
  hardware: 'hardware',
  runtime: 'runtime',
  globallyPaused: 'globally-paused',
} as const;

export type AppStateKey = (typeof APP_STATE_KEYS)[keyof typeof APP_STATE_KEYS];

export type AppStateRow = typeof appState.$inferSelect;
export type NewAppStateRow = typeof appState.$inferInsert;
