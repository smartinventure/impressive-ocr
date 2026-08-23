// SPDX-License-Identifier: AGPL-3.0-or-later
import { type BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { IPC_CHANNELS } from '../shared/ipc-contract';
import { registerDialogHandlers } from './ipc/dialog-handlers';
import { startServer, type ServerHost } from './server-host';
import { getLogPath, initStartupLog, installCrashHandlers, logError, logLine } from './startup-log';
import { AppTray, type TrayState } from './tray/tray-menu';
import { UpdateService, UPDATE_CHECK_INTERVAL_MS } from './updater/update-service';
import { createMainWindow } from './windows/main-window';

/**
 * Electron main process.
 *
 * The backend runs in here, so this file owns the whole application lifecycle: start the
 * server, show a window, keep processing while the window is closed, and shut down cleanly.
 */

let host: ServerHost | null = null;
let window: BrowserWindow | null = null;
let tray: AppTray | null = null;
let updates: UpdateService | null = null;
let updateTimer: NodeJS.Timeout | null = null;
let trayStateTimer: NodeJS.Timeout | null = null;
let quitting = false;
/**
 * Set once quitting is settled — the user confirmed, or there was nobody to ask.
 *
 * Separate from `quitting` because `before-quit` fires again after the confirmation
 * dialog calls `app.quit()`, and without this the prompt would reappear forever.
 */
let quitConfirmed = false;

/**
 * Headless mode, launched by the "Impressive OCR Server" shortcut the installer creates.
 *
 * Same executable, no window and no tray: the queue runs and the UI is reached from a browser.
 * This is what makes a spare machine into a processing server without a second download —
 * and it is why the SPA may never depend on an Electron-only affordance.
 */
const headless = process.argv.includes('--server');

/**
 * One instance only.
 *
 * A second instance would bind the same port and fail, or worse, open a second SQLite handle
 * over the same queue. Launching again just reveals the running window.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => revealWindow());
  void main();
}

async function main(): Promise<void> {
  await app.whenReady();

  // First, before anything can fail: on Windows there is no console to report into.
  const logFile = initStartupLog();
  installCrashHandlers();
  logLine(`Log file: ${logFile}`);
  logLine(`Mode: ${headless ? 'headless (--server)' : 'desktop'}`);

  registerDialogHandlers();
  registerAppHandlers();

  try {
    logLine('Starting the backend…');
    host = await startServer();
    logLine(`Backend listening at ${host.url}`);
  } catch (error) {
    // Nothing works without the backend, so this is fatal — but it must say *why*, since the
    // overwhelmingly likely cause is a port already in use.
    logError('startServer', error);
    if (!headless) {
      await showFatalError(error);
    }
    app.exit(1);
    return;
  }

  const settings = host.handle.settings;

  updates = new UpdateService({
    getWindow: () => window,
    isEnabled: () => host?.handle.services.settings.get().autoUpdateEnabled ?? false,
    isBusy: () => (host?.handle.services.scheduler.runningCount ?? 0) > 0,
  });

  if (headless) {
    // No window, no tray — but the update *check* still runs, so an administrator sees that
    // a newer version exists rather than discovering it months later.
    host.handle.logger.info({ url: host.url }, 'Running headless; open the URL in a browser');
    logLine(`Impressive OCR is running at ${host.url}`);
    logLine(`Open that URL in a browser. Logs: ${getLogPath() ?? '(none)'}`);
  } else {
    createTray();
    startTrayStatePolling();

    if (settings.startMinimizedToTray) {
      // Started with Windows, or deliberately backgrounded: the queue runs, no window appears.
      host.handle.logger.info('Started minimised to the tray');
    } else {
      revealWindow();
    }

    if (settings.openBrowserOnStart && !settings.startMinimizedToTray) {
      // Both: the native window *and* the browser, because some people simply prefer their
      // browser and the app is identical in either.
      void shell.openExternal(host.url);
    }
  }

  updateTimer = setInterval(() => void updates?.checkQuietly(), UPDATE_CHECK_INTERVAL_MS);
  void updates.checkQuietly();
}

function registerAppHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.getServerInfo, () => ({
    url: host?.url ?? '',
    port: host?.handle.settings.port ?? 0,
  }));

  ipcMain.handle(IPC_CHANNELS.getVersion, () => app.getVersion());

  /**
   * Closing the window does NOT quit.
   *
   * This is a background processor; quitting on window close would abandon a running queue
   * the moment someone tidied their desktop. Quit is explicit, from the tray or the menu.
   */
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && quitting) {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (!headless) {
      revealWindow();
    }
  });

  // Headless mode is a service: it must stop on the signals a service manager sends, and it
  // has no tray to quit from.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      // Never prompt here. A service manager sending SIGTERM cannot answer a dialog, and
      // stalling on one turns a graceful stop into a kill a few seconds later.
      quitConfirmed = true;
      quitting = true;
      app.quit();
    });
  }

  app.on('before-quit', (event) => {
    const running = host?.handle.services.scheduler.runningCount ?? 0;

    // Quitting aborts whatever is mid-document. That is recoverable — the job is retried —
    // but it can throw away many minutes of OCR on a large scan, so it should not happen
    // because somebody hit Quit in the tray without thinking.
    if (quitConfirmed || running === 0 || headless || window === null || window.isDestroyed()) {
      quitting = true;
      return;
    }

    event.preventDefault();
    void confirmQuitWhileBusy(running);
  });

  app.on('will-quit', (event) => {
    if (host === null) {
      return;
    }
    // Drain properly: stop watchers, abort in-flight jobs, close the sidecars and the
    // database. Skipping this leaves orphaned Python processes holding the GPU.
    event.preventDefault();
    const handle = host;
    host = null;

    clearTimers();
    void handle.handle
      .shutdown()
      .catch(() => undefined)
      .finally(() => app.exit(0));
  });
}

