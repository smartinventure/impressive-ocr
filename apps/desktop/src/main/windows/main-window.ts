// SPDX-License-Identifier: AGPL-3.0-or-later
import { BrowserWindow, shell } from 'electron';
import { join } from 'node:path';

/**
 * The application window.
 *
 * It loads the very same SPA the headless server serves over HTTP, rather than from `file://`.
 * That keeps one code path for both modes: no Electron-only build, no origin differences, and
 * the browser and the window behave identically because they are the same page.
 */

const MIN_WIDTH = 1024;
const MIN_HEIGHT = 700;

export function createMainWindow(url: string, iconPath: string | undefined): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    ...(iconPath === undefined ? {} : { icon: iconPath }),
    // Painted with the app's own light ground so the window does not flash white-then-themed
    // while the SPA boots.
    backgroundColor: '#F7F8F4',
    title: 'Impressive OCR',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      // The three settings that matter. Anything the page needs from Node goes through the
      // preload's explicit bridge; nothing else is reachable.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });

  // Shown only once the SPA has painted, so there is no empty grey rectangle while the
  // backend and the bundle come up.
  window.once('ready-to-show', () => window.show());

  void window.loadURL(url);
  hardenNavigation(window, url);

  return window;
}

/**
 * Confine the window to the local app.
 *
 * The page renders OCR output — text extracted from documents the user did not write. If a
 * link in that text could navigate the window or open a new one, a malicious PDF would have a
 * route to render attacker-controlled content inside a context holding the preload bridge.
 * External links are handed to the real browser, where they are harmless.
 */
function hardenNavigation(window: BrowserWindow, appUrl: string): void {
  const appOrigin = new URL(appUrl).origin;

  window.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== appOrigin) {
      event.preventDefault();
      void shell.openExternal(target);
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    // Never a new Electron window: only http(s) is passed to the system browser, so a
    // `file://` or custom-scheme URL cannot be used to launch something.
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}
