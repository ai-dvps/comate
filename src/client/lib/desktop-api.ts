/**
 * U2: single Electron bridge entry. All renderer access to shell capabilities
 * goes through this module; tests mock this one module instead of the old
 * per-package `@tauri-apps/*` boundary mocks.
 *
 * The preload (electron/preload.ts) exposes a whitelisted `window.comate`
 * surface via contextBridge — never raw ipcRenderer. Members beyond
 * `getApiInfo`/`showWindow` are optional until the preload exposes them, so
 * every call site degrades the way the Tauri client did when the bridge (or
 * the capability) is missing: `window.open` for external links, no-op badge,
 * rejected reveal/notification promises that callers already catch, etc.
 */

export interface ComateApiInfo {
  port: number;
  token: string;
}

/** Mirrors the old plugin-updater DownloadEvent so updater-api stays unchanged. */
export type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

/**
 * Plain-data update info as returned over IPC by the shell's
 * `comate:updater-check` handler (a DesktopUpdate handle cannot cross IPC —
 * the `downloadAndInstall` closure is reconstructed client-side below).
 */
export interface DesktopUpdateInfo {
  currentVersion: string;
  version: string;
  body?: string;
  date?: string;
}

/** Mirrors the old plugin-updater Update handle. */
export interface DesktopUpdate extends DesktopUpdateInfo {
  downloadAndInstall(onEvent?: (event: DownloadEvent) => void): Promise<void>;
}

/**
 * The `window.comate` surface exposed by electron/preload.ts. Everything
 * except getApiInfo is optional: the preload exposes capabilities as the
 * Electron shell units land (dialog/notification in lockstep with U2,
 * updater in U5), and the client must keep working in the meantime.
 */
export interface ComateBridge {
  getApiInfo: () => Promise<ComateApiInfo>;
  showWindow?: () => Promise<void>;
  startDragging?: () => Promise<void>;
  updateBadgeState?: (count: number) => Promise<void>;
  revealInFileManager?: (path: string, itemType: 'file' | 'folder') => Promise<void>;
  openUrl?: (url: string) => Promise<void>;
  prepareUpdaterRelaunch?: () => Promise<void>;
  getVersion?: () => Promise<string>;
  dialog?: {
    openDirectory?: () => Promise<string | null>;
  };
  notifications?: {
    isPermissionGranted?: () => Promise<boolean>;
    requestPermission?: () => Promise<boolean>;
    send?: (options: { title: string; body?: string }) => void;
    onAction?: (handler: () => void) => Promise<unknown>;
  };
  updater?: {
    check?: () => Promise<DesktopUpdateInfo | null>;
    download?: () => Promise<void>;
    relaunch?: () => Promise<void>;
    /** Subscribes to shell-pushed download events; returns an unsubscribe. */
    onDownloadEvent?: (handler: (event: DownloadEvent) => void) => () => void;
  };
}

interface ComateWindow extends Window {
  comate?: ComateBridge;
}

function getBridge(): ComateBridge | null {
  if (typeof window === 'undefined') return null;
  return (window as ComateWindow).comate ?? null;
}

/** Bridge detection: true inside the Electron shell, false in a plain browser. */
export function isDesktop(): boolean {
  return getBridge() !== null;
}

function unsupported(capability: string): Error {
  return new Error(`Desktop bridge capability unavailable: ${capability}`);
}

// ---------------------------------------------------------------------------
// Sidecar API coordinates (port + desktop token), 50×200ms retry semantics
// carried over from tauri-api.ts: the shell rejects getApiInfo until the
// sidecar ready handshake lands.
// ---------------------------------------------------------------------------

const RETRY_COUNT = 50;
const RETRY_DELAY_MS = 200;

