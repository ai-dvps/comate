import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  createDetachedBrowserWindowController,
  type DetachedBrowserPlacement,
  type DetachedBrowserWindowLike,
} from './detached-browser-window';
import type { HostWindowLike } from './browser-view-manager';

function makeHost() {
  return {
    contentView: { addChildView() {}, removeChildView() {} },
    webContents: { focus() {}, send() {} },
    destroyed: false,
    isDestroyed() { return this.destroyed; },
  };
}

function makeWindow(): DetachedBrowserWindowLike & {
  emitClose(): { prevented: boolean };
  emitRendererGone(): void;
  calls: string[];
  title: string;
} {
  const handlers = new Map<string, Array<(...args: never[]) => void>>();
  const webHandlers = new Map<string, Array<(...args: never[]) => void>>();
  const host = makeHost();
  let minimized = false;
  let destroyed = false;
  const calls: string[] = [];
  const win = {
    ...host,
    calls,
    title: '',
    on(event: string, listener: (...args: never[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), listener]);
    },
    webContents: {
      ...host.webContents,
      on(event: string, listener: (...args: never[]) => void) {
        webHandlers.set(event, [...(webHandlers.get(event) ?? []), listener]);
      },
    },
    show() { calls.push('show'); },
    hide() { calls.push('hide'); },
    focus() { calls.push('focus'); },
    isMinimized: () => minimized,
    restore() { minimized = false; calls.push('restore'); },
    setTitle(title: string) { win.title = title; },
    close() {
      calls.push('close');
      const event = win.emitClose();
      if (!event.prevented) {
        destroyed = true;
        for (const listener of handlers.get('closed') ?? []) listener();
      }
    },
    destroy() {
      calls.push('destroy');
      destroyed = true;
      for (const listener of handlers.get('closed') ?? []) listener();
    },
    isDestroyed: () => destroyed,
    emitClose() {
      const state = { prevented: false };
      const event = { preventDefault: () => { state.prevented = true; } };
      for (const listener of handlers.get('close') ?? []) listener(event as never);
      return state;
    },
    emitRendererGone() {
      for (const listener of webHandlers.get('render-process-gone') ?? []) listener({} as never, {} as never);
    },
  };
  return win;
}

const A: DetachedBrowserPlacement = {
  workspaceId: 'ws-a',
  sessionId: 'session-a',
  title: 'Research chat',
};
const B: DetachedBrowserPlacement = {
  workspaceId: 'ws-b',
  sessionId: 'session-b',
  title: 'Build chat',
};

function setup() {
  const main = makeHost();
  const windows: ReturnType<typeof makeWindow>[] = [];
  const placements: Array<DetachedBrowserPlacement | null> = [];
  const hostChanges: Array<{ sessionId: string; host: HostWindowLike | null }> = [];
  const loads: DetachedBrowserWindowLike[] = [];
  const controller = createDetachedBrowserWindowController({
    createWindow: () => {
      const win = makeWindow();
      windows.push(win);
      return win;
    },
    mainWindow: () => main,
    setViewHost: (sessionId, host) => hostChanges.push({ sessionId, host }),
    loadWindow: async (win) => { loads.push(win); },
    publishPlacement: (placement) => placements.push(placement),
  });
  return { controller, main, windows, placements, hostChanges, loads };
}

describe('detached browser window controller', () => {
  it('creates one top-level window and moves the view only after renderer readiness', async () => {
    const { controller, windows, placements, hostChanges, loads } = setup();
    await controller.detach(A);
    assert.equal(windows.length, 1);
    assert.equal(loads.length, 1);
    assert.deepEqual(placements.at(-1), A);
    assert.equal(hostChanges.length, 0, 'browser remains embedded while child UI loads');
    assert.equal(windows[0]!.title, 'Browser — Research chat');

    assert.equal(controller.rendererReady('session-a'), true);
    assert.deepEqual(hostChanges.at(-1), { sessionId: 'session-a', host: windows[0] });
    assert.deepEqual(windows[0]!.calls.slice(-2), ['show', 'focus']);

    await controller.detach(A);
    assert.equal(windows.length, 1, 'same placement focuses the reusable window');
    assert.equal(loads.length, 1);
  });

  it('restores the old session before retargeting the singleton window', async () => {
    const { controller, main, windows, hostChanges, placements } = setup();
    await controller.detach(A);
    controller.rendererReady('session-a');
    await controller.detach(B);
    assert.deepEqual(hostChanges.at(-1), { sessionId: 'session-a', host: main });
    assert.deepEqual(placements.at(-1), B);
    assert.equal(controller.rendererReady('session-a'), false, 'stale child readiness is ignored');
    assert.equal(controller.rendererReady('session-b'), true);
    assert.deepEqual(hostChanges.at(-1), { sessionId: 'session-b', host: windows[0] });
  });

  it('user-close redocks and hides without changing the active main window', async () => {
    const { controller, main, windows, hostChanges, placements } = setup();
    await controller.detach(A);
    controller.rendererReady('session-a');
    const event = windows[0]!.emitClose();
    assert.equal(event.prevented, true);
    assert.deepEqual(hostChanges.at(-1), { sessionId: 'session-a', host: main });
    assert.equal(placements.at(-1), null);
    assert.equal(windows[0]!.calls.at(-1), 'hide');
  });

  it('browser-session close and app quit close without redocking', async () => {
    const ended = setup();
    await ended.controller.detach(A);
    ended.controller.rendererReady('session-a');
    const beforeEnd = ended.hostChanges.length;
    assert.equal(ended.controller.browserSessionEnded('session-a'), true);
    assert.equal(ended.hostChanges.length, beforeEnd + 1);
    assert.deepEqual(ended.hostChanges.at(-1), { sessionId: 'session-a', host: null });
    assert.equal(ended.windows[0]!.calls.includes('close'), true);

    const quitting = setup();
    await quitting.controller.detach(A);
    quitting.controller.rendererReady('session-a');
    const beforeQuit = quitting.hostChanges.length;
    quitting.controller.closeForQuit();
    assert.equal(quitting.hostChanges.length, beforeQuit + 1);
    assert.deepEqual(quitting.hostChanges.at(-1), { sessionId: 'session-a', host: null });
    assert.equal(quitting.windows[0]!.calls.includes('close'), true);
  });

  it('renderer failure destroys the bad shell and fails safe to the main host', async () => {
    const { controller, main, windows, hostChanges, placements } = setup();
    await controller.detach(A);
    controller.rendererReady('session-a');
    windows[0]!.emitRendererGone();
    assert.deepEqual(hostChanges.at(-1), { sessionId: 'session-a', host: main });
    assert.equal(placements.at(-1), null);
    assert.equal(windows[0]!.calls.includes('destroy'), true);
  });
});
