// SPDX-License-Identifier: AGPL-3.0-or-later
import { type BrowserWindow, app, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import { IPC_CHANNELS, type UpdateStatus } from '../../shared/ipc-contract';

/**
 * Update checking and installation.
 *
 * The governing rule: **never restart the app on its own.** A pipeline may be halfway through
 * a 2,000-page backlog, and an update that interrupts that — silently, at 3am — destroys
 * exactly the unattended reliability the product exists to provide. So the update is
 * downloaded in the background and then *offered*; the user chooses the moment.
 *
 * The headless server build does not use this at all. It has no Electron, and a server
 * managed by a package manager or baked into a container image must not overwrite itself; it
 * checks the releases API and notifies instead.
 */

export interface UpdateServiceOptions {
  getWindow: () => BrowserWindow | null;
  isEnabled: () => boolean;
  /** True while any job is running, so a ready update waits rather than nagging. */
  isBusy: () => boolean;
}

export class UpdateService {
  private status: UpdateStatus = {
    state: 'idle',
    version: null,
    progressPercent: 0,
    releaseNotesUrl: null,
    message: null,
  };

  constructor(private readonly options: UpdateServiceOptions) {
    // Both off: downloading is our decision (it respects the user's setting), and installing
    // on quit would restart the app without asking.
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;

    this.wireEvents();
    this.registerHandlers();
  }

  private wireEvents(): void {
    autoUpdater.on('checking-for-update', () => this.publish({ state: 'checking' }));

    autoUpdater.on('update-available', (info) => {
      this.publish({
        state: 'available',
        version: info.version,
        releaseNotesUrl: releaseUrlFor(info.version),
      });
    });

    autoUpdater.on('update-not-available', () =>
      this.publish({ state: 'up-to-date', version: app.getVersion() }),
    );

    autoUpdater.on('download-progress', (progress) =>
      this.publish({ state: 'downloading', progressPercent: Math.round(progress.percent) }),
    );

    autoUpdater.on('update-downloaded', (info) =>
      this.publish({ state: 'ready', version: info.version, progressPercent: 100 }),
    );

    autoUpdater.on('error', (error: Error) =>
      // A failed update check must never be fatal, and must never interrupt processing. It is
      // reported in the UI and otherwise ignored.
      this.publish({ state: 'error', message: error.message }),
    );
  }

  private registerHandlers(): void {
    ipcMain.handle(IPC_CHANNELS.checkForUpdate, async () => {
      if (!this.options.isEnabled()) {
        return this.publish({ state: 'idle', message: 'Automatic updates are switched off.' });
      }
      if (!app.isPackaged) {
        // electron-updater refuses to run unpackaged; say so plainly rather than surfacing
        // its internal error to a developer.
        return this.publish({ state: 'idle', message: 'Updates are disabled in development.' });
      }
      try {
        await autoUpdater.checkForUpdates();
      } catch (error) {
        this.publish({
          state: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return this.status;
    });

    ipcMain.handle(IPC_CHANNELS.downloadUpdate, async () => {
      if (this.status.state !== 'available') {
        return;
      }
      try {
        await autoUpdater.downloadUpdate();
      } catch (error) {
        this.publish({
          state: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });

    ipcMain.handle(IPC_CHANNELS.installUpdate, () => {
      if (this.status.state !== 'ready') {
        return;
      }
      // `isSilent: false, isForceRunAfter: true` — the installer is visible and the app comes
      // back afterwards, so an unattended machine returns to processing rather than sitting
      // closed until someone logs in.
      autoUpdater.quitAndInstall(false, true);
    });
  }

  /** Background check on a timer. Never downloads or installs by itself. */
  async checkQuietly(): Promise<void> {
    if (!this.options.isEnabled() || !app.isPackaged) {
      return;
    }
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      // Offline, or GitHub unreachable. Nothing to do and nothing worth interrupting for.
    }
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  private publish(patch: Partial<UpdateStatus>): UpdateStatus {
    this.status = { ...this.status, ...patch };
    this.options.getWindow()?.webContents.send(IPC_CHANNELS.updateStatus, this.status);
    return this.status;
  }
}

function releaseUrlFor(version: string): string {
  return `https://github.com/smartinventure/impressive-ocr/releases/tag/v${version}`;
}

/** How often to look for an update in the background. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
