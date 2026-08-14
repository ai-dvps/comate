import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  createBrowserViewManager,
  type BrowserViewManager,
  type HostWindowLike,
} from './browser-view-manager';
import type { ControlEvent, ViewRect } from './control-server';

/**
 * U8 browser view manager (fake view/session/host factories — no electron
 * import, the control-server.test.ts pattern). Covers the KTD-10/KTD-16
 * creation contract moved from U7 plus the U8 panel behaviors: attach/bounds,
 * occlusion, shield-based input gating + Esc, activity/navigation events,
 * managed popup overlays, and orphan-partition reconciliation.
 *
 * View creation order per session: page view first, then its transparent
 * agent-mode shield; popup overlays follow.
 */

interface FakeWebContents extends Record<string, unknown> {
  handlers: Map<string, Array<(...args: never[]) => void>>;
  openHandler: ((details: { url: string }) => unknown) | null;
  loadedUrls: string[];
  destroyed: boolean;
  focusCount: number;
  destroy(): void;
  isDestroyed(): boolean;
}

function emit(wc: FakeWebContents, event: string, ...args: unknown[]): void {
  for (const listener of wc.handlers.get(event) ?? []) {
    (listener as (...a: unknown[]) => void)(...args);
  }
}

function makeFakeView(prefs: Record<string, unknown>) {
  const webContents: FakeWebContents = {
    handlers: new Map(),
    openHandler: null,
    loadedUrls: [],
    destroyed: false,
    focusCount: 0,
    async loadURL(url: string) {
      webContents.loadedUrls.push(url);
    },
    on(event: string, listener: (...args: never[]) => void) {
      const list = webContents.handlers.get(event) ?? [];
      list.push(listener);
      webContents.handlers.set(event, list);
    },
    destroy() {
      webContents.destroyed = true;
      emit(webContents, 'destroyed');
    },
    isDestroyed: () => webContents.destroyed,
    focus() {
      webContents.focusCount += 1;
    },
    setWindowOpenHandler(handler: never) {
      webContents.openHandler = handler as FakeWebContents['openHandler'];
    },
    getLastWebPreferences: () => prefs,
  };
  const view = {
    webContents,
    boundsSet: [] as ViewRect[],
    visibleSet: [] as boolean[],
    setBounds(rect: ViewRect) {
      view.boundsSet.push(rect);
    },
    setVisible(visible: boolean) {
      view.visibleSet.push(visible);
    },
  };
  return view;
}

type FakeView = ReturnType<typeof makeFakeView>;

function makeFakeHost() {
  const host = {
    added: [] as unknown[],
    removed: [] as unknown[],
    destroyed: false,
    uiFocusCount: 0,
    sent: [] as Array<{ channel: string; args: unknown[] }>,
    contentView: {
      addChildView(view: unknown) {
        host.added.push(view);
      },
      removeChildView(view: unknown) {
        host.removed.push(view);
      },
    },
    webContents: {
      focus() {
        host.uiFocusCount += 1;
      },
      send(channel: string, ...args: unknown[]) {
        host.sent.push({ channel, args });
      },
    },
    isDestroyed: () => host.destroyed,
  };
  return host;
}

type FakeHost = ReturnType<typeof makeFakeHost>;

interface Harness {
  manager: BrowserViewManager;
  events: ControlEvent[];
  sessions: Map<string, { clearedStorage: number; clearedCache: number; permissionHandler: unknown }>;
  views: FakeView[];
  host: FakeHost;
  escapes: string[];
  dirs: { listed: string[]; removed: string[]; failOn?: string };
}

