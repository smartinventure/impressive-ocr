// SPDX-License-Identifier: AGPL-3.0-or-later
import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_CHANNELS,
  type DesktopBridge,
  type SelectFolderRequest,
  type ServerInfo,
  type UpdateStatus,
} from '../shared/ipc-contract';

/**
 * The preload script — the only bridge between the page and Node.
 *
 * Runs sandboxed with `contextIsolation` on, so it cannot hand the renderer anything but
 * plain serialisable values and functions. That is the point: exposing `ipcRenderer` itself,
 * or any Node primitive, would give the page arbitrary main-process access and undo the whole
 * isolation model.
 *
 * Every method here is a deliberate capability, and each is validated again on the main side —
 * a compromised renderer must not be able to reach past this file.
 */

const bridge: DesktopBridge = {
  isDesktop: true,

  selectFolder: (request?: SelectFolderRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.selectFolder, request ?? {}) as Promise<string | null>,

  showInFolder: (path: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.showInFolder, path) as Promise<void>,

  getServerInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getServerInfo) as Promise<ServerInfo>,

  getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.getVersion) as Promise<string>,

  checkForUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.checkForUpdate) as Promise<UpdateStatus>,

  downloadUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.downloadUpdate) as Promise<void>,

  installUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.installUpdate) as Promise<void>,

  onUpdateStatus: (listener) => {
    // The raw IpcRendererEvent is deliberately not forwarded — it carries a `sender` the page
    // has no business holding.
    const handler = (_event: unknown, status: UpdateStatus): void => listener(status);
    ipcRenderer.on(IPC_CHANNELS.updateStatus, handler);
    return () => {
      ipcRenderer.off(IPC_CHANNELS.updateStatus, handler);
    };
  },
};

contextBridge.exposeInMainWorld('impressiveOcr', bridge);
