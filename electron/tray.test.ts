import { describe, it } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import {
  botStatusLabel,
  buildTrayMenuModel,
  fetchTrayStatus,
  runTrayStatusPoller,
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

describe('runTrayStatusPoller', () => {
  it('polls while running, skips when port/token are unknown, stops on shutdown', async () => {
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
});
