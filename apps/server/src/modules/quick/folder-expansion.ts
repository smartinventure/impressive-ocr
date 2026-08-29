// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

/**
 * The files a Quick run should take from a folder.
 *
 * Expanded here rather than in the browser for two reasons. A web page cannot list a
 * directory, and the desktop's own dialog returns the folder rather than its contents — so
 * whichever way the folder was chosen, only the server can say what is in it.
 *
 * Deliberately not recursive. A Quick run is a one-off over a folder someone is looking at;
 * walking a tree of thousands is a watched pipeline's job, and doing it quietly here would
 * turn "run this folder" into something the user did not ask for and cannot see the size of.
 */

/** Refuse a folder that would queue more work than anyone intended from one click. */
export const MAX_FOLDER_FILES = 200;

export interface FolderExpansion {
  files: string[];
  /** Entries left out because their type was not selected, for a truthful count on screen. */
  skipped: number;
  /** True when the folder held more than the cap and the list was cut short. */
  truncated: boolean;
}

export async function expandFolder(
  folderPath: string,
  extensions: readonly string[],
): Promise<FolderExpansion> {
  // `withFileTypes` so a subfolder is skipped without a stat per entry, which on a network
  // share is the difference between instant and a visible pause.
  const entries = await readdir(folderPath, { withFileTypes: true });

  const wanted = new Set(extensions.map((extension) => normalise(extension)));
  const files: string[] = [];
  let skipped = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!wanted.has(normalise(extname(entry.name)))) {
      skipped += 1;
      continue;
    }
    files.push(join(folderPath, entry.name));
  }

  // Sorted so a run's job order matches what the user sees in their file manager, rather than
  // whatever order the filesystem happened to return.
  files.sort((left, right) => left.localeCompare(right));

  return {
    files: files.slice(0, MAX_FOLDER_FILES),
    skipped,
    truncated: files.length > MAX_FOLDER_FILES,
  };
}

/** Compare extensions without caring about a leading dot or case. */
function normalise(extension: string): string {
  return extension.replace(/^\./, '').toLowerCase();
}
