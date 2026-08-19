// SPDX-License-Identifier: AGPL-3.0-or-later
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Filesystem paths are this product's highest-risk input: a pipeline names folders, and the
 * server then reads, writes, moves and deletes inside them. Without a check, a crafted
 * pipeline turns the app into an arbitrary-file-read/write primitive — and once the server
 * is bound beyond loopback, a remote one.
 *
 * The rule is simple and fail-closed: a path is usable only if its *resolved* location lies
 * inside a folder the user explicitly allowlisted. Resolution matters — `..` and symlinks
 * both escape a purely textual check, and on Windows so do short (8.3) names and drive-
 * relative paths like `C:foo`.
 */

export type PathRejection =
  | 'not-absolute'
  | 'contains-null-byte'
  | 'allowlist-empty'
  | 'outside-allowlist'
  | 'does-not-exist';

export class PathNotAllowedError extends Error {
  constructor(
    readonly reason: PathRejection,
    readonly attemptedPath: string,
  ) {
    super(`Path rejected (${reason})`);
    this.name = 'PathNotAllowedError';
  }
}

export interface SafePathOptions {
  /** Absolute folders the user has authorised. Empty rejects everything, by design. */
  allowlist: readonly string[];
  /**
   * When false the path need not exist yet — required for output folders we are about to
   * create. Containment is still enforced against the nearest existing ancestor.
   */
  mustExist?: boolean;
}

/**
 * True when `candidate` is inside `parent`, comparing resolved paths segment-wise.
 *
 * `relative()` rather than `startsWith()`: `C:\data-secret` starts with `C:\data` as a
 * string but is a sibling, not a child.
 */
export function isInside(parent: string, candidate: string): boolean {
  const parentResolved = resolve(parent);
  const candidateResolved = resolve(candidate);
  if (normalizeForCompare(parentResolved) === normalizeForCompare(candidateResolved)) {
    return true;
  }
  const rel = relative(parentResolved, candidateResolved);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Windows paths are case-insensitive; Linux and macOS are (usually) not. Comparing with the
 * wrong rule either lets `C:\DATA` past a `C:\data` allowlist entry or wrongly rejects it.
 */
function normalizeForCompare(value: string): string {
  const trimmed = value.endsWith(sep) && value.length > 1 ? value.slice(0, -1) : value;
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

/**
 * Resolve a user-supplied path and prove it is inside the allowlist.
 *
 * Returns the canonical path to use from then on — callers must use the returned value, not
 * the input, so that later operations cannot be redirected by a symlink swapped in between
 * the check and the use.
 */
export async function resolveSafePath(
  candidate: string,
  options: SafePathOptions,
): Promise<string> {
  if (candidate.includes('\0')) {
    throw new PathNotAllowedError('contains-null-byte', candidate);
  }
  if (!isAbsolute(candidate)) {
    throw new PathNotAllowedError('not-absolute', candidate);
  }
  if (options.allowlist.length === 0) {
    throw new PathNotAllowedError('allowlist-empty', candidate);
  }

  const canonical = await canonicalize(candidate, options.mustExist ?? true);

  // The allowlist entries are canonicalized too: if the user allowlisted a path that is
  // itself reached through a symlink, a textual comparison against a real path would fail.
  for (const entry of options.allowlist) {
    const canonicalEntry = await canonicalize(entry, false);
    if (isInside(canonicalEntry, canonical)) {
      return canonical;
    }
  }

  throw new PathNotAllowedError('outside-allowlist', candidate);
}

/**
 * Fully resolve a path, following symlinks as far as the filesystem allows.
 *
 * For a path that does not exist yet we resolve the deepest ancestor that does and re-append
 * the remainder. That still defeats a symlinked parent, which is the attack that matters —
 * a leaf that does not exist cannot itself be a symlink.
 */
async function canonicalize(target: string, mustExist: boolean): Promise<string> {
  const absolute = resolve(target);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
    if (mustExist) {
      throw new PathNotAllowedError('does-not-exist', target);
    }
  }

  const segments: string[] = [];
  let current = absolute;
  for (;;) {
    const parent = resolve(current, '..');
    if (parent === current) {
      // Reached the filesystem root without finding anything that exists.
      return absolute;
    }
    segments.unshift(current.slice(parent.length + 1));
    try {
      const realParent = await realpath(parent);
      return resolve(realParent, ...segments);
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
      current = parent;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}
