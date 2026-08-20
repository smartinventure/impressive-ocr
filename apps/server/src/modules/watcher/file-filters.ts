// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SourceOptions } from '@impressive-ocr/shared';

/**
 * Include/exclude matching for watched folders.
 *
 * A small glob implementation rather than a dependency: the patterns users write here are
 * simple (`**\/*.pdf`, `archive/**`, `*.tmp`), and a full glob library would pull in a large
 * surface for something that has to run on every filesystem event.
 */

/**
 * Translate a glob to a regular expression.
 *
 * Supports `**` (any depth, including none), `*` (anything but a separator), `?` (one
 * character but a separator), and character classes. Everything else is escaped literally.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = '';
  let index = 0;

  while (index < pattern.length) {
    const char = pattern[index];

    if (char === '*') {
      const isDoubleStar = pattern[index + 1] === '*';
      if (isDoubleStar) {
        // `**/` should also match zero directories, so `**/*.pdf` matches `a.pdf` at the
        // root as well as `sub/a.pdf`. Without this every user writes the pattern twice.
        if (pattern[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 3;
          continue;
        }
        source += '.*';
        index += 2;
        continue;
      }
      source += '[^/]*';
      index += 1;
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }

    if (char === '[') {
      const close = pattern.indexOf(']', index + 1);
      if (close > index) {
        source += pattern.slice(index, close + 1);
        index = close + 1;
        continue;
      }
    }

    source += escapeLiteral(char ?? '');
    index += 1;
  }

  // Case-insensitive throughout: Windows paths are, and a pipeline that silently skips
  // `SCAN.PDF` because the pattern said `*.pdf` is a support ticket waiting to happen.
  return new RegExp(`^${source}$`, 'i');
}

function escapeLiteral(char: string): string {
  return /[.+^${}()|\\]/.test(char) ? `\\${char}` : char;
}

/** Normalise a relative path so patterns can always be written with forward slashes. */
export function normalizeRelativePath(relativePath: string): string {
  return relativePath.split('\\').join('/');
}

/**
 * Whether a file should be picked up.
 *
 * Exclusions win over inclusions: a user adding `archive/**` to the exclude list expects it
 * to hold even though `**\/*.pdf` also matches.
 */
export function matchesFilters(relativePath: string, source: SourceOptions): boolean {
  const normalized = normalizeRelativePath(relativePath);

  for (const pattern of source.excludeGlobs) {
    if (globToRegExp(pattern).test(normalized)) {
      return false;
    }
  }
  if (source.includeGlobs.length === 0) {
    return true;
  }
  return source.includeGlobs.some((pattern) => globToRegExp(pattern).test(normalized));
}
