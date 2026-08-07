/**
 * U1: system tray — a behavioral port of lib.rs:226-326 (menu layout, status
 * labels, 5s status poller with the desktop Bearer credential).
 *
 * The module is electron-free: `createTray` receives Electron's `Tray`/`Menu`
 * constructors by injection from main.ts, so the menu model, label mapping,
 * and poller stay unit-testable under plain node:test.
 */

import type { Menu as ElectronMenu, MenuItemConstructorOptions, NativeImage, Tray as ElectronTray } from 'electron';

export interface TrayStatus {
  wecomBot: string;
  activeSessions: number;
}

/** lib.rs:234-241 — exact label mapping. */
export function botStatusLabel(state: string): string {
  switch (state) {
    case 'connected':
      return 'WeCom bot: connected';
    case 'partial':
      return 'WeCom bot: partially connected';
    case 'disconnected':
      return 'WeCom bot: disconnected';
    default:
      return 'WeCom bot: not configured';
  }
}

export interface TrayMenuItemModel {
  id: 'open' | 'bot_status' | 'session_count' | 'separator' | 'quit';
  label: string;
  enabled: boolean;
}

/** lib.rs:437-457 — Open / bot status / session count / separator / Quit. */
export function buildTrayMenuModel(status: TrayStatus | null): TrayMenuItemModel[] {
  return [
    { id: 'open', label: 'Open Comate', enabled: true },
    {
      id: 'bot_status',
      label: status ? botStatusLabel(status.wecomBot) : 'WeCom bot: …',
      enabled: false,
    },
    {
      id: 'session_count',
      label: status ? `Active sessions: ${status.activeSessions}` : 'Active sessions: …',
      enabled: false,
    },
    { id: 'separator', label: '', enabled: false },
    { id: 'quit', label: 'Quit Comate', enabled: true },
  ];
}

/** lib.rs:243-250 — loopback GET carrying the per-boot desktop credential. */
export async function fetchTrayStatus(
  port: number,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TrayStatus> {
  const response = await fetchImpl(`http://127.0.0.1:${port}/api/system/tray-status`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) {
    throw new Error(`tray-status request failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as Partial<TrayStatus>;
  return {
    wecomBot: typeof body.wecomBot === 'string' ? body.wecomBot : '',
    activeSessions: typeof body.activeSessions === 'number' ? body.activeSessions : 0,
  };
}

export interface TrayStatusPollerOptions {
  getPort: () => number | null;
  getToken: () => string | null;
  isShuttingDown: () => boolean;
  onStatus: (status: TrayStatus) => void;
  logger: { debug?(message: string): void; info?(message: string): void; error?(message: string): void };
  /** lib.rs TRAY_POLL_INTERVAL — 5s. Injectable for tests. */
  intervalMs?: number;
  fetchImpl?: typeof fetch;
}

export interface TrayStatusPoller {
  stop(): void;
}

/** lib.rs:273-326 — poll until shutdown; skip silently while port/token are unknown. */
export function runTrayStatusPoller(options: TrayStatusPollerOptions): TrayStatusPoller {
  const intervalMs = options.intervalMs ?? 5000;
  let stopped = false;
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (stopped || options.isShuttingDown()) {
      stopped = true;
      clearInterval(timer);
      return;
    }
    // Skip ticks while the previous fetch hasn't settled (a hung poll delivers
    // nothing either way; this keeps slow polls from stacking up).
    if (inFlight) return;
    const port = options.getPort();
    const token = options.getToken();
    if (port == null || token == null) return;
    inFlight = true;
    try {
      const status = await fetchTrayStatus(port, token, options.fetchImpl ?? fetch);
      if (!stopped && !options.isShuttingDown()) options.onStatus(status);
    } catch (err) {
      options.logger.debug?.(
        `Tray status fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export type WindowCloseAction = 'close' | 'hide-to-tray' | 'quit';

/**
 * Decide what closing the main window does (U10). Close-to-tray hiding is
 * the default (lib.rs close-to-hide), but with no tray — creation failed,
 * realistic on Linux desktops without a status notifier host — a hidden
 * window could only be recovered via a second-instance relaunch, so close
 * degrades to quitting the app and the app stays usable on minimal WMs.
 */
export function resolveWindowCloseAction(quitting: boolean, hasTray: boolean): WindowCloseAction {
  if (quitting) return 'close';
  return hasTray ? 'hide-to-tray' : 'quit';
}

// ---------------------------------------------------------------------------
// Electron wiring (constructors injected by main.ts so this module stays
// importable from node:test)
// ---------------------------------------------------------------------------

export interface CreateTrayOptions {
  TrayClass: typeof ElectronTray;
  MenuClass: typeof ElectronMenu;
  icon: NativeImage;
  onOpen: () => void;
  onQuit: () => void;
  logger: { info(message: string): void; error(message: string): void };
}

export interface TrayHandle {
  updateStatus(status: TrayStatus | null): void;
  destroy(): void;
}

/**
 * Build the tray from the menu model. Menu clicks: Open shows/focuses the
 * main window; Quit runs the shutdown path. The two status items are disabled
 * (read-only labels), updated by the poller via `updateStatus`.
 *
 * Tray creation can fail on Linux desktops without a status notifier host —
 * callers treat a thrown error as non-fatal (lib.rs:494-499).
 */
export function createTray(options: CreateTrayOptions): TrayHandle {
  const { TrayClass, MenuClass } = options;
  const tray = new TrayClass(options.icon);

  const clickHandlers: Partial<Record<TrayMenuItemModel['id'], () => void>> = {
    open: options.onOpen,
    quit: options.onQuit,
  };

  const templateFor = (status: TrayStatus | null): MenuItemConstructorOptions[] =>
    buildTrayMenuModel(status).map((item) => {
      if (item.id === 'separator') return { type: 'separator' as const };
      return {
        id: item.id,
        label: item.label,
        enabled: item.enabled,
        click: clickHandlers[item.id],
      };
    });

  // The 5s poller feeds updateStatus for the app's lifetime, but the labels
  // rarely change — skip the Menu rebuild when the status is unchanged.
  let lastAppliedStatus: TrayStatus | null | undefined;

  const applyMenu = (status: TrayStatus | null): void => {
    if (lastAppliedStatus !== undefined && sameTrayStatus(lastAppliedStatus, status)) return;
    lastAppliedStatus = status;
    tray.setContextMenu(MenuClass.buildFromTemplate(templateFor(status)));
  };

  applyMenu(null);
  tray.setToolTip('Comate');

  return {
    updateStatus: (status) => applyMenu(status),
    destroy: () => tray.destroy(),
  };
}

function sameTrayStatus(a: TrayStatus | null, b: TrayStatus | null): boolean {
  if (a === null || b === null) return a === b;
  return a.wecomBot === b.wecomBot && a.activeSessions === b.activeSessions;
}
