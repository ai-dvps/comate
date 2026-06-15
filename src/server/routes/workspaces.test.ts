import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { chatService } from '../services/chat-service.js';

describe('workspaces routes', { concurrency: false }, () => {
  let originalDelete: typeof workspaceStore.delete;
  let originalCloseRuntimes: typeof chatService.closeRuntimesForWorkspace;

  beforeEach(() => {
    originalDelete = workspaceStore.delete.bind(workspaceStore);
    originalCloseRuntimes = chatService.closeRuntimesForWorkspace.bind(chatService);
  });

  afterEach(() => {
    workspaceStore.delete = originalDelete;
    chatService.closeRuntimesForWorkspace = originalCloseRuntimes;
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
});
