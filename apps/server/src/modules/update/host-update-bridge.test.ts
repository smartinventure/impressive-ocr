// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST_UPDATE_MARKER_FILE, UPDATE_REQUEST_FILE } from '@impressive-ocr/shared';
import { createLogger } from '../../infra/logger';
import { HostUpdateBridge } from './host-update-bridge';

const logger = createLogger({ level: 'silent', pretty: false });
const created: string[] = [];

async function controlDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'impressive-ocr-update-'));
  created.push(dir);
  return dir;
}

/** What the installer does: drop the marker that advertises a listening host updater. */
async function installMarker(dir: string): Promise<void> {
  await writeFile(join(dir, HOST_UPDATE_MARKER_FILE), '');
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('HostUpdateBridge', () => {
  describe('state', () => {
    it('is unavailable when there is no control directory at all', () => {
      // The desktop app and any container started without the installer.
      const bridge = new HostUpdateBridge({ controlDir: null, logger });
      expect(bridge.state()).toBe('unavailable');
    });

    it('is unavailable when the directory exists but carries no marker', async () => {
      // A bind mount without the installer having run. The button must stay hidden: the
      // request file would be written and nothing would ever act on it.
      const dir = await controlDir();
      const bridge = new HostUpdateBridge({ controlDir: dir, logger });
      expect(bridge.state()).toBe('unavailable');
    });

    it('is ready once the installer has left its marker', async () => {
      const dir = await controlDir();
      await installMarker(dir);
      expect(new HostUpdateBridge({ controlDir: dir, logger }).state()).toBe('ready');
    });

    it('is requested while a request is still waiting to be collected', async () => {
      const dir = await controlDir();
      await installMarker(dir);
      await writeFile(join(dir, UPDATE_REQUEST_FILE), '');
      expect(new HostUpdateBridge({ controlDir: dir, logger }).state()).toBe('requested');
    });

    it('returns to ready after the host script collects the request', async () => {
      // Read from disk on every call rather than cached, so the UI recovers on its own when
      // an update was requested and the host declined or the container was recreated.
      const dir = await controlDir();
      await installMarker(dir);
      const bridge = new HostUpdateBridge({ controlDir: dir, logger });

      bridge.requestUpdate();
      expect(bridge.state()).toBe('requested');

      await rm(join(dir, UPDATE_REQUEST_FILE));
      expect(bridge.state()).toBe('ready');
    });
  });

  describe('requestUpdate', () => {
    it('writes the request file the host watcher is waiting for', async () => {
      const dir = await controlDir();
      await installMarker(dir);

      expect(new HostUpdateBridge({ controlDir: dir, logger }).requestUpdate()).toBe(true);
      expect(existsSync(join(dir, UPDATE_REQUEST_FILE))).toBe(true);
    });

    it('writes a timestamp the host never reads, and nothing else', async () => {
      // The security property: the host script acts on the file existing and runs one fixed
      // command. Contents are for an operator finding a stale request, so they must stay
      // inert -- anything the host interpreted would be an injection point from inside the
      // container.
      const dir = await controlDir();
      await installMarker(dir);
      new HostUpdateBridge({ controlDir: dir, logger }).requestUpdate();

      const contents = await readFile(join(dir, UPDATE_REQUEST_FILE), 'utf8');
      expect(contents.trim()).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    });

    it('refuses when no control directory is configured', () => {
      expect(new HostUpdateBridge({ controlDir: null, logger }).requestUpdate()).toBe(false);
    });

    it('refuses when no host updater has advertised itself', async () => {
      // Without this the UI would report a scheduled update that nothing will ever perform.
      const dir = await controlDir();
      const bridge = new HostUpdateBridge({ controlDir: dir, logger });

      expect(bridge.requestUpdate()).toBe(false);
      expect(existsSync(join(dir, UPDATE_REQUEST_FILE))).toBe(false);
    });

    it('reports failure rather than throwing when the directory cannot be written', async () => {
      // The realistic cause is a bind mount owned by root while the container runs as uid
      // 10001. A failed write must surface as "could not schedule", not a 500.
      const dir = await controlDir();
      await installMarker(dir);
      // A file where the request file needs to be a file *inside* a directory: writing to
      // `<marker>/update-request` fails with ENOTDIR on every platform.
      const bridge = new HostUpdateBridge({
        controlDir: join(dir, HOST_UPDATE_MARKER_FILE),
        logger,
      });

      expect(bridge.requestUpdate()).toBe(false);
    });
  });
});
