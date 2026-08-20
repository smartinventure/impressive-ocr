// SPDX-License-Identifier: AGPL-3.0-or-later
import { BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { IPC_CHANNELS, type SelectFolderRequest } from '../../shared/ipc-contract';

/**
 * Native folder chooser and file reveal.
 *
 * This is the one thing the desktop build can do that a browser structurally cannot:
 * `showOpenDialog` returns a real absolute path. `<input webkitdirectory>` gives only relative
 * names and `showDirectoryPicker()` an opaque handle, so the browser build has to fall back to
 * the server-side folder browser. Here the OS dialog is both nicer and more capable.
 */

export function registerDialogHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.selectFolder, async (event, raw: unknown) => {
    const request = parseSelectFolderRequest(raw);
    const window = BrowserWindow.fromWebContents(event.sender);

    const properties: NonNullable<OpenDialogOptions['properties']> = ['openDirectory'];
    if (request.allowCreate === true) {
      // Output and archive folders routinely do not exist yet; without this the user has to
      // leave the app, create the folder, and come back.
      properties.push('createDirectory');
    }

    const result =
      window === null
        ? await dialog.showOpenDialog({ properties, ...titleAndPath(request) })
        : await dialog.showOpenDialog(window, { properties, ...titleAndPath(request) });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0] ?? null;
  });

  ipcMain.handle(IPC_CHANNELS.showInFolder, (_event, raw: unknown) => {
    // Validated even though it came from our own page: a renderer holding this channel must
    // not be able to ask the shell to act on an arbitrary string.
    if (typeof raw !== 'string' || raw.length === 0 || !isAbsolute(raw)) {
      return;
    }
    try {
      statSync(raw);
    } catch {
      return; // Already moved or deleted — nothing to reveal.
    }
    shell.showItemInFolder(raw);
  });
}

/** Narrow the untyped IPC payload. */
function parseSelectFolderRequest(raw: unknown): SelectFolderRequest {
  if (typeof raw !== 'object' || raw === null) {
    return {};
  }
  const record = raw as Record<string, unknown>;
  return {
    defaultPath:
      typeof record.defaultPath === 'string' && isAbsolute(record.defaultPath)
        ? record.defaultPath
        : undefined,
    title: typeof record.title === 'string' ? record.title.slice(0, 200) : undefined,
    allowCreate: record.allowCreate === true,
  };
}

function titleAndPath(request: SelectFolderRequest): { title?: string; defaultPath?: string } {
  return {
    ...(request.title === undefined ? {} : { title: request.title }),
    ...(request.defaultPath === undefined ? {} : { defaultPath: request.defaultPath }),
  };
}
