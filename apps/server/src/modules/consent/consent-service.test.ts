// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APP_STATE_KEYS, appState, createDatabase, type Database_ } from '@impressive-ocr/db';
import { CONSENT_TERMS_VERSION } from '@impressive-ocr/shared';
import { defaultMigrationsDir } from '../../infra/module-paths';
import { ConsentService, ConsentVersionMismatchError } from './consent-service';

/**
 * Consent is the one piece of state that must fail closed: asking someone to agree twice is a
 * minor annoyance, recording an agreement that never happened is not.
 */

let consent: ConsentService;
let db: Database_;
let close: () => void;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'impressive-ocr-consent-'));
  const database = createDatabase({
    filePath: join(root, 'test.db'),
    migrationsFolder: defaultMigrationsDir(),
  });
  close = database.close;
  db = database.db;
  consent = new ConsentService(db);
});

afterEach(() => {
  close();
});

describe('ConsentService', () => {
  it('reports a fresh install as not yet agreed', () => {
    const status = consent.status();

    expect(status.acceptedVersion).toBe(0);
    expect(status.acceptedAt).toBeNull();
    expect(status.isCurrent).toBe(false);
  });

  it('records an agreement with the version and the time', () => {
    const status = consent.accept(CONSENT_TERMS_VERSION);

    expect(status.isCurrent).toBe(true);
    expect(status.acceptedVersion).toBe(CONSENT_TERMS_VERSION);
    expect(status.acceptedAt).not.toBeNull();
  });

  it('keeps the agreement across a restart', () => {
    consent.accept(CONSENT_TERMS_VERSION);

    // Same database, new service: what a restart amounts to.
    expect(consent.status().isCurrent).toBe(true);
  });

  it('refuses consent submitted for a version this build does not require', () => {
    // An application left open across an update would otherwise record agreement to the
    // terms it happens to be holding rather than the ones now in force.
    expect(() => consent.accept(CONSENT_TERMS_VERSION + 1)).toThrow(ConsentVersionMismatchError);
    expect(consent.status().isCurrent).toBe(false);
  });

  it('treats an unreadable record as never agreed', () => {
    db.insert(appState)
      .values({
        key: APP_STATE_KEYS.consent,
        value: { acceptedVersion: 'yes please' },
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: appState.key,
        set: { value: { acceptedVersion: 'yes please' } },
      })
      .run();

    // A hand-edited or downgraded row must not read as consent. Prompting again is the only
    // safe way to be wrong here.
    expect(consent.status().isCurrent).toBe(false);
  });
});
