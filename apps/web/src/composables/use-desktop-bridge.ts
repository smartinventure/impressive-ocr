// SPDX-License-Identifier: AGPL-3.0-or-later
import { readonly, ref } from 'vue';

/**
 * Access to the Electron bridge, when there is one.
 *
 * The same SPA is served by the desktop app and by the headless server, so every feature here
 * has to be optional. Feature-detected rather than build-flagged: there is exactly one build
 * of the frontend, which is what guarantees the browser path stays working instead of
 * quietly rotting behind an `if (isElectron)` that nobody exercises.
 */

export interface SelectFilesRequest {
  title?: string | undefined;
  defaultPath?: string | undefined;
  /** Extensions the OS dialog should offer, without the dot. */
  extensions?: readonly string[] | undefined;
}

export interface SelectFolderRequest {
  defaultPath?: string | undefined;
  title?: string | undefined;
  allowCreate?: boolean | undefined;
}

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'up-to-date' | 'error';
  version: string | null;
  progressPercent: number;
  releaseNotesUrl: string | null;
  message: string | null;
}

export interface DataLocation {
  /** Where the runtime, models and database are being kept right now. */
  current: string;
  /** Where they would be kept with no override at all. */
  default: string;
  /** The user's stored choice, or null when the default is in use. */
  chosen: string | null;
  /** True when an environment variable decided it, which makes the setting read-only. */
  fromEnvironment: boolean;
}

/** Why an open did not happen. `missing` is routine: Quick Mode results expire. */
export type OpenFileResult =
  | { status: 'opened' }
  | { status: 'refused'; reason: 'not-a-path' | 'unsupported-type' | 'missing' };

interface DesktopBridge {
  readonly isDesktop: true;
  selectFolder: (request?: SelectFolderRequest) => Promise<string | null>;
  selectFiles: (request?: SelectFilesRequest) => Promise<string[]>;
  showInFolder: (path: string) => Promise<void>;
  openFile: (path: string) => Promise<OpenFileResult>;
  getServerInfo: () => Promise<{ url: string; port: number }>;
  getVersion: () => Promise<string>;
  getDataLocation: () => Promise<DataLocation>;
  setDataLocation: (dataDir: string | null) => Promise<DataLocation>;
  checkForUpdate: () => Promise<UpdateStatus>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  onUpdateStatus: (listener: (status: UpdateStatus) => void) => () => void;
}

declare global {
  interface Window {
    impressiveOcr?: DesktopBridge;
  }
}

const bridge = ref<DesktopBridge | null>(
  typeof window !== 'undefined' && window.impressiveOcr !== undefined ? window.impressiveOcr : null,
);

export function useDesktopBridge() {
  return {
    /** True in the Electron app, false in a browser. */
    isDesktop: readonly(ref(bridge.value !== null)),
    bridge: readonly(bridge),

    /**
     * Open the OS folder chooser, or null when there is none.
     *
     * A browser cannot return an absolute path — `webkitdirectory` gives relative names and
     * `showDirectoryPicker()` an opaque handle — so callers must fall back to the
     * server-side folder browser rather than treating this as always available.
     */
    async selectFolder(request?: SelectFolderRequest): Promise<string | null> {
      return bridge.value === null ? null : bridge.value.selectFolder(request);
    },

    /** Native multi-file picker. Empty in a browser, where no such thing exists. */
    async selectFiles(request?: SelectFilesRequest): Promise<string[]> {
      return bridge.value === null ? [] : bridge.value.selectFiles(request);
    },

    async showInFolder(path: string): Promise<void> {
      await bridge.value?.showInFolder(path);
    },

    /** The running version, or null in a browser where there is no packaged app. */
    async getVersion(): Promise<string | null> {
      return bridge.value === null ? null : bridge.value.getVersion();
    },

    /**
     * Where the runtime lives, or null in a browser.
     *
     * Desktop-only on purpose. The headless server takes its location from
     * `IMPRESSIVE_OCR_DATA_DIR` or a volume mount, both decided before the process starts,
     * and a page offering to move it would be describing something it cannot do.
     */
    async getDataLocation(): Promise<DataLocation | null> {
      return bridge.value === null ? null : bridge.value.getDataLocation();
    },

    /** Choose a location for the next start, or pass null to go back to the default. */
    async setDataLocation(dataDir: string | null): Promise<DataLocation | null> {
      return bridge.value === null ? null : bridge.value.setDataLocation(dataDir);
    },

    /**
     * Updates, which exist only in the desktop app.
     *
     * The headless server deliberately has no equivalent: it is managed by a package manager
     * or baked into an image, where an app that overwrites itself is actively wrong.
     */
    async checkForUpdate(): Promise<UpdateStatus | null> {
      return bridge.value === null ? null : bridge.value.checkForUpdate();
    },

    async downloadUpdate(): Promise<void> {
      await bridge.value?.downloadUpdate();
    },

    async installUpdate(): Promise<void> {
      await bridge.value?.installUpdate();
    },

    /** Returns an unsubscribe function; a no-op in a browser, so callers need no branch. */
    onUpdateStatus(listener: (status: UpdateStatus) => void): () => void {
      return bridge.value?.onUpdateStatus(listener) ?? (() => undefined);
    },
  };
}
