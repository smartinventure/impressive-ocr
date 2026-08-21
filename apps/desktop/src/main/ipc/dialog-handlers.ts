// SPDX-License-Identifier: AGPL-3.0-or-later
import { BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  IPC_CHANNELS,
  type SelectFilesRequest,
  type SelectFolderRequest,
} from '../../shared/ipc-contract';

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

  /**
   * Native multi-file chooser, for Quick Mode.
   *
   * On the desktop the server and the browser are the same machine, so uploading a file to
   * ourselves would copy every byte for nothing. The OS dialog hands back real absolute paths
   * the backend can open directly.
   */
  ipcMain.handle(IPC_CHANNELS.selectFiles, async (event, raw: unknown) => {
    const request = parseSelectFilesRequest(raw);
    const window = BrowserWindow.fromWebContents(event.sender);

    const options: OpenDialogOptions = {
      properties: ['openFile', 'multiSelections'],
      ...(request.title === undefined ? {} : { title: request.title }),
      ...(request.defaultPath === undefined ? {} : { defaultPath: request.defaultPath }),
      ...(request.extensions === undefined || request.extensions.length === 0
        ? {}
        : {
            filters: [
              { name: 'Documents', extensions: [...request.extensions] },
              { name: 'All files', extensions: ['*'] },
            ],
          }),
    };

    const result =
      window === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(window, options);

    return result.canceled ? [] : result.filePaths;
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

/**
 * Validate the file-dialog request.
 *
 * Every field is checked even though it came from our own renderer: a channel exposed over
 * `contextBridge` is reachable by anything running in that page, and the main process must
 * not take its word for a string it will hand to the OS.
 */
function parseSelectFilesRequest(raw: unknown): SelectFilesRequest {
  if (typeof raw !== 'object' || raw === null) {
    return {};
  }
  const record = raw as Record<string, unknown>;

  const extensions = Array.isArray(record.extensions)
    ? record.extensions
        .filter((value): value is string => typeof value === 'string')
        // Letters and digits only: a filter string is not a place for a path or a wildcard.
        .filter((value) => /^[A-Za-z0-9]{1,10}$/.test(value))
        .slice(0, 40)
    : undefined;

  return {
    title: typeof record.title === 'string' ? record.title.slice(0, 200) : undefined,
    defaultPath:
      typeof record.defaultPath === 'string' && isAbsolute(record.defaultPath)
        ? record.defaultPath
        : undefined,
    extensions,
  };
}

function titleAndPath(request: SelectFolderRequest): { title?: string; defaultPath?: string } {
  return {
    ...(request.title === undefined ? {} : { title: request.title }),
    ...(request.defaultPath === undefined ? {} : { defaultPath: request.defaultPath }),
  };
}
