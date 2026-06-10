import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import type { WeComProactiveMessage } from '../models/wecom-proactive-message.js';

describe('wecom-queue routes', { concurrency: false }, () => {
  let originalGetEncryptedUserIdByPlaintext: typeof workspaceStore.getEncryptedUserIdByPlaintext;
  let originalGetWecomSession: typeof workspaceStore.getWecomSession;
  let originalEnqueueProactiveMessage: typeof workspaceStore.enqueueProactiveMessage;
  let originalListProactiveMessages: typeof workspaceStore.listProactiveMessages;
  let originalGetProactiveMessage: typeof workspaceStore.getProactiveMessage;
  let originalUpdateProactiveMessage: typeof workspaceStore.updateProactiveMessage;
  let originalDeleteProactiveMessage: typeof workspaceStore.deleteProactiveMessage;

  beforeEach(() => {
    originalGetEncryptedUserIdByPlaintext = workspaceStore.getEncryptedUserIdByPlaintext.bind(workspaceStore);
    originalGetWecomSession = workspaceStore.getWecomSession.bind(workspaceStore);
    originalEnqueueProactiveMessage = workspaceStore.enqueueProactiveMessage.bind(workspaceStore);
    originalListProactiveMessages = workspaceStore.listProactiveMessages.bind(workspaceStore);
    originalGetProactiveMessage = workspaceStore.getProactiveMessage.bind(workspaceStore);
    originalUpdateProactiveMessage = workspaceStore.updateProactiveMessage.bind(workspaceStore);
    originalDeleteProactiveMessage = workspaceStore.deleteProactiveMessage.bind(workspaceStore);
  });

  afterEach(() => {
    workspaceStore.getEncryptedUserIdByPlaintext = originalGetEncryptedUserIdByPlaintext;
    workspaceStore.getWecomSession = originalGetWecomSession;
    workspaceStore.enqueueProactiveMessage = originalEnqueueProactiveMessage;
    workspaceStore.listProactiveMessages = originalListProactiveMessages;
    workspaceStore.getProactiveMessage = originalGetProactiveMessage;
    workspaceStore.updateProactiveMessage = originalUpdateProactiveMessage;
    workspaceStore.deleteProactiveMessage = originalDeleteProactiveMessage;
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

  // Helper to dynamically import the route handlers so we can test them directly
  async function importRouteHandlers() {
    const mod = await import('./wecom-queue.js');
    const router = mod.default;
    // Express router stacks hold layer objects with route and handle
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

  it('enqueue returns 202 with valid recipient and session', async () => {
    const handlers = await importRouteHandlers();
    workspaceStore.getEncryptedUserIdByPlaintext = () => 'enc-b';
    workspaceStore.getWecomSession = () => 'session-b';
    workspaceStore.enqueueProactiveMessage = () =>
      ({ id: 'msg-1', status: 'pending' } as WeComProactiveMessage);

    const req = { params: { id: 'ws-1' }, body: { toUser: 'user-b', message: 'hello' } };
    const res = createMockRes();

    await handlers['/'].post(req, res);

    assert.strictEqual(res.statusCode, 202);
    assert.strictEqual((res.jsonBody as { id: string }).id, 'msg-1');
  });

  it('enqueue returns 400 when recipient not resolved', async () => {
    const handlers = await importRouteHandlers();
    workspaceStore.getEncryptedUserIdByPlaintext = () => null;

    const req = { params: { id: 'ws-1' }, body: { toUser: 'user-b', message: 'hello' } };
    const res = createMockRes();

    await handlers['/'].post(req, res);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual((res.jsonBody as { error: string }).error, 'recipient_not_resolved');
  });

  it('enqueue returns 400 when recipient has no session', async () => {
    const handlers = await importRouteHandlers();
    workspaceStore.getEncryptedUserIdByPlaintext = () => 'enc-b';
    workspaceStore.getWecomSession = () => null;

    const req = { params: { id: 'ws-1' }, body: { toUser: 'user-b', message: 'hello' } };
    const res = createMockRes();

    await handlers['/'].post(req, res);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual((res.jsonBody as { error: string }).error, 'recipient_no_session');
  });

  it('list returns entries for workspace', async () => {
    const handlers = await importRouteHandlers();
    const entries = [{ id: 'msg-1', status: 'pending' }] as WeComProactiveMessage[];
    workspaceStore.listProactiveMessages = () => entries;

    const req = { params: { id: 'ws-1' }, query: {} };
    const res = createMockRes();

    await handlers['/'].get(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual((res.jsonBody as { entries: unknown }).entries, entries);
  });

  it('list filters by status when provided', async () => {
    const handlers = await importRouteHandlers();
    const entries = [{ id: 'msg-1', status: 'failed' }] as WeComProactiveMessage[];
    workspaceStore.listProactiveMessages = (wsId, filter) => {
      assert.strictEqual(filter, 'failed');
      return entries;
    };

    const req = { params: { id: 'ws-1' }, query: { status: 'failed' } };
    const res = createMockRes();

    await handlers['/'].get(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual((res.jsonBody as { entries: unknown }).entries, entries);
  });

  it('retry resets failed entry to pending', async () => {
    const handlers = await importRouteHandlers();
    workspaceStore.getProactiveMessage = () =>
      ({ id: 'msg-1', status: 'failed', retryCount: 0 } as WeComProactiveMessage);
    let updatedRetryCount = -1;
    workspaceStore.updateProactiveMessage = (id, input) => {
      updatedRetryCount = input.retryCount ?? -1;
      return { id: 'msg-1', status: 'pending', retryCount: updatedRetryCount } as WeComProactiveMessage;
    };

    const req = { params: { id: 'ws-1', entryId: 'msg-1' }, body: {} };
    const res = createMockRes();

    await handlers['/:entryId/retry'].post(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(updatedRetryCount, 1);
  });

  it('retry returns 404 for non-existent entry', async () => {
    const handlers = await importRouteHandlers();
    workspaceStore.getProactiveMessage = () => null;

    const req = { params: { id: 'ws-1', entryId: 'msg-1' }, body: {} };
    const res = createMockRes();

    await handlers['/:entryId/retry'].post(req, res);

    assert.strictEqual(res.statusCode, 404);
  });

  it('delete removes entry', async () => {
    const handlers = await importRouteHandlers();
    workspaceStore.deleteProactiveMessage = () => true;

    const req = { params: { id: 'ws-1', entryId: 'msg-1' } };
    const res = createMockRes();

    await handlers['/:entryId'].delete(req, res);

    assert.strictEqual(res.statusCode, 204);
  });

  it('delete returns 404 for non-existent entry', async () => {
    const handlers = await importRouteHandlers();
    workspaceStore.deleteProactiveMessage = () => false;

    const req = { params: { id: 'ws-1', entryId: 'msg-1' } };
    const res = createMockRes();

    await handlers['/:entryId'].delete(req, res);

    assert.strictEqual(res.statusCode, 404);
  });
});
