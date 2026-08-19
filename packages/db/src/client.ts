// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema/index';

export type Database_ = ReturnType<typeof drizzle<typeof schema>>;

export interface DatabaseHandle {
  db: Database_;
  close: () => void;
}

export interface CreateDatabaseOptions {
  /** Absolute path to the SQLite file. `:memory:` is accepted for tests. */
  filePath: string;
  /** Directory holding generated Drizzle migrations. Omit to skip migrating (tests use push). */
  migrationsFolder?: string;
}

/**
 * Opens the SQLite database with the pragmas this workload needs.
 *
 * WAL matters here: the watcher and scheduler write continuously while the HTTP layer reads
 * for the UI. Without WAL every SSE-driven read would contend with the queue's writes.
 */
export function createDatabase(options: CreateDatabaseOptions): DatabaseHandle {
  if (options.filePath !== ':memory:') {
    mkdirSync(dirname(options.filePath), { recursive: true });
  }

  const sqlite = new Database(options.filePath);

  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  // Wait rather than throw SQLITE_BUSY when the scheduler and an HTTP read overlap.
  sqlite.pragma('busy_timeout = 5000');

  const db = drizzle(sqlite, { schema });

  if (options.migrationsFolder !== undefined) {
    migrate(db, { migrationsFolder: options.migrationsFolder });
  }

  return {
    db,
    close: () => sqlite.close(),
  };
}