async function resolveApiInfoWithRetry(): Promise<ComateApiInfo | null> {
  const bridge = getBridge();
  if (!bridge?.getApiInfo) return null;
  for (let attempt = 0; attempt < RETRY_COUNT; attempt++) {
    try {
      return await bridge.getApiInfo();
    } catch {
      // sidecar not ready yet
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  return null;
}

let apiInfoPromise: Promise<ComateApiInfo | null> | null = null;

export function getApiInfo(): Promise<ComateApiInfo | null> {
  if (!apiInfoPromise) {
    apiInfoPromise = resolveApiInfoWithRetry();
  }
  return apiInfoPromise;
}

export async function getApiBase(): Promise<string> {
  const info = await getApiInfo();
  return info ? `http://localhost:${info.port}` : '';
}

/**
 * U12 (KTD-28): the desktop GUI credential. Minted per sidecar boot, handed
 * to the shell via the sidecar ready message, and injected here into every
 * /api request. It is never exposed to sandboxed sessions — bot sessions
 * authenticate with their own per-session capability tokens.
 */
export async function getApiToken(): Promise<string> {
  const info = await getApiInfo();
  return info?.token ?? '';
}

export async function getWebSocketUrl(): Promise<string> {
  const base = await getApiBase();
  if (!base) return '';
  return base.replace(/^http/, 'ws') + '/ws';
}

export function initDesktopApi(): void {
  if (!isDesktop()) return;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/api')) {
      const base = await getApiBase();
      if (base) {
        input = `${base}${input}`;
        const token = await getApiToken();
        if (token) {
          const headers = new Headers(init?.headers);
          if (!headers.has('Authorization')) {
            headers.set('Authorization', `Bearer ${token}`);
          }
          init = { ...init, headers };
        }
      }
    }
    return originalFetch(input, init);
  };
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

/** App.tsx parity: show + unminimize + focus the main window. */
export async function showWindow(): Promise<void> {
  await getBridge()?.showWindow?.();
}

/**
 * Custom titlebar dragging. Electron drags via CSS `-webkit-app-region: drag`
 * (shell-side); the optional bridge hook exists for parity with the old
 * startDragging call and is a no-op when not exposed.
 */
export async function startWindowDrag(): Promise<void> {
  await getBridge()?.startDragging?.();
}

// ---------------------------------------------------------------------------
// Shell capabilities
// ---------------------------------------------------------------------------

/** Dock/taskbar badge. No-op outside the shell (badge is desktop-only). */
export async function updateBadgeState(count: number): Promise<void> {
  await getBridge()?.updateBadgeState?.(count);
}

/** Reveal a file or folder in the OS file manager. Rejects without the bridge. */
export async function revealInFileManager(
  path: string,
  itemType: 'file' | 'folder',
): Promise<void> {
  const bridge = getBridge();
  if (!bridge?.revealInFileManager) throw unsupported('revealInFileManager');
  await bridge.revealInFileManager(path, itemType);
}

/**
 * Open an http/https URL in the system browser. Rejects without the bridge;
 * callers (open-url.ts) keep the scheme validation and the window.open
 * fallback for plain browsers.
 */
export async function openExternal(url: string): Promise<void> {
  const bridge = getBridge();
  if (!bridge?.openUrl) throw unsupported('openUrl');
  await bridge.openUrl(url);
}

/** Native folder picker. Resolves null without the bridge (dialog cancelled/absent). */
export async function openDirectoryDialog(): Promise<string | null> {
  const bridge = getBridge();
  if (!bridge?.dialog?.openDirectory) return null;
  return bridge.dialog.openDirectory();
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export async function isNotificationPermissionGranted(): Promise<boolean> {
  const bridge = getBridge();
  if (!bridge?.notifications?.isPermissionGranted) throw unsupported('notifications');
  return bridge.notifications.isPermissionGranted();
}

export async function requestNotificationPermission(): Promise<boolean> {
  const bridge = getBridge();
  if (!bridge?.notifications?.requestPermission) throw unsupported('notifications');
  return bridge.notifications.requestPermission();
}

export function sendDesktopNotification(options: { title: string; body?: string }): void {
  const bridge = getBridge();
  if (!bridge?.notifications?.send) throw unsupported('notifications');
  bridge.notifications.send(options);
}

export async function onNotificationAction(handler: () => void): Promise<void> {
  const bridge = getBridge();
  if (!bridge?.notifications?.onAction) throw unsupported('notifications');
  await bridge.notifications.onAction(handler);
}

// ---------------------------------------------------------------------------
// Updater (U5: the shell resolves plain update info over IPC; the
// plugin-updater-style DesktopUpdate handle is reconstructed here so
// updater-api.ts and its consumers stay unchanged)
// ---------------------------------------------------------------------------

export async function checkForUpdate(): Promise<DesktopUpdate | null> {
  const bridge = getBridge();
  if (!bridge?.updater?.check) return null;
  const info = await bridge.updater.check();
  if (!info) return null;
  return {
    currentVersion: info.currentVersion,
    version: info.version,
    body: info.body,
    date: info.date,
    downloadAndInstall: async (onEvent) => {
      const updater = bridge.updater;
      if (!updater?.download) throw unsupported('updater.download');
      const unsubscribe =
        onEvent && updater.onDownloadEvent ? updater.onDownloadEvent(onEvent) : undefined;
      try {
        await updater.download();
      } finally {
        unsubscribe?.();
      }
    },
  };
}

/** Arms the shell's update grace period; no-op when not exposed yet. */
export async function prepareUpdaterRelaunch(): Promise<void> {
  await getBridge()?.prepareUpdaterRelaunch?.();
}

export async function relaunchApp(): Promise<void> {
  const bridge = getBridge();
  if (!bridge?.updater?.relaunch) throw unsupported('updater.relaunch');
  await bridge.updater.relaunch();
}

export async function getAppVersion(): Promise<string | null> {
  const bridge = getBridge();
  if (!bridge?.getVersion) return null;
  try {
    return await bridge.getVersion();
  } catch {
    return null;
  }
}
