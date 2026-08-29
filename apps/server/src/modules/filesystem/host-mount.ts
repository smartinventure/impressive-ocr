// SPDX-License-Identifier: AGPL-3.0-or-later
import { stat } from 'node:fs/promises';

/**
 * The host's filesystem, when a container was started with it mounted.
 *
 * A container cannot see the host, and Docker will not reliably tell it where a mount came
 * from — asking is the unreliable part. So this does not ask. The operator mounts the host
 * root at one fixed, known place:
 *
 *     volumes:
 *       - /:/host:ro
 *
 * and the mapping is then chosen rather than inferred: `host /X` is `container /host/X`,
 * always. That is the same convention the Infinity Tools images use for Rclone and Borgmatic,
 * so an operator running those already knows it.
 *
 * **The prefix is for display only, and that is the opposite of what those tools do.** They
 * strip `/host` before handing a path to `rclone rcd` or `borg`, because those run in the
 * host's view. Nothing here does: the PaddleOCR sidecar is a subprocess of this server, in
 * this container, and a job given `/mnt/scans/x.pdf` fails because that path does not exist
 * in its namespace. Every stored path stays `/host/...`; only what the operator reads is
 * shortened.
 *
 * Mounting also does not authorise. `/host` becomes browsable and nothing more — a job still
 * refuses a path that is not on the allowlist. The alternative would make one line of compose
 * enough to turn an OCR service into a way to read every file on the machine, since this
 * application's whole purpose is to extract the text of a document into a file someone else
 * chooses.
 */

/** Where the host root is expected. Fixed on purpose: a configurable one is not a convention. */
export const HOST_MOUNT = '/host';

/**
 * Whether this process can see a mounted host filesystem.
 *
 * Deliberately only a directory check. Verifying it is a real mount point would mean parsing
 * `/proc/self/mountinfo`, which buys nothing: if `/host` exists and holds the host tree, the
 * convention holds, and if some non-container installation happens to have a `/host`
 * directory, browsing it is the same as browsing any other folder — the allowlist still
 * decides what may be used.
 */
export async function hasHostMount(): Promise<boolean> {
  if (process.platform === 'win32') {
    return false;
  }
  try {
    return (await stat(HOST_MOUNT)).isDirectory();
  } catch {
    return false;
  }
}

/** Whether a path lies under the host mount. */
export function isHostPath(path: string): boolean {
  return path === HOST_MOUNT || path.startsWith(`${HOST_MOUNT}/`);
}

/**
 * The path as the operator knows it on their own machine.
 *
 * `/host/mnt/scans` reads back as `/mnt/scans`; the mount itself reads as `/`. Returns null
 * for anything outside the mount, so a caller cannot accidentally shorten a container path
 * that was never a host one.
 */
export function toHostPath(path: string): string | null {
  if (!isHostPath(path)) {
    return null;
  }
  const remainder = path.slice(HOST_MOUNT.length);
  return remainder === '' ? '/' : remainder;
}
