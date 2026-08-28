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
  selectFiles: 'dialog:select-files',
  /** Reveal a produced file in Explorer/Finder. */
  showInFolder: 'shell:show-in-folder',
  openFile: 'shell:open-file',
  /** Where the backend is listening, so the renderer can build absolute URLs if it needs to. */
  getServerInfo: 'app:server-info',
  getVersion: 'app:version',
  /** Update lifecycle. */
  checkForUpdate: 'update:check',
  downloadUpdate: 'update:download',
  installUpdate: 'update:install',
  /** Main → renderer push for update progress. */
  updateStatus: 'update:status',
  /** Where the runtime, models and database live, and how to move them. */
  getDataLocation: 'data:location',
  setDataLocation: 'data:set-location',
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

export interface SelectFilesRequest {
  title?: string | undefined;
  defaultPath?: string | undefined;
  /**
   * Extensions offered in the dialog, without the dot.
   *
   * The desktop build can filter at the OS level, which the browser's `accept` attribute only
   * suggests. Quick Mode passes the formats the OCR engine can actually read, so a user
   * cannot pick a .zip and discover the problem only after starting a run.
   */
  extensions?: readonly string[] | undefined;
}

export interface ServerInfo {
  url: string;
  port: number;
}

export interface DataLocation {
  /** Where everything is being kept right now. */
  current: string;
  /** Where it would be kept with no override at all. */
  default: string;
  /** The user's stored choice, or null when the default is in use. */
  chosen: string | null;
  /**
   * True when `IMPRESSIVE_OCR_DATA_DIR` decided it.
   *
   * The setting is shown as unavailable rather than hidden: someone who set the variable
   * should be told why the control does nothing, not left to wonder whether it is broken.
   */
  fromEnvironment: boolean;
}

export type UpdateState =
  'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'up-to-date' | 'error';

export interface UpdateStatus {
  state: UpdateState;
  version: string | null;
  /** 0–100 while downloading. */
  progressPercent: number;
  releaseNotesUrl: string | null;
  message: string | null;
}

/** The object the preload puts on `window.impressiveOcr`. */
/** Why an open did not happen, for a message the user can act on. */
export type OpenFileResult =
  | { status: 'opened' }
  | { status: 'refused'; reason: 'not-a-path' | 'unsupported-type' | 'missing' };

export interface DesktopBridge {
  readonly isDesktop: true;
  selectFolder: (request?: SelectFolderRequest) => Promise<string | null>;
  /** Absolute paths of the chosen files; empty when cancelled. */
  selectFiles: (request?: SelectFilesRequest) => Promise<string[]>;
  showInFolder: (path: string) => Promise<void>;
  /**
   * Open a produced document in the user's default application.
   *
   * Resolves to whether it happened. The main process refuses anything that is not one of the
   * formats this application writes, so the caller has to be able to say "that file is gone"
   * rather than assume it worked.
   */
  openFile: (path: string) => Promise<OpenFileResult>;
  getServerInfo: () => Promise<ServerInfo>;
  getVersion: () => Promise<string>;
  getDataLocation: () => Promise<DataLocation>;
  /**
   * Choose where the runtime lives, or pass null to return to the default.
   *
   * Takes effect on the next start and moves nothing: the runtime is gigabytes and is open
   * by a running Python process while the app is up.
   */
  setDataLocation: (dataDir: string | null) => Promise<DataLocation>;
  checkForUpdate: () => Promise<UpdateStatus>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  onUpdateStatus: (listener: (status: UpdateStatus) => void) => () => void;
}