function setup(options?: { activityThrottleMs?: number; withHost?: boolean }): Harness {
  const events: ControlEvent[] = [];
  const sessions = new Map<string, { clearedStorage: number; clearedCache: number; permissionHandler: unknown }>();
  const views: FakeView[] = [];
  const host = makeFakeHost();
  const escapes: string[] = [];
  const dirs = { listed: [] as string[], removed: [] as string[], failOn: undefined as string | undefined };
  const manager = createBrowserViewManager({
    createViewImpl: (opts) => {
      const view = makeFakeView(opts.webPreferences);
      views.push(view);
      return view as never;
    },
    sessionFromPartition: (partition) => {
      let ses = sessions.get(partition);
      if (!ses) {
        ses = { clearedStorage: 0, clearedCache: 0, permissionHandler: null };
        sessions.set(partition, ses);
      }
      return {
        setPermissionRequestHandler(handler: never) {
          ses!.permissionHandler = handler;
        },
        setPermissionCheckHandler() {},
        async clearStorageData() {
          ses!.clearedStorage += 1;
        },
        async clearCache() {
          ses!.clearedCache += 1;
        },
      } as never;
    },
    onEvent: (event) => events.push(event),
    hostWindow: () => ((options?.withHost ?? true) ? (host as unknown as HostWindowLike) : null),
    partitionsDir: () => '/fake/userData/Partitions',
    onEscape: (sessionId) => escapes.push(sessionId),
    ...(options?.activityThrottleMs !== undefined
      ? { activityThrottleMs: options.activityThrottleMs }
      : {}),
    listDir: async () => dirs.listed,
    removeDir: async (dir) => {
      const name = dir.split('/').pop()!;
      if (dirs.failOn === name) throw new Error('EBUSY: locked');
      dirs.removed.push(name);
    },
  });
  return { manager, events, sessions, views, host, escapes, dirs };
}

const RECT: ViewRect = { x: 100, y: 40, width: 480, height: 600 };

describe('browser view manager — creation contract (KTD-10/KTD-16)', () => {
  it('creates an unattached sized hidden view on a per-session partition and loads the marker', async () => {
    const { manager, views } = setup();
    const created = await manager.createView({ sessionId: 's1', marker: 'comate-view-x' });
    assert.equal(created.partition, 'persist:comate-browser-s1');
    const [page, shield] = views;
    assert.deepEqual(page!.webContents.loadedUrls, ['about:blank#comate-view-x']);
    assert.deepEqual(page!.boundsSet, [{ x: 0, y: 0, width: 1280, height: 800 }]);
    assert.deepEqual(page!.visibleSet, [false]);
    assert.deepEqual(shield!.webContents.loadedUrls, ['about:blank']);
    assert.deepEqual(shield!.visibleSet, [false]);
    assert.equal(manager.size(), 1);
    assert.deepEqual(created.webPreferences, {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: null,
    });
    const prefs = (page!.webContents.getLastWebPreferences as () => Record<string, unknown>)();
    assert.equal(prefs['sandbox'], true);
    assert.equal(prefs['contextIsolation'], true);
    assert.equal(prefs['nodeIntegration'], false);
    assert.equal(prefs['preload'], undefined);
    assert.equal(prefs['partition'], 'persist:comate-browser-s1');
    // The shield never joins a persisted partition.
    const shieldPrefs = (shield!.webContents.getLastWebPreferences as () => Record<string, unknown>)();
    assert.equal(shieldPrefs['partition'], undefined);
    // Unattached until the panel reports a rect.
    assert.equal(manager.getViewState('s1')?.attached, false);
  });

  it('rejects a duplicate view for the same session', async () => {
    const { manager } = setup();
    await manager.createView({ sessionId: 's1', marker: 'm1' });
    await assert.rejects(() => manager.createView({ sessionId: 's1', marker: 'm2' }), /already exists/);
  });

  it('emits view-crashed on render-process-gone and reaps the crashed record shell-side', async () => {
    const { manager, events, views } = setup();
    await manager.createView({ sessionId: 's1', marker: 'm' });
    emit(views[0]!.webContents, 'render-process-gone', {}, { reason: 'killed' });
    assert.deepEqual(events[0], { type: 'view-crashed', sessionId: 's1', reason: 'killed', at: events[0]!.at });
    // Electron never auto-destroys a crashed webContents, so the manager
    // reaps the record itself — otherwise every rebuild would 409 on the
    // duplicate guard until app restart.
    assert.equal(views[0]!.webContents.destroyed, true);
    assert.equal(views[1]!.webContents.destroyed, true, 'shield destroyed with the page');
    assert.equal(events.at(-1)?.type, 'view-destroyed');
    assert.equal(manager.size(), 0);
    assert.equal(await manager.destroyView('s1'), false);
  });

  it('a crashed view rebuilds for the same session (no 409) with popups reaped and partition kept', async () => {
    const { manager, events, views, sessions } = setup();
    await manager.createView({ sessionId: 's1', marker: 'm1' });
    await manager.setViewBounds('s1', RECT);
    views[0]!.webContents.openHandler!({ url: 'https://accounts.example.com/oauth' });
    const popup = views[2]!;
    emit(views[0]!.webContents, 'render-process-gone', {}, { reason: 'crashed' });
    assert.equal(events[0]!.type, 'view-crashed');
    assert.equal(manager.size(), 0, 'crashed record is reaped, not left for a 409');
    assert.equal(popup.webContents.destroyed, true, 'popups of the crashed view are reaped too');
    const ses = sessions.get('persist:comate-browser-s1')!;
    assert.equal(ses.clearedStorage, 0, 'partition preserved — login state survives the crash');
    assert.equal(ses.clearedCache, 0);
    // The session_lost rebuild POSTs /views for the same sessionId.
    const rebuilt = await manager.createView({ sessionId: 's1', marker: 'm2' });
    assert.equal(rebuilt.partition, 'persist:comate-browser-s1');
    assert.equal(manager.getViewState('s1')?.attached, true, 'rebuild reattaches to the still-reported rect');
    assert.equal(manager.size(), 1);
  });

  it('wipes a partition: destroys the live view and clears storage + cache', async () => {
    const { manager, sessions, views } = setup();
    await manager.createView({ sessionId: 's1', marker: 'm' });
    await manager.wipePartition('s1');
    assert.equal(views[0]!.webContents.destroyed, true);
    const ses = sessions.get('persist:comate-browser-s1')!;
    assert.equal(ses.clearedStorage, 1);
    assert.equal(ses.clearedCache, 1);
    assert.notEqual(ses.permissionHandler, null, 'deny-by-default permission handler installed');
  });

  it('destroyAll tears down every live view', async () => {
    const { manager, views } = setup();
    await manager.createView({ sessionId: 's1', marker: 'a' });
    await manager.createView({ sessionId: 's2', marker: 'b' });
    await manager.destroyAll();
    assert.equal(manager.size(), 0);
    assert.ok(views.every((v) => v.webContents.destroyed));
  });
});

