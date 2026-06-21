import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { chatService } from '../services/chat-service.js';
import type { Workspace } from '../models/workspace.js';

describe('workspaces routes', { concurrency: false }, () => {
  let originalDelete: typeof workspaceStore.delete;
  let originalCloseRuntimes: typeof chatService.closeRuntimesForWorkspace;
  let originalGet: typeof workspaceStore.get;
  let originalListPromptHistory: typeof workspaceStore.listPromptHistory;
  let originalPrunePromptHistory: typeof workspaceStore.prunePromptHistory;
  let originalCreatePromptHistory: typeof workspaceStore.createPromptHistory;
  let originalRecordLastOpened: typeof workspaceStore.recordLastOpened;

  beforeEach(() => {
    originalDelete = workspaceStore.delete.bind(workspaceStore);
    originalCloseRuntimes = chatService.closeRuntimesForWorkspace.bind(chatService);
    originalGet = workspaceStore.get.bind(workspaceStore);
    originalListPromptHistory = workspaceStore.listPromptHistory.bind(workspaceStore);
    originalPrunePromptHistory = workspaceStore.prunePromptHistory.bind(workspaceStore);
    originalCreatePromptHistory = workspaceStore.createPromptHistory.bind(workspaceStore);
    originalRecordLastOpened = workspaceStore.recordLastOpened.bind(workspaceStore);
  });

  afterEach(() => {
    workspaceStore.delete = originalDelete;
    chatService.closeRuntimesForWorkspace = originalCloseRuntimes;
    workspaceStore.get = originalGet;
    workspaceStore.listPromptHistory = originalListPromptHistory;
    workspaceStore.prunePromptHistory = originalPrunePromptHistory;
    workspaceStore.createPromptHistory = originalCreatePromptHistory;
    workspaceStore.recordLastOpened = originalRecordLastOpened;
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
    const mod = await import('./workspaces.js');
    const router = mod.default;
    const layers = (router as unknown as { stack: Array<{ route?: { methods: Record<string, boolean>; path: string; stack: Array<{ handle: (req: unknown, res: unknown) => Promise<void> } > } } > }).stack;
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

  it('DELETE returns 204 and evicts runtimes when workspace exists', async () => {
    const handlers = await importRouteHandlers();

    let deletedWorkspaceId: string | null = null;
    workspaceStore.delete = async (id: string) => {
      deletedWorkspaceId = id;
      return true;
    };

    let evictedWorkspaceId: string | null = null;
    chatService.closeRuntimesForWorkspace = async (id: string) => {
      evictedWorkspaceId = id;
    };

    const req = { params: { id: 'ws-1' } };
    const res = createMockRes();

    await handlers['/:id'].delete(req, res);

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(deletedWorkspaceId, 'ws-1');
    assert.strictEqual(evictedWorkspaceId, 'ws-1');
  });

  it('DELETE returns 404 when workspace does not exist', async () => {
    const handlers = await importRouteHandlers();

    workspaceStore.delete = async () => false;

    let evictedWorkspaceId: string | null = null;
    chatService.closeRuntimesForWorkspace = async (id: string) => {
      evictedWorkspaceId = id;
    };

    const req = { params: { id: 'missing-ws' } };
    const res = createMockRes();

    await handlers['/:id'].delete(req, res);

    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(
      (res.jsonBody as { error: string }).error,
      'Workspace not found',
    );
    assert.strictEqual(evictedWorkspaceId, null);
  });

  it('GET /:id/prompt-history returns pruned history for workspace', async () => {
    const handlers = await importRouteHandlers();

    workspaceStore.get = async () =>
      ({ settings: { promptHistoryRetentionDays: 30 } } as Workspace);
    let prunedWorkspaceId: string | null = null;
    let prunedDays: number | null = null;
    workspaceStore.prunePromptHistory = (workspaceId: string, days: number) => {
      prunedWorkspaceId = workspaceId;
      prunedDays = days;
      return 1;
    };
    workspaceStore.listPromptHistory = (workspaceId: string) => [
      { id: 'h1', workspaceId, sessionId: 's1', prompt: 'hello', createdAt: new Date().toISOString() },
    ];

    const req = { params: { id: 'ws-1' } };
    const res = createMockRes();

    await handlers['/:id/prompt-history'].get(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(prunedWorkspaceId, 'ws-1');
    assert.strictEqual(prunedDays, 30);
    const body = res.jsonBody as { prompts: Array<{ prompt: string }> };
    assert.strictEqual(body.prompts.length, 1);
    assert.strictEqual(body.prompts[0].prompt, 'hello');
  });

  it('GET /:id/prompt-history skips pruning when retention is not positive', async () => {
    const handlers = await importRouteHandlers();

    workspaceStore.get = async () =>
      ({ settings: { promptHistoryRetentionDays: 0 } } as Workspace);
    let pruneCalled = false;
    workspaceStore.prunePromptHistory = () => {
      pruneCalled = true;
      return 0;
    };
    workspaceStore.listPromptHistory = () => [];

    const req = { params: { id: 'ws-1' } };
    const res = createMockRes();

    await handlers['/:id/prompt-history'].get(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(pruneCalled, false);
  });

  it('GET /:id/prompt-history returns 404 when workspace does not exist', async () => {
    const handlers = await importRouteHandlers();

    workspaceStore.get = async () => null;

    const req = { params: { id: 'missing-ws' } };
    const res = createMockRes();

    await handlers['/:id/prompt-history'].get(req, res);

    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual((res.jsonBody as { error: string }).error, 'Workspace not found');
  });

  it('POST /:id/prompt-history creates a history entry', async () => {
    const handlers = await importRouteHandlers();

    workspaceStore.get = async () => ({ settings: {} } as Workspace);
    let createdWorkspaceId: string | null = null;
    let createdSessionId: string | null = null;
    let createdPrompt: string | null = null;
    workspaceStore.createPromptHistory = (workspaceId: string, sessionId: string, prompt: string) => {
      createdWorkspaceId = workspaceId;
      createdSessionId = sessionId;
      createdPrompt = prompt;
      return {
        id: 'h1',
        workspaceId,
        sessionId,
        prompt,
        createdAt: new Date().toISOString(),
      };
    };

    const req = { params: { id: 'ws-1' }, body: { sessionId: 's1', prompt: 'hello' } };
    const res = createMockRes();

    await handlers['/:id/prompt-history'].post(req, res);

    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(createdWorkspaceId, 'ws-1');
    assert.strictEqual(createdSessionId, 's1');
    assert.strictEqual(createdPrompt, 'hello');
  });

  it('POST /:id/prompt-history returns 400 for missing sessionId', async () => {
    const handlers = await importRouteHandlers();

    const req = { params: { id: 'ws-1' }, body: { prompt: 'hello' } };
    const res = createMockRes();

    await handlers['/:id/prompt-history'].post(req, res);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual((res.jsonBody as { error: string }).error, 'sessionId is required');
  });

  it('POST /:id/prompt-history returns 400 for empty prompt', async () => {
    const handlers = await importRouteHandlers();

    const req = { params: { id: 'ws-1' }, body: { sessionId: 's1', prompt: '   ' } };
    const res = createMockRes();

    await handlers['/:id/prompt-history'].post(req, res);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual((res.jsonBody as { error: string }).error, 'prompt cannot be empty');
  });

  it('POST /:id/open records last opened and returns workspace', async () => {
    const handlers = await importRouteHandlers();

    let recordedId: string | null = null;
    workspaceStore.recordLastOpened = async (id: string) => {
      recordedId = id;
      return { id, name: 'Opened', lastOpenedAt: new Date().toISOString() } as Workspace;
    };

    const req = { params: { id: 'ws-1' } };
    const res = createMockRes();

    await handlers['/:id/open'].post(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(recordedId, 'ws-1');
    const body = res.jsonBody as { workspace: Workspace };
    assert.strictEqual(body.workspace.id, 'ws-1');
    assert.ok(body.workspace.lastOpenedAt);
  });

  it('POST /:id/open returns 404 when workspace does not exist', async () => {
    const handlers = await importRouteHandlers();

    workspaceStore.recordLastOpened = async () => null;

    const req = { params: { id: 'missing-ws' } };
    const res = createMockRes();

    await handlers['/:id/open'].post(req, res);

    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual((res.jsonBody as { error: string }).error, 'Workspace not found');
  });
});