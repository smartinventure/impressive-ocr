// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, extname, join, parse } from 'node:path';

/**
 * Filesystem operations that must survive a crash, a network share, and a user watching the
 * output folder with another tool.
 */

/** Read in chunks so a 500 MB scan does not have to fit in memory to be hashed. */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export interface FileStability {
  sizeBytes: number;
  modifiedAtMs: number;
}

export async function readStability(path: string): Promise<FileStability | null> {
  try {
    const stats = await stat(path);
    return stats.isFile() ? { sizeBytes: stats.size, modifiedAtMs: stats.mtimeMs } : null;
  } catch {
    return null;
  }
}

/**
 * Move a file, falling back to copy-then-delete across devices.
 *
 * `rename` is atomic but only within one filesystem; watched input folders and output
 * folders routinely live on different drives or a network share, where it fails EXDEV.
 */
export async function moveFile(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  try {
    await rename(source, destination);
    return;
  } catch (error) {
    if (!isCrossDevice(error)) {
      throw error;
    }
  }
  await copyFile(source, destination);
  await rm(source, { force: true });
}

function isCrossDevice(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'EXDEV'
  );
}

/**
 * Pick a destination that does not clobber an existing file.
 *
 * Numbered suffixes rather than a timestamp: a user re-running a folder wants
 * `invoice (2).pdf` next to `invoice.pdf`, not a filename they cannot predict.
 */
export async function uniquePath(desired: string): Promise<string> {
  if (!(await exists(desired))) {
    return desired;
  }
  const { dir, name } = parse(desired);
  const extension = extname(desired);
  for (let counter = 2; counter < 10_000; counter += 1) {
    const candidate = join(dir, `${name} (${counter})${extension}`);
    if (!(await exists(candidate))) {
      return candidate;
    }
  }
  throw new Error(`Could not find a free filename for ${desired}`);
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
