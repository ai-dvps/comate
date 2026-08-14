/**
 * U8 (KTD-10/KTD-14/KTD-16): the shell's browser view manager — the real
 * Electron-facing implementation behind the control channel's
 * ControlViewManager surface (moved out of control-server.ts in U8) plus the
 * panel-facing behavior the renderer drives over IPC:
 *
 *  - window attach + bounds: views are created unattached (U7) and attach to
 *    the main window's contentView once the panel reports its rect; rect
 *    reports are window-relative CSS pixels (the UI view fills the window);
 *  - occlusion (KTD-14): a single global flag hides every browser view while
 *    a modal-level overlay covers the panel area; the panel keeps rendering
 *    its backdrop behind the hidden view;
 *  - input gating (KTD-14): WebContentsView has no setIgnoreMouseEvents, so
 *    agent mode layers a transparent shield view over the page view (and its
 *    popups) — pointer input dies on the shield (and still pings activity,
 *    like the iframe stack's React read-only shield), keystrokes are
 *    swallowed via before-input-event, and the view is blurred back to the
 *    UI; user mode hides the shield and passes input through, intercepting
 *    only Esc to return focus to the panel frame;
 *  - activity (KTD-14): view input events are throttled into view-activity
 *    SSE events (replaces the iframe's React pointer reporting);
 *  - popups (KTD-14 OAuth decision): window.open from a browser view becomes
 *    a second managed WebContentsView in the SAME partition, overlaid on the
 *    panel area — subject to the same bounds/occlusion/gating rules, never an
 *    OS window;
 *  - last-URL tracking: did-navigate events feed view-navigated SSE events so
 *    the sidecar can rebuild a session_lost view onto its last page (the
 *    partition survives, login state kept);
 *  - orphan partition reconciliation (KTD-11): persist:comate-browser-*
 *    partition dirs not present in the sidecar's session registry are deleted
 *    (the pidfile/SingletonLock cleanup semantic translated to partitions).
 *
 * The module stays electron-free (the control-server.ts / tray.ts pattern):
 * all Electron objects arrive via injected factories so node:test drives fakes.
 */

import { join } from 'node:path';
import { readdir, rm } from 'node:fs/promises';
import type { ControlEvent, ControlViewManager, ControlViewState, ViewRect } from './control-server';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BrowserViewInputMode = 'user' | 'agent';

/** E2E/attestation surface (GET /views/:id/state on the control channel). */
export type BrowserViewState = ControlViewState;

interface ElectronSessionLike {
  setPermissionRequestHandler(
    handler: ((webContents: unknown, permission: string, callback: (granted: boolean) => void) => void) | null,
  ): void;
  setPermissionCheckHandler(
    handler: ((webContents: unknown, permission: string, requestingOrigin: string, details: unknown) => boolean) | null,
  ): void;
  clearStorageData(): Promise<void>;
  clearCache(): Promise<void>;
}

interface ElectronWebContentsLike {
  loadURL(url: string): Promise<void>;
  on(event: string, listener: (...args: never[]) => void): void;
  destroy(): void;
  isDestroyed(): boolean;
  focus(): void;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'allow' | 'deny' }): void;
  getLastWebPreferences(): Record<string, unknown>;
}

interface ElectronViewLike {
  webContents: ElectronWebContentsLike;
  setBounds(rect: ViewRect): void;
  setVisible(visible: boolean): void;
  /** Present on real WebContentsView (View.setBackgroundColor). */
  setBackgroundColor?(color: string): void;
}

/** The slice of BrowserWindow the manager drives (injected, fakeable). */
export interface HostWindowLike {
  contentView: {
    addChildView(view: ElectronViewLike): void;
    removeChildView(view: ElectronViewLike): void;
  };
  webContents: {
    focus(): void;
    send(channel: string, ...args: unknown[]): void;
  };
  isDestroyed(): boolean;
}

