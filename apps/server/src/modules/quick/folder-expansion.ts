// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { PROCESSABLE_EXTENSIONS } from '@impressive-ocr/shared';

/**
 * The files a Quick run should take from the folders it was given.
 *
 * Expanded here rather than in the browser for two reasons. A web page cannot list a
 * directory, and the desktop's own dialog returns the folder rather than its contents — so
 * whichever way the folder was chosen, only the server can say what is in it.
 *
 * Deliberately not recursive. A Quick run is a one-off over folders someone is looking at;
 * walking a tree of thousands is a watched pipeline's job, and doing it quietly here would
 * turn "run this folder" into something the user did not ask for and cannot see the size of.
 */

/** Refuse a set of folders that would queue more work than anyone intended from one click. */
export const MAX_FOLDER_FILES = 200;

export interface FolderExpansion {
  files: string[];
  /** Entries left out because their type was not selected, for a truthful count on screen. */
  skipped: number;
  /** True when the folders held more than the cap and the list was cut short. */
  truncated: boolean;
}

/** How many readable files of each type one folder holds, for the count shown before a run. */
export interface FolderPreview {
  /** Only types actually present. A chip for a type the folder does not have is noise. */
  counts: { extension: string; files: number }[];
  /** Files the engine cannot read, so "12 of 30 files" is explainable rather than alarming. */
  other: number;
}

/**
 * Every chosen folder's files, in the order the folders were chosen.
 *
 * The cap is applied to the total rather than per folder: it exists to bound one click's work,
 * and ten folders of thirty files is the same amount of work however it is divided.
 */
export async function expandFolders(
  folderPaths: readonly string[],
  extensions: readonly string[],
): Promise<FolderExpansion> {
  const wanted = new Set(extensions.map((extension) => normalise(extension)));
  const files: string[] = [];
  let skipped = 0;

  for (const folderPath of folderPaths) {
    const entries = await listFiles(folderPath);
    const wantedHere: string[] = [];

    for (const name of entries) {
      if (wanted.has(normalise(extname(name)))) {
        wantedHere.push(join(folderPath, name));
      } else {
        skipped += 1;
      }
    }

    // Sorted within the folder, so a run's job order matches what the user sees in their file
    // manager. Not across folders: the order they were added in is itself a choice.
    wantedHere.sort((left, right) => left.localeCompare(right));
    files.push(...wantedHere);
  }

  return {
    files: files.slice(0, MAX_FOLDER_FILES),
    skipped,
    truncated: files.length > MAX_FOLDER_FILES,
  };
}

/**
 * What one folder holds, before anything is run.
 *
 * Counted per type so the picker can offer only the types that are there and put a number
 * against the run — "3 files" answers a question the folder's name cannot.
 */
export async function previewFolder(folderPath: string): Promise<FolderPreview> {
  const names = await listFiles(folderPath);
  const tally = new Map<string, number>();
  let other = 0;

  for (const name of names) {
    const extension = normalise(extname(name));
    if ((PROCESSABLE_EXTENSIONS as readonly string[]).includes(extension)) {
      tally.set(extension, (tally.get(extension) ?? 0) + 1);
    } else {
      other += 1;
    }
  }

  // Ordered as `PROCESSABLE_EXTENSIONS` is, so the chips do not reshuffle when a second
  // folder adds a type the first did not have.
  const counts = PROCESSABLE_EXTENSIONS.filter((extension) => tally.has(extension)).map(
    (extension) => ({ extension, files: tally.get(extension) ?? 0 }),
  );

  return { counts, other };
}

/** File names directly inside a folder. */
async function listFiles(folderPath: string): Promise<string[]> {
  // `withFileTypes` so a subfolder is skipped without a stat per entry, which on a network
  // share is the difference between instant and a visible pause.
  const entries = await readdir(folderPath, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

/** Compare extensions without caring about a leading dot or case. */
function normalise(extension: string): string {
  return extension.replace(/^\./, '').toLowerCase();
}
