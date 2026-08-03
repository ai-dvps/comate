import '../../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { WebSocketServer } from 'ws';
import {
  CdpConnection,
  CdpNetworkCaptureTransport,
  retryDuringColdStart,
} from '../browser-cdp.js';
import type { CdpEventEnvelope } from '../browser-network-capture.js';

describe('CdpConnection event envelopes', () => {
  it('preserves flattened sessionId and listener teardown', async () => {
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const peerPromise = new Promise<import('ws').WebSocket>((resolve) => server.once('connection', resolve));
    const connection = await CdpConnection.connect(`ws://127.0.0.1:${address.port}`);
    const peer = await peerPromise;

    const event = new Promise<{ method: string; sessionId?: string; params: unknown }>((resolve) => {
      const off = connection.onEvent((envelope) => {
        off();
        resolve(envelope);
      });
    });
    peer.send(JSON.stringify({
      method: 'Network.requestWillBeSent',
      sessionId: 'child-session',
      params: { requestId: 'same-id' },
    }));
    assert.deepEqual(await event, {
      method: 'Network.requestWillBeSent',
      sessionId: 'child-session',
      params: { requestId: 'same-id' },
    });

    let calls = 0;
    const off = connection.onEvent(() => { calls += 1; });
    off();
    peer.send(JSON.stringify({ method: 'Network.loadingFinished', params: {} }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls, 0);
    connection.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe('CdpNetworkCaptureTransport', () => {
  it('recursively enables Network before resuming paused iframe/worker targets', async () => {
    const commands: Array<{ method: string; sessionId?: string; params: Record<string, unknown> }> = [];
    const methodListeners = new Map<string, Set<(event: CdpEventEnvelope) => void>>();
    const fakeConnection = {
      send: async <T>(method: string, params: Record<string, unknown>, sessionId?: string): Promise<T> => {
        commands.push({ method, params, sessionId });
        if (method === 'Target.setAutoAttach' && sessionId === 'page') {
          for (const listener of methodListeners.get('Target.attachedToTarget') ?? []) {
            listener({
              method: 'Target.attachedToTarget',
              sessionId: 'page',
              params: {
                sessionId: 'frame',
                targetInfo: { type: 'iframe' },
                waitingForDebugger: true,
              },
            });
          }
        }
        if (method === 'Target.setAutoAttach' && sessionId === 'frame') {
          for (const listener of methodListeners.get('Target.attachedToTarget') ?? []) {
            listener({
              method: 'Target.attachedToTarget',
              sessionId: 'frame',
              params: {
                sessionId: 'worker',
                targetInfo: { type: 'worker' },
                waitingForDebugger: true,
              },
            });
          }
        }
        return {} as T;
      },
      on: (method: string, listener: (event: CdpEventEnvelope) => void) => {
        const listeners = methodListeners.get(method) ?? new Set();
        listeners.add(listener);
        methodListeners.set(method, listeners);
        return () => listeners.delete(listener);
      },
      onEvent: () => () => {},
      onClose: () => () => {},
    };
    const transport = new CdpNetworkCaptureTransport(
      fakeConnection as unknown as CdpConnection,
      'page',
    );
    await transport.start();

    for (const sessionId of ['page', 'frame', 'worker']) {
      assert.ok(commands.some((command) => command.method === 'Network.enable' && command.sessionId === sessionId));
      assert.ok(commands.some((command) => command.method === 'Target.setAutoAttach' && command.sessionId === sessionId));
    }
    for (const sessionId of ['frame', 'worker']) {
      const enabled = commands.findIndex((command) => command.method === 'Network.enable' && command.sessionId === sessionId);
      const resumed = commands.findIndex((command) => command.method === 'Runtime.runIfWaitingForDebugger' && command.sessionId === sessionId);
      assert.ok(enabled >= 0 && resumed > enabled, `${sessionId} must be enabled before resume`);
    }
    assert.deepEqual(
      commands.find((command) => command.method === 'Network.enable' && command.sessionId === 'page')?.params,
      {
        maxTotalBufferSize: 5 * 1024 * 1024,
        maxResourceBufferSize: 1024 * 1024,
        maxPostDataSize: 64 * 1024,
      },
    );
  });
});

describe('retryDuringColdStart', () => {
  // A fake clock: `now()` returns the current virtual time; `sleep` advances it
  // by the interval so tests run instantly without real timers.
  function fakeClock() {
    let t = 0;
    return {
      now: () => t,
      sleep: (ms: number) => {
        t += ms;
        return Promise.resolve();
      },
    };
  }

  it('returns the value once attempt succeeds on a later try', async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await retryDuringColdStart(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('socket hang up');
        return 'attached';
      },
      { budgetMs: 1_000, intervalMs: 100, now: clock.now, sleep: clock.sleep },
    );
    assert.strictEqual(result, 'attached');
    assert.strictEqual(calls, 3, 'retries until success');
  });

  it('throws the last error once the budget is exhausted', async () => {
    const clock = fakeClock();
    let calls = 0;
    await assert.rejects(
      retryDuringColdStart(
        async () => {
          calls += 1;
          throw new Error(`attempt ${calls} failed`);
        },
        { budgetMs: 500, intervalMs: 200, now: clock.now, sleep: clock.sleep },
      ),
      /attempt 4 failed/,
    );
    // t0=0; attempts at t=0,200,400,600(exceeds 500 budget → throw after 4th).
    // Actually: attempt1@0 fail (0<500, sleep→200), attempt2@200 fail (sleep→400),
    // attempt3@400 fail (sleep→600), attempt4@600 fail (600>=500 → throw). = 4 calls.
    assert.ok(calls >= 3, `expected several retries, got ${calls}`);
  });

  it('does not retry when the first attempt succeeds', async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await retryDuringColdStart(
      async () => {
        calls += 1;
        return 'ok';
      },
      { budgetMs: 1_000, intervalMs: 100, now: clock.now, sleep: clock.sleep },
    );
    assert.strictEqual(result, 'ok');
    assert.strictEqual(calls, 1);
  });
});
