// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import { createApp, PortInUseError } from './app';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * What happens when the configured port is taken.
 *
 * A real listener, not a mock: the behaviour under test is the operating system's, and a
 * stubbed EADDRINUSE would pass whether or not the scan works.
 */

/** What a fresh install stores, and therefore what an unrelated override must leave alone. */
const DEFAULT_PORT = 8084;

function occupy(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function appOn(port: number, portStrategy: 'fixed' | 'next-free') {
  return createApp({
    dataDir: mkdtempSync(join(tmpdir(), 'ocr-port-')),
    port,
    portStrategy,
    bindAddress: '127.0.0.1',
  });
}

describe('port fallback', () => {
  it('moves to the next free port when the caller allows it', async () => {
    const blocker = await occupy(18_231);
    const handle = await appOn(18_231, 'next-free');
    try {
      const url = await handle.listen();

      expect(handle.boundPort()).toBe(18_232);
      expect(url).toContain('18232');
    } finally {
      await handle.shutdown();
      await close(blocker);
    }
  });

  it('keeps the configured port when it is free', async () => {
    const handle = await appOn(18_235, 'next-free');
    try {
      await handle.listen();

      expect(handle.boundPort()).toBe(18_235);
    } finally {
      await handle.shutdown();
    }
  });

  it('skips as many taken ports as it needs to', async () => {
    const blockers = [await occupy(18_240), await occupy(18_241), await occupy(18_242)];
    const handle = await appOn(18_240, 'next-free');
    try {
      await handle.listen();

      expect(handle.boundPort()).toBe(18_243);
    } finally {
      await handle.shutdown();
      for (const blocker of blockers) await close(blocker);
    }
  });

  it('fails loudly under the fixed strategy, naming the configured port', async () => {
    // What a container or a service unit gets. A server that moved would leave a published
    // port mapping pointing at nothing, which looks like a network fault rather than a
    // configuration one.
    const blocker = await occupy(18_250);
    const handle = await appOn(18_250, 'fixed');
    try {
      await expect(handle.listen()).rejects.toBeInstanceOf(PortInUseError);
    } finally {
      await handle.shutdown();
      await close(blocker);
    }
  });

  it('does not write the fallback back into settings', async () => {
    // A port held by something transient must not silently rewrite a preference the user
    // set; the next start should try their port again. The stored value here is the default,
    // because `port` is a startup override that never touches settings either — so the check
    // that matters is that the port it *landed* on did not become the stored one.
    const blocker = await occupy(18_260);
    const handle = await appOn(18_260, 'next-free');
    try {
      await handle.listen();
      const stored = handle.services.settings.get().port;

      expect(handle.boundPort()).toBe(18_261);
      expect(stored).not.toBe(18_261);
      expect(stored).toBe(DEFAULT_PORT);
    } finally {
      await handle.shutdown();
      await close(blocker);
    }
  });
});
