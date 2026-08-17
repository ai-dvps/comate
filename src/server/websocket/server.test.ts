import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import { WebSocket } from 'ws';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { chatService } from '../services/chat-service.js';
import { browserStateChannel } from './browser-state-channel.js';
import { ComateWebSocketServer } from './server.js';
import type { WsResponse, WsErrorResponse, WsEventMessage } from './types.js';

describe('ComateWebSocketServer', { concurrency: false }, () => {
  let server: http.Server;
  let wsUrl: string;
  let ws: WebSocket;
  let webSocketServer: ComateWebSocketServer;
  let lastRuntimeCloseCallback: ((sessionId: string) => void) | undefined;
  let originalSetOnRuntimeClose: typeof chatService.setOnRuntimeClose;

  beforeEach(async () => {
    workspaceStore.resetData();
    lastRuntimeCloseCallback = undefined;
    originalSetOnRuntimeClose = chatService.setOnRuntimeClose.bind(chatService);
    chatService.setOnRuntimeClose = (cb) => {
      lastRuntimeCloseCallback = cb;
    };

    webSocketServer = new ComateWebSocketServer();
    server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    webSocketServer.attach(server);

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
      'session-a': {
        pendingCount: 1,
        pendingKind: 'approval',
        isProcessing: true,
        activity: { phase: 'background', active: true, backgroundTasks: [] },
      },
    });

    try {
      ws = await connect();
      sendRequest(ws, 'req-1', 'status', { workspaceId: 'ws-1' });

      const response = await waitForMessage<WsResponse>(ws, (msg) =>
        'id' in msg && (msg as WsResponse).id === 'req-1',
      );
      assert.strictEqual(response.ok, true);
      const payload = response.payload as { statuses: ReturnType<typeof chatService.getSessionsStatus> };
      assert.deepStrictEqual(payload.statuses, {
        'session-a': {
          pendingCount: 1,
          pendingKind: 'approval',
          isProcessing: true,
          activity: { phase: 'background', active: true, backgroundTasks: [] },
        },
      });
    } finally {
      chatService.getSessionsStatus = original;
    }
  });

  it('acknowledges send admission with the matching client turn id only after push resolves', async () => {
    const originalPushMessage = chatService.pushMessage.bind(chatService);
    let resolvePush: (() => void) | undefined;
    let admittedClientTurnId: string | undefined;
    chatService.pushMessage = async (...args: Parameters<typeof chatService.pushMessage>) => new Promise<void>((resolve) => {
      admittedClientTurnId = args[6];
      resolvePush = resolve;
    });
    try {
      ws = await connect();
      const responsePromise = waitForMessage<WsResponse>(ws, (message) =>
        'id' in message && message.id === 'send-1',
      );
      sendRequest(ws, 'send-1', 'sendMessage', {
        workspaceId: 'ws-1',
        sessionId: 'session-1',
        clientTurnId: '550e8400-e29b-41d4-a716-446655440000',
        content: 'hello',
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(resolvePush, 'push should be awaiting runtime admission');
      resolvePush();

      const response = await responsePromise;
      assert.equal(admittedClientTurnId, '550e8400-e29b-41d4-a716-446655440000');
      assert.deepEqual(response.payload, { sent: true, clientTurnId: '550e8400-e29b-41d4-a716-446655440000' });
    } finally {
      chatService.pushMessage = originalPushMessage;
    }
  });

  it('accepts the legacy text-only payload and assigns its transcript identity at the server boundary', async () => {
    const originalPushMessage = chatService.pushMessage.bind(chatService);
    let admittedClientTurnId: string | undefined;
    chatService.pushMessage = async (...args: Parameters<typeof chatService.pushMessage>) => {
      admittedClientTurnId = args[6];
    };
    try {
      ws = await connect();
      const responsePromise = waitForMessage<WsResponse>(ws, (message) =>
        'id' in message && message.id === 'send-legacy',
      );
      sendRequest(ws, 'send-legacy', 'sendMessage', {
        workspaceId: 'ws-1',
        sessionId: 'session-1',
        content: 'legacy text',
      });

      const response = await responsePromise;
      assert.match(admittedClientTurnId ?? '', /^[0-9a-f-]{36}$/i);
      assert.deepEqual(response.payload, { sent: true, clientTurnId: admittedClientTurnId });
    } finally {
      chatService.pushMessage = originalPushMessage;
    }
  });

  it('deduplicates a retry with the same client turn id while admission is delayed', async () => {
    const originalPushMessage = chatService.pushMessage.bind(chatService);
    let resolvePush: (() => void) | undefined;
    let pushCount = 0;
    chatService.pushMessage = async () => new Promise<void>((resolve) => {
      pushCount += 1;
      resolvePush = resolve;
    });
    try {
      ws = await connect();
      const payload = {
        workspaceId: 'ws-1',
        sessionId: 'session-1',
        clientTurnId: '550e8400-e29b-41d4-a716-446655440099',
        content: 'slow admission',
      };
      const firstResponse = waitForMessage<WsResponse>(ws, (message) =>
        'id' in message && message.id === 'send-slow-1',
      );
      const retryResponse = waitForMessage<WsResponse>(ws, (message) =>
        'id' in message && message.id === 'send-slow-2',
      );
      sendRequest(ws, 'send-slow-1', 'sendMessage', payload);
      await new Promise((resolve) => setTimeout(resolve, 20));
      sendRequest(ws, 'send-slow-2', 'sendMessage', payload);
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.equal(pushCount, 1);
      resolvePush?.();
      const [first, retry] = await Promise.all([firstResponse, retryResponse]);
      assert.deepEqual(first.payload, { sent: true, clientTurnId: payload.clientTurnId });
      assert.deepEqual(retry.payload, first.payload);
      assert.equal(pushCount, 1);
      const admissions = (webSocketServer as unknown as {
        sendAdmissions: Map<string, { settled: boolean }>;
      }).sendAdmissions;
      assert.equal(admissions.get(payload.clientTurnId)?.settled, true);
    } finally {
      chatService.pushMessage = originalPushMessage;
    }
  });

  it('keeps the admission dedupe registry bounded without evicting recent identities', async () => {
    const originalPushMessage = chatService.pushMessage.bind(chatService);
    let pushed = false;
    chatService.pushMessage = async () => {
      pushed = true;
    };
    try {
      const admissions = (webSocketServer as unknown as {
        sendAdmissions: Map<string, {
          workspaceId: string;
          sessionId: string;
          fingerprint: string;
          promise: Promise<void>;
          settled: boolean;
          createdAt: number;
        }>;
      }).sendAdmissions;
      for (let index = 0; index < 1000; index += 1) {
        admissions.set(`recent-${index}`, {
          workspaceId: 'ws-1',
          sessionId: 'session-1',
          fingerprint: `fingerprint-${index}`,
          promise: Promise.resolve(),
          settled: true,
          createdAt: Date.now(),
        });
      }

      ws = await connect();
      const responsePromise = waitForMessage<WsErrorResponse>(ws, (message) =>
        'id' in message && message.id === 'send-at-capacity',
      );
      sendRequest(ws, 'send-at-capacity', 'sendMessage', {
        workspaceId: 'ws-1',
        sessionId: 'session-1',
        clientTurnId: '550e8400-e29b-41d4-a716-446655440098',
        content: 'new distinct turn',
      });

      const response = await responsePromise;
      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'SEND_ADMISSION_BUSY');
      assert.equal(response.error.retryable, true);
      assert.equal(admissions.size, 1000);
      assert.equal(pushed, false);
    } finally {
      chatService.pushMessage = originalPushMessage;
    }
  });

  it('rejects image payloads without a client turn id and without a partial runtime push', async () => {
    const originalPushMessage = chatService.pushMessage.bind(chatService);
    let pushed = false;
    chatService.pushMessage = async () => {
      pushed = true;
    };
    try {
      ws = await connect();
      const responsePromise = waitForMessage<WsErrorResponse>(ws, (message) =>
        'id' in message && message.id === 'send-invalid',
      );
      sendRequest(ws, 'send-invalid', 'sendMessage', {
        workspaceId: 'ws-1',
        sessionId: 'session-1',
        content: '',
        images: [{ id: 'image', mediaType: 'image/png', data: 'AA==', width: 1, height: 1 }],
      });

      const response = await responsePromise;
      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'INVALID_SEND_MESSAGE');
      assert.equal(pushed, false);
    } finally {
      chatService.pushMessage = originalPushMessage;
    }
  });

  it('rejects unsafe or unbounded client turn ids before runtime push', async () => {
    const originalPushMessage = chatService.pushMessage.bind(chatService);
    let pushed = false;
    chatService.pushMessage = async () => {
      pushed = true;
    };
    try {
      ws = await connect();
      for (const [index, clientTurnId] of [
        'turn-1',
        'x'.repeat(65),
        '1723980000000-abc1234',
        '550e8400-e29b-41d4-a716-44665544 000',
      ].entries()) {
        const requestId = `send-unsafe-${index}`;
        const responsePromise = waitForMessage<WsErrorResponse>(ws, (message) =>
          'id' in message && message.id === requestId,
        );
        sendRequest(ws, requestId, 'sendMessage', {
          workspaceId: 'ws-1',
          sessionId: 'session-1',
          clientTurnId,
          content: 'hello',
        });
        const response = await responsePromise;
        assert.equal(response.error.code, 'INVALID_SEND_MESSAGE');
      }
      assert.equal(pushed, false);

      const uuidRequest = waitForMessage<WsResponse>(ws, (message) =>
        'id' in message && message.id === 'send-safe-uuid',
      );
      sendRequest(ws, 'send-safe-uuid', 'sendMessage', {
        workspaceId: 'ws-1',
        sessionId: 'session-1',
        clientTurnId: '550e8400-e29b-41d4-a716-446655440000',
        content: 'hello',
      });
      const uuidResponse = await uuidRequest;
      assert.equal(uuidResponse.ok, true);
      assert.equal(pushed, true);
    } finally {
      chatService.pushMessage = originalPushMessage;
    }
  });

  it('returns structured pre-admission image validation failures without acknowledging', async () => {
    const originalPushMessage = chatService.pushMessage.bind(chatService);
    chatService.pushMessage = async () => {
      const error = new Error('Image media type does not match its contents');
      Object.assign(error, {
        details: {
          kind: 'image_input_validation',
          code: 'media_signature_mismatch',
          message: error.message,
          imageIndex: 0,
        },
      });
      throw error;
    };
    try {
      ws = await connect();
      const responsePromise = waitForMessage<WsErrorResponse>(ws, (message) =>
        'id' in message && message.id === 'send-rejected',
      );
      sendRequest(ws, 'send-rejected', 'sendMessage', {
        workspaceId: 'ws-1',
        sessionId: 'session-1',
        clientTurnId: '550e8400-e29b-41d4-a716-446655440001',
        content: '',
        images: [{ id: 'bad', mediaType: 'image/png', data: 'AA==', width: 1, height: 1 }],
      });

      const response = await responsePromise;
      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'IMAGE_INPUT_VALIDATION');
      assert.deepEqual(response.error.details, {
        kind: 'image_input_validation',
        code: 'media_signature_mismatch',
        message: 'Image media type does not match its contents',
        imageIndex: 0,
      });
    } finally {
      chatService.pushMessage = originalPushMessage;
    }
  });

  it('multiplexes multiple concurrent requests', async () => {
    const originalStatus = chatService.getSessionsStatus.bind(chatService);
    chatService.getSessionsStatus = () => ({
      'session-a': {
        pendingCount: 2,
        isProcessing: true,
        activity: { phase: 'foreground', active: true, backgroundTasks: [] },
      },
    });

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

  it('browser_state channel: passive hydration, no runtime creation, disconnect cleanup', async () => {
    ws = await connect();
    const runtimesBefore = chatService.getActiveSessionCount();

    // Collect every message up front: the hydration push and the subscribe
    // ack race each other, so sequential waitForMessage calls would lose one.
    const received: Array<WsResponse | WsErrorResponse | WsEventMessage> = [];
    ws.on('message', (raw) => {
      try {
        received.push(JSON.parse(raw as string) as WsResponse);
      } catch {
        // ignore
      }
    });
    const waitFor = <T>(predicate: (msg: T) => boolean): Promise<T> =>
      new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
          const match = received.find((msg) => predicate(msg as T));
          if (match) {
            clearInterval(timer);
            resolve(match as T);
          } else if (Date.now() - started > 3000) {
            clearInterval(timer);
            reject(new Error('Timed out waiting for collected message'));
          }
        }, 25);
      });

    sendRequest(ws, 'sub-1', 'subscribeBrowserState', { workspaceId: 'ws-1', sessionId: 'sess-x' });
    const ack = await waitFor<WsResponse>((msg) => 'id' in msg && msg.id === 'sub-1');
    assert.strictEqual(ack.ok, true);

    // Hydration: the current state is pushed immediately — 'none' here since
    // the session has no browser.
    const hydration = await waitFor<WsEventMessage>((msg) => (msg as WsEventMessage).eventType === 'browser_state');
    assert.strictEqual((hydration as WsEventMessage).sessionId, 'sess-x');
    assert.strictEqual(
      ((hydration as WsEventMessage).data as { state: string }).state,
      'none',
    );
    // Passive: subscribing created no runtime.
    assert.strictEqual(chatService.getActiveSessionCount(), runtimesBefore);
    assert.strictEqual(browserStateChannel.subscriberCount('sess-x'), 1);

    // Takeover with no browser session maps to a domain error, not a crash.
    sendRequest(ws, 'take-1', 'browserTakeover', { sessionId: 'sess-x' });
    const takeover = await waitFor<WsErrorResponse>((msg) => 'id' in msg && msg.id === 'take-1');
    assert.strictEqual(takeover.ok, false);
    assert.strictEqual(takeover.error.code, 'browser_no_session');

    // Activity ping is always safe (no-op without a handoff).
    sendRequest(ws, 'ping-1', 'browserActivityPing', { sessionId: 'sess-x' });
    const ping = await waitFor<WsResponse>((msg) => 'id' in msg && msg.id === 'ping-1');
    assert.strictEqual(ping.ok, true);

    // Explicit close + idle-reclaim verbs are safe with no live session (U1/U3/U4).
    sendRequest(ws, 'close-1', 'browserClose', { sessionId: 'sess-x' });
    const closeResp = await waitFor<WsResponse>((msg) => 'id' in msg && msg.id === 'close-1');
    assert.strictEqual(closeResp.ok, true);
    assert.strictEqual((closeResp.payload as { closed: boolean }).closed, false);

    sendRequest(ws, 'idle-confirm-1', 'browserIdleConfirm', { sessionId: 'sess-x' });
    const idleConfirm = await waitFor<WsResponse>((msg) => 'id' in msg && msg.id === 'idle-confirm-1');
    assert.strictEqual(idleConfirm.ok, true);

    sendRequest(ws, 'idle-snooze-1', 'browserIdleSnooze', { sessionId: 'sess-x' });
    const idleSnooze = await waitFor<WsResponse>((msg) => 'id' in msg && msg.id === 'idle-snooze-1');
    assert.strictEqual(idleSnooze.ok, true);
    assert.strictEqual((idleSnooze.payload as { snoozed: boolean }).snoozed, true);

    // Disconnect drops the channel subscription.
    ws.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.strictEqual(browserStateChannel.subscriberCount('sess-x'), 0);
  });
});
