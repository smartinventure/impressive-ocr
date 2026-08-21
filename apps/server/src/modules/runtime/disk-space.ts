// SPDX-License-Identifier: AGPL-3.0-or-later
import { statfs } from 'node:fs/promises';
import { parse } from 'node:path';

/**
 * Free-space check for the runtime install.
 *
 * The install downloads roughly a gigabyte of Python and PaddlePaddle, plus model weights.
 * Without this check a full disk produces a failure deep inside pip — or worse, a partially
 * written venv and an out-of-memory crash — and the user is left with no idea that the disk
 * was the problem. Asking first turns that into one clear sentence.
 */

/** Python + PaddlePaddle + PaddleOCR, measured on a real install. */
export const RUNTIME_INSTALL_BYTES = 1_200_000_000;

/** Model weights for the Fast profile; the VLM needs considerably more. */
export const MODEL_DOWNLOAD_BYTES = 400_000_000;

/**
 * Headroom on top of the install itself.
 *
 * pip and uv both stage downloads before moving them into place, so peak usage exceeds the
 * final footprint — and finishing with a disk at exactly 100% would break everything else
 * running on the machine.
 */
export const INSTALL_HEADROOM_BYTES = 1_000_000_000;

export const REQUIRED_INSTALL_BYTES =
  RUNTIME_INSTALL_BYTES + MODEL_DOWNLOAD_BYTES + INSTALL_HEADROOM_BYTES;

export interface DiskSpace {
  freeBytes: number;
  totalBytes: number;
}

export class InsufficientDiskSpaceError extends Error {
  constructor(
    readonly path: string,
    readonly freeBytes: number,
    readonly requiredBytes: number,
  ) {
    super(
      `Not enough free space on ${driveOf(path)}: ${formatGib(freeBytes)} available, ` +
        `about ${formatGib(requiredBytes)} needed for Python, PaddleOCR and the models.`,
    );
    this.name = 'InsufficientDiskSpaceError';
  }
}

/**
 * Free and total bytes on the filesystem holding `path`, or null if it cannot be measured.
 *
 * Only ever called for the app's own data directory, which is local. Pointed at a dead
 * network share `statfs` can block for the SMB timeout — several seconds — so this is not
 * safe to use on a user-supplied path without a timeout around it.
 */
export async function measureDiskSpace(path: string): Promise<DiskSpace | null> {
  try {
    const stats = await statfs(path);
    return {
      // `bavail` rather than `bfree`: on Unix some blocks are reserved for root and are not
      // actually available to us.
      freeBytes: stats.bavail * stats.bsize,
      totalBytes: stats.blocks * stats.bsize,
    };
  } catch {
    // An unmeasurable filesystem must not block the install — better to try and fail with
    // pip's own error than to refuse on a network share we simply cannot stat.
    return null;
  }
}

export async function assertEnoughSpaceForInstall(
  path: string,
  requiredBytes = REQUIRED_INSTALL_BYTES,
): Promise<void> {
  const space = await measureDiskSpace(path);
  if (space === null) {
    return;
  }
  if (space.freeBytes < requiredBytes) {
    throw new InsufficientDiskSpaceError(path, space.freeBytes, requiredBytes);
  }
}

function driveOf(path: string): string {
  const root = parse(path).root;
  return root.length > 0 ? root : path;
}

export function formatGib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
