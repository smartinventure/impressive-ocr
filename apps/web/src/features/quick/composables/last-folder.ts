// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where the last file or folder was picked from, so the next dialog opens there.
 *
 * The OS remembers a per-application default of its own, but it is one default shared by
 * every dialog the app opens — choosing an output folder moves where the *input* dialog will
 * start. Someone working through a scan folder then navigates back to it every single time.
 *
 * `localStorage` rather than a ref: the point is that it survives the app being closed. Kept
 * to a path, never a file list — what was picked is nobody's business but this session's.
 */

const LAST_INPUT_FOLDER_KEY = 'impressive-ocr.quick.lastInputFolder';

export function rememberInputFolder(path: string): void {
  try {
    if (path.length > 0) localStorage.setItem(LAST_INPUT_FOLDER_KEY, path);
  } catch {
    // Private browsing, or storage full. Costs the convenience, not the run.
  }
}

/** Undefined rather than empty, because that is what the dialog request omits. */
export function recallInputFolder(): string | undefined {
  try {
    const stored = localStorage.getItem(LAST_INPUT_FOLDER_KEY);
    return stored === null || stored.length === 0 ? undefined : stored;
  } catch {
    return undefined;
  }
}

/**
 * The folder a chosen file sits in.
 *
 * Both separators are checked because the browser build talks to a server that may not run
 * the same OS it does, so a path's shape cannot be inferred from this machine's.
 */
export function parentFolderOf(filePath: string): string {
  const cut = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return cut <= 0 ? '' : filePath.slice(0, cut);
}
