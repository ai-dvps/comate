import '../test-utils/test-env.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { store as workspaceStore } from '../storage/sqlite-store.js';

describe('workspaces route Feishu users', { concurrency: false }, () => {
  afterEach(() => {
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

  async function importGetFeishuUsersHandler() {
    const mod = await import('./workspaces.js');
    const router = mod.default;
    const layers = (router as unknown as { stack: Array<{ route?: { methods: Record<string, boolean>; path: string; stack: Array<{ handle: (req: unknown, res: unknown) => Promise<void> }> } }> }).stack;
    for (const layer of layers) {
      if (layer.route?.path === '/:id/feishu/users' && layer.route.methods.get) {
        return layer.route.stack[layer.route.stack.length - 1].handle;
      }
    }
    throw new Error('GET /:id/feishu/users handler not found');
  }

  it('returns 404 when the workspace does not exist', async () => {
    const handler = await importGetFeishuUsersHandler();
    const res = createMockRes();
    await handler({ params: { id: 'missing' } }, res);

    assert.strictEqual(res.statusCode, 404);
  });

  it('returns an empty list when no Feishu users have been discovered', async () => {
    const ws = await workspaceStore.create({ name: 'Empty Users', folderPath: '/tmp/empty' });

    const handler = await importGetFeishuUsersHandler();
    const res = createMockRes();
    await handler({ params: { id: ws.id } }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.jsonBody, { users: [] });
  });

  it('returns users ordered by lastSeenAt DESC with namePending true when uncached', async () => {
    const ws = await workspaceStore.create({ name: 'Pending Users', folderPath: '/tmp/pending' });
    const bot = workspaceStore.createBot({ name: 'Feishu Bot', activeWorkspaceId: ws.id });
    const channel = workspaceStore.getBotChannelByKey(bot.id, 'feishu')!;
    const role = workspaceStore.getBotRoleByKey(bot.id, 'normal')!;

    workspaceStore.createBotUser({
      botId: bot.id,
      channelId: channel.id,
      roleId: role.id,
      channelUserId: 'ou-alice',
      plaintextUserId: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    workspaceStore.createBotUser({
      botId: bot.id,
      channelId: channel.id,
      roleId: role.id,
      channelUserId: 'ou-bob',
      plaintextUserId: null,
    });

    const handler = await importGetFeishuUsersHandler();
    const res = createMockRes();
    await handler({ params: { id: ws.id } }, res);

    assert.strictEqual(res.statusCode, 200);
    const body = res.jsonBody as { users: Array<{ openId: string; namePending: boolean }> };
    assert.strictEqual(body.users.length, 2);
    assert.strictEqual(body.users[0].openId, 'ou-bob');
    assert.strictEqual(body.users[1].openId, 'ou-alice');
    assert.strictEqual(body.users[0].namePending, true);
    assert.strictEqual(body.users[1].namePending, true);
  });

  it('returns cached names and marks namePending false', async () => {
    const ws = await workspaceStore.create({ name: 'Named Users', folderPath: '/tmp/named' });
    const bot = workspaceStore.createBot({ name: 'Feishu Bot', activeWorkspaceId: ws.id });
    const channel = workspaceStore.getBotChannelByKey(bot.id, 'feishu')!;
    const role = workspaceStore.getBotRoleByKey(bot.id, 'normal')!;

    workspaceStore.createBotUser({
      botId: bot.id,
      channelId: channel.id,
      roleId: role.id,
      channelUserId: 'ou-alice',
      plaintextUserId: 'alice-uid',
    });

    const handler = await importGetFeishuUsersHandler();
    const res = createMockRes();
    await handler({ params: { id: ws.id } }, res);

    assert.strictEqual(res.statusCode, 200);
    const body = res.jsonBody as { users: Array<{ openId: string; name: string; userId: string; namePending: boolean }> };
    assert.strictEqual(body.users.length, 1);
    assert.strictEqual(body.users[0].openId, 'ou-alice');
    assert.strictEqual(body.users[0].name, 'alice-uid');
    assert.strictEqual(body.users[0].userId, 'alice-uid');
    assert.strictEqual(body.users[0].namePending, false);
  });
});