export interface BrowserViewManagerDeps {
  /** `(opts) => new WebContentsView(opts)` — injected to keep electron out of unit tests. */
  createViewImpl: (options: { webPreferences: Record<string, unknown> }) => ElectronViewLike;
  /** `session.fromPartition` equivalent. */
  sessionFromPartition: (partition: string) => ElectronSessionLike;
  /** Sink for view lifecycle events (wired to the control server's SSE emit). */
  onEvent: (event: ControlEvent) => void;
  /** The window browser views attach to (null before creation / after close). */
  hostWindow: () => HostWindowLike | null;
  /** `<userData>/Partitions` — the on-disk home of persist:* partitions. */
  partitionsDir: () => string;
  /** Esc on a user-driven view: notify the renderer to reclaim panel focus. */
  onEscape?: (sessionId: string) => void;
  /** view-activity throttle (KTD-14: 取代 iframe 的 React 指针上报节奏). */
  activityThrottleMs?: number;
  /** fs seams for tests. */
  listDir?: (dir: string) => Promise<string[]>;
  removeDir?: (dir: string) => Promise<void>;
  logger?: {
    warn?(message: string): void;
  };
}

export type BrowserViewManager = ControlViewManager & {
  /** Main-process placement authority: select the window that owns a session. */
  setViewHost(sessionId: string, host: HostWindowLike | null): void;
  /** Current live owner, used by the detached-window controller and IPC guard. */
  getViewHost(sessionId: string): HostWindowLike | null;
  /** Renderer rect report accepted only when `host` currently owns the session. */
  setViewBoundsFromHost(
    sessionId: string,
    host: HostWindowLike,
    rect: ViewRect | null,
  ): Promise<boolean>;
  /** Renderer-driven input gating (KTD-14). */
  setInputMode(sessionId: string, mode: BrowserViewInputMode): void;
  /** Global modal-occlusion flag: hides every browser view while set. */
  setOccluded(occluded: boolean): void;
  /** Renderer modal occlusion, scoped to views owned by that host. */
  setHostOccluded(host: HostWindowLike, occluded: boolean): void;
  /**
   * U9: one session exempt from modal occlusion — the usage-login modal hosts
   * its capture session's view INSIDE the modal. Null clears the exemption.
   */
  setOcclusionExemption(sessionId: string | null): void;
  /** Attestation snapshot; null when the session has no live view. */
  getViewState(sessionId: string): BrowserViewState | null;
  /** KTD-11 reconciliation: delete partition dirs absent from `keep`. */
  reconcilePartitions(keep: string[]): Promise<{ removed: string[]; errors: string[] }>;
  /** Quit path: destroy every live view (best-effort). */
  destroyAll(): Promise<void>;
  /** Test/attestation hook: live view count (parents; shields/popups follow). */
  size(): number;
};

/** Locked webPreferences for browser views AND their same-partition popups (KTD-16). */
const VIEW_WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  // No preload — ever. A preload would bridge Node/Electron into untrusted pages.
} as const;

const DEFAULT_ACTIVITY_THROTTLE_MS = 15_000;
const PARTITION_DIR_PREFIX = 'comate-browser-';
/**
 * Cap on concurrent managed popup overlays per session: agent-driven pages
 * are untrusted and can loop window.open, and each popup is a full
 * WebContentsView. 8 comfortably covers 1-2-deep OAuth chains.
 */
const MAX_POPUPS_PER_SESSION = 8;
/** The agent-mode shield paints nothing — it only eats pointer events. */
const SHIELD_BACKGROUND = '#00000000';
/**
 * Bounds for unattached views: a zero-area view cannot produce screenshots
 * (no compositor surface) and several CDP layout paths misbehave; the panel
 * rect replaces this on attach.
 */
const DEFAULT_VIEW_RECT: ViewRect = { x: 0, y: 0, width: 1280, height: 800 };

