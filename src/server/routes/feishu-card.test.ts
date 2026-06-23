import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as lark from '@larksuiteoapi/node-sdk';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { parseCardActionValue, extractMenuEvent } from './feishu-card.js';
import type { Workspace } from '../models/workspace.js';

describe('feishu card route', { concurrency: false }, () => {
  const originalGet = workspaceStore.get.bind(workspaceStore);
  const originalGetFeishuActiveWorkspace = workspaceStore.getFeishuActiveWorkspace.bind(workspaceStore);
  let invokeStub: ((input: unknown) => Promise<unknown>) | null = null;
  let originalInvoke: typeof lark.EventDispatcher.prototype.invoke;

  beforeEach(() => {
    originalInvoke = lark.EventDispatcher.prototype.invoke;
    lark.EventDispatcher.prototype.invoke = async (input: unknown) => {
      return invokeStub ? await invokeStub(input) : { toast: { type: 'success', content: 'ok' } };
    };
  });

  afterEach(() => {
    workspaceStore.get = originalGet;
    workspaceStore.getFeishuActiveWorkspace = originalGetFeishuActiveWorkspace;
    lark.EventDispatcher.prototype.invoke = originalInvoke;
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

  async function importHandler(path: string) {
    const mod = await import('./feishu-card.js');
    const router = mod.default;
    const layers = (router as unknown as { stack: Array<{ route?: { methods: Record<string, boolean>; path: string; stack: Array<{ handle: (req: unknown, res: unknown) => Promise<void> }> } }> }).stack;
    for (const layer of layers) {
      if (layer.route?.path === path && layer.route.methods.post) {
        return layer.route.stack[layer.route.stack.length - 1].handle;
      }
    }
    throw new Error(`route handler not found for ${path}`);
  }

  it('returns 404 when workspace does not exist', async () => {
    workspaceStore.get = async () => null;
    const handler = await importHandler('/:workspaceId');
    const res = createMockRes();
    await handler({ params: { workspaceId: 'missing' }, rawBody: '{}' }, res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual((res.jsonBody as { error: string }).error, 'Workspace not found');
  });

  it('returns 403 when Feishu bot is disabled', async () => {
    workspaceStore.get = async () => makeWorkspace(false);
    const handler = await importHandler('/:workspaceId');
    const res = createMockRes();
    await handler({ params: { workspaceId: 'ws-1' }, rawBody: '{}' }, res);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual((res.jsonBody as { error: string }).error, 'Feishu bot is not enabled for this workspace');
  });

  it('returns 400 for invalid JSON body', async () => {
    workspaceStore.get = async () => makeWorkspace();
    const handler = await importHandler('/:workspaceId');
    const res = createMockRes();
    await handler({ params: { workspaceId: 'ws-1' }, rawBody: 'not-json' }, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual((res.jsonBody as { error: string }).error, 'Invalid JSON body');
  });

  it('returns the card handler response on success', async () => {
    workspaceStore.get = async () => makeWorkspace();
    let capturedInput: Record<string, unknown> | null = null;
    invokeStub = async (input: unknown) => {
      capturedInput = input as Record<string, unknown>;
      return { toast: { type: 'success', content: 'created' } };
    };

    const handler = await importHandler('/:workspaceId');
    const res = createMockRes();
    const reqHeaders = { 'x-request-id': 'req-1' };
    await handler({ params: { workspaceId: 'ws-1' }, rawBody: '{"schema":"2.0","header":{"event_type":"card.action.trigger"},"event":{"operator":{"open_id":"user-1"},"action":{"value":{"action":"create_session","workspaceId":"ws-1"},"tag":"button"},"context":{"open_message_id":"om-1","open_chat_id":"oc-1"}}}', headers: reqHeaders }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual((res.jsonBody as { toast: { content: string } }).toast.content, 'created');
    assert.ok(capturedInput, 'invoke should receive input');
    assert.strictEqual((capturedInput as Record<string, unknown>).headers, reqHeaders, 'headers should be accessible');
    assert.ok(!Object.prototype.hasOwnProperty.call(capturedInput, 'headers'), 'headers should not be an own enumerable property');
    assert.ok(!Object.keys(capturedInput ?? {}).includes('headers'), 'headers should not appear in JSON.stringify');
  });

  it('handles url_verification challenge', async () => {
    workspaceStore.get = async () => makeWorkspace();
    invokeStub = async () => ({ challenge: 'challenge-123' });

    const handler = await importHandler('/:workspaceId');
    const res = createMockRes();
    const body = JSON.stringify({ schema: '2.0', header: { event_type: 'url_verification' }, event: { challenge: 'challenge-123', type: 'url_verification' } });
    await handler({ params: { workspaceId: 'ws-1' }, rawBody: body, headers: {} }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual((res.jsonBody as { challenge: string }).challenge, 'challenge-123');
  });

  describe('root callback path /api/feishu/card', () => {
    it('returns 400 when there is no active Feishu workspace binding', async () => {
      workspaceStore.getFeishuActiveWorkspace = () => null;
      const handler = await importHandler('/');
      const res = createMockRes();
      await handler({ rawBody: '{}' }, res);
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual((res.jsonBody as { error: string }).error, 'No active Feishu workspace binding');
    });

    it('uses the active workspace binding and returns the card handler response', async () => {
      workspaceStore.getFeishuActiveWorkspace = () => 'ws-1';
      workspaceStore.get = async () => makeWorkspace();
      let capturedInput: Record<string, unknown> | null = null;
      invokeStub = async (input: unknown) => {
        capturedInput = input as Record<string, unknown>;
        return { toast: { type: 'success', content: 'selected' } };
      };

      const handler = await importHandler('/');
      const res = createMockRes();
      const reqHeaders = { 'x-request-id': 'req-2' };
      const body = JSON.stringify({
        schema: '2.0',
        header: { event_type: 'card.action.trigger' },
        event: {
          operator: { open_id: 'user-1' },
          action: { value: { action: 'select_session', workspaceId: 'ws-1', sessionId: 's-1' }, tag: 'button' },
          context: { open_message_id: 'om-1', open_chat_id: 'oc-1' },
        },
      });
      await handler({ rawBody: body, headers: reqHeaders }, res);

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual((res.jsonBody as { toast: { content: string } }).toast.content, 'selected');
      assert.ok(capturedInput, 'invoke should receive input');
      assert.strictEqual((capturedInput as Record<string, unknown>).headers, reqHeaders, 'headers should be accessible');
      assert.ok(!Object.prototype.hasOwnProperty.call(capturedInput, 'headers'), 'headers should not be an own enumerable property');
      assert.ok(!Object.keys(capturedInput ?? {}).includes('headers'), 'headers should not appear in JSON.stringify');
    });
  });

  describe('action.value payload parsing', () => {
    it('returns the object as-is when action.value is already an object', () => {
      const value = { action: 'select_session', workspaceId: 'ws-1', sessionId: 's-1' };
      assert.deepStrictEqual(parseCardActionValue(value), value);
    });

    it('parses action.value when it is a JSON string', () => {
      const value = { action: 'select_session', workspaceId: 'ws-1', sessionId: 's-1' };
      assert.deepStrictEqual(parseCardActionValue(JSON.stringify(value)), value);
    });

    it('returns null for non-object, non-string values', () => {
      assert.strictEqual(parseCardActionValue(123), null);
      assert.strictEqual(parseCardActionValue(null), null);
      assert.strictEqual(parseCardActionValue(undefined), null);
      assert.strictEqual(parseCardActionValue('{invalid'), null);
    });
  });

  describe('application.bot.menu_v6 extraction', () => {
    it('extracts operator.operator_id.open_id and event_key', () => {
      const { openId, eventKey } = extractMenuEvent({
        operator: { operator_id: { open_id: 'ou_menu' } },
        event_key: 'session',
      });
      assert.strictEqual(openId, 'ou_menu');
      assert.strictEqual(eventKey, 'session');
    });

    it('returns an empty open_id when operator.operator_id.open_id is missing', () => {
      const { openId, eventKey } = extractMenuEvent({ operator: {}, event_key: 'new' });
      assert.strictEqual(openId, '');
      assert.strictEqual(eventKey, 'new');
    });

    it('returns undefined event_key when event_key is not a string', () => {
      const { openId, eventKey } = extractMenuEvent({
        operator: { operator_id: { open_id: 'ou_menu' } },
        event_key: 42,
      });
      assert.strictEqual(openId, 'ou_menu');
      assert.strictEqual(eventKey, undefined);
    });
  });

  describe('application.bot.menu_v6 route handling', () => {
    function menuBody(eventKey = 'session', openId = 'ou_menu'): string {
      return JSON.stringify({
        schema: '2.0',
        header: { event_type: 'application.bot.menu_v6' },
        event: {
          operator: { operator_id: { open_id: openId } },
          event_key: eventKey,
        },
      });
    }

    function makeMenuWorkspace(overrides: Partial<Workspace['settings']> = {}): Workspace {
      return {
        ...makeWorkspace(),
        settings: {
          feishuBotEnabled: true,
          feishuAppId: 'app-1',
          feishuAppSecret: 'secret-1',
          feishuEncryptKey: 'key',
          feishuVerificationToken: 'token',
          ...overrides,
        },
      } as Workspace;
    }

    it('rejects a menu event with HTTP 400 when the workspace lacks app credentials', async () => {
      // makeWorkspace() has no feishuAppId / feishuAppSecret
      workspaceStore.get = async () => makeWorkspace();

      const handler = await importHandler('/:workspaceId');
      const res = createMockRes();
      await handler({ params: { workspaceId: 'ws-1' }, rawBody: menuBody(), headers: {} }, res);

      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(
        (res.jsonBody as { error: string }).error,
        'Workspace Feishu credentials or encryption key are not configured',
      );
    });

    it('rejects a menu event with HTTP 400 when the workspace lacks an encrypt key', async () => {
      workspaceStore.get = async () =>
        makeMenuWorkspace({ feishuEncryptKey: '' });

      const handler = await importHandler('/:workspaceId');
      const res = createMockRes();
      await handler({ params: { workspaceId: 'ws-1' }, rawBody: menuBody(), headers: {} }, res);

      assert.strictEqual(res.statusCode, 400);
    });

    it('admits a menu event when the workspace is fully configured', async () => {
      workspaceStore.get = async () => makeMenuWorkspace();
      invokeStub = async () => ({ toast: { type: 'success', content: '已处理。' } });

      const handler = await importHandler('/:workspaceId');
      const res = createMockRes();
      await handler(
        { params: { workspaceId: 'ws-1' }, rawBody: menuBody('session', 'ou_menu'), headers: {} },
        res,
      );

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual((res.jsonBody as { toast: { content: string } }).toast.content, '已处理。');
    });
  });
});
