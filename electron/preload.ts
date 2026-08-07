/**
 * U1/U2: preload bridge. Sandboxed (sandbox: true) and context-isolated, so
 * this file must stay CJS-compatible and self-contained (only the `electron`
 * module is available). Exposes a whitelisted bridge — never raw ipcRenderer.
 *
 * The client-side `desktop-api.ts` bridge (U2) consumes exactly this surface;
 * every member must stay camelCase-aligned with the `ComateBridge` interface
 * there. Main-process handlers live in electron/main.ts.
 */

import { contextBridge, ipcRenderer } from 'electron';

export interface ComateApiInfo {
  port: number;
  token: string;
}

export interface DesktopNotificationOptions {
  title: string;
  body?: string;
}

/** U8: panel rect in window-relative CSS pixels (the UI view fills the window). */
export interface BrowserViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Renderer→main notification click relay. The main process re-emits
 * 'comate:notification-action' on the webContents when a notification is
 * clicked; the renderer handler is wrapped here so raw ipcRenderer never
 * crosses the contextBridge.
 */
function onNotificationAction(handler: () => void): Promise<void> {
  ipcRenderer.on('comate:notification-action', () => handler());
  return Promise.resolve();
}

const api = {
  /**
   * Port + per-boot desktop credential of the sidecar, captured from the
   * ready handshake. Rejects until the sidecar is up — the client bridge
   * keeps the 50×200ms retry semantics from tauri-api.ts.
   */
  getApiInfo: (): Promise<ComateApiInfo> => ipcRenderer.invoke('comate:get-api-info'),

  /** App.tsx parity: show + unminimize + focus the main window. */
  showWindow: (): Promise<void> => ipcRenderer.invoke('comate:show-window'),

  // Custom titlebar dragging has no IPC equivalent: Electron drags via CSS
  // `-webkit-app-region: drag` on the data-tauri-drag-region elements (see
  // src/client/index.css), so `startDragging` is intentionally not exposed.

  /** Dock badge / macOS accessory-policy toggle / Windows taskbar flash. */
  updateBadgeState: (count: number): Promise<void> =>
    ipcRenderer.invoke('comate:update-badge-state', count),

  /** Reveal a file or folder in the OS file manager. */
  revealInFileManager: (path: string): Promise<void> =>
    ipcRenderer.invoke('comate:reveal-in-file-manager', path),

  /** Open an http/https URL in the system browser (validated main-side). */
  openUrl: (url: string): Promise<void> => ipcRenderer.invoke('comate:open-url', url),

  /** Arms the shell's update quit grace before a relaunch. */
  prepareUpdaterRelaunch: (): Promise<void> =>
    ipcRenderer.invoke('comate:prepare-updater-relaunch'),

  /** package.json version of the shell. */
  getVersion: (): Promise<string> => ipcRenderer.invoke('comate:get-app-version'),

  dialog: {
    /** Native folder picker; resolves null when cancelled. */
    openDirectory: (): Promise<string | null> =>
      ipcRenderer.invoke('comate:open-directory-dialog'),
  },

  notifications: {
    isPermissionGranted: (): Promise<boolean> =>
      ipcRenderer.invoke('comate:notification-is-permission-granted'),
    requestPermission: (): Promise<boolean> =>
      ipcRenderer.invoke('comate:notification-request-permission'),
    send: (options: DesktopNotificationOptions): void => {
      void ipcRenderer.invoke('comate:notification-send', options);
    },
    onAction: onNotificationAction,
  },

  updater: {
    // U5: electron-updater. check resolves the update info (null = none);
    // download triggers the manual download with progress pushed over the
    // whitelisted 'comate:updater-download-event' channel (onDownloadEvent);
    // relaunch arms the shell's update grace then quitAndInstall.
    check: (): Promise<unknown | null> => ipcRenderer.invoke('comate:updater-check'),
    download: (): Promise<void> => ipcRenderer.invoke('comate:updater-download'),
    relaunch: (): Promise<void> => ipcRenderer.invoke('comate:updater-relaunch'),
    // Same wrapper pattern as notifications.onAction: raw ipcRenderer never
    // crosses the contextBridge; returns an unsubscribe function.
    onDownloadEvent: (handler: (event: unknown) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
        handler(payload);
      };
      ipcRenderer.on('comate:updater-download-event', listener);
      return () => {
        ipcRenderer.removeListener('comate:updater-download-event', listener);
      };
    },
  },

  // U8 (KTD-14): native browser view panel control. reportRect(null) hides
  // the view (pane collapsed / another surface hosts it); setOccluded hides
  // every browser view while a modal-level overlay covers the panel area;
  // onEscape fires when the shell intercepts Esc on a user-driven view and
  // returns focus to the panel frame.
  browserView: {
    reportRect: (sessionId: string, rect: BrowserViewRect | null): Promise<void> =>
      ipcRenderer.invoke('comate:browser-view-report-rect', sessionId, rect),
    setInputMode: (sessionId: string, mode: 'user' | 'agent'): Promise<void> =>
      ipcRenderer.invoke('comate:browser-view-input-mode', sessionId, mode),
    setOccluded: (occluded: boolean): Promise<void> =>
      ipcRenderer.invoke('comate:browser-view-occluded', occluded),
    setOcclusionExemption: (sessionId: string | null): Promise<void> =>
      ipcRenderer.invoke('comate:browser-view-occlusion-exemption', sessionId),
    // Same wrapper pattern as notifications.onAction: raw ipcRenderer never
    // crosses the contextBridge; returns an unsubscribe function.
    onEscape: (handler: (sessionId: string) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, sessionId: unknown): void => {
        if (typeof sessionId === 'string') handler(sessionId);
      };
      ipcRenderer.on('comate:browser-view-escape', listener);
      return () => {
        ipcRenderer.removeListener('comate:browser-view-escape', listener);
      };
    },
  },
};

contextBridge.exposeInMainWorld('comate', api);
