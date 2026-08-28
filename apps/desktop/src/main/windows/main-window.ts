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
 * The page renders OCR output â€” text extracted from documents the user did not write. If a
 * link in that text could navigate the window or open a new one, a malicious PDF would have a
 * route to render attacker-controlled content inside a context holding the preload bridge.
 * External links are handed to the real browser, where they are harmless.
 */
/**
 * Whether a target belongs to the application itself.
 *
 * A target that will not parse is treated as foreign, so a malformed URL is refused rather
 * than throwing inside the main process â€” where an exception in a `will-navigate` listener
 * has no sensible place to go.
 */
export function isSameOrigin(target: string, appOrigin: string): boolean {
  try {
    return new URL(target).origin === appOrigin;
  } catch {
    return false;
  }
}

/** Hand a URL to the system browser, but only when it is a web address. */
export function openIfWebAddress(url: string): void {
  if (url.startsWith('https://') || url.startsWith('http://')) {
    void shell.openExternal(url);
  }
}

function hardenNavigation(window: BrowserWindow, appUrl: string): void {
  const appOrigin = new URL(appUrl).origin;

  window.webContents.on('will-navigate', (event, target) => {
    if (isSameOrigin(target, appOrigin)) {
      return;
    }
    // Anything leaving the app is refused here and handed to the system browser only if it
    // is a web address. The scheme check is the point: `openExternal` on a `file://` or
    // custom-scheme URL asks the operating system to open it with whatever is registered,
    // which for the wrong target means launching a program. The handler below has always
    // said so; this one did not, and passed every scheme straight through.
    event.preventDefault();
    openIfWebAddress(target);
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    // Never a new Electron window: only http(s) is passed to the system browser, so a
    // `file://` or custom-scheme URL cannot be used to launch something.
    openIfWebAddress(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}