describe('browser view manager — attach, bounds, occlusion (U8, KTD-14)', () => {
  it('moves the complete view hierarchy between hosts and ignores stale reports', async () => {
    const { manager, views, host } = setup();
    const detachedHost = makeFakeHost();
    await manager.createView({ sessionId: 's1', marker: 'm' });
    await manager.setViewBounds('s1', RECT);
    views[0]!.webContents.openHandler!({ url: 'https://accounts.example.com/oauth' });
    const [page, shield, popup] = views;

    manager.setViewHost('s1', detachedHost as unknown as HostWindowLike);
    assert.ok(host.removed.includes(page), 'page leaves the former host immediately');
    assert.ok(host.removed.includes(popup), 'managed popups leave with the page');
    assert.ok(host.removed.includes(shield), 'input shield leaves with the page');
    assert.equal(manager.getViewState('s1')?.attached, false, 'waits for the new host rect');

    const detachedRect = { ...RECT, x: 20, width: 720 };
    assert.equal(
      await manager.setViewBoundsFromHost(
        's1',
        detachedHost as unknown as HostWindowLike,
        detachedRect,
      ),
      true,
    );
    assert.deepEqual(detachedHost.added.slice(0, 3), [page, popup, shield]);
    assert.equal(detachedHost.added.at(-1), shield, 'shield is stacked last');
    assert.equal(manager.getViewState('s1')?.bounds?.width, 720);

    assert.equal(
      await manager.setViewBoundsFromHost('s1', host as unknown as HostWindowLike, null),
      false,
      'a late cleanup from the former host is rejected',
    );
    assert.equal(manager.getViewState('s1')?.visible, true);
    assert.equal(manager.getViewState('s1')?.bounds?.width, 720);
  });

  it('waits for a fresh renderer rect every time ownership changes hosts', async () => {
    const { manager, host } = setup();
    const detachedHost = makeFakeHost();
    await manager.createView({ sessionId: 's1', marker: 'm' });
    await manager.setViewBounds('s1', RECT);

    manager.setViewHost('s1', detachedHost as unknown as HostWindowLike);
    await manager.setViewBoundsFromHost(
      's1',
      detachedHost as unknown as HostWindowLike,
      { ...RECT, width: 720 },
    );
    assert.equal(manager.getViewState('s1')?.attached, true);

    manager.setViewHost('s1', host as unknown as HostWindowLike);
    assert.equal(manager.getViewState('s1')?.attached, false);
    await manager.setViewBoundsFromHost('s1', host as unknown as HostWindowLike, RECT);
    assert.equal(manager.getViewState('s1')?.attached, true);

    manager.setViewHost('s1', detachedHost as unknown as HostWindowLike);
    assert.equal(
      manager.getViewState('s1')?.attached,
      false,
      'the previous detached-window rect cannot be reused',
    );
    manager.setViewHost('s1', host as unknown as HostWindowLike);
    assert.equal(
      manager.getViewState('s1')?.attached,
      false,
      'the previous main-window rect cannot be reused while its pane is inactive',
    );
  });

  it('scopes modal occlusion to the host that reported it', async () => {
    const { manager, views, host } = setup();
    const detachedHost = makeFakeHost();
    await manager.createView({ sessionId: 's1', marker: 'm' });
    manager.setViewHost('s1', detachedHost as unknown as HostWindowLike);
    await manager.setViewBoundsFromHost(
      's1',
      detachedHost as unknown as HostWindowLike,
      RECT,
    );

    manager.setHostOccluded(host as unknown as HostWindowLike, true);
    assert.equal(views[0]!.visibleSet.at(-1), true, 'main-window modal cannot hide detached view');
    manager.setHostOccluded(detachedHost as unknown as HostWindowLike, true);
    assert.equal(views[0]!.visibleSet.at(-1), false);
    manager.setHostOccluded(detachedHost as unknown as HostWindowLike, false);
    assert.equal(views[0]!.visibleSet.at(-1), true);
  });

  it('attaches page + shield to the host window on the first rect report', async () => {
    const { manager, views, host } = setup();
    await manager.createView({ sessionId: 's1', marker: 'm' });
    await manager.setViewBounds('s1', RECT);
    const [page, shield] = views;
    assert.deepEqual(host.added, [page, shield]);
    assert.equal(page!.boundsSet.at(-1)!.width, RECT.width);
    assert.equal(shield!.boundsSet.at(-1)!.width, RECT.width);
    assert.equal(page!.visibleSet.at(-1), true);
    // Default agent mode: the pointer gate (shield) is up.
    assert.equal(shield!.visibleSet.at(-1), true);
    assert.deepEqual(manager.getViewState('s1'), {
      attached: true,
      visible: true,
      bounds: RECT,
      inputMode: 'agent',
      pointerGated: true,
      popupCount: 0,
      lastUrl: null,
    });
  });

  it('follows resize with new bounds and hides on a null rect', async () => {
    const { manager, views } = setup();
    await manager.createView({ sessionId: 's1', marker: 'm' });
    await manager.setViewBounds('s1', RECT);
    const grown = { ...RECT, width: 640 };
    await manager.setViewBounds('s1', grown);
    assert.equal(views[0]!.boundsSet.at(-1)!.width, 640);
    await manager.setViewBounds('s1', null);
    assert.equal(views[0]!.visibleSet.at(-1), false);
    assert.equal(views[1]!.visibleSet.at(-1), false, 'shield hides with the page');
    assert.equal(manager.getViewState('s1')?.visible, false);
    // A later rect restores visibility without a re-attach.
    await manager.setViewBounds('s1', grown);
    assert.equal(views[0]!.visibleSet.at(-1), true);
    assert.equal(views[1]!.visibleSet.at(-1), true);
  });

  it('reattaches a rebuilt view to the still-reported rect (session_lost retry)', async () => {
    const { manager, views, host } = setup();
    await manager.setViewBounds('s1', RECT);
    await manager.createView({ sessionId: 's1', marker: 'm1' });
    assert.equal(manager.getViewState('s1')?.attached, true);
    await manager.destroyView('s1');
    await manager.createView({ sessionId: 's1', marker: 'm2' });
    assert.equal(manager.getViewState('s1')?.attached, true);
    assert.deepEqual(host.added, [views[0], views[1], views[2], views[3]]);
    assert.equal(views[2]!.boundsSet.at(-1)!.width, RECT.width);
  });

  it('occlusion hides every view and restores them with their last rect', async () => {
    const { manager, views } = setup();
    await manager.createView({ sessionId: 's1', marker: 'a' });
    await manager.createView({ sessionId: 's2', marker: 'b' });
    await manager.setViewBounds('s1', RECT);
    await manager.setViewBounds('s2', { ...RECT, x: 700 });
    manager.setOccluded(true);
    assert.equal(views[0]!.visibleSet.at(-1), false);
    assert.equal(views[2]!.visibleSet.at(-1), false);
    assert.equal(manager.getViewState('s1')?.visible, false);
    manager.setOccluded(false);
    assert.equal(views[0]!.visibleSet.at(-1), true);
    assert.equal(views[2]!.visibleSet.at(-1), true);
  });

  it('defers attach while occluded and attaches on de-occlusion', async () => {
    const { manager, host } = setup();
    manager.setOccluded(true);
    await manager.createView({ sessionId: 's1', marker: 'm' });
    await manager.setViewBounds('s1', RECT);
    assert.equal(host.added.length, 0);
    manager.setOccluded(false);
    assert.equal(host.added.length, 2, 'page + shield attach together');
    assert.equal(manager.getViewState('s1')?.visible, true);
  });

  it('never attaches without a host window', async () => {
    const { manager, views } = setup({ withHost: false });
    await manager.createView({ sessionId: 's1', marker: 'm' });
    await manager.setViewBounds('s1', RECT);
    assert.equal(manager.getViewState('s1')?.attached, false);
    assert.equal(views[0]!.boundsSet.length, 1, 'keeps the unattached default size');
  });
});

