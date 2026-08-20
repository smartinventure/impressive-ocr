// SPDX-License-Identifier: AGPL-3.0-or-later
import { access, lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { isInside, PathNotAllowedError } from '../../infra/fs/safe-path';

/**
 * Server-side folder browsing for the pipeline editor and the settings allowlist.
 *
 * A server-side browser is not a nicety here, it is the only thing that works. The browser's
 * own pickers cannot supply an absolute path: `<input webkitdirectory>` yields relative names,
 * and `showDirectoryPicker()` yields an opaque handle whose real location the page never
 * sees. The server needs a real path to watch a folder, so the server has to be what lists
 * the folders.
 *
 * Adapted from the `_resources/external-code/filebrowser` template, keeping the parts that
 * were learned the hard way against network shares — bounded stats, `lstat` over `stat`, and
 * listing an entry even when probing it failed — but replacing its deliberately unjailed
 * model with our folder allowlist.
 */

/**
 * A single `lstat` on a disconnected CIFS/NFS share can block for the whole TCP timeout.
 * Unbounded, one dead share makes the entire listing hang and the UI look frozen.
 */
const ENTRY_STAT_TIMEOUT_MS = 3_000;

/** Directories with tens of thousands of entries would otherwise stall the response. */
const MAX_ENTRIES = 1_000;

export type BrowseScope = 'allowlist' | 'system';

export interface FolderEntry {
  name: string;
  path: string;
  /** False when the entry was listed but could not be probed — offline share, denied ACL. */
  isAccessible: boolean;
  modifiedAt: string | null;
  /** Whether this folder may be chosen, given the scope. */
  selectable: boolean;
  /** Files are listed only when the caller asks for them; folders are always listed. */
  isDirectory: boolean;
  /** Bytes, for files. Null for folders, which are not sized here. */
  sizeBytes: number | null;
}

export interface BrowseResult {
  /** Null when showing the root list (drives on Windows, allowlist entries when confined). */
  currentPath: string | null;
  parentPath: string | null;
  isRoot: boolean;
  selectable: boolean;
  truncated: boolean;
  entries: FolderEntry[];
}

export interface BrowseOptions {
  path: string | null;
  scope: BrowseScope;
  allowlist: readonly string[];
  /**
   * Whether to list files alongside folders.
   *
   * Off by default: this browser mostly exists to choose a *folder*, and listing thousands of
   * scanned PDFs would bury the thing the user is looking for. Quick Mode turns it on,
   * because there the files are the point.
   */
  includeFiles?: boolean;
}

export class FolderBrowseError extends Error {
  constructor(
    readonly code: 'not-found' | 'not-a-directory' | 'permission-denied' | 'not-allowed',
    message: string,
  ) {
    super(message);
    this.name = 'FolderBrowseError';
  }
}

export async function browseFolders(options: BrowseOptions): Promise<BrowseResult> {
  if (options.path === null || options.path.length === 0) {
    return listRoots(options);
  }

  const target = resolve(options.path);
  if (options.scope === 'allowlist' && !isWithinAllowlist(target, options.allowlist)) {
    throw new FolderBrowseError('not-allowed', 'That folder is outside the authorized folders.');
  }

  const entries = await listDirectory(target, options);
  const parent = dirname(target);

  return {
    currentPath: target,
    // At a filesystem root `dirname` returns the path itself; show the root list instead of
    // a breadcrumb that goes nowhere.
    parentPath: parent === target ? null : parent,
    isRoot: false,
    selectable: options.scope === 'system' || isWithinAllowlist(target, options.allowlist),
    truncated: entries.length >= MAX_ENTRIES,
    entries,
  };
}

/**
 * The top level of the browser.
 *
 * Confined to the allowlist this is the authorised folders themselves; unconfined it is the
 * machine's drives. Windows has no single `/` to start from, which the original template —
 * POSIX-only — did not have to handle.
 */
async function listRoots(options: BrowseOptions): Promise<BrowseResult> {
  const roots = options.scope === 'allowlist' ? [...options.allowlist] : await systemRoots();

  const entries = await Promise.all(roots.map(async (root) => describeEntry(root, options)));

  return {
    currentPath: null,
    parentPath: null,
    isRoot: true,
    selectable: false,
    truncated: false,
    entries,
  };
}

async function systemRoots(): Promise<string[]> {
  if (process.platform !== 'win32') {
    return ['/', homedir()];
  }
  // No API enumerates drives without a native dependency, so probe the letters. Each check
  // is a cheap `access`, and an unmapped letter fails immediately.
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const found = await Promise.all(
    letters.map(async (letter) => {
      const root = `${letter}:\\`;
      try {
        await withTimeout(access(root), ENTRY_STAT_TIMEOUT_MS);
        return root;
      } catch {
        return null;
      }
    }),
  );
  const drives = found.filter((drive): drive is string => drive !== null);
  return [...drives, homedir()];
}

async function listDirectory(target: string, options: BrowseOptions): Promise<FolderEntry[]> {
  let names: string[];
  try {
    const dirents = await readdir(target, { withFileTypes: true });
    names = dirents
      .filter(
        (entry) =>
          entry.isDirectory() ||
          entry.isSymbolicLink() ||
          (options.includeFiles === true && entry.isFile()),
      )
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_ENTRIES);
  } catch (error) {
    throw toBrowseError(error, target);
  }

  return Promise.all(names.map((name) => describeEntry(join(target, name), options)));
}

