// SPDX-License-Identifier: AGPL-3.0-or-later
import { statfs } from 'node:fs/promises';
import { dirname, parse, resolve } from 'node:path';

/**
 * Free-space check for the runtime install.
 *
 * The install writes several gigabytes of Python, PaddlePaddle, model weights and the
 * inference engine. Without this check a full disk produces a failure deep inside pip — or
 * worse, a partially written venv and an out-of-memory crash — and the user is left with no
 * idea that the disk was the problem. Asking first turns that into one clear sentence.
 *
 * The figures below are measured on a complete Windows GPU install rather than estimated.
 * They previously were not, and were wrong by a factor of three: the check demanded 2.6 GB
 * for something that occupies 8.4 GB, so a machine with four gigabytes free passed the
 * preflight and then failed part-way through the install — the exact outcome this exists to
 * prevent.
 */

/**
 * uv's package cache, which is where the downloaded wheels actually live.
 *
 * Counted rather than treated as scratch, because it is not deleted after the install and
 * the venv's files are hardlinks into it. On one volume that means the venv costs almost
 * nothing on top; across two it would be paid twice, which is a reason to keep the runtime
 * on a single drive.
 */
export const PACKAGE_CACHE_BYTES = 5_100_000_000;

/** The pinned CPython build. */
export const PYTHON_INSTALL_BYTES = 70_000_000;

/** Python + PaddlePaddle + PaddleOCR, hardlinked from the cache above. */
export const RUNTIME_INSTALL_BYTES = 5_000_000_000;

/**
 * Everything downloaded besides the PaddlePaddle wheel itself: the pinned CPython build and
 * the PaddleOCR dependency tree (numpy, OpenCV, shapely and the rest).
 *
 * An estimate, unlike the wheel sizes in `wheel-index.ts` which are measured. It exists so
 * the pre-install confirmation can quote a total rather than only the largest single item.
 */
export const SUPPORTING_DOWNLOAD_BYTES = 450_000_000;

/** PaddleOCR's model cache: layout, detection, recognition and the optional recognisers. */
export const MODEL_DOWNLOAD_BYTES = 1_100_000_000;

/**
 * The inference engine: llama.cpp's binaries, the quantised language model and the vision
 * encoder that is deliberately left unquantised.
 *
 * Peak is higher than this. The language model is downloaded at BF16 — about 1.9 GB — and
 * quantised on the machine to 341 MB, with the original deleted afterwards, so roughly
 * 1.6 GB has to be free during the install that is not occupied at the end of it.
 */
export const VL_SERVER_BYTES = 2_250_000_000;
export const VL_QUANTISATION_PEAK_BYTES = 1_600_000_000;

/**
 * Installed footprint by flavour.
 *
 * The GPU figure is an estimate and deliberately generous: the wheel bundles CUDA and cuDNN,
 * which expand to several times the download. Correct it once a real GPU install has been
 * measured — no one has run one yet.
 */
export const INSTALLED_BYTES_BY_FLAVOR = {
  // An estimate, and marked as one: the CPU wheel carries no CUDA or cuDNN, which is most of
  // the GPU build's weight, but no CPU-only install has been measured end to end.
  cpu: 1_500_000_000 + PYTHON_INSTALL_BYTES + MODEL_DOWNLOAD_BYTES + VL_SERVER_BYTES,
  gpu: PACKAGE_CACHE_BYTES + PYTHON_INSTALL_BYTES + MODEL_DOWNLOAD_BYTES + VL_SERVER_BYTES,
} as const;

/**
 * Headroom on top of the install itself.
 *
 * Covers the BF16 weights held while they are quantised, and leaves a gigabyte spare —
 * finishing with a disk at exactly 100% would break everything else running on the machine.
 */
export const INSTALL_HEADROOM_BYTES = VL_QUANTISATION_PEAK_BYTES + 1_000_000_000;

/**
 * What the preflight demands before starting.
 *
 * The GPU figure, because the check runs before the hardware is known to the installer and
 * asking for too much is a warning while asking for too little is a failed install.
 */
export const REQUIRED_INSTALL_BYTES = INSTALLED_BYTES_BY_FLAVOR.gpu + INSTALL_HEADROOM_BYTES;

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

/**
 * Free space on the filesystem that *will* hold `path`, even when `path` does not exist yet.
 *
 * `statfs` fails on a missing path, and the directory whose space matters most — the venv —
 * does not exist until the first install has run. So the plain measurement returned null
 * exactly when the answer was most useful, and preflight reported "could not measure free
 * space" on a machine with 30 GB free and nothing installed.
 *
 * Walking up to the nearest existing ancestor measures the same filesystem, which is the
 * number we actually wanted.
 */
export async function measureNearestDiskSpace(path: string): Promise<DiskSpace | null> {
  let current = resolve(path);
  for (;;) {
    const space = await measureDiskSpace(current);
    if (space !== null) {
      return space;
    }
    const parent = dirname(current);
    if (parent === current) {
      // `dirname` fixes at the filesystem root, so this terminates.
      return null;
    }
    current = parent;
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
