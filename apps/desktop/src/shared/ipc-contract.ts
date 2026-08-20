// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The complete surface the renderer can reach in the main process.
 *
 * Deliberately tiny. `contextIsolation` and `sandbox` are on, so the only way into Node is
 * through these channels — and every one of them is a capability the web page would not
 * otherwise have. Adding a channel is adding a permission.
 *
 * Shared by the preload (which exposes it) and the renderer's type declarations (which
 * consume it), so a renamed channel is a compile error rather than a silent no-op.
 */

export const IPC_CHANNELS = {
  /** Native folder chooser. Returns an absolute path, which no browser API can supply. */
  selectFolder: 'dialog:select-folder',
  /** Reveal a produced file in Explorer/Finder. */
  showInFolder: 'shell:show-in-folder',
  /** Where the backend is listening, so the renderer can build absolute URLs if it needs to. */
  getServerInfo: 'app:server-info',
  getVersion: 'app:version',
  /** Update lifecycle. */
  checkForUpdate: 'update:check',
  downloadUpdate: 'update:download',
  installUpdate: 'update:install',
  /** Main → renderer push for update progress. */
  updateStatus: 'update:status',
} as const;

export interface SelectFolderRequest {
  /** Where the dialog opens. */
  defaultPath?: string | undefined;
  title?: string | undefined;
  /**
   * Offer the OS "New Folder" button. On for output folders, which routinely do not exist
   * yet, so the user is not sent to a file manager and back.
   */
  allowCreate?: boolean | undefined;
}

export interface ServerInfo {
  url: string;
  port: number;
}

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'up-to-date'
  | 'error';

export interface UpdateStatus {
  state: UpdateState;
  version: string | null;
  /** 0–100 while downloading. */
  progressPercent: number;
  releaseNotesUrl: string | null;
  message: string | null;
}

/** The object the preload puts on `window.impressiveOcr`. */
export interface DesktopBridge {
  readonly isDesktop: true;
  selectFolder: (request?: SelectFolderRequest) => Promise<string | null>;
  showInFolder: (path: string) => Promise<void>;
  getServerInfo: () => Promise<ServerInfo>;
  getVersion: () => Promise<string>;
  checkForUpdate: () => Promise<UpdateStatus>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  onUpdateStatus: (listener: (status: UpdateStatus) => void) => () => void;
}