/**
 * Ask before abandoning running conversions.
 *
 * Modal on the window rather than a notification: the answer decides whether work is thrown
 * away, so it has to block. English only, like the tray menu — the main process has no
 * access to the renderer's i18n bundle.
 */
async function confirmQuitWhileBusy(running: number): Promise<void> {
  const parent = window;
  if (parent === null || parent.isDestroyed()) {
    quitConfirmed = true;
    app.quit();
    return;
  }

  // Bring it forward first: the tray Quit can be clicked while the window is hidden, and a
  // modal parented to an invisible window is a silent hang.
  revealWindow();

  const { response } = await dialog.showMessageBox(parent, {
    type: 'question',
    buttons: ['Keep running', 'Quit anyway'],
    defaultId: 0,
    cancelId: 0,
    title: 'Impressive OCR',
    message:
      running === 1
        ? 'A document is still being processed.'
        : `${running} documents are still being processed.`,
    detail:
      'Quitting stops them now. They stay in the queue and start again next time, but the ' +
      'work done so far on them is lost.',
  });

  if (response !== 1) {
    return;
  }

  quitConfirmed = true;
  app.quit();
}

function revealWindow(): void {
  if (host === null) {
    return;
  }
  if (window !== null && !window.isDestroyed()) {
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
    return;
  }

  window = createMainWindow(host.url, appIconPath());
  window.on('closed', () => {
    window = null;
  });
}

function createTray(): void {
  if (host === null) {
    return;
  }
  const services = host.handle.services;

  tray = new AppTray({
    serverUrl: host.url,
    isPaused: () => services.isGloballyPaused(),
    onShowWindow: () => revealWindow(),
    onOpenInBrowser: () => {
      if (host !== null) {
        void shell.openExternal(host.url);
      }
    },
    onTogglePause: () => services.setGloballyPaused(!services.isGloballyPaused()),
    onQuit: () => {
      quitting = true;
      app.quit();
    },
  });
  tray.create();
}

/**
 * Keep the tray icon in step with what the queue is doing.
 *
 * Polling rather than subscribing to the event bus: the tray only needs a coarse state, and a
 * poll cannot leak a listener across the window being closed and reopened.
 */
function startTrayStatePolling(): void {
  trayStateTimer = setInterval(() => {
    if (host === null || tray === null) {
      return;
    }
    const services = host.handle.services;
    let state: TrayState = 'idle';

    if (services.isGloballyPaused()) {
      state = 'paused';
    } else if (services.scheduler.runningCount > 0) {
      state = 'running';
    } else if (!services.runtime.isReady()) {
      state = 'error';
    }
    tray.setState(state);
  }, 2_000);
}

function clearTimers(): void {
  if (updateTimer !== null) {
    clearInterval(updateTimer);
    updateTimer = null;
  }
  if (trayStateTimer !== null) {
    clearInterval(trayStateTimer);
    trayStateTimer = null;
  }
  tray?.destroy();
  tray = null;
}

function appIconPath(): string | undefined {
  // Windows and Linux take the icon from the window; macOS uses the bundle's own.
  if (process.platform === 'darwin') {
    return undefined;
  }
  return app.isPackaged
    ? join(process.resourcesPath, 'icons', 'icon.png')
    : join(app.getAppPath(), 'build', 'icons', 'icon.png');
}

async function showFatalError(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await dialog.showMessageBox({
    type: 'error',
    title: 'Impressive OCR could not start',
    message,
    detail:
      'If the port is in use, change it in Settings or stop the other program, then start ' +
      'Impressive OCR again.',
    buttons: ['Close'],
  });
}
