import '../test-utils/test-env.js';
import { describe, it, afterEach } from 'node:test';
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

  it('connects Feishu when newly enabled with credentials', async () => {
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
    assert.strictEqual(connectedWorkspaceId, 'ws-1');
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

  it('disconnects and clears active binding when Feishu is disabled', async () => {
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
    assert.strictEqual(disconnected, true);
    assert.strictEqual(cleared, true);
  });
});