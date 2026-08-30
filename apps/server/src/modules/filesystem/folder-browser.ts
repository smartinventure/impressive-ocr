// SPDX-License-Identifier: AGPL-3.0-or-later
import { access, lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { isInside, PathNotAllowedError } from '../../infra/fs/safe-path';
import { hasHostMount, HOST_MOUNT, toHostPath } from './host-mount';

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
  /**
   * The same folder as the operator knows it on their own machine, when this server is in a
   * container started with the host mounted. `/host/mnt/scans` reports `/mnt/scans`.
   *
   * Null everywhere else, which is every desktop installation. `path` remains the only value
   * anything acts on — this is what the operator reads, not what the sidecar is given.
   */
  hostPath: string | null;
}

export interface BrowseResult {
  /** Null when showing the root list (drives on Windows, allowlist entries when confined). */
  currentPath: string | null;
  parentPath: string | null;
  isRoot: boolean;
  selectable: boolean;
  truncated: boolean;
  entries: FolderEntry[];
  /** `currentPath` as the operator knows it, when browsing under a mounted host. */
  hostPath: string | null;
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
    hostPath: toHostPath(target),
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
    // The root list is not itself anywhere; the host mount appears as one of its entries.
    hostPath: null,
  };
}

/**
 * How long a probed drive list is trusted before it is asked for again.
 *
 * Drives are mapped and unmapped by hand, minutes apart at the very fastest, so a minute of
 * staleness costs nothing a refresh does not fix.
 */
const SYSTEM_ROOTS_TTL_MS = 60_000;

let systemRootsCache: { roots: string[]; at: number } | null = null;
let systemRootsInFlight: Promise<string[]> | null = null;

/**
 * The machine's drives, remembered between browses.
 *
 * Not an optimisation -- a correctness fix for the rest of the process. `access` on a drive
 * root is the only way Node can ask whether a letter is mapped, and on a *disconnected*
 * network drive Windows takes its time answering: measured at 63 seconds for a stale `L:`
 * mapping on one machine here. `withTimeout` abandons the promise after three seconds so the
 * user still gets their list, but it cannot cancel the syscall underneath. The libuv thread
 * stays pinned until Windows returns, and libuv has four of those by default -- so four root
 * listings in one process is every thread gone, and every other file operation, including
 * reading a document to OCR it, queues behind a drive nobody asked about.
 *
 * Probing once per TTL instead of once per browse holds that to a single pinned thread, and
 * makes every listing after the first instant. `systemRootsInFlight` matters as much as the
 * cache: two browses arriving together must share one probe rather than start two.
 *
 * Module-level state is deliberate, and is the same exception the sidecar's warm-model cache
 * is granted: this is a memo of the machine's own shape, not service state. Nothing reads it
 * but the function below.
 */
async function systemRoots(): Promise<string[]> {
  const cached = systemRootsCache;
  if (cached !== null && Date.now() - cached.at < SYSTEM_ROOTS_TTL_MS) {
    return cached.roots;
  }
  if (systemRootsInFlight !== null) {
    return systemRootsInFlight;
  }

  systemRootsInFlight = probeSystemRoots()
    .then((roots) => {
      systemRootsCache = { roots, at: Date.now() };
      return roots;
    })
    .finally(() => {
      systemRootsInFlight = null;
    });

  return systemRootsInFlight;
}

/** Forget the probed drive list, so the next browse asks the machine again. */
export function resetSystemRootsCache(): void {
  systemRootsCache = null;
  systemRootsInFlight = null;
}

async function probeSystemRoots(): Promise<string[]> {
  if (process.platform !== 'win32') {
    // The host mount first when there is one: in a container the operator came looking for
    // their own machine, and `/` is this container's short and unfamiliar tree.
    const host = (await hasHostMount()) ? [HOST_MOUNT] : [];
    return [...host, '/', homedir()];
  }
  // No API enumerates drives without a native dependency, so probe the letters. An unmapped
  // letter fails immediately; a *disconnected* one does not, which is why this runs at most
  // once a minute -- see `systemRoots` above.
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
      hostPath: toHostPath(path),
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
      hostPath: toHostPath(path),
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
