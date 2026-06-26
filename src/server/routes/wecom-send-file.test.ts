import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import type { Workspace } from '../models/workspace.js';

describe('wecom-send-file routes', { concurrency: false }, () => {
  let originalGetWecomUserIdBySession: typeof workspaceStore.getWecomUserIdBySession;
  let originalGet: typeof workspaceStore.get;
  let originalGetWecomUserMapping: typeof workspaceStore.getWecomUserMapping;
  let originalSendFile: (
    workspaceId: string,
    toUser: string,
    filePath: string,
    isAdmin?: boolean,
  ) => Promise<void>;

  beforeEach(async () => {
    originalGetWecomUserIdBySession = workspaceStore.getWecomUserIdBySession.bind(workspaceStore);
    originalGet = workspaceStore.get.bind(workspaceStore);
    originalGetWecomUserMapping = workspaceStore.getWecomUserMapping.bind(workspaceStore);

    workspaceStore.get = async () => ({ id: 'ws-1', settings: {} } as unknown as Workspace);
    workspaceStore.getWecomUserMapping = () => null;

    const { wecomBotService } = await import('../services/wecom-bot-service.js');
    originalSendFile = wecomBotService.sendFile.bind(wecomBotService);
  });

  afterEach(() => {
    workspaceStore.getWecomUserIdBySession = originalGetWecomUserIdBySession;
    workspaceStore.get = originalGet;
    workspaceStore.getWecomUserMapping = originalGetWecomUserMapping;

    import('../services/wecom-bot-service.js').then(({ wecomBotService }) => {
      wecomBotService.sendFile = originalSendFile;
    });
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
    const mod = await import('./wecom-send-file.js');
    const router = mod.default;
    const layers = (router as unknown as {
      stack: Array<{
        route?: {
          methods: Record<string, boolean>;
          path: string;
          stack: Array<{ handle: (req: unknown, res: unknown) => Promise<void> }>;
        };
      }>;
    }).stack;
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

  it('returns 200 when sendFile succeeds', async () => {
    const handlers = await importRouteHandlers();
    workspaceStore.getWecomUserIdBySession = () => 'enc-alice';

    const { wecomBotService } = await import('../services/wecom-bot-service.js');
    let sendFileCalled = false;
    wecomBotService.sendFile = async (wsId, toUser, filePath) => {
      sendFileCalled = true;
      assert.strictEqual(wsId, 'ws-1');
      assert.strictEqual(toUser, 'bob');
      assert.strictEqual(filePath, 'docs/report.pdf');
    };

    const req = {
      params: { workspaceId: 'ws-1' },
      body: { sessionId: 'sid-1', toUser: 'bob', filePath: 'docs/report.pdf' },
    };
    const res = createMockRes();

    await handlers['/'].post(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.jsonBody, { sent: true });
    assert.strictEqual(sendFileCalled, true);
  });

  it('passes isAdmin=true to sendFile when the caller is an admin', async () => {
    const handlers = await importRouteHandlers();
    workspaceStore.getWecomUserIdBySession = () => 'enc-alice';
    workspaceStore.getWecomUserMapping = () => 'alice';
    workspaceStore.get = async () => ({
      id: 'ws-1',
      settings: {
        wecomBotIsolation: {
          adminUserIds: ['alice'],
          defaultAllowedSkills: [],
          adminAllowedSkills: [],
        },
      },
    } as unknown as Workspace);

    const { wecomBotService } = await import('../services/wecom-bot-service.js');
    let capturedIsAdmin: boolean | undefined;
    wecomBotService.sendFile = async (_wsId, _toUser, _filePath, isAdmin) => {
      capturedIsAdmin = isAdmin;
    };

    const req = {
      params: { workspaceId: 'ws-1' },
      body: { sessionId: 'sid-1', toUser: 'bob', filePath: 'docs/report.pdf' },
    };
    const res = createMockRes();

    await handlers['/'].post(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(capturedIsAdmin, true);
  });

  it('passes isAdmin=false to sendFile for non-admin callers', async () => {
    const handlers = await importRouteHandlers();
    workspaceStore.getWecomUserIdBySession = () => 'enc-alice';
    workspaceStore.getWecomUserMapping = () => 'alice';
    workspaceStore.get = async () => ({
      id: 'ws-1',
      settings: {
        wecomBotIsolation: {
          adminUserIds: ['admin-user'],
          defaultAllowedSkills: [],
          adminAllowedSkills: [],
        },
      },
    } as unknown as Workspace);

    const { wecomBotService } = await import('../services/wecom-bot-service.js');
    let capturedIsAdmin: boolean | undefined;
    wecomBotService.sendFile = async (_wsId, _toUser, _filePath, isAdmin) => {
      capturedIsAdmin = isAdmin;
    };

    const req = {
      params: { workspaceId: 'ws-1' },
      body: { sessionId: 'sid-1', toUser: 'bob', filePath: 'docs/report.pdf' },
    };
    const res = createMockRes();

    await handlers['/'].post(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(capturedIsAdmin, false);
  });

  it('returns 400 when sessionId is missing', async () => {
    const handlers = await importRouteHandlers();

    const req1 = { params: { workspaceId: 'ws-1' }, body: { toUser: 'bob', filePath: 'docs/report.pdf' } };
    const res1 = createMockRes();
    await handlers['/'].post(req1, res1);
    assert.strictEqual(res1.statusCode, 400);

    const req2 = { params: { workspaceId: 'ws-1' }, body: { sessionId: '', toUser: 'bob', filePath: 'docs/report.pdf' } };
    const res2 = createMockRes();
    await handlers['/'].post(req2, res2);
    assert.strictEqual(res2.statusCode, 400);
  });

  it('returns 400 when toUser is missing', async () => {
    const handlers = await importRouteHandlers();

    const req = { params: { workspaceId: 'ws-1' }, body: { sessionId: 'sid-1', filePath: 'docs/report.pdf' } };
    const res = createMockRes();
    await handlers['/'].post(req, res);
    assert.strictEqual(res.statusCode, 400);
  });

  it('returns 400 when filePath is missing', async () => {
    const handlers = await importRouteHandlers();

    const req = { params: { workspaceId: 'ws-1' }, body: { sessionId: 'sid-1', toUser: 'bob' } };
    const res = createMockRes();
    await handlers['/'].post(req, res);
    assert.strictEqual(res.statusCode, 400);
  });

  it('returns 400 when session is unknown', async () => {
    const handlers = await importRouteHandlers();
    workspaceStore.getWecomUserIdBySession = () => null;

    const req = {
      params: { workspaceId: 'ws-1' },
      body: { sessionId: 'sid-1', toUser: 'bob', filePath: 'docs/report.pdf' },
    };
    const res = createMockRes();

    await handlers['/'].post(req, res);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual((res.jsonBody as { error: string }).error, 'unknown_session');
  });

  it('returns 400 when sendFile throws a permission error', async () => {
    const handlers = await importRouteHandlers();
    workspaceStore.getWecomUserIdBySession = () => 'enc-alice';

    const { wecomBotService } = await import('../services/wecom-bot-service.js');
    wecomBotService.sendFile = async () => {
      throw new Error('File access denied: other-user-dir');
    };

    const req = {
      params: { workspaceId: 'ws-1' },
      body: { sessionId: 'sid-1', toUser: 'bob', filePath: 'data/ZhangWei/private.pdf' },
    };
    const res = createMockRes();

    await handlers['/'].post(req, res);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual((res.jsonBody as { error: string }).error, 'send_file_failed');
    assert.ok(((res.jsonBody as { message: string }).message).includes('other-user-dir'));
  });

  it('returns 503 when bot is not connected', async () => {
    const handlers = await importRouteHandlers();
    workspaceStore.getWecomUserIdBySession = () => 'enc-alice';

    const { wecomBotService } = await import('../services/wecom-bot-service.js');
    wecomBotService.sendFile = async () => {
      throw new Error('Bot for workspace ws-1 is not connected');
    };

    const req = {
      params: { workspaceId: 'ws-1' },
      body: { sessionId: 'sid-1', toUser: 'bob', filePath: 'docs/report.pdf' },
    };
    const res = createMockRes();

    await handlers['/'].post(req, res);

    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual((res.jsonBody as { error: string }).error, 'bot_not_connected');
  });

  it('returns 500 when sendFile throws an upload error', async () => {
    const handlers = await importRouteHandlers();
    workspaceStore.getWecomUserIdBySession = () => 'enc-alice';

    const { wecomBotService } = await import('../services/wecom-bot-service.js');
    wecomBotService.sendFile = async () => {
      throw new Error('upload failed');
    };

    const req = {
      params: { workspaceId: 'ws-1' },
      body: { sessionId: 'sid-1', toUser: 'bob', filePath: 'docs/report.pdf' },
    };
    const res = createMockRes();

    await handlers['/'].post(req, res);

    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual((res.jsonBody as { error: string }).error, 'send_file_failed');
  });
});
