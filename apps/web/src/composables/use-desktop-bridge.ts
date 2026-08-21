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

interface DesktopBridge {
  readonly isDesktop: true;
  selectFolder: (request?: SelectFolderRequest) => Promise<string | null>;
  selectFiles: (request?: SelectFilesRequest) => Promise<string[]>;
  showInFolder: (path: string) => Promise<void>;
  getServerInfo: () => Promise<{ url: string; port: number }>;
  getVersion: () => Promise<string>;
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
  };
}
