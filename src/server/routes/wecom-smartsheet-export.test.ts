import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { wecomDocService } from '../services/wecom-doc-service.js';
import type { Workspace } from '../models/workspace.js';

describe('wecom-smartsheet-export routes', { concurrency: false }, () => {
  let origGet: typeof workspaceStore.get;
  let origExport: typeof wecomDocService.exportSmartsheetWorkbook;

  beforeEach(() => {
    origGet = workspaceStore.get.bind(workspaceStore);
    origExport = wecomDocService.exportSmartsheetWorkbook.bind(wecomDocService);
  });

  afterEach(() => {
    workspaceStore.get = origGet;
    wecomDocService.exportSmartsheetWorkbook = origExport;
  });

  function makeWorkspace(): Workspace {
    return {
      id: 'ws-1',
      name: 'Test',
      description: '',
      folderPath: '/tmp',
      settings: { wecomBotId: 'bot_123', wecomBotSecret: 'secret_456' },
      skills: [],
      mcpServers: [],
      hooks: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  function createMockRes() {
    const res = {
      statusCode: 200,
      jsonBody: undefined as unknown,
      sentBody: undefined as unknown,
      headers: {} as Record<string, string>,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      set(field: string, value: string) {
        this.headers[field] = value;
        return this;
      },
      json(body: unknown) {
        this.jsonBody = body;
      },
      send(body: unknown) {
        this.sentBody = body;
      },
    };
    return res;
  }

  async function getPostHandler() {
    const mod = await import('./wecom-smartsheet-export.js');
    const router = mod.default as unknown as {
      stack: Array<{
        route?: {
          path: string;
          methods: Record<string, boolean>;
          stack: Array<{ handle: (req: unknown, res: unknown) => Promise<void> }>;
        };
      }>;
    };
    const layer = router.stack.find((l) => l.route?.path === '/' && l.route.methods.post);
    assert.ok(layer?.route);
    return layer.route.stack[0].handle;
  }

  it('returns 200 with xlsx bytes on success', async () => {
    const handler = await getPostHandler();
    workspaceStore.get = (async () => makeWorkspace()) as typeof workspaceStore.get;
    const fakeBuffer = Buffer.from('PK-fake-xlsx');
    wecomDocService.exportSmartsheetWorkbook = async () => fakeBuffer;

    const req = { params: { workspaceId: 'ws-1' }, body: { docid: 'DOC1' } };
    const res = createMockRes();
    await handler(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(
      res.headers['Content-Type'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    assert.deepStrictEqual(res.sentBody, fakeBuffer);
  });

  it('returns 400 when docid is missing', async () => {
    const handler = await getPostHandler();
    workspaceStore.get = (async () => makeWorkspace()) as typeof workspaceStore.get;

    const req = { params: { workspaceId: 'ws-1' }, body: {} };
    const res = createMockRes();
    await handler(req, res);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual((res.jsonBody as { error: string }).error, 'docid is required');
  });

  it('returns 404 when workspace is unknown', async () => {
    const handler = await getPostHandler();
    workspaceStore.get = (async () => undefined) as typeof workspaceStore.get;

    const req = { params: { workspaceId: 'ws-x' }, body: { docid: 'DOC1' } };
    const res = createMockRes();
    await handler(req, res);

    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual((res.jsonBody as { error: string }).error, 'workspace_not_found');
  });

  it('returns 500 when the export throws', async () => {
    const handler = await getPostHandler();
    workspaceStore.get = (async () => makeWorkspace()) as typeof workspaceStore.get;
    wecomDocService.exportSmartsheetWorkbook = async () => {
      throw new Error('mcp boom');
    };

    const req = { params: { workspaceId: 'ws-1' }, body: { docid: 'DOC1' } };
    const res = createMockRes();
    await handler(req, res);

    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual((res.jsonBody as { error: string }).error, 'smartsheet_export_failed');
    assert.ok(((res.jsonBody as { message: string }).message).includes('mcp boom'));
  });
});
