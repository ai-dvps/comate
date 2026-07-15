import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import { WebSocket } from 'ws';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { chatService } from '../services/chat-service.js';
import { ComateWebSocketServer } from './server.js';
import type { WsResponse, WsErrorResponse, WsEventMessage } from './types.js';

describe('ComateWebSocketServer', { concurrency: false }, () => {
  let server: http.Server;
  let wsUrl: string;
  let ws: WebSocket;
  let lastRuntimeCloseCallback: ((sessionId: string) => void) | undefined;
  let originalSetOnRuntimeClose: typeof chatService.setOnRuntimeClose;

  beforeEach(async () => {
    workspaceStore.resetData();
    lastRuntimeCloseCallback = undefined;
    originalSetOnRuntimeClose = chatService.setOnRuntimeClose.bind(chatService);
    chatService.setOnRuntimeClose = (cb) => {
      lastRuntimeCloseCallback = cb;
    };

    const wss = new ComateWebSocketServer();
    server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    wss.attach(server);

    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    wsUrl = `ws://localhost:${port}/ws`;
  });

  afterEach(async () => {
    chatService.setOnRuntimeClose = originalSetOnRuntimeClose;
    ws?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function connect(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      socket.on('open', () => resolve(socket));
      socket.on('error', reject);
    });
  }

  function waitForMessage<T>(socket: WebSocket, predicate: (msg: T) => boolean): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for message')), 3000);
      const handler = (raw: unknown) => {
        try {
          const msg = JSON.parse(raw as string) as T;
          if (predicate(msg)) {
            clearTimeout(timer);
            socket.off('message', handler);
            resolve(msg);
          }
        } catch {
          // ignore non-matching messages
        }
      };
      socket.on('message', handler);
    });
  }

  function sendRequest(socket: WebSocket, id: string, type: string, payload: Record<string, unknown>): void {
    socket.send(JSON.stringify({ id, type, payload }));
  }

  it('handles status requests over the same connection', async () => {
    const original = chatService.getSessionsStatus.bind(chatService);
    chatService.getSessionsStatus = () => ({
      'session-a': { pendingCount: 1, isProcessing: true },
    });

    try {
      ws = await connect();
      sendRequest(ws, 'req-1', 'status', { workspaceId: 'ws-1' });

      const response = await waitForMessage<WsResponse>(ws, (msg) =>
        'id' in msg && (msg as WsResponse).id === 'req-1',
      );
      assert.strictEqual(response.ok, true);
      const payload = response.payload as { statuses: Record<string, { pendingCount: number; isProcessing: boolean }> };
      assert.deepStrictEqual(payload.statuses, { 'session-a': { pendingCount: 1, isProcessing: true } });
    } finally {
      chatService.getSessionsStatus = original;
    }
  });

  it('multiplexes multiple concurrent requests', async () => {
    const originalStatus = chatService.getSessionsStatus.bind(chatService);
    chatService.getSessionsStatus = () => ({ 'session-a': { pendingCount: 2, isProcessing: true } });

    try {
      ws = await connect();
      const responses: WsResponse[] = [];
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw as string) as WsResponse;
          if ('id' in msg && ['req-1', 'req-2', 'req-3'].includes(msg.id)) {
            responses.push(msg);
          }
        } catch {
          // ignore
        }
      });

      sendRequest(ws, 'req-1', 'status', { workspaceId: 'ws-1' });
      sendRequest(ws, 'req-2', 'status', { workspaceId: 'ws-1' });
      sendRequest(ws, 'req-3', 'status', { workspaceId: 'ws-1' });

      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (responses.length >= 3) {
            clearInterval(timer);
            resolve();
          }
        }, 50);
        setTimeout(() => {
          clearInterval(timer);
          resolve();
        }, 2000);
      });

      const ids = responses.map((r) => r.id).sort();
      assert.deepStrictEqual(ids, ['req-1', 'req-2', 'req-3']);
      for (const r of responses) {
        assert.strictEqual(r.ok, true);
      }
    } finally {
      chatService.getSessionsStatus = originalStatus;
    }
  });

  it('forwards runtime events to subscribed sockets', async () => {
    let eventHandler: ((id: number, event: { type: string }) => void) | undefined;

    const originalGetOrCreateRuntime = chatService.getOrCreateRuntime.bind(chatService);
    chatService.getOrCreateRuntime = async () =>
      ({
        subscribeWebSocket: (handler: (id: number, event: { type: string }) => void) => {
          eventHandler = handler;
        },
        removeWebEventHandler: () => {},
        unsubscribeWebSocket: () => {},
        unsubscribe: () => {},
      }) as unknown as ReturnType<typeof originalGetOrCreateRuntime>;

    try {
      ws = await connect();
      sendRequest(ws, 'sub-1', 'subscribe', { workspaceId: 'ws-1', sessionId: 'session-a' });

      const subOk = await waitForMessage<WsResponse>(ws, (msg) => 'id' in msg && (msg as WsResponse).id === 'sub-1');
      assert.strictEqual(subOk.ok, true);

      assert.ok(eventHandler);
      eventHandler!(1, { type: 'text' });

      const event = await waitForMessage<WsEventMessage>(ws, (msg) => (msg as WsEventMessage).type === 'event');
      assert.strictEqual(event.eventType, 'sse');
      assert.strictEqual(event.sessionId, 'session-a');
      assert.strictEqual((event.data as { type: string }).type, 'text');
    } finally {
      chatService.getOrCreateRuntime = originalGetOrCreateRuntime;
    }
  });

  it('notifies subscribed sockets when a runtime closes', async () => {
    const originalGetOrCreateRuntime = chatService.getOrCreateRuntime.bind(chatService);

    chatService.getOrCreateRuntime = async () =>
      ({
        subscribeWebSocket: () => {},
        removeWebEventHandler: () => {},
        unsubscribeWebSocket: () => {},
        unsubscribe: () => {},
      }) as unknown as ReturnType<typeof originalGetOrCreateRuntime>;

    try {
      ws = await connect();
      sendRequest(ws, 'sub-1', 'subscribe', { workspaceId: 'ws-1', sessionId: 'session-a' });

      const subOk = await waitForMessage<WsResponse>(ws, (msg) => 'id' in msg && (msg as WsResponse).id === 'sub-1');
      assert.strictEqual(subOk.ok, true);

      assert.ok(lastRuntimeCloseCallback, 'WebSocket server should register a runtime-close listener');
      lastRuntimeCloseCallback!('session-a');

      const event = await waitForMessage<WsEventMessage>(ws, (msg) => (msg as WsEventMessage).eventType === 'runtime_closed');
      assert.strictEqual(event.sessionId, 'session-a');
      assert.strictEqual(event.workspaceId, 'ws-1');
    } finally {
      chatService.getOrCreateRuntime = originalGetOrCreateRuntime;
    }
  });

  it('does not call runtime.unsubscribe when one of several WebSocket sockets disconnects', async () => {
    const originalGetOrCreateRuntime = chatService.getOrCreateRuntime.bind(chatService);
    let unsubscribeWebSocketCalls = 0;
    let unsubscribeCalls = 0;

    chatService.getOrCreateRuntime = async () =>
      ({
        subscribeWebSocket: () => {},
        removeWebEventHandler: () => {},
        unsubscribeWebSocket: () => {
          unsubscribeWebSocketCalls++;
        },
        unsubscribe: () => {
          unsubscribeCalls++;
        },
      }) as unknown as ReturnType<typeof originalGetOrCreateRuntime>;

    try {
      const ws1 = await connect();
      const ws2 = await connect();

      sendRequest(ws1, 'sub-1', 'subscribe', { workspaceId: 'ws-1', sessionId: 'session-a' });
      sendRequest(ws2, 'sub-2', 'subscribe', { workspaceId: 'ws-1', sessionId: 'session-a' });

      const subOk1 = await waitForMessage<WsResponse>(ws1, (msg) => 'id' in msg && (msg as WsResponse).id === 'sub-1');
      assert.strictEqual(subOk1.ok, true);
      const subOk2 = await waitForMessage<WsResponse>(ws2, (msg) => 'id' in msg && (msg as WsResponse).id === 'sub-2');
      assert.strictEqual(subOk2.ok, true);

      ws1.close();
      await new Promise((r) => setTimeout(r, 50));

      assert.strictEqual(unsubscribeWebSocketCalls, 1);
      assert.strictEqual(unsubscribeCalls, 0);

      ws2.close();
      await new Promise((r) => setTimeout(r, 50));

      assert.strictEqual(unsubscribeWebSocketCalls, 2);
      assert.strictEqual(unsubscribeCalls, 0);
    } finally {
      chatService.getOrCreateRuntime = originalGetOrCreateRuntime;
    }
  });

  it('returns an error for unknown request types', async () => {
    ws = await connect();
    sendRequest(ws, 'bad-1', 'unknownType', {});

    const response = await waitForMessage<WsErrorResponse>(ws, (msg) => 'id' in msg && (msg as WsResponse).id === 'bad-1');
    assert.strictEqual(response.ok, false);
    assert.match((response as WsErrorResponse).error.message, /Unknown request type/);
  });
});
