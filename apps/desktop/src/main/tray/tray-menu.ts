// SPDX-License-Identifier: AGPL-3.0-or-later
import { Menu, Tray, app, nativeImage, shell } from 'electron';
import { join } from 'node:path';

/**
 * The system tray icon.
 *
 * The point of the tray for this product is that the app is a *background processor*: closing
 * the window must not stop a running queue, and the user needs a way to tell at a glance
 * whether work is happening without restoring anything.
 */

export type TrayState = 'idle' | 'running' | 'paused' | 'error';

export interface TrayOptions {
  serverUrl: string;
  onShowWindow: () => void;
  onOpenInBrowser: () => void;
  onTogglePause: () => void;
  onQuit: () => void;
  isPaused: () => boolean;
}

export class AppTray {
  private tray: Tray | null = null;
  private state: TrayState = 'idle';

  constructor(private readonly options: TrayOptions) {}

  create(): void {
    this.tray = new Tray(iconFor(this.state));
    this.tray.setToolTip('Impressive OCR');

    // Left click restores the window on Windows and Linux; on macOS the convention is that a
    // click opens the menu, which Electron does by itself.
    if (process.platform !== 'darwin') {
      this.tray.on('click', () => this.options.onShowWindow());
    }

    this.refreshMenu();
  }

  setState(state: TrayState): void {
    if (state === this.state || this.tray === null) {
      return;
    }
    this.state = state;
    this.tray.setImage(iconFor(state));
    this.tray.setToolTip(`Impressive OCR — ${TOOLTIPS[state]}`);
    this.refreshMenu();
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  private refreshMenu(): void {
    const paused = this.options.isPaused();

    this.tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Impressive OCR ${app.getVersion()}`, enabled: false },
        { label: TOOLTIPS[this.state], enabled: false },
        { type: 'separator' },
        { label: 'Open', click: () => this.options.onShowWindow() },
        {
          label: 'Open in browser',
          click: () => this.options.onOpenInBrowser(),
        },
        { type: 'separator' },
        {
          label: paused ? 'Resume all pipelines' : 'Pause all pipelines',
          click: () => this.options.onTogglePause(),
        },
        { type: 'separator' },
        {
          label: 'Open the data folder',
          click: () => {
            void shell.openPath(app.getPath('userData'));
          },
        },
        { type: 'separator' },
        { label: 'Quit', click: () => this.options.onQuit() },
      ]),
    );
  }
}

const TOOLTIPS: Record<TrayState, string> = {
  idle: 'Idle',
  running: 'Processing',
  paused: 'Paused',
  error: 'Attention needed',
};

/**
 * Load the tray image for a state.
 *
 * macOS gets the template variant: a black-and-alpha image the OS tints itself, so the icon
 * stays legible when the user switches between a light and dark menu bar. A coloured icon
 * there looks wrong in one of the two.
 */
function iconFor(state: TrayState): Electron.NativeImage {
  const base = app.isPackaged
    ? join(process.resourcesPath, 'icons')
    : join(app.getAppPath(), 'build', 'icons');

  const name = process.platform === 'darwin' ? 'tray-template.png' : `tray-${state}.png`;
  const image = nativeImage.createFromPath(join(base, name));

  if (process.platform === 'darwin') {
    image.setTemplateImage(true);
  }
  // A missing file yields an empty image and an invisible tray icon; falling back to the app
  // icon at least leaves something clickable.
  return image.isEmpty() ? nativeImage.createFromPath(join(base, 'icon.png')) : image;
}
