import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import type { WeComProactiveMessage } from '../models/wecom-proactive-message.js';

describe('wecom-send routes', { concurrency: false }, () => {
  let originalGetWecomUserIdBySession: typeof workspaceStore.getWecomUserIdBySession;
  let originalGetWecomUserMapping: typeof workspaceStore.getWecomUserMapping;
  let originalGetEncryptedUserIdByPlaintext: typeof workspaceStore.getEncryptedUserIdByPlaintext;
  let originalGetActiveWecomSession: typeof workspaceStore.getActiveWecomSession;
  let originalEnqueueProactiveMessage: typeof workspaceStore.enqueueProactiveMessage;
  let originalGetStatus: (workspaceId: string) => string;
  let originalSendDirectMessage: (
    workspaceId: string,
    toUser: string,
    message: string,
  ) => Promise<void>;

  beforeEach(async () => {
    originalGetWecomUserIdBySession = workspaceStore.getWecomUserIdBySession.bind(workspaceStore);
    originalGetWecomUserMapping = workspaceStore.getWecomUserMapping.bind(workspaceStore);
    originalGetEncryptedUserIdByPlaintext = workspaceStore.getEncryptedUserIdByPlaintext.bind(workspaceStore);
    originalGetActiveWecomSession = workspaceStore.getActiveWecomSession.bind(workspaceStore);
    originalEnqueueProactiveMessage = workspaceStore.enqueueProactiveMessage.bind(workspaceStore);

    const { wecomBotService } = await import('../services/wecom-bot-service.js');
    originalGetStatus = wecomBotService.getStatus.bind(wecomBotService);
    originalSendDirectMessage = wecomBotService.sendDirectMessage.bind(wecomBotService);
  });

  afterEach(() => {
    workspaceStore.getWecomUserIdBySession = originalGetWecomUserIdBySession;
    workspaceStore.getWecomUserMapping = originalGetWecomUserMapping;
    workspaceStore.getEncryptedUserIdByPlaintext = originalGetEncryptedUserIdByPlaintext;
    workspaceStore.getActiveWecomSession = originalGetActiveWecomSession;
    workspaceStore.enqueueProactiveMessage = originalEnqueueProactiveMessage;

    import('../services/wecom-bot-service.js').then(({ wecomBotService }) => {
      wecomBotService.getStatus = originalGetStatus;
      wecomBotService.sendDirectMessage = originalSendDirectMessage;
    });
  });

  function createMockRes(): {
    statusCode: number;
    jsonBody: unknown;
    status(code: number): typeof res;
    json(body: unknown): void;
    send(): void;
  } {
    const res = {
      statusCode: 200,
      jsonBody: undefined as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: unknown) {
        this.jsonBody = body;
      },
      send() {
        // no-op
      },
    };
    return res;
  }

  async function importRouteHandlers() {
    const mod = await import('./wecom-send.js');
    const router = mod.default;
    const layers = (router as unknown as { stack: Array<{ route?: { methods: Record<string, boolean>; path: string; stack: Array<{ handle: (req: unknown, res: unknown) => Promise<void> }> } }> }).stack;
    const handlers: Record<string, Record<string, (req: unknown, res: unknown) => Promise<void>>> = {};
    for (const layer of layers) {
      if (!layer.route) continue;
      const path = layer.route.path;
      const methods = Object.keys(layer.route.methods);
      if (!handlers[path]) handlers[path] = {};
      for (const method of methods) {
        handlers[path][method] = layer.route.stack[0].handle;
      }
    }
    return handlers;
  }

  it('direct send when caller matches recipient and bot is connected', async () => {
    const handlers = await importRouteHandlers();
    workspaceStore.getWecomUserIdBySession = () => 'enc-alice';
    workspaceStore.getWecomUserMapping = () => 'alice';

    let sendCalled = false;
    const { wecomBotService } = await import('../services/wecom-bot-service.js');
    wecomBotService.getStatus = () => 'connected';
    wecomBotService.sendDirectMessage = async (wsId, toUser, message) => {
      sendCalled = true;
      assert.strictEqual(wsId, 'ws-1');
      assert.strictEqual(toUser, 'alice');
      assert.strictEqual(message, 'hello');
    };

    const req = {
      params: { workspaceId: 'ws-1' },
      body: { sessionId: 'sid-1', toUser: 'alice', message: 'hello', msgType: 'text' },
    };
    const res = createMockRes();

    await handlers['/'].post(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual((res.jsonBody as { method: string }).method, 'direct');
    assert.strictEqual(sendCalled, true);
  });

  it('queues when caller differs from recipient', async () => {
    const handlers = await importRouteHandlers();
    workspaceStore.getWecomUserIdBySession = () => 'enc-alice';
    workspaceStore.getWecomUserMapping = () => 'alice';
    workspaceStore.getEncryptedUserIdByPlaintext = () => 'enc-bob';
    workspaceStore.getActiveWecomSession = () => 'session-bob';
    workspaceStore.enqueueProactiveMessage = () =>
      ({ id: 'msg-1', status: 'pending' } as WeComProactiveMessage);

    const { wecomBotService } = await import('../services/wecom-bot-service.js');
    wecomBotService.getStatus = () => 'connected';

    const req = {
      params: { workspaceId: 'ws-1' },
      body: { sessionId: 'sid-1', toUser: 'bob', message: 'hello' },
    };
    const res = createMockRes();

    await handlers['/'].post(req, res);

    assert.strictEqual(res.statusCode, 202);
    assert.strictEqual((res.jsonBody as { method: string }).method, 'queued');
    assert.strictEqual((res.jsonBody as { entryId: string }).entryId, 'msg-1');
  });

  it('queues when session has no WeCom user mapping', async () => {
    const handlers = await importRouteHandlers();
    workspaceStore.getWecomUserIdBySession = () => null;
    workspaceStore.getEncryptedUserIdByPlaintext = () => 'enc-bob';
    workspaceStore.getActiveWecomSession = () => 'session-bob';
    workspaceStore.enqueueProactiveMessage = () =>
      ({ id: 'msg-2', status: 'pending' } as WeComProactiveMessage);

    const req = {
      params: { workspaceId: 'ws-1' },
      body: { sessionId: 'sid-1', toUser: 'bob', message: 'hello' },
    };
    const res = createMockRes();

    await handlers['/'].post(req, res);

    assert.strictEqual(res.statusCode, 202);
    assert.strictEqual((res.jsonBody as { method: string }).method, 'queued');
  });

  it('returns error when bot is not connected even for same user', async () => {
    const handlers = await importRouteHandlers();
    workspaceStore.getWecomUserIdBySession = () => 'enc-alice';
    workspaceStore.getWecomUserMapping = () => 'alice';
    workspaceStore.getEncryptedUserIdByPlaintext = () => 'enc-alice';
    workspaceStore.getActiveWecomSession = () => 'session-alice';
    workspaceStore.enqueueProactiveMessage = () =>
      ({ id: 'msg-3', status: 'pending' } as WeComProactiveMessage);

    const { wecomBotService } = await import('../services/wecom-bot-service.js');
    wecomBotService.getStatus = () => 'disconnected';

    const req = {
      params: { workspaceId: 'ws-1' },
      body: { sessionId: 'sid-1', toUser: 'alice', message: 'hello' },
    };
    const res = createMockRes();

    await handlers['/'].post(req, res);

    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual((res.jsonBody as { error: string }).error, 'bot_not_connected');
  });

  it('returns error when direct send throws', async () => {
    const handlers = await importRouteHandlers();
    workspaceStore.getWecomUserIdBySession = () => 'enc-alice';
    workspaceStore.getWecomUserMapping = () => 'alice';

    const { wecomBotService } = await import('../services/wecom-bot-service.js');
    wecomBotService.getStatus = () => 'connected';
    wecomBotService.sendDirectMessage = async () => {
      throw new Error('network error');
    };

    const req = {
      params: { workspaceId: 'ws-1' },
      body: { sessionId: 'sid-1', toUser: 'alice', message: 'hello' },
    };
    const res = createMockRes();

    await handlers['/'].post(req, res);

    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual((res.jsonBody as { error: string }).error, 'direct_send_failed');
    assert.ok(((res.jsonBody as { message: string }).message).includes('network error'));
  });

  it('returns 400 when recipient is not resolved', async () => {
    const handlers = await importRouteHandlers();
    workspaceStore.getWecomUserIdBySession = () => 'enc-alice';
    workspaceStore.getWecomUserMapping = () => 'alice';
    workspaceStore.getEncryptedUserIdByPlaintext = () => null;

    const req = {
      params: { workspaceId: 'ws-1' },
      body: { sessionId: 'sid-1', toUser: 'bob', message: 'hello' },
    };
    const res = createMockRes();

    await handlers['/'].post(req, res);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual((res.jsonBody as { error: string }).error, 'recipient_not_resolved');
  });

  it('returns 400 when recipient has no session', async () => {
    const handlers = await importRouteHandlers();
    workspaceStore.getWecomUserIdBySession = () => 'enc-alice';
    workspaceStore.getWecomUserMapping = () => 'alice';
    workspaceStore.getEncryptedUserIdByPlaintext = () => 'enc-bob';
    workspaceStore.getActiveWecomSession = () => null;

    const req = {
      params: { workspaceId: 'ws-1' },
      body: { sessionId: 'sid-1', toUser: 'bob', message: 'hello' },
    };
    const res = createMockRes();

    await handlers['/'].post(req, res);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual((res.jsonBody as { error: string }).error, 'recipient_no_session');
  });

  it('returns 400 when required fields are missing', async () => {
    const handlers = await importRouteHandlers();

    const req1 = { params: { workspaceId: 'ws-1' }, body: { toUser: 'bob', message: 'hello' } };
    const res1 = createMockRes();
    await handlers['/'].post(req1, res1);
    assert.strictEqual(res1.statusCode, 400);

    const req2 = { params: { workspaceId: 'ws-1' }, body: { sessionId: 'sid-1', message: 'hello' } };
    const res2 = createMockRes();
    await handlers['/'].post(req2, res2);
    assert.strictEqual(res2.statusCode, 400);

    const req3 = { params: { workspaceId: 'ws-1' }, body: { sessionId: 'sid-1', toUser: 'bob' } };
    const res3 = createMockRes();
    await handlers['/'].post(req3, res3);
    assert.strictEqual(res3.statusCode, 400);
  });
});