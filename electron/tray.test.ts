import { describe, it } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import {
  botStatusLabel,
  buildTrayMenuModel,
  createTray,
  fetchTrayStatus,
  resolveWindowCloseAction,
  runTrayStatusPoller,
  type TrayStatus,
} from './tray';

/** Tray status logic mirrors lib.rs:234-326 (labels, Bearer auth, 5s poll loop). */
describe('botStatusLabel', () => {
  it('maps sidecar states to the exact Tauri tray labels', () => {
    assert.strictEqual(botStatusLabel('connected'), 'WeCom bot: connected');
    assert.strictEqual(botStatusLabel('partial'), 'WeCom bot: partially connected');
    assert.strictEqual(botStatusLabel('disconnected'), 'WeCom bot: disconnected');
    assert.strictEqual(botStatusLabel('anything-else'), 'WeCom bot: not configured');
    assert.strictEqual(botStatusLabel(''), 'WeCom bot: not configured');
  });
});

describe('buildTrayMenuModel', () => {
  it('builds the Open / bot status / session count / Quit layout with placeholder labels', () => {
    const model = buildTrayMenuModel(null);
    assert.deepStrictEqual(
      model.map((item) => [item.id, item.label, item.enabled]),
      [
        ['open', 'Open Comate', true],
        ['bot_status', 'WeCom bot: …', false],
        ['session_count', 'Active sessions: …', false],
        ['separator', '', false],
        ['quit', 'Quit Comate', true],
      ],
    );
  });

  it('interpolates live status into the read-only items', () => {
    const model = buildTrayMenuModel({ wecomBot: 'connected', activeSessions: 3 });
    assert.strictEqual(model[1]!.label, 'WeCom bot: connected');
    assert.strictEqual(model[2]!.label, 'Active sessions: 3');
  });
});

describe('fetchTrayStatus', () => {
  it('GETs /api/system/tray-status with the desktop Bearer credential (lib.rs:243-250)', async () => {
    let seenAuth: string | undefined;
    let seenPath: string | undefined;
    const server = http.createServer((req, res) => {
      seenAuth = req.headers.authorization;
      seenPath = req.url;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ wecomBot: 'partial', activeSessions: 2 }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const status = await fetchTrayStatus(port, 'desktop-token');
      assert.deepStrictEqual(status, { wecomBot: 'partial', activeSessions: 2 });
      assert.strictEqual(seenAuth, 'Bearer desktop-token');
      assert.strictEqual(seenPath, '/api/system/tray-status');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('resolveWindowCloseAction', () => {
  it('hides to the tray on a plain close when the tray exists', () => {
    assert.strictEqual(resolveWindowCloseAction(false, true), 'hide-to-tray');
  });

  it('lets explicit quit paths close the window', () => {
    assert.strictEqual(resolveWindowCloseAction(true, true), 'close');
    assert.strictEqual(resolveWindowCloseAction(true, false), 'close');
  });

  it('degrades close to quit when the tray is unavailable (U10 minimal-WM edge)', () => {
    assert.strictEqual(resolveWindowCloseAction(false, false), 'quit');
  });
});

describe('runTrayStatusPoller', () => {  it('polls while running, skips when port/token are unknown, stops on shutdown', async () => {
    let fetchCalls = 0;
    const updates: string[] = [];
    let port: number | null = null;
    let shuttingDown = false;
    const poller = runTrayStatusPoller({
      getPort: () => port,
      getToken: () => 'tok',
      isShuttingDown: () => shuttingDown,
      intervalMs: 40,
      fetchImpl: (async () => ({
        ok: true,
        json: async () => ({ wecomBot: 'connected', activeSessions: 1 }),
      })) as unknown as typeof fetch,
      onStatus: (status) => {
        fetchCalls += 1;
        updates.push(`${status.wecomBot}:${status.activeSessions}`);
      },
      logger: { debug: () => {}, info: () => {}, error: () => {} },
    });

    // Unknown port: poll ticks but no fetch happens.
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.strictEqual(fetchCalls, 0);

    port = 1234;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(fetchCalls >= 1, 'expected at least one poll once port/token are known');
    assert.ok(updates.includes('connected:1'));

    shuttingDown = true;
    const callsAtStop = fetchCalls;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.strictEqual(fetchCalls, callsAtStop, 'poller must stop once shutdown begins');
    poller.stop();
  });

  it('skips ticks while the previous fetch is still in flight', async () => {
    let fetchCalls = 0;
    const resolvers: Array<() => void> = [];
    const pending = () =>
      new Promise<Response>((resolve) => {
        fetchCalls += 1;
        resolvers.push(() =>
          resolve({
            ok: true,
            json: async () => ({ wecomBot: 'connected', activeSessions: 1 }),
          } as Response),
        );
      });
    const poller = runTrayStatusPoller({
      getPort: () => 1234,
      getToken: () => 'tok',
      isShuttingDown: () => false,
      intervalMs: 30,
      fetchImpl: pending as unknown as typeof fetch,
      onStatus: () => {},
      logger: { debug: () => {}, info: () => {}, error: () => {} },
    });

    try {
      // The fetch never settles: every tick after the first must be skipped.
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.strictEqual(fetchCalls, 1, 'overlapping ticks must not stack fetches');

      // Once the fetch settles, polling resumes.
      resolvers[0]!();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(fetchCalls >= 2, 'poller should resume after the in-flight fetch settles');
    } finally {
      poller.stop();
      for (const release of resolvers) release();
    }
  });
});

describe('createTray', () => {
  function createTrayFakes() {
    const builtTemplates: unknown[][] = [];
    let appliedMenus = 0;
    class FakeTray {
      setContextMenu(): void {
        appliedMenus += 1;
      }
      setToolTip(): void {}
      destroy(): void {}
    }
    class FakeMenu {
      static buildFromTemplate(template: unknown[]): unknown {
        builtTemplates.push(template);
        return { template };
      }
    }
    return { builtTemplates, built: () => builtTemplates.length, applied: () => appliedMenus, FakeTray, FakeMenu };
  }

  function buildTray(fakes: ReturnType<typeof createTrayFakes>) {
    const clicks = { open: 0, quit: 0 };
    const tray = createTray({
      TrayClass: fakes.FakeTray as never,
      MenuClass: fakes.FakeMenu as never,
      icon: {} as never,
      onOpen: () => { clicks.open += 1; },
      onQuit: () => { clicks.quit += 1; },
      logger: { info: () => {}, error: () => {} },
    });
    return { tray, clicks };
  }

  it('rebuilds the menu only when the status actually changes', () => {
    const fakes = createTrayFakes();
    const { tray } = buildTray(fakes);
    assert.strictEqual(fakes.built(), 1, 'initial placeholder menu');

    const status: TrayStatus = { wecomBot: 'connected', activeSessions: 1 };
    tray.updateStatus(status);
    assert.strictEqual(fakes.built(), 2, 'first real status rebuilds');

    tray.updateStatus({ ...status });
    tray.updateStatus({ wecomBot: 'connected', activeSessions: 1 });
    assert.strictEqual(fakes.built(), 2, 'deep-equal statuses skip the rebuild');

    tray.updateStatus({ wecomBot: 'connected', activeSessions: 2 });
    assert.strictEqual(fakes.built(), 3, 'a changed status rebuilds');

    tray.updateStatus(null);
    assert.strictEqual(fakes.built(), 4, 'dropping back to placeholders rebuilds');
  });

  it('wires clicks through the open/quit handler lookup', () => {
    const fakes = createTrayFakes();
    const { clicks } = buildTray(fakes);
    const template = fakes.builtTemplates[0] as Array<{ id?: string; click?: () => void }>;
    const byId = new Map(template.map((item) => [item.id, item.click]));
    byId.get('open')!();
    byId.get('quit')!();
    assert.strictEqual(clicks.open, 1);
    assert.strictEqual(clicks.quit, 1);
    assert.strictEqual(byId.get('bot_status'), undefined, 'status items stay click-less');
  });
});