describe('browser view manager — input gating + Esc (U8, KTD-14)', () => {
  it('user mode drops the shield; agent mode raises it and blurs to the UI view', async () => {
    const { manager, views, host } = setup();
    await manager.createView({ sessionId: 's1', marker: 'm' });
    await manager.setViewBounds('s1', RECT);
    const shield = views[1]!;
    manager.setInputMode('s1', 'user');
    assert.equal(shield.visibleSet.at(-1), false);
    assert.equal(manager.getViewState('s1')?.pointerGated, false);
    manager.setInputMode('s1', 'agent');
    assert.equal(shield.visibleSet.at(-1), true);
    assert.equal(host.uiFocusCount, 1, 'agent gating moves focus back to the UI view');
  });

  it('agent mode swallows keystrokes before they reach the page', async () => {
    const { manager, views } = setup();
    await manager.createView({ sessionId: 's1', marker: 'm' });
    let prevented = 0;
    const event = { preventDefault: () => (prevented += 1) };
    emit(views[0]!.webContents, 'before-input-event', event, { type: 'keyDown', key: 'a' });
    assert.equal(prevented, 1);
  });

  it('the shield dead-ends every keystroke and pointer input pings activity', async () => {
    const { manager, views, events } = setup({ activityThrottleMs: 1000 });
    await manager.createView({ sessionId: 's1', marker: 'm' });
    const shield = views[1]!;
    let prevented = 0;
    const event = { preventDefault: () => (prevented += 1) };
    emit(shield.webContents, 'before-input-event', event, { type: 'keyDown', key: 'a' });
    assert.equal(prevented, 1);
    emit(shield.webContents, 'input-event', {}, { type: 'mouseDown' });
    const activity = events.filter((e) => e.type === 'view-activity');
    assert.equal(activity.length, 1, 'shield pointer input counts as activity');
  });

  it('user mode passes keystrokes but intercepts Esc back to the panel frame', async () => {
    const { manager, views, host, escapes } = setup();
    await manager.createView({ sessionId: 's1', marker: 'm' });
    await manager.setViewBounds('s1', RECT);
    manager.setInputMode('s1', 'user');
    let prevented = 0;
    const event = { preventDefault: () => (prevented += 1) };
    emit(views[0]!.webContents, 'before-input-event', event, { type: 'keyDown', key: 'Enter' });
    assert.equal(prevented, 0, 'regular keys reach the page');
    emit(views[0]!.webContents, 'before-input-event', event, { type: 'keyDown', key: 'Escape' });
    assert.equal(prevented, 1, 'Esc is intercepted');
    assert.equal(host.uiFocusCount, 1, 'focus returns to the UI view');
    assert.deepEqual(escapes, ['s1']);
  });
});

