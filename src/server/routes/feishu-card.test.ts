import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as lark from '@larksuiteoapi/node-sdk';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import type { Workspace } from '../models/workspace.js';

describe('feishu card route', { concurrency: false }, () => {
  const originalGet = workspaceStore.get.bind(workspaceStore);
  let invokeStub: ((input: unknown) => Promise<unknown>) | null = null;
  let originalInvoke: typeof lark.CardActionHandler.prototype.invoke;

  beforeEach(() => {
    originalInvoke = lark.CardActionHandler.prototype.invoke;
    lark.CardActionHandler.prototype.invoke = async (input: unknown) => {
      return invokeStub ? await invokeStub(input) : { toast: { type: 'success', content: 'ok' } };
    };
  });

  afterEach(() => {
    workspaceStore.get = originalGet;
    lark.CardActionHandler.prototype.invoke = originalInvoke;
  });

  function makeWorkspace(enabled = true): Workspace {
    return {
      id: 'ws-1',
      name: 'Test',
      folderPath: '/tmp/test',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      settings: {
        feishuBotEnabled: enabled,
        feishuEncryptKey: 'key',
        feishuVerificationToken: 'token',
      },
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

  async function importHandler() {
    const mod = await import('./feishu-card.js');
    const router = mod.default;
    const layers = (router as unknown as { stack: Array<{ route?: { methods: Record<string, boolean>; path: string; stack: Array<{ handle: (req: unknown, res: unknown) => Promise<void> } > } } > }).stack;
    for (const layer of layers) {
      if (layer.route?.path === '/:workspaceId' && layer.route.methods.post) {
        return layer.route.stack[layer.route.stack.length - 1].handle;
      }
    }
    throw new Error('route handler not found');
  }

  it('returns 404 when workspace does not exist', async () => {
    workspaceStore.get = async () => null;
    const handler = await importHandler();
    const res = createMockRes();
    await handler({ params: { workspaceId: 'missing' }, rawBody: '{}' }, res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual((res.jsonBody as { error: string }).error, 'Workspace not found');
  });

  it('returns 403 when Feishu bot is disabled', async () => {
    workspaceStore.get = async () => makeWorkspace(false);
    const handler = await importHandler();
    const res = createMockRes();
    await handler({ params: { workspaceId: 'ws-1' }, rawBody: '{}' }, res);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual((res.jsonBody as { error: string }).error, 'Feishu bot is not enabled for this workspace');
  });

  it('returns 400 for invalid JSON body', async () => {
    workspaceStore.get = async () => makeWorkspace();
    const handler = await importHandler();
    const res = createMockRes();
    await handler({ params: { workspaceId: 'ws-1' }, rawBody: 'not-json' }, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual((res.jsonBody as { error: string }).error, 'Invalid JSON body');
  });

  it('returns the card handler response on success', async () => {
    workspaceStore.get = async () => makeWorkspace();
    invokeStub = async () => ({ toast: { type: 'success', content: 'created' } });

    const handler = await importHandler();
    const res = createMockRes();
    await handler({ params: { workspaceId: 'ws-1' }, rawBody: '{"open_id":"user-1"}', headers: {} }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual((res.jsonBody as { toast: { content: string } }).toast.content, 'created');
  });
});