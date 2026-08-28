// SPDX-License-Identifier: AGPL-3.0-or-later
import { shell } from 'electron';
import { statSync } from 'node:fs';
import { extname, isAbsolute } from 'node:path';

/**
 * Opening a produced document in whatever application the user has for it.
 *
 * Kept apart from the other shell handler because the two are not equally dangerous.
 * `showItemInFolder` selects a file in a file manager; `openPath` hands it to the operating
 * system to *execute* with its registered application, and for `.exe`, `.bat`, `.ps1`, `.lnk`
 * or `.scr` that means running it. A renderer holding this channel must not be able to turn
 * it into a way to start a program.
 *
 * So the extension is checked against what this application actually writes. Everything else
 * is refused, including anything with no extension at all. It is a small list on purpose: the
 * question is not "is this file dangerous" — which cannot be answered from a name — but "is
 * this one of the documents we just produced".
 */

/** Exactly the formats the writers emit, and nothing else. */
const OPENABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md',
  '.txt',
  '.json',
  '.docx',
  '.xlsx',
  '.html',
  '.htm',
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.zip',
]);

export type OpenFileOutcome =
  | { status: 'opened' }
  | { status: 'refused'; reason: 'not-a-path' | 'unsupported-type' | 'missing' };

/**
 * Validate and open. Returns why it declined rather than throwing, because every reason is
 * something the user should be told plainly rather than a failure of the application.
 */
export function openProducedFile(raw: unknown): OpenFileOutcome {
  if (typeof raw !== 'string' || raw.length === 0 || !isAbsolute(raw)) {
    return { status: 'refused', reason: 'not-a-path' };
  }

  if (!OPENABLE_EXTENSIONS.has(extname(raw).toLowerCase())) {
    return { status: 'refused', reason: 'unsupported-type' };
  }

  try {
    // Directories have extensions too, on a system that allows it, and `openPath` on one
    // opens a file manager rather than the document the user clicked.
    if (!statSync(raw).isFile()) {
      return { status: 'refused', reason: 'missing' };
    }
  } catch {
    // Swept, moved, or on a disconnected drive. Quick Mode results expire, so this is a
    // normal thing to happen to a window someone left open.
    return { status: 'refused', reason: 'missing' };
  }

  void shell.openPath(raw);
  return { status: 'opened' };
}
