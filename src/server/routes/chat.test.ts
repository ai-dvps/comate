import '../test-utils/test-env.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { chatService } from '../services/chat-service.js';
import { botService } from '../services/bot-service.js';

describe('chat route Feishu user info', { concurrency: false }, () => {
  beforeEach(() => {
    workspaceStore.resetData();
  });

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
