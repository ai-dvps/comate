import '../test-utils/test-env.js';
import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { feishuBotService } from '../services/feishu-bot-service.js';
import type { Workspace } from '../models/workspace.js';

describe('workspaces route Feishu connection', { concurrency: false }, () => {
  const originalGet = workspaceStore.get.bind(workspaceStore);
  const originalUpdate = workspaceStore.update.bind(workspaceStore);
  const originalGetFeishuActiveWorkspace = workspaceStore.getFeishuActiveWorkspace.bind(workspaceStore);
  const originalClearFeishuActiveWorkspace = workspaceStore.clearFeishuActiveWorkspace.bind(workspaceStore);
  const originalConnect = feishuBotService.connect.bind(feishuBotService);
  const originalDisconnect = feishuBotService.disconnect.bind(feishuBotService);
  const originalReconnectIfActive = feishuBotService.reconnectIfActive.bind(feishuBotService);

  afterEach(() => {
    workspaceStore.get = originalGet;
    workspaceStore.update = originalUpdate;
    workspaceStore.getFeishuActiveWorkspace = originalGetFeishuActiveWorkspace;
    workspaceStore.clearFeishuActiveWorkspace = originalClearFeishuActiveWorkspace;
    feishuBotService.connect = originalConnect;
    feishuBotService.disconnect = originalDisconnect;
    feishuBotService.reconnectIfActive = originalReconnectIfActive;
  });

  beforeEach(() => {
    workspaceStore.resetData();
  });

  function makeWorkspace(overrides?: Partial<Workspace>): Workspace {
    return {
      id: 'ws-1',
      name: 'Test',
      folderPath: '/tmp/test',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      settings: {},
      ...overrides,
    } as Workspace;
  }

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

  async function importPutHandler() {
    const mod = await import('./workspaces.js');
    const router = mod.default;
    const layers = (router as unknown as { stack: Array<{ route?: { methods: Record<string, boolean>; path: string; stack: Array<{ handle: (req: unknown, res: unknown) => Promise<void> } > } } > }).stack;
    for (const layer of layers) {
      if (layer.route?.path === '/:id' && layer.route.methods.put) {
        return layer.route.stack[layer.route.stack.length - 1].handle;
      }
    }
    throw new Error('PUT handler not found');
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

  it('does not connect Feishu when workspace settings enable it with credentials', async () => {
    workspaceStore.get = async () => makeWorkspace({
      settings: {
        feishuBotEnabled: false,
        feishuAppId: 'app-id',
        feishuAppSecret: 'app-secret',
      },
    });

    const updated = makeWorkspace({
      settings: {
        feishuBotEnabled: true,
        feishuAppId: 'app-id',
        feishuAppSecret: 'app-secret',
      },
    });
    workspaceStore.update = async () => updated;

    let connectedWorkspaceId: string | null = null;
    feishuBotService.connect = async (workspace: Workspace) => {
      connectedWorkspaceId = workspace.id;
    };
    feishuBotService.disconnect = () => undefined;
    feishuBotService.reconnectIfActive = async () => undefined;

    const handler = await importPutHandler();
    const res = createMockRes();
    await handler(
      {
        params: { id: 'ws-1' },
        body: {
          settings: {
            feishuBotEnabled: true,
            feishuAppId: 'app-id',
            feishuAppSecret: 'app-secret',
          },
        },
      },
      res,
    );

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(connectedWorkspaceId, null);
  });

  it('does not connect Feishu when enabled without credentials', async () => {
    workspaceStore.get = async () => makeWorkspace({ settings: { feishuBotEnabled: false } });
    const updated = makeWorkspace({ settings: { feishuBotEnabled: true } });
    workspaceStore.update = async () => updated;

    let connectedWorkspaceId: string | null = null;
    feishuBotService.connect = async (workspace: Workspace) => {
      connectedWorkspaceId = workspace.id;
    };
    feishuBotService.disconnect = () => undefined;
    feishuBotService.reconnectIfActive = async () => undefined;

    const handler = await importPutHandler();
    const res = createMockRes();
    await handler(
      { params: { id: 'ws-1' }, body: { settings: { feishuBotEnabled: true } } },
      res,
    );

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(connectedWorkspaceId, null);
  });

  it('does not disconnect Feishu when workspace settings disable it', async () => {
    workspaceStore.get = async () => makeWorkspace({
      settings: {
        feishuBotEnabled: true,
        feishuAppId: 'app-id',
        feishuAppSecret: 'app-secret',
      },
    });
    const updated = makeWorkspace({ settings: { feishuBotEnabled: false } });
    workspaceStore.update = async () => updated;
    workspaceStore.getFeishuActiveWorkspace = () => 'ws-1';

    let disconnected = false;
    let cleared = false;
    feishuBotService.connect = async () => undefined;
    feishuBotService.disconnect = () => {
      disconnected = true;
    };
    feishuBotService.reconnectIfActive = async () => undefined;
    workspaceStore.clearFeishuActiveWorkspace = () => {
      cleared = true;
    };

    const handler = await importPutHandler();
    const res = createMockRes();
    await handler(
      { params: { id: 'ws-1' }, body: { settings: { feishuBotEnabled: false } } },
      res,
    );

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(disconnected, false);
    assert.strictEqual(cleared, false);
  });

  describe('GET /api/workspaces/:id/feishu/users', () => {
    it('returns 404 when the workspace does not exist', async () => {
      workspaceStore.get = async () => null;

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

      workspaceStore.setFeishuWorkspaceUser(ws.id, 'ou-alice');
      await new Promise((resolve) => setTimeout(resolve, 5));
      workspaceStore.setFeishuWorkspaceUser(ws.id, 'ou-bob');

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

      workspaceStore.setFeishuWorkspaceUser(ws.id, 'ou-alice');
      workspaceStore.setFeishuWorkspaceUserName(ws.id, 'ou-alice', 'Alice', 'alice-uid');

      const handler = await importGetFeishuUsersHandler();
      const res = createMockRes();
      await handler({ params: { id: ws.id } }, res);

      assert.strictEqual(res.statusCode, 200);
      const body = res.jsonBody as { users: Array<{ openId: string; name: string; userId: string; namePending: boolean }> };
      assert.strictEqual(body.users.length, 1);
      assert.strictEqual(body.users[0].openId, 'ou-alice');
      assert.strictEqual(body.users[0].name, 'Alice');
      assert.strictEqual(body.users[0].userId, 'alice-uid');
      assert.strictEqual(body.users[0].namePending, false);
    });
  });
});