// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/host` as a browse root, which is the half of the feature a unit test can still reach.
 *
 * The mapping itself is covered in `host-mount.test.ts`. What this pins down is the wiring:
 * that a container started with `-v /:/host:ro` gets the mount offered first in the root list
 * and labelled with the operator's own path, and that a machine without one is unchanged.
 *
 * The mount is faked rather than created. `hasHostMount` is a real `stat` against a real
 * path, and a test that needed `/host` to exist would only run inside a container — which is
 * exactly the environment this cannot assume.
 */

import type * as HostMount from './host-mount';

const hasHostMount = vi.hoisted(() => vi.fn());

vi.mock('./host-mount', async (importOriginal) => {
  // Only the probe is faked; `toHostPath` and the rest stay real, so this exercises the same
  // mapping the container would.
  const actual = await importOriginal<typeof HostMount>();
  return { ...actual, hasHostMount };
});

const { browseFolders, resetSystemRootsCache } = await import('./folder-browser');

/**
 * A container is Linux, and this suite runs on whatever the developer has.
 *
 * `systemRoots` branches on the platform — Windows enumerates drive letters and never looks
 * for a mount — so without this the tests pass on Windows for the wrong reason: `/host` is
 * absent because the branch was never taken, not because the logic works.
 */
const realPlatform = process.platform;

function pretendLinux(): void {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
}

/**
 * The drive list is probed at most once a minute and remembered in between, so without this
 * the second test in the file is answered from the first one's cache -- and a machine with a
 * host mount goes on reporting one after it has been taken away.
 */
beforeEach(() => {
  resetSystemRootsCache();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  resetSystemRootsCache();
});

async function systemRootNames(): Promise<string[]> {
  const result = await browseFolders({ path: null, scope: 'system', allowlist: [] });
  return result.entries.map((entry) => entry.path);
}

describe('the host mount as a browse root', () => {
  it('offers it first, ahead of the container root', async () => {
    // In a container the operator came looking for their own machine; `/` is this container's
    // short and unfamiliar tree, and putting it first buries what they wanted.
    pretendLinux();
    hasHostMount.mockResolvedValue(true);

    const roots = await systemRootNames();

    expect(roots[0]).toBe('/host');
    expect(roots).toContain('/');
  });

  it('labels it with the path the operator knows', async () => {
    pretendLinux();
    hasHostMount.mockResolvedValue(true);

    const result = await browseFolders({ path: null, scope: 'system', allowlist: [] });
    const host = result.entries.find((entry) => entry.path === '/host');

    // The mount is the host's root, so that is what it reads as.
    expect(host?.hostPath).toBe('/');
  });

  it('is absent on a machine without one', async () => {
    // Every desktop installation, where nothing should mention a container.
    pretendLinux();
    hasHostMount.mockResolvedValue(false);

    const roots = await systemRootNames();

    expect(roots).not.toContain('/host');
  });

  it('leaves ordinary roots unlabelled', async () => {
    pretendLinux();
    hasHostMount.mockResolvedValue(true);

    const result = await browseFolders({ path: null, scope: 'system', allowlist: [] });
    const containerRoot = result.entries.find((entry) => entry.path === '/');

    expect(containerRoot?.hostPath).toBeNull();
  });
});
