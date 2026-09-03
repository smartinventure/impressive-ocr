// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_STATE_KEYS, appState, createDatabase, type Database_ } from '@impressive-ocr/db';
import { APP_VERSION, type RuntimeStatus } from '@impressive-ocr/shared';

import { defaultMigrationsDir } from '../../infra/module-paths';
import { RuntimeService } from './runtime-service';
import type { RuntimeInstaller } from './runtime-installer';
import { EventBus } from '../events/event-bus';
import { createLogger } from '../../infra/logger';

/**
 * Bringing the installed Python up to the version this build ships.
 *
 * The failure this prevents happened in a release: a fix for documents taken from a PDF's own
 * text layer shipped, and every existing install went on writing nothing. The sidecar is
 * copied into the venv during setup and never touched again, so the Python carrying the fix
 * sat unused in the app's resources while the old copy kept running — with a healthy-looking
 * runtime and a job that reported success.
 */

let db: Database_;
let close: () => void;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'impressive-ocr-runtime-'));
  const database = createDatabase({
    filePath: join(root, 'test.db'),
    migrationsFolder: defaultMigrationsDir(),
  });
  close = database.close;
  db = database.db;
});

afterEach(() => {
  close();
});

function storeStatus(status: Partial<RuntimeStatus>): void {
  const full = {
    state: 'ready',
    currentStep: null,
    progressPercent: 100,
    message: '',
    pythonVersion: '3.12.8',
    paddleVersion: '3.0.0',
    paddleocrVersion: '3.7.0',
    sidecarVersion: '1.0.2',
    paddleFlavor: 'gpu',
    vlServerInstalled: false,
    errorMessage: null,
    ...status,
  };
  db.insert(appState)
    .values({
      key: APP_STATE_KEYS.runtime,
      value: full,
      updatedAt: new Date().toISOString(),
    })
    .run();
}

function makeService(status: Partial<RuntimeStatus>) {
  storeStatus(status);

  const installer = {
    isInstalled: vi.fn().mockResolvedValue(true),
    reinstallSidecar: vi.fn().mockResolvedValue({
      python: '3.12.8',
      paddle: '3.0.0',
      paddleocr: '3.7.0',
      sidecar: APP_VERSION,
    }),
    readVersions: vi.fn().mockResolvedValue({
      python: '3.12.8',
      paddle: '3.0.0',
      paddleocr: '3.7.0',
      sidecar: status.sidecarVersion ?? null,
    }),
  };

  const service = new RuntimeService({
    db,
    events: new EventBus(),
    logger: createLogger({ level: 'silent', pretty: false }),
    venvDir: join(tmpdir(), 'venv'),
    uvBinary: join(tmpdir(), 'uv'),
    isVlServerInstalled: () => false,
    installer: installer as unknown as RuntimeInstaller,
  });

  return { service, installer };
}

describe('RuntimeService sidecar freshness', () => {
  it('updates an engine older than this build', async () => {
    const { service, installer } = makeService({ state: 'ready', sidecarVersion: '1.0.2' });

    await service.initialize();

    expect(installer.reinstallSidecar).toHaveBeenCalled();
  });

  it('leaves a matching engine alone', async () => {
    // Reinstalling on every start would add seconds to launch for nothing.
    const { service, installer } = makeService({ state: 'ready', sidecarVersion: APP_VERSION });

    await service.initialize();

    expect(installer.reinstallSidecar).not.toHaveBeenCalled();
  });

  it('does not touch a runtime that is not installed', async () => {
    const { service, installer } = makeService({
      state: 'not-installed',
      sidecarVersion: null,
    });

    await service.initialize();

    expect(installer.reinstallSidecar).not.toHaveBeenCalled();
  });

  it('starts anyway when the update fails', async () => {
    // Last week's Python still works. Refusing to start would be the worse outcome, and the
    // user would have no way to reach the repair that fixes it.
    const { service, installer } = makeService({ state: 'ready', sidecarVersion: '1.0.2' });
    installer.reinstallSidecar.mockRejectedValue(new Error('locked by another process'));

    await expect(service.initialize()).resolves.not.toThrow();
  });

  it('records the version it moved to', async () => {
    const { service } = makeService({ state: 'ready', sidecarVersion: '1.0.2' });

    await service.initialize();

    expect(service.getStatus().sidecarVersion).toBe(APP_VERSION);
  });
});