describe('browser view manager — activity + navigation events (U8)', () => {
  it('throttles input-event into view-activity', async () => {
    const { manager, views, events } = setup({ activityThrottleMs: 1000 });
    await manager.createView({ sessionId: 's1', marker: 'm' });
    emit(views[0]!.webContents, 'input-event', {}, { type: 'mouseDown' });
    emit(views[0]!.webContents, 'input-event', {}, { type: 'mouseUp' });
    const activity = events.filter((e) => e.type === 'view-activity');
    assert.equal(activity.length, 1);
    assert.equal(activity[0]!.type === 'view-activity' && activity[0]!.sessionId, 's1');
  });

  it('tracks http(s) navigations as view-navigated events + lastUrl; ignores about:blank', async () => {
    const { manager, views, events } = setup();
    await manager.createView({ sessionId: 's1', marker: 'm' });
    emit(views[0]!.webContents, 'did-navigate', {}, 'about:blank#m');
    assert.equal(events.filter((e) => e.type === 'view-navigated').length, 0);
    emit(views[0]!.webContents, 'did-navigate', {}, 'https://example.com/login');
    emit(views[0]!.webContents, 'did-navigate-in-page', {}, 'https://example.com/login#2');
    const nav = events.filter((e) => e.type === 'view-navigated');
    assert.equal(nav.length, 2);
    assert.equal(manager.getViewState('s1')?.lastUrl, 'https://example.com/login#2');
  });
});

