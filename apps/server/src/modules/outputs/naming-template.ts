// SPDX-License-Identifier: AGPL-3.0-or-later
import { basename, extname } from 'node:path';

/**
 * Expands a pipeline's output-naming template.
 *
 * Users hand these results to other systems — a DMS watch folder, an import script — so the
 * filename is part of the contract, not cosmetics. The expansion must therefore be
 * predictable, and it must never be able to produce a path that escapes the output folder.
 */

export interface NamingContext {
  /** Source file name without its extension. */
  sourceStem: string;
  /** 1-based page number, for per-page formats. */
  page?: number | undefined;
  /** Content hash of the source; only the first 12 characters are substituted. */
  contentHash?: string | undefined;
  /** Job completion time; defaults to now. */
  date?: Date | undefined;
}

const PLACEHOLDER = /\{(name|page|date|hash)\}/g;

/**
 * Characters no mainstream filesystem accepts: the Windows-illegal set, both path
 * separators, and control codes.
 *
 * The separators are the security-relevant part. Without stripping them, a template or a
 * source filename containing `..\` would write outside the output folder.
 *
 * Spaces and hyphens are deliberately absent from this set — `Invoice 2024-01.pdf` has to
 * keep its name, or every output stops matching the source the user recognises.
 */
// Spelled out as a set rather than a regex character class: escaping the backslash and the
// control range inside a literal is easy to get subtly wrong, and getting it wrong here
// silently reopens path traversal.
const ILLEGAL_CHARACTERS = new Set(['<', '>', ':', '"', '|', '?', '*', '/', '\\']);
const FIRST_PRINTABLE_CHAR_CODE = 0x20;

function replaceIllegalCharacters(value: string): string {
  let result = '';
  for (const character of value) {
    const isControl = (character.codePointAt(0) ?? 0) < FIRST_PRINTABLE_CHAR_CODE;
    result += ILLEGAL_CHARACTERS.has(character) || isControl ? '_' : character;
  }
  return result;
}

/** Windows refuses these as filenames regardless of extension. */
const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

const MAX_STEM_LENGTH = 120;

export function expandTemplate(template: string, context: NamingContext): string {
  const date = context.date ?? new Date();
  const expanded = template.replace(PLACEHOLDER, (_match, token: string) => {
    switch (token) {
      case 'name':
        return context.sourceStem;
      case 'page':
        // Zero-padded so a folder of per-page outputs sorts correctly in any file browser.
        return context.page === undefined ? '' : String(context.page).padStart(4, '0');
      case 'date':
        return formatDate(date);
      case 'hash':
        return (context.contentHash ?? '').slice(0, 12);
      default:
        return '';
    }
  });
  return sanitizeStem(expanded);
}

/** Local date, not UTC: a user filing at 00:30 in Munich expects today, not yesterday. */
function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Reduce an arbitrary string to something safe to use as a filename stem.
 *
 * Exported because it also guards the *source* filename, which is attacker-influenced in the
 * sense that anyone able to drop a file into a watched folder chooses it.
 */
export function sanitizeStem(value: string): string {
  let stem = replaceIllegalCharacters(value).trim();

  // Windows silently strips trailing dots and spaces, which would turn `report.` into
  // `report` and quietly collide with a file that already exists.
  stem = stem.replace(/[. ]+$/, '');

  if (stem.length === 0) {
    return 'document';
  }
  if (RESERVED_NAMES.has(stem.toUpperCase())) {
    return `${stem}_`;
  }
  return stem.length > MAX_STEM_LENGTH ? stem.slice(0, MAX_STEM_LENGTH) : stem;
}

/** The `{name}` value for a source path: its basename with the extension removed. */
export function sourceStemOf(sourcePath: string): string {
  const name = basename(sourcePath);
  const extension = extname(name);
  return sanitizeStem(extension.length > 0 ? name.slice(0, -extension.length) : name);
}
