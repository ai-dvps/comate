/**
 * U1: preload bridge. Sandboxed (sandbox: true) and context-isolated, so this
 * file must stay CJS-compatible and self-contained (only the `electron`
 * module is available). Exposes a whitelisted bridge — never raw ipcRenderer.
 *
 * U2 will build the client-side `desktop-api.ts` bridge on top of this
 * surface and migrate all `@tauri-apps/*` consumers onto it.
 */

import { contextBridge, ipcRenderer } from 'electron';

export interface ComateApiInfo {
  port: number;
  token: string;
}

const api = {
  /**
   * Port + per-boot desktop credential of the sidecar, captured from the
   * ready handshake. Rejects until the sidecar is up — the client bridge
   * keeps the 50×200ms retry semantics (tauri-api.ts) in U2.
   */
  getApiInfo: (): Promise<ComateApiInfo> => ipcRenderer.invoke('comate:get-api-info'),

  /** App.tsx parity: show + unminimize + focus the main window. */
  showWindow: (): Promise<void> => ipcRenderer.invoke('comate:show-window'),

  // TODO(U2): expose the remaining shell commands once the client bridge
  // layer lands — the main-process handlers already exist:
  //   updateBadgeState(count)            -> 'comate:update-badge-state'
  //   revealInFileManager(path, itemType)-> 'comate:reveal-in-file-manager'
  //   openUrl(url)                       -> 'comate:open-url'
  //   prepareUpdaterRelaunch()           -> 'comate:prepare-updater-relaunch'
  // TODO(U2): custom titlebar dragging — Tauri's startDragging() has no IPC
  // equivalent; Electron uses CSS `-webkit-app-region: drag`.
  // TODO(U5): updater methods (check/download/install) once electron-updater
  // is wired.
};

contextBridge.exposeInMainWorld('comate', api);
