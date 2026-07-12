import '../test-utils/test-env.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { chatService, ChatError } from '../services/chat-service.js';
import { botService } from '../services/bot-service.js';

function createMockRes() {
  return {
    statusCode: 200,
    jsonBody: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.jsonBody = body;
    },
  };
}

describe('chat route Feishu user info', { concurrency: false }, () => {
  beforeEach(() => {
    workspaceStore.resetData();
  });

  async function importGetFeishuUserHandler() {
    const mod = await import('./chat.js');
    const router = mod.default;
    const layers = (router as unknown as { stack: Array<{ route?: { methods: Record<string, boolean>; path: string; stack: Array<{ handle: (req: unknown, res: unknown) => Promise<void> }> } }> }).stack;
    for (const layer of layers) {
      if (layer.route?.path === '/sessions/:sessionId/feishu-user' && layer.route.methods.get) {
        return layer.route.stack[layer.route.stack.length - 1].handle;
      }
    }
    throw new Error('GET /sessions/:sessionId/feishu-user handler not found');
  }

  function createFeishuBot(workspaceId: string) {
    return botService.createBot({
      name: 'Feishu Bot',
      activeWorkspaceId: workspaceId,
      channelSettings: {
        feishu: { enabled: true, appId: 'test-app', appSecret: 'test-secret' },
      },
    });
  }

  it('returns Feishu user info for a bound session', async () => {
    const workspaceId = 'ws-1';
    const feishuUserId = 'ou_12345';
    const bot = createFeishuBot(workspaceId);
    const user = botService.addMember(bot.id, {
      channelKey: 'feishu',
      channelUserId: feishuUserId,
      plaintextUserId: 'Alice',
    });
    const session = await chatService.createSession({ workspaceId, name: 'feishu session', source: 'feishu' });
    workspaceStore.addUserSession(workspaceId, session.id, user.id);
    workspaceStore.setActiveUserSession(user.id, session.id);

    const handler = await importGetFeishuUserHandler();
    const res = createMockRes();
    await handler({ params: { id: workspaceId, sessionId: session.id } }, res);

    assert.strictEqual(res.statusCode, 200);
    const body = res.jsonBody as { userId: string; name: string | null };
    assert.strictEqual(body.userId, 'Alice');
    assert.strictEqual(body.name, 'Alice');
  });

  it('returns 404 when the session has no Feishu owner', async () => {
    const workspaceId = 'ws-1';
    const session = await chatService.createSession({ workspaceId, name: 'gui session', source: 'gui' });

    const handler = await importGetFeishuUserHandler();
    const res = createMockRes();
    await handler({ params: { id: workspaceId, sessionId: session.id } }, res);

    assert.strictEqual(res.statusCode, 404);
  });

  it('falls back to open_id when no cached name exists', async () => {
    const workspaceId = 'ws-1';
    const feishuUserId = 'ou_67890';
    const bot = createFeishuBot(workspaceId);
    const user = botService.addMember(bot.id, {
      channelKey: 'feishu',
      channelUserId: feishuUserId,
    });
    const session = await chatService.createSession({ workspaceId, name: 'feishu session', source: 'feishu' });
    workspaceStore.addUserSession(workspaceId, session.id, user.id);
    workspaceStore.setActiveUserSession(user.id, session.id);

    const handler = await importGetFeishuUserHandler();
    const res = createMockRes();
    await handler({ params: { id: workspaceId, sessionId: session.id } }, res);

    assert.strictEqual(res.statusCode, 200);
    const body = res.jsonBody as { userId: string; name: string | null };
    assert.strictEqual(body.userId, feishuUserId);
    assert.strictEqual(body.name, null);
  });
});

describe('chat route interrupt (clear-all)', { concurrency: false }, () => {
  beforeEach(() => {
    workspaceStore.resetData();
  });

  async function importInterruptHandler() {
    const mod = await import('./chat.js');
    const router = mod.default;
    const layers = (router as unknown as { stack: Array<{ route?: { methods: Record<string, boolean>; path: string; stack: Array<{ handle: (req: unknown, res: unknown) => Promise<void> }> } }> }).stack;
    for (const layer of layers) {
      if (layer.route?.path === '/sessions/:sessionId/interrupt' && layer.route.methods.post) {
        return layer.route.stack[layer.route.stack.length - 1].handle;
      }
    }
    throw new Error('POST /sessions/:sessionId/interrupt handler not found');
  }

  // Shadow chatService methods with own properties for the duration of one
  // test; deleting them on restore un-shadows the prototype methods.
  function stubChatService(overrides: Record<string, unknown>): { restore: () => void } {
    const target = chatService as unknown as Record<string, unknown>;
    const keys = Object.keys(overrides);
    for (const key of keys) {
      target[key] = overrides[key];
    }
    return {
      restore: () => {
        for (const key of keys) {
          delete target[key];
        }
      },
    };
  }

  it('returns 200 ok and never spawns a runtime when none exists', async () => {
    let createCalls = 0;
    const stub = stubChatService({
      getRuntimeIfExists: () => undefined,
      getOrCreateRuntime: () => {
        createCalls++;
        return Promise.reject(new Error('must not be called'));
      },
    });
    try {
      const handler = await importInterruptHandler();
      const res = createMockRes();
      await handler({ params: { id: 'ws-1', sessionId: 'sess-gone' } }, res);

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res.jsonBody, { ok: true });
      assert.strictEqual(createCalls, 0, 'getOrCreateRuntime must not be called');
    } finally {
      stub.restore();
    }
    assert.strictEqual(
      chatService.getRuntimeIfExists('sess-gone'),
      undefined,
      'no runtime created for a stale stop',
    );
  });

  it('invokes stopAll on the existing runtime', async () => {
    let stopAllCalls = 0;
    const fakeRuntime = {
      stopAll: async () => {
        stopAllCalls++;
      },
    };
    const stub = stubChatService({
      getRuntimeIfExists: () => fakeRuntime,
    });
    try {
      const handler = await importInterruptHandler();
      const res = createMockRes();
      await handler({ params: { id: 'ws-1', sessionId: 'sess-1' } }, res);

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res.jsonBody, { ok: true });
      assert.strictEqual(stopAllCalls, 1, 'stopAll invoked exactly once');
    } finally {
      stub.restore();
    }
  });

  it('maps a ChatError from stopAll to its status and code', async () => {
    const fakeRuntime = {
      stopAll: async () => {
        throw new ChatError('Session not found', 'SESSION_NOT_FOUND', 404);
      },
    };
    const stub = stubChatService({
      getRuntimeIfExists: () => fakeRuntime,
    });
    try {
      const handler = await importInterruptHandler();
      const res = createMockRes();
      await handler({ params: { id: 'ws-1', sessionId: 'sess-1' } }, res);

      assert.strictEqual(res.statusCode, 404);
      assert.deepStrictEqual(res.jsonBody, {
        error: 'Session not found',
        code: 'SESSION_NOT_FOUND',
      });
    } finally {
      stub.restore();
    }
  });

  it('falls back to 500 for unexpected errors', async () => {
    const fakeRuntime = {
      stopAll: async () => {
        throw new Error('disk gone');
      },
    };
    const stub = stubChatService({
      getRuntimeIfExists: () => fakeRuntime,
    });
    try {
      const handler = await importInterruptHandler();
      const res = createMockRes();
      await handler({ params: { id: 'ws-1', sessionId: 'sess-1' } }, res);

      assert.strictEqual(res.statusCode, 500);
      assert.deepStrictEqual(res.jsonBody, { error: 'Failed to interrupt' });
    } finally {
      stub.restore();
    }
  });
});
