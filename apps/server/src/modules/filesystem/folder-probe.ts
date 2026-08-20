// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { opendir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Ask a folder whether it can actually do the job it is being chosen for.
 *
 * Existence is not the question. An input folder the service cannot read, and an output
 * folder it cannot write, both look perfectly fine to `stat` — and then fail hours later as
 * an error about some individual file, which is the point at which nobody can tell whether
 * the folder, the file or the OCR was at fault.
 *
 * On Windows in particular, permission lives in an ACL that `stat` does not reflect at all,
 * so the only honest test is to try.
 */

export type FolderRole = 'input' | 'output';

export interface FolderProbe {
  /** Blocking. The folder cannot serve the role it was chosen for. */
  error: string | null;
  /** Non-blocking. Worth saying out loud before the user commits to it. */
  warnings: string[];
  /** Entries seen while probing an input folder; null when not counted. */
  entryCount: number | null;
}

export interface ProbeOptions {
  /** Injectable so the unreadable-folder branch can be tested without fighting Windows ACLs. */
  openDirectory?: (path: string) => Promise<AsyncIterable<{ isFile: () => boolean }>>;
  timeoutMs?: number;
}

/**
 * Stop counting here.
 *
 * The warning only needs to say "this is not empty, and by a lot"; walking a 400,000-file
 * archive to produce an exact number would cost more than the answer is worth.
 */
const COUNT_LIMIT = 5_000;

/** A dead network share must not hold the request open. */
const DEFAULT_TIMEOUT_MS = 5_000;

export async function probeFolder(
  path: string,
  role: FolderRole,
  options: ProbeOptions = {},
): Promise<FolderProbe> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    return await withTimeout(
      role === 'input' ? probeInput(path, options) : probeOutput(path),
      timeoutMs,
    );
  } catch (error) {
    if (error instanceof TimeoutError) {
      return {
        error: 'This folder did not respond. If it is a network share, check it is reachable.',
        warnings: [],
        entryCount: null,
      };
    }
    throw error;
  }
}

/**
 * Read the folder, and count what is already in it.
 *
 * A non-empty input folder is a warning rather than an error because it is a legitimate
 * choice — but the watcher queues everything it finds the moment the pipeline starts, and
 * pointing at an archive of several thousand scans is otherwise a very expensive surprise.
 */
async function probeInput(path: string, options: ProbeOptions): Promise<FolderProbe> {
  const open = options.openDirectory ?? ((target: string) => opendir(target));

  let files = 0;
  try {
    const directory = await open(path);
    for await (const entry of directory) {
      if (entry.isFile()) {
        files += 1;
        if (files >= COUNT_LIMIT) break;
      }
    }
  } catch (error) {
    return {
      error: describeReadFailure(error),
      warnings: [],
      entryCount: null,
    };
  }

  if (files === 0) {
    return { error: null, warnings: [], entryCount: 0 };
  }

  const counted = files >= COUNT_LIMIT ? `more than ${COUNT_LIMIT.toLocaleString()}` : `${files}`;
  return {
    error: null,
    warnings: [
      `This folder already contains ${counted} file${files === 1 ? '' : 's'}. ` +
        'They will all be queued as soon as the pipeline starts.',
    ],
    entryCount: files,
  };
}

/**
 * Write a file and delete it again.
 *
 * The only reliable test. A read-only ACL, a full disk and a share mounted read-only are all
 * invisible until something is actually written, and every one of them would otherwise
 * surface as a failed job rather than as "you cannot write here".
 */
async function probeOutput(path: string): Promise<FolderProbe> {
  const probePath = join(path, `.impressive-ocr-write-test-${randomBytes(6).toString('hex')}`);

  try {
    await writeFile(probePath, '', { flag: 'wx' });
  } catch (error) {
    return { error: describeWriteFailure(error), warnings: [], entryCount: null };
  }

  try {
    await unlink(probePath);
  } catch {
    // Written but not removable: writing works, which is what was being asked. Leaving a
    // zero-byte dotfile behind is better than reporting a failure that is not one.
  }

  return { error: null, warnings: [], entryCount: null };
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : '';
}

function describeReadFailure(error: unknown): string {
  switch (errorCode(error)) {
    case 'EACCES':
    case 'EPERM':
      return 'This folder cannot be read. Check the permissions on it.';
    case 'ENOENT':
      return 'This folder no longer exists.';
    case 'ENOTDIR':
      return 'That is a file, not a folder.';
    default:
      return 'This folder could not be read.';
  }
}

function describeWriteFailure(error: unknown): string {
  switch (errorCode(error)) {
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return 'This folder cannot be written to. Check the permissions on it.';
    case 'ENOENT':
      return 'This folder no longer exists.';
    case 'ENOSPC':
      return 'The disk holding this folder is full.';
    default:
      return 'This folder could not be written to.';
  }
}

class TimeoutError extends Error {}

async function withTimeout<TValue>(promise: Promise<TValue>, ms: number): Promise<TValue> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TimeoutError()), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