describe('browser view manager — managed popup overlays (U8 OAuth decision)', () => {
  it('hosts http(s) popups as same-partition overlay views; denies non-web schemes', async () => {
    const { manager, views, host } = setup();
    await manager.createView({ sessionId: 's1', marker: 'm' });
    await manager.setViewBounds('s1', RECT);
    const [page, shield] = views;
    const handler = page!.webContents.openHandler!;
    assert.equal((handler({ url: 'file:///etc/passwd' }) as { action: string }).action, 'deny');
    assert.equal(views.length, 2, 'no overlay for a denied scheme');

    const result = handler({ url: 'https://accounts.example.com/oauth' }) as { action: string };
    assert.equal(result.action, 'deny', 'default window creation is always denied');
    assert.equal(views.length, 3, 'a managed overlay view was created instead');
    const popup = views[2]!;
    const prefs = (popup.webContents.getLastWebPreferences as () => Record<string, unknown>)();
    assert.equal(prefs['partition'], 'persist:comate-browser-s1');
    assert.equal(prefs['sandbox'], true);
    assert.equal(prefs['preload'], undefined);
    assert.deepEqual(host.added.slice(0, 3), [page, shield, popup]);
    // The shield is re-raised above the popup (agent-mode gate stays on top).
    assert.deepEqual(host.removed, [shield]);
    assert.deepEqual(host.added.at(-1), shield);
    assert.equal(popup.boundsSet.at(-1)!.width, RECT.width, 'overlay covers the panel area');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(popup.webContents.loadedUrls, ['https://accounts.example.com/oauth']);
    assert.equal(manager.getViewState('s1')?.popupCount, 1);

    // Overlay teardown: destroyed popups detach and drop out of the count.
    popup.webContents.destroy();
    assert.equal(manager.getViewState('s1')?.popupCount, 0);
    assert.ok(host.removed.includes(popup));
  });

  it('popups follow bounds, hide with occlusion, and die with the parent', async () => {
    const { manager, views } = setup();
    await manager.createView({ sessionId: 's1', marker: 'm' });
    await manager.setViewBounds('s1', RECT);
    const handler = views[0]!.webContents.openHandler!;
    handler({ url: 'https://accounts.example.com/oauth' });
    const popup = views[2]!;
    const moved = { ...RECT, width: 700 };
    await manager.setViewBounds('s1', moved);
    assert.equal(popup.boundsSet.at(-1)!.width, 700);
    manager.setOccluded(true);
    assert.equal(popup.visibleSet.at(-1), false);
    manager.setOccluded(false);
    assert.equal(popup.visibleSet.at(-1), true);
    await manager.destroyView('s1');
    assert.equal(popup.webContents.destroyed, true, 'parent destroy takes popups down');
  });

  it('refuses popups beyond the per-session cap (untrusted pages can loop window.open)', async () => {
    const { manager, views } = setup();
    await manager.createView({ sessionId: 's1', marker: 'm' });
    await manager.setViewBounds('s1', RECT);
    const handler = views[0]!.webContents.openHandler!;
    for (let i = 0; i < 8; i += 1) {
      handler({ url: `https://example.com/popup-${i}` });
    }
    assert.equal(views.length, 2 + 8, 'page + shield + 8 popups');
    assert.equal(manager.getViewState('s1')?.popupCount, 8);
    const result = handler({ url: 'https://example.com/popup-9' }) as { action: string };
    assert.equal(result.action, 'deny', 'default window creation is still denied');
    assert.equal(views.length, 2 + 8, 'the (N+1)th popup is refused — no new view');
    assert.equal(manager.getViewState('s1')?.popupCount, 8);
    // A closed popup frees its slot.
    views[2]!.webContents.destroy();
    handler({ url: 'https://example.com/popup-10' });
    assert.equal(views.length, 2 + 9);
    assert.equal(manager.getViewState('s1')?.popupCount, 8);
  });
});