interface PopupRecord {
  view: ElectronViewLike;
  attachedHost: HostWindowLike | null;
}

interface ViewRecord {
  view: ElectronViewLike;
  /** Transparent overlay above the page (and popups) while agent-driven. */
  shield: ElectronViewLike;
  attachedHost: HostWindowLike | null;
  visible: boolean;
  shieldVisible: boolean;
  bounds: ViewRect | null;
  inputMode: BrowserViewInputMode;
  popups: Set<PopupRecord>;
  lastActivityAt: number;
  lastUrl: string | null;
}

/**
 * Per-session browser views (KTD-10): one WebContentsView per chat session on
 * `persist:comate-browser-<sessionId>`. Each view loads `about:blank#<marker>`
 * so the sidecar can find its CDP page target on the debug port before the
 * first real navigation. Views attach to the host window when the panel
 * reports a rect (U8) — an unattached view has no compositor surface, so CDP
 * screenshots only work once the panel is showing.
 */
export function createBrowserViewManager(deps: BrowserViewManagerDeps): BrowserViewManager {
  const views = new Map<string, ViewRecord>();
  /** Legacy/control-channel rect per session — survives view rebuilds. */
  const desiredRects = new Map<string, ViewRect | null>();
  /** Explicit shell-owned host. Absence means the default main-window host. */
  const viewHosts = new Map<string, HostWindowLike | null>();
  /** Renderer reports are retained per host so a host switch cannot reuse another window's rect. */
  const hostRects = new Map<string, Map<HostWindowLike, ViewRect | null>>();
  /** Modal occlusion belongs to the reporting application window. */
  const hostOcclusion = new Map<HostWindowLike, boolean>();
  const partitions = new Map<string, ElectronSessionLike>();
  let occluded = false;
  /** U9: session exempt from modal occlusion (modal-hosted capture view). */
  let occlusionExemptSessionId: string | null = null;
  const activityThrottleMs = deps.activityThrottleMs ?? DEFAULT_ACTIVITY_THROTTLE_MS;
  const listDir = deps.listDir ?? ((dir: string) => readdir(dir));
  const removeDir = deps.removeDir ?? ((dir: string) => rm(dir, { recursive: true, force: true }).then(() => undefined));

  const partitionName = (sessionId: string): string => `persist:comate-browser-${sessionId}`;
  const sessionFor = (sessionId: string): ElectronSessionLike => {
    let ses = partitions.get(sessionId);
    if (!ses) {
      ses = deps.sessionFromPartition(partitionName(sessionId));
      // Deny-by-default permission policy for untrusted web content (plan
      // System-Wide Impact auth boundary).
      ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      ses.setPermissionCheckHandler(() => false);
      partitions.set(sessionId, ses);
    }
    return ses;
  };

  const defaultHost = (): HostWindowLike | null => {
    const host = deps.hostWindow();
    return host && !host.isDestroyed() ? host : null;
  };

  const hostFor = (sessionId: string): HostWindowLike | null => {
    const host = viewHosts.has(sessionId) ? viewHosts.get(sessionId) ?? null : defaultHost();
    return host && !host.isDestroyed() ? host : null;
  };

  const rectFor = (sessionId: string, host: HostWindowLike | null): ViewRect | null => {
    if (host && viewHosts.has(sessionId)) {
      return hostRects.get(sessionId)?.get(host) ?? null;
    }
    return desiredRects.get(sessionId) ?? null;
  };

  const trackNavigation = (record: ViewRecord, sessionId: string, url: unknown): void => {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return;
    record.lastUrl = url;
    deps.onEvent({ type: 'view-navigated', sessionId, url, at: Date.now() });
  };

  const trackActivity = (record: ViewRecord, sessionId: string): void => {
    const now = Date.now();
    if (now - record.lastActivityAt < activityThrottleMs) return;
    record.lastActivityAt = now;
    deps.onEvent({ type: 'view-activity', sessionId, at: now });
  };

  const wireInput = (view: ElectronViewLike, record: ViewRecord, sessionId: string): void => {
    const { webContents } = view;
    // Keyboard gating (KTD-14): agent-driven pages never see user keystrokes;
    // user-driven pages give Esc back to the panel frame.
    webContents.on('before-input-event', ((event: { preventDefault(): void }, input: { type?: string; key?: string }) => {
      if (record.inputMode === 'agent') {
        event.preventDefault();
        return;
      }
      if (input.type === 'keyDown' && input.key === 'Escape') {
        // Esc returns focus to the panel frame (keyboard contract parity with
        // the iframe viewer's release-capture path).
        event.preventDefault();
        record.attachedHost?.webContents.focus();
        deps.onEscape?.(sessionId);
      }
    }) as never);
    // Activity forwarding (KTD-14): input that reaches the page throttles
    // into a content-free view-activity event for the idle-reclaim clock.
    webContents.on('input-event', (() => trackActivity(record, sessionId)) as never);
    webContents.on('did-navigate', ((_event: unknown, url: unknown) => {
      trackNavigation(record, sessionId, url);
    }) as never);
    webContents.on('did-navigate-in-page', ((_event: unknown, url: unknown) => {
      trackNavigation(record, sessionId, url);
    }) as never);
  };

  /** The shield sits above every popup too — re-raise after stacking changes. */
  const raiseShield = (record: ViewRecord): void => {
    if (!record.attachedHost) return;
    try {
      record.attachedHost.contentView.removeChildView(record.shield);
      record.attachedHost.contentView.addChildView(record.shield);
    } catch {
      // host already gone
    }
  };

  const detachHierarchy = (record: ViewRecord): void => {
    const host = record.attachedHost;
    if (!host) return;
    record.view.setVisible(false);
    record.shield.setVisible(false);
    record.visible = false;
    record.shieldVisible = false;
    for (const popup of record.popups) popup.view.setVisible(false);
    for (const view of [record.shield, ...[...record.popups].map((popup) => popup.view), record.view]) {
      try {
        host.contentView.removeChildView(view);
      } catch {
        // host already gone
      }
    }
    for (const popup of record.popups) popup.attachedHost = null;
    record.attachedHost = null;
  };

  const attachHierarchy = (record: ViewRecord, host: HostWindowLike): void => {
    host.contentView.addChildView(record.view);
    for (const popup of record.popups) {
      host.contentView.addChildView(popup.view);
      popup.attachedHost = host;
    }
    // The input gate must always be the final/top-most child.
    host.contentView.addChildView(record.shield);
    record.attachedHost = host;
  };

  const openPopup = (record: ViewRecord, sessionId: string, url: string): void => {
    const host = record.attachedHost ?? hostFor(sessionId);
    if (!host) return; // no window — nothing to overlay onto
    if (record.popups.size >= MAX_POPUPS_PER_SESSION) {
      // Refuse past the cap (the window.open handler already denies the
      // default action, so this is silent to the page).
      deps.logger?.warn?.(
        `[browser-view] refusing popup for session ${sessionId}: cap of ${MAX_POPUPS_PER_SESSION} reached`,
      );
      return;
    }
    const popupView = deps.createViewImpl({
      webPreferences: { ...VIEW_WEB_PREFERENCES, partition: partitionName(sessionId) },
    });
    const popup: PopupRecord = { view: popupView, attachedHost: null };
    record.popups.add(popup);
    wireInput(popupView, record, sessionId);
    // Nested popups (OAuth chains) land in the same managed overlay scheme.
    popupView.webContents.setWindowOpenHandler(({ url: nested }) => {
      if (!/^https?:\/\//.test(nested)) return { action: 'deny' };
      openPopup(record, sessionId, nested);
      return { action: 'deny' };
    });
    popupView.webContents.on('destroyed', (() => {
      if (popup.attachedHost) {
        try {
          popup.attachedHost.contentView.removeChildView(popupView);
        } catch {
          // host already gone
        }
        popup.attachedHost = null;
      }
      record.popups.delete(popup);
    }) as never);
    if (record.attachedHost === host) {
      host.contentView.addChildView(popupView);
      popup.attachedHost = host;
    }
    popupView.setBounds(record.bounds ?? rectFor(sessionId, host) ?? DEFAULT_VIEW_RECT);
    popupView.setVisible(record.visible && popup.attachedHost !== null);
    if (record.shieldVisible) raiseShield(record);
    void popupView.webContents.loadURL(url).catch(() => {
      if (!popupView.webContents.isDestroyed()) popupView.webContents.destroy();
    });
  };

  /** Recompute one session's attach/visibility/bounds from the current inputs. */
  const applyLayout = (sessionId: string): void => {
    const record = views.get(sessionId);
    if (!record) return;
    const host = hostFor(sessionId);
    const rect = rectFor(sessionId, host);
    if (record.attachedHost && record.attachedHost !== host) detachHierarchy(record);
    const hostIsOccluded = host ? hostOcclusion.get(host) === true : false;
    const shouldShow =
      (!occluded && !hostIsOccluded || sessionId === occlusionExemptSessionId) &&
      rect !== null &&
      rect.width > 0 &&
      rect.height > 0 &&
      host !== null;
    if (shouldShow && rect && host) {
      if (!record.attachedHost) attachHierarchy(record, host);
      record.view.setBounds(rect);
      record.shield.setBounds(rect);
      record.bounds = rect;
      if (!record.visible) {
        record.view.setVisible(true);
        record.visible = true;
      }
      const shieldShouldShow = record.inputMode === 'agent';
      if (record.shieldVisible !== shieldShouldShow) {
        record.shield.setVisible(shieldShouldShow);
        record.shieldVisible = shieldShouldShow;
      }
      for (const popup of record.popups) {
        popup.view.setBounds(rect);
        popup.view.setVisible(true);
      }
      if (record.shieldVisible && record.popups.size > 0) raiseShield(record);
    } else if (record.visible) {
      record.view.setVisible(false);
      record.visible = false;
      record.shield.setVisible(false);
      record.shieldVisible = false;
      for (const popup of record.popups) {
        popup.view.setVisible(false);
      }
    }
  };

  const applyLayoutAll = (): void => {
    for (const sessionId of views.keys()) applyLayout(sessionId);
  };

  const destroyRecord = (record: ViewRecord): void => {
    for (const popup of [...record.popups]) {
      if (!popup.view.webContents.isDestroyed()) popup.view.webContents.destroy();
    }
    record.popups.clear();
    if (record.attachedHost) detachHierarchy(record);
    if (!record.shield.webContents.isDestroyed()) record.shield.webContents.destroy();
    if (!record.view.webContents.isDestroyed()) record.view.webContents.destroy();
  };

  return {
    size: () => views.size,

    async createView({ sessionId, marker }) {
      if (views.has(sessionId)) {
        throw new Error(`browser view already exists for session ${sessionId}`);
      }
      const partition = partitionName(sessionId);
      // Install the deny-by-default permission policy on the partition before
      // any document loads in it.
      sessionFor(sessionId);
      const view = deps.createViewImpl({
        webPreferences: { ...VIEW_WEB_PREFERENCES, partition },
      });
      // The agent-mode pointer shield: an in-memory-session overlay that eats
      // mouse input above the page (WebContentsView has no
      // setIgnoreMouseEvents). Keyboard gating is before-input-event below.
      const shield = deps.createViewImpl({
        webPreferences: { ...VIEW_WEB_PREFERENCES },
      });
      shield.setBackgroundColor?.(SHIELD_BACKGROUND);
      const { webContents } = view;
      const record: ViewRecord = {
        view,
        shield,
        attachedHost: null,
        visible: false,
        shieldVisible: false,
        bounds: null,
        // Safe default: gated until the panel reports user_in_control.
        inputMode: 'agent',
        popups: new Set(),
        lastActivityAt: 0,
        lastUrl: null,
      };
      // Unattached but sized (DEFAULT_VIEW_RECT); the panel rect replaces
      // this on attach.
      view.setBounds(DEFAULT_VIEW_RECT);
      view.setVisible(false);
      shield.setBounds(DEFAULT_VIEW_RECT);
      shield.setVisible(false);
      // Shield clicks never reach a page; they still count as activity
      // (parity with the iframe stack's read-only shield pointerdown ping).
      shield.webContents.on('input-event', (() => trackActivity(record, sessionId)) as never);
      shield.webContents.on('before-input-event', ((event: { preventDefault(): void }) => {
        event.preventDefault();
      }) as never);
      void shield.webContents.loadURL('about:blank').catch(() => undefined);
      webContents.setWindowOpenHandler(({ url }) => {
        // KTD-14 / U8 decision: same-partition popups (OAuth login flows) are
        // hosted as managed overlay views over the panel area — the default
        // window creation is always denied; non-web schemes are denied
        // outright.
        if (!/^https?:\/\//.test(url)) return { action: 'deny' };
        openPopup(record, sessionId, url);
        return { action: 'deny' };
      });
      wireInput(view, record, sessionId);
      webContents.on('render-process-gone', (_event: unknown, details: { reason?: string }) => {
        deps.onEvent({
          type: 'view-crashed',
          sessionId,
          reason: details?.reason ?? 'unknown',
          at: Date.now(),
        });
        // Electron never auto-destroys a crashed webContents, so without this
        // reap the record would linger and every session_lost rebuild would
        // hit the createView duplicate guard (409 view_exists) until app
        // restart. Popups and the shield go down with it; the partition
        // (login state) is preserved for the rebuild.
        if (views.get(sessionId) === record) {
          views.delete(sessionId);
          destroyRecord(record);
        }
      });
      webContents.on('destroyed', () => {
        views.delete(sessionId);
        deps.onEvent({ type: 'view-destroyed', sessionId, at: Date.now() });
      });
      views.set(sessionId, record);
      try {
        await webContents.loadURL(`about:blank#${marker}`);
      } catch (err) {
        views.delete(sessionId);
        if (!webContents.isDestroyed()) webContents.destroy();
        if (!shield.webContents.isDestroyed()) shield.webContents.destroy();
        throw err;
      }
      // A rebuilt view (session_lost retry / next tool call) re-attaches to
      // the rect the panel is still reporting.
      applyLayout(sessionId);
      const lastPrefs = webContents.getLastWebPreferences();
      return {
        partition,
        targetMarker: marker,
        webPreferences: {
          sandbox: lastPrefs['sandbox'] === true,
          contextIsolation: lastPrefs['contextIsolation'] === true,
          nodeIntegration: lastPrefs['nodeIntegration'] === true,
          preload: typeof lastPrefs['preload'] === 'string' ? (lastPrefs['preload'] as string) : null,
        },
      };
    },

    async destroyView(sessionId) {
      const record = views.get(sessionId);
      if (!record) return false;
      views.delete(sessionId);
      destroyRecord(record);
      return true;
    },

    async wipePartition(sessionId) {
      // Login state must not outlive the session: destroy any live view, then
      // clear the partition's storage + cache (the wipeProfile semantic).
      const record = views.get(sessionId);
      if (record) {
        views.delete(sessionId);
        destroyRecord(record);
      }
      const ses = partitions.get(sessionId) ?? deps.sessionFromPartition(partitionName(sessionId));
      await ses.clearStorageData();
      await ses.clearCache();
      partitions.delete(sessionId);
    },

    async setViewBounds(sessionId, rect) {
      desiredRects.set(sessionId, rect);
      const host = hostFor(sessionId);
      if (host && viewHosts.has(sessionId)) {
        const rects = hostRects.get(sessionId) ?? new Map<HostWindowLike, ViewRect | null>();
        rects.set(host, rect);
        hostRects.set(sessionId, rects);
      }
      applyLayout(sessionId);
    },

    setViewHost(sessionId, host) {
      viewHosts.set(sessionId, host);
      applyLayout(sessionId);
    },

    getViewHost(sessionId) {
      return hostFor(sessionId);
    },

    async setViewBoundsFromHost(sessionId, host, rect) {
      if (hostFor(sessionId) !== host) return false;
      const rects = hostRects.get(sessionId) ?? new Map<HostWindowLike, ViewRect | null>();
      rects.set(host, rect);
      hostRects.set(sessionId, rects);
      if (!viewHosts.has(sessionId)) desiredRects.set(sessionId, rect);
      applyLayout(sessionId);
      return true;
    },

    setInputMode(sessionId, mode) {
      const record = views.get(sessionId);
      if (!record || record.inputMode === mode) return;
      record.inputMode = mode;
      if (mode === 'agent') {
        // KTD-14: gating also blurs the view so keystrokes stop landing in
        // the page the user can no longer drive.
        record.attachedHost?.webContents.focus();
      }
      applyLayout(sessionId);
    },

    setOccluded(next) {
      if (occluded === next) return;
      occluded = next;
      applyLayoutAll();
    },

    setHostOccluded(host, next) {
      if (hostOcclusion.get(host) === next) return;
      hostOcclusion.set(host, next);
      for (const sessionId of views.keys()) {
        if (hostFor(sessionId) === host) applyLayout(sessionId);
      }
    },

    setOcclusionExemption(sessionId) {
      if (occlusionExemptSessionId === sessionId) return;
      occlusionExemptSessionId = sessionId;
      applyLayoutAll();
    },

    getViewState(sessionId) {
      const record = views.get(sessionId);
      if (!record) return null;
      return {
        attached: record.attachedHost !== null,
        visible: record.visible,
        bounds: record.bounds,
        inputMode: record.inputMode,
        pointerGated: record.shieldVisible,
        popupCount: record.popups.size,
        lastUrl: record.lastUrl,
      };
    },

    async reconcilePartitions(keep) {
      // Live views and partitions touched this boot are never reconciled away
      // (their wipe goes through the control channel's wipe endpoint).
      const keepSet = new Set(keep);
      for (const sessionId of views.keys()) keepSet.add(sessionId);
      for (const sessionId of partitions.keys()) keepSet.add(sessionId);
      const dir = deps.partitionsDir();
      let entries: string[];
      try {
        entries = await listDir(dir);
      } catch {
        return { removed: [], errors: [] }; // no Partitions dir yet — nothing to reconcile
      }
      const removed: string[] = [];
      const errors: string[] = [];
      for (const entry of entries) {
        if (!entry.startsWith(PARTITION_DIR_PREFIX)) continue;
        const sessionId = entry.slice(PARTITION_DIR_PREFIX.length);
        if (keepSet.has(sessionId)) continue;
        try {
          await removeDir(join(dir, entry));
          removed.push(sessionId);
        } catch (err) {
          // A locked file (Windows) must not block the sweep (U9 tolerance).
          const message = err instanceof Error ? err.message : String(err);
          errors.push(`${sessionId}: ${message}`);
          deps.logger?.warn?.(`[browser-view] orphan partition ${sessionId} could not be removed: ${message}`);
        }
      }
      return { removed, errors };
    },

    async destroyAll() {
      for (const [sessionId, record] of [...views]) {
        views.delete(sessionId);
        try {
          destroyRecord(record);
        } catch (err) {
          deps.logger?.warn?.(
            `[browser-view] failed to destroy view ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    },
  };
}
