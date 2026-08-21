// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  writeSync,
} from 'node:fs';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A size-capped log file the UI can read back.
 *
 * The console is not enough. A user whose pipeline quietly quarantines every document has no
 * way to see why: the desktop build has no terminal at all, and the headless one scrolls its
 * output into a service manager the user may not have access to. Writing the same records to
 * a file, and serving the tail of it, is what turns "it does not work" into a line number.
 *
 * Rotation is a plain rename rather than a library. One current file plus one previous keeps
 * the on-disk cost bounded and predictable, and there is no scenario here where a user wants
 * to page through a fortnight of history in a browser.
 */

export const LOG_FILE_NAME = 'impressive-ocr.log';
export const PREVIOUS_LOG_FILE_NAME = 'impressive-ocr.log.1';

/** Rotate at this size; with one kept generation, disk use tops out at twice this. */
export const MAX_LOG_BYTES = 30 * 1024 * 1024;

/**
 * Most the API will return in one request.
 *
 * The file may be 30 MB; a browser asked to render that as text will stall. The viewer wants
 * the recent end of it, which is where anything actionable is.
 */
export const MAX_TAIL_BYTES = 2 * 1024 * 1024;

export interface LogFileOptions {
  directory: string;
  maxBytes?: number;
}

/**
 * A pino destination that rotates.
 *
 * Implemented as a `write`-shaped object rather than a stream subclass because that is the
 * whole interface pino asks for, and anything more would be scaffolding.
 */
export class RotatingLogFile {
  private handle: number | null = null;
  private written = 0;
  private readonly maxBytes: number;
  readonly path: string;
  readonly previousPath: string;

  constructor(private readonly options: LogFileOptions) {
    this.maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
    this.path = join(options.directory, LOG_FILE_NAME);
    this.previousPath = join(options.directory, PREVIOUS_LOG_FILE_NAME);
  }

  /**
   * Append one record.
   *
   * Synchronous, for the same reason the console destination is: a buffered write is lost in
   * a hard crash, and a crash is the one moment the log has to be trustworthy. This app
   * writes a handful of lines per document, so the throughput a buffered stream would buy is
   * worth nothing against that.
   */
  write(line: string): void {
    try {
      this.ensureOpen();
      const bytes = Buffer.byteLength(line);
      if (this.written + bytes > this.maxBytes) {
        this.rotate();
      }
      if (this.handle !== null) {
        writeSync(this.handle, line);
        this.written += bytes;
      }
    } catch {
      // Logging must never be the thing that breaks the app. A full disk or a revoked
      // permission costs the log file, not the OCR run in progress.
    }
  }

  close(): void {
    if (this.handle !== null) {
      try {
        closeSync(this.handle);
      } catch {
        // Already gone; nothing left to release.
      }
      this.handle = null;
    }
  }

  private ensureOpen(): void {
    if (this.handle !== null) return;

    mkdirSync(this.options.directory, { recursive: true });
    // Continue an existing file rather than truncating: a restart is exactly when the
    // preceding lines matter most.
    this.written = existsSync(this.path) ? statSync(this.path).size : 0;
    this.handle = openSync(this.path, 'a');
  }

  private rotate(): void {
    this.close();

    try {
      // Replaces any older generation; two files is the whole retention policy.
      renameSync(this.path, this.previousPath);
    } catch {
      // If the rename fails the file simply keeps growing, which is better than losing it.
    }

    this.written = 0;
    this.handle = openSync(this.path, 'a');
  }
}

export interface LogTail {
  /** Newest lines last, as written. */
  text: string;
  /** Whether older content was omitted, so the viewer can say so. */
  truncated: boolean;
  totalBytes: number;
}

/**
 * Read the end of the log.
 *
 * Reads only the tail rather than the whole file: at 30 MB the difference is a request that
 * returns and one that exhausts memory on both ends.
 */
export async function readLogTail(directory: string, maxBytes = MAX_TAIL_BYTES): Promise<LogTail> {
  const path = join(directory, LOG_FILE_NAME);

  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return { text: '', truncated: false, totalBytes: 0 };
  }

  if (size <= maxBytes) {
    return { text: await readFile(path, 'utf8'), truncated: false, totalBytes: size };
  }

  const handle = await import('node:fs/promises').then((fs) => fs.open(path, 'r'));
  try {
    const buffer = Buffer.alloc(maxBytes);
    await handle.read(buffer, 0, maxBytes, size - maxBytes);
    const text = buffer.toString('utf8');
    // Drop the first line: starting mid-record would hand the viewer broken JSON.
    const firstBreak = text.indexOf('\n');
    return {
      text: firstBreak === -1 ? text : text.slice(firstBreak + 1),
      truncated: true,
      totalBytes: size,
    };
  } finally {
    await handle.close();
  }
}

/** Delete both generations. Offered in the UI, because a log is also a privacy liability. */
export async function clearLogs(directory: string): Promise<void> {
  for (const name of [LOG_FILE_NAME, PREVIOUS_LOG_FILE_NAME]) {
    await rm(join(directory, name), { force: true });
  }
}

/** Sizes on disk, for the UI to show what clearing would reclaim. */
export async function logSizes(directory: string): Promise<{ name: string; bytes: number }[]> {
  try {
    const names = await readdir(directory);
    const wanted = names.filter((name) => name.startsWith(LOG_FILE_NAME));
    return await Promise.all(
      wanted.map(async (name) => ({
        name,
        bytes: (await stat(join(directory, name))).size,
      })),
    );
  } catch {
    return [];
  }
}
