// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { HOST_MOUNT, isHostPath, toHostPath } from './host-mount';

/**
 * The container-to-host path mapping.
 *
 * A container cannot see the host, and Docker will not reliably say where a mount came from.
 * This does not ask: the operator mounts the host root at one fixed place, so the mapping is
 * chosen rather than inferred and `host /X` is `container /host/X`, always.
 *
 * The direction matters. Rclone and Borgmatic strip this prefix before handing a path on,
 * because their consumers run in the host's view. Nothing here does — the OCR sidecar is a
 * subprocess of this server, in this container — so the shortened path is for reading only
 * and must never reach a pipeline.
 */

describe('toHostPath', () => {
  it('reads a mounted folder back as the operator knows it', () => {
    expect(toHostPath('/host/mnt/scans')).toBe('/mnt/scans');
  });

  it('reports the mount itself as the host root', () => {
    expect(toHostPath(HOST_MOUNT)).toBe('/');
  });

  it('returns null outside the mount, so a container path is never shortened by accident', () => {
    expect(toHostPath('/data/output')).toBeNull();
    expect(toHostPath('/')).toBeNull();
  });

  it('does not treat a similarly named sibling as mounted', () => {
    // `/hostile` shares the prefix as text and shares nothing as a path.
    expect(toHostPath('/hostile/data')).toBeNull();
    expect(isHostPath('/hostile/data')).toBe(false);
  });

  it('round-trips: prefixing the host path gives back the container path', () => {
    // The property the whole convention rests on.
    for (const hostPath of ['/mnt/scans', '/srv/documents', '/home/anna/inbox']) {
      expect(toHostPath(`${HOST_MOUNT}${hostPath}`)).toBe(hostPath);
    }
  });
});

describe('isHostPath', () => {
  it('recognises the mount and everything under it', () => {
    expect(isHostPath(HOST_MOUNT)).toBe(true);
    expect(isHostPath('/host/etc')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isHostPath('/data')).toBe(false);
    expect(isHostPath('/hostname.txt')).toBe(false);
  });
});