describe('browser view manager — orphan partition reconciliation (U8, KTD-11)', () => {
  it('deletes partition dirs absent from the keep list; keeps live/touched/listed', async () => {
    const { manager, dirs } = setup();
    await manager.createView({ sessionId: 'live', marker: 'm' });
    dirs.listed = [
      'comate-browser-live', // live view — kept even though unlisted
      'comate-browser-known', // in the keep list
      'comate-browser-orphan-1',
      'comate-browser-orphan-2',
      'default', // not a browser partition
      'comate-browser-locked',
    ];
    dirs.failOn = 'comate-browser-locked';
    const result = await manager.reconcilePartitions(['known', 'locked-session-mismatch']);
    assert.deepEqual(result.removed.sort(), ['orphan-1', 'orphan-2']);
    assert.equal(result.errors.length, 1);
    assert.ok(dirs.removed.includes('comate-browser-orphan-1'));
    assert.ok(!dirs.removed.includes('comate-browser-live'));
    assert.ok(!dirs.removed.includes('comate-browser-known'));
    assert.ok(!dirs.removed.includes('default'));
  });

  it('a missing Partitions dir reconciles to nothing', async () => {
    const manager = createBrowserViewManager({
      createViewImpl: () => makeFakeView({}) as never,
      sessionFromPartition: () => {
        throw new Error('unused');
      },
      onEvent: () => {},
      hostWindow: () => null,
      partitionsDir: () => '/nonexistent',
      listDir: async () => {
        throw new Error('ENOENT');
      },
      removeDir: async () => {},
    });
    assert.deepEqual(await manager.reconcilePartitions([]), { removed: [], errors: [] });
  });
});
