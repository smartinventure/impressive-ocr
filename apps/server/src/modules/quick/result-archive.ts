// SPDX-License-Identifier: AGPL-3.0-or-later
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { Readable } from 'node:stream';
import { ZipFile } from 'yazl';

/**
 * Package a run's outputs into a ZIP the browser can download.
 *
 * Always a ZIP, even for a single small file. One button with one predictable result is worth
 * more than saving a user one click on the occasions when there is exactly one output — and
 * "exactly one" is ambiguous the moment two formats are selected anyway.
 *
 * Streamed rather than assembled in memory: a hundred-page scan rendered to searchable PDF is
 * not something to hold in a Buffer while the client downloads it slowly.
 */

export interface ArchiveEntry {
  /** Absolute path of a produced output file. */
  path: string;
  /** Name of the document it came from, used to group entries in the archive. */
  documentName: string;
}

export interface ArchiveResult {
  stream: Readable;
  /** Entries actually added. Fewer than requested when outputs have been swept or moved. */
  included: number;
  missing: string[];
}

/**
 * Build the archive.
 *
 * Missing files are skipped rather than fatal: outputs can be swept, moved or deleted between
 * a run finishing and the user clicking download, and a partial archive is far more useful
 * than an error telling them the whole thing is gone.
 */
export async function buildResultArchive(entries: readonly ArchiveEntry[]): Promise<ArchiveResult> {
  const zip = new ZipFile();
  const missing: string[] = [];
  const usedNames = new Set<string>();
  let included = 0;

  for (const entry of entries) {
    try {
      const info = await stat(entry.path);
      if (!info.isFile()) {
        missing.push(entry.path);
        continue;
      }
    } catch {
      missing.push(entry.path);
      continue;
    }

    const name = uniqueName(archiveNameFor(entry), usedNames);
    // A stream per entry, so nothing is read until yazl asks for it.
    zip.addReadStream(createReadStream(entry.path), name, { compress: true });
    included += 1;
  }

  zip.end();
  // yazl types outputStream as the DOM ReadableStream; it is a Node Readable at runtime, and
  // the route pipes it straight to the reply.
  return { stream: zip.outputStream as unknown as Readable, included, missing };
}

/**
 * Group each output under the document it came from.
 *
 * Three documents times four formats is twelve files; flat, they interleave into a list
 * nobody can read. `invoice-1/invoice-1.md` makes the structure obvious on extraction.
 */
function archiveNameFor(entry: ArchiveEntry): string {
  const folder = sanitizeSegment(entry.documentName);
  const file = sanitizeSegment(basename(entry.path));
  return `${folder}/${file}`;
}

/**
 * Strip anything that would make an archive entry unsafe to extract.
 *
 * A ZIP entry name is attacker-influenced data as far as the extracting program is concerned
 * — `..` segments and absolute paths are how archives write outside their target directory.
 * These names come from our own output writer, but sanitising at the boundary costs nothing
 * and means a future writer cannot introduce the problem silently.
 */
function sanitizeSegment(value: string): string {
  const cleaned = value
    .replace(/[\\/]/g, '-')
    // Collapse any run of dots. Separators are already gone by this point, so `..` can no
    // longer traverse anywhere -- but leaving it in an entry name invites the next reader to
    // wonder whether it can, and some extraction tools are less careful than they should be.
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\s-]+/, '')
    // eslint-disable-next-line no-control-regex -- control characters are exactly what to drop
    .replace(/[\x00-\x1f<>:"|?*]/g, '')
    .trim();

  return cleaned.length > 0 ? cleaned : 'output';
}

/**
 * What the downloaded file is called: the first document's name, with `.zip`.
 *
 * Named after the document rather than a constant, because otherwise three runs in an
 * afternoon give you `impressive-ocr-results.zip`, `(1)` and `(2)`, with no way to tell which
 * one was the invoice. The name is the first document's whatever the run contained — a
 * document count in the name would itself be a name a real document could have.
 */
export function archiveFileName(entries: readonly ArchiveEntry[]): string {
  const first = entries[0]?.documentName;
  if (first === undefined) {
    return 'impressive-ocr-results.zip';
  }

  const extension = extname(first);
  const stem = sanitizeSegment(first.slice(0, first.length - extension.length));
  return `${stem}.zip`;
}

/** Keep names unique, because a ZIP with two identical entries extracts unpredictably. */
function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }

  const extension = extname(name);
  const stem = name.slice(0, name.length - extension.length);
  for (let index = 2; ; index += 1) {
    const candidate = `${stem} (${index})${extension}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}