/**
 * Probe one entry, never failing the listing because of it.
 *
 * A symlink to an offline target, or a folder with a denied ACL, still belongs in the list —
 * flagged, so the UI can grey it out instead of pretending it does not exist.
 */
async function describeEntry(path: string, options: BrowseOptions): Promise<FolderEntry> {
  const name = basename(path) || path;
  const selectable = options.scope === 'system' || isWithinAllowlist(path, options.allowlist);

  try {
    // `lstat`, not `stat`: `stat` follows the link and would stall on a dead target.
    const stats = await withTimeout(lstat(path), ENTRY_STAT_TIMEOUT_MS);
    const isDirectory = stats.isDirectory() || stats.isSymbolicLink();
    return {
      name,
      path,
      isAccessible: true,
      modifiedAt: stats.mtime.toISOString(),
      selectable,
      isDirectory,
      sizeBytes: isDirectory ? null : stats.size,
    };
  } catch {
    // Unprobeable: assume a folder, which is the safer guess — a file that turns out not to
    // exist fails clearly at read time, whereas hiding a real folder strands the user.
    return {
      name,
      path,
      isAccessible: false,
      modifiedAt: null,
      selectable,
      isDirectory: true,
      sizeBytes: null,
    };
  }
}

/**
 * Create a folder from inside the browser.
 *
 * Makes "type a path that does not exist yet, then create it" a single step, which is the
 * common case when setting up an output folder for a new pipeline.
 */
export async function createFolder(
  path: string,
  options: { scope: BrowseScope; allowlist: readonly string[] },
): Promise<string> {
  const target = resolve(path);

  if (options.scope === 'allowlist' && !isWithinAllowlist(target, options.allowlist)) {
    throw new FolderBrowseError('not-allowed', 'That folder is outside the authorized folders.');
  }
  // Refuse to create a drive root or `/` — always a typo, and mkdir would fail confusingly.
  if (parse(target).root === target) {
    throw new FolderBrowseError('not-allowed', 'Choose a folder name.');
  }

  try {
    await mkdir(target, { recursive: true });
    return await realpath(target);
  } catch (error) {
    throw toBrowseError(error, target);
  }
}

/**
 * Whether a path sits inside any authorised folder.
 *
 * Compared against resolved paths so `..` cannot walk out. Symlink resolution happens later,
 * in `resolveSafePath`, which is what actually guards reads and writes — this check only
 * decides what the browser offers, and must stay fast enough to run per listed entry.
 */
export function isWithinAllowlist(target: string, allowlist: readonly string[]): boolean {
  return allowlist.some((entry) => isInside(entry, target));
}

/** Reject a promise that takes too long, so one dead mount cannot hang the request. */
async function withTimeout<TValue>(promise: Promise<TValue>, ms: number): Promise<TValue> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out')), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function toBrowseError(error: unknown, target: string): FolderBrowseError {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;

  switch (code) {
    case 'ENOENT':
      return new FolderBrowseError('not-found', `${basename(target)} does not exist.`);
    case 'ENOTDIR':
      return new FolderBrowseError('not-a-directory', 'That path is not a folder.');
    case 'EACCES':
    case 'EPERM':
      return new FolderBrowseError('permission-denied', 'Access to that folder was denied.');
    default:
      return new FolderBrowseError('not-found', 'That folder could not be read.');
  }
}

export { PathNotAllowedError };
