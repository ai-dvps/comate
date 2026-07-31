import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { chatService } from '../services/chat-service.js';
import { botService } from '../services/bot-service.js';
import type { Workspace } from '../models/workspace.js';

describe('wecom-send-file routes', { concurrency: false }, () => {
  let originalSendFile: (
    workspaceId: string,
    toUser: string,
    filePath: string,
    isAdmin?: boolean,
  ) => Promise<void>;

  beforeEach(async () => {
    workspaceStore.resetData();

    const { wecomBotService } = await import('../services/wecom-bot-service.js');
    originalSendFile = wecomBotService.sendFile.bind(wecomBotService);
  });

  afterEach(() => {
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


  /**
   * U12: handlers derive identity from the session capability token stamped
   * by the loopback-auth middleware - tests stamp it directly.
   */
  function sessionAuth(sessionId: string, workspaceId: string) {
    return { loopbackAuth: { kind: 'session' as const, sessionId, workspaceId, botId: null } };
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

  async function createWorkspace(settings: Workspace['settings'] = {}) {
    return workspaceStore.create({
      name: 'Test Workspace',
      folderPath: '/tmp/test-workspace',
      settings,
    });
  }

  function createWecomBot(workspaceId: string) {
    return botService.createBot({
      name: 'WeCom Bot',
      activeWorkspaceId: workspaceId,
      channelSettings: {
        wecom: { enabled: true, corpId: 'test-corp', corpSecret: 'test-secret', agentId: 'test-agent' },
      },
    });
  }

  function addWecomUser(botId: string, channelUserId: string, plaintextUserId?: string) {
    return botService.addMember(botId, {
      channelKey: 'wecom',
      channelUserId,
      plaintextUserId,
    });
  }

  async function createWecomSession(workspaceId: string, userId: string) {
    const session = await chatService.createSession({ workspaceId, name: 'wecom session', source: 'wecom' });
    workspaceStore.addUserSession(workspaceId, session.id, userId);
    workspaceStore.setActiveUserSession(userId, session.id);
    return session;
  }

  it('returns 200 when sendFile succeeds', async () => {
    const workspace = await createWorkspace();
    const bot = createWecomBot(workspace.id);
    const user = addWecomUser(bot.id, 'enc-alice');
    const session = await createWecomSession(workspace.id, user.id);

    const handlers = await importRouteHandlers();

    const { wecomBotService } = await import('../services/wecom-bot-service.js');
    let sendFileCalled = false;
    wecomBotService.sendFile = async (wsId, toUser, filePath) => {
      sendFileCalled = true;
      assert.strictEqual(wsId, workspace.id);
      assert.strictEqual(toUser, 'bob');
      assert.strictEqual(filePath, 'docs/report.pdf');
    };

    const req = {
      ...sessionAuth(session.id, workspace.id),
      params: { workspaceId: workspace.id },
      body: { sessionId: session.id, toUser: 'bob', filePath: 'docs/report.pdf' },
    };
    const res = createMockRes();

    await handlers['/'].post(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.jsonBody, { sent: true });
    assert.strictEqual(sendFileCalled, true);
  });

  it('passes isAdmin=true to sendFile when the caller is an admin', async () => {
    const workspace = await createWorkspace({
      wecomBotIsolation: {
        adminUserIds: ['alice'],
        defaultAllowedSkills: [],
        adminAllowedSkills: [],
      },
    });
    const bot = createWecomBot(workspace.id);
    const user = addWecomUser(bot.id, 'enc-alice', 'alice');
    const session = await createWecomSession(workspace.id, user.id);

    const handlers = await importRouteHandlers();

    const { wecomBotService } = await import('../services/wecom-bot-service.js');
    let capturedIsAdmin: boolean | undefined;
    wecomBotService.sendFile = async (_wsId, _toUser, _filePath, isAdmin) => {
      capturedIsAdmin = isAdmin;
    };

    const req = {
      ...sessionAuth(session.id, workspace.id),
      params: { workspaceId: workspace.id },
      body: { sessionId: session.id, toUser: 'bob', filePath: 'docs/report.pdf' },
    };
    const res = createMockRes();

    await handlers['/'].post(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(capturedIsAdmin, true);
  });

  it('passes isAdmin=false to sendFile for non-admin callers', async () => {
    const workspace = await createWorkspace({
      wecomBotIsolation: {
        adminUserIds: ['admin-user'],
        defaultAllowedSkills: [],
        adminAllowedSkills: [],
      },
    });
    const bot = createWecomBot(workspace.id);
    const user = addWecomUser(bot.id, 'enc-alice', 'alice');
    const session = await createWecomSession(workspace.id, user.id);

    const handlers = await importRouteHandlers();

    const { wecomBotService } = await import('../services/wecom-bot-service.js');
    let capturedIsAdmin: boolean | undefined;
    wecomBotService.sendFile = async (_wsId, _toUser, _filePath, isAdmin) => {
      capturedIsAdmin = isAdmin;
    };

    const req = {
      ...sessionAuth(session.id, workspace.id),
      params: { workspaceId: workspace.id },
      body: { sessionId: session.id, toUser: 'bob', filePath: 'docs/report.pdf' },
    };
    const res = createMockRes();

    await handlers['/'].post(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(capturedIsAdmin, false);
  });

  it('body sessionId is optional — identity comes from the token (U12)', async () => {
    const workspace = await createWorkspace();
    const handlers = await importRouteHandlers();

    // No body sessionId at all: passes input validation, then fails at
    // unknown_session for the token-bound (unmapped) session.
    const req1 = {
      ...sessionAuth('sid-unknown', workspace.id),
      params: { workspaceId: workspace.id },
      body: { toUser: 'bob', filePath: 'docs/report.pdf' },
    };
    const res1 = createMockRes();
    await handlers['/'].post(req1, res1);
    assert.strictEqual(res1.statusCode, 400);
    assert.strictEqual((res1.jsonBody as { error: string }).error, 'unknown_session');

    // A self-asserted sessionId that disagrees with the token is rejected loudly.
    const req2 = {
      ...sessionAuth('sid-real', workspace.id),
      params: { workspaceId: workspace.id },
      body: { sessionId: 'sid-foreign', toUser: 'bob', filePath: 'docs/report.pdf' },
    };
    const res2 = createMockRes();
    await handlers['/'].post(req2, res2);
    assert.strictEqual(res2.statusCode, 403);
    assert.strictEqual((res2.jsonBody as { error: string }).error, 'session_mismatch');
  });

  it('rejects callers without a session capability token', async () => {
    const workspace = await createWorkspace();
    const handlers = await importRouteHandlers();

    const req = {
      params: { workspaceId: workspace.id },
      body: { toUser: 'bob', filePath: 'docs/report.pdf' },
    };
    const res = createMockRes();
    await handlers['/'].post(req, res);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual((res.jsonBody as { error: string }).error, 'forbidden');
  });

  it('returns 400 when toUser is missing', async () => {
    const workspace = await createWorkspace();
    const handlers = await importRouteHandlers();

    const req = {
      ...sessionAuth('sid-1', workspace.id),
      params: { workspaceId: workspace.id },
      body: { sessionId: 'sid-1', filePath: 'docs/report.pdf' },
    };
    const res = createMockRes();
    await handlers['/'].post(req, res);
    assert.strictEqual(res.statusCode, 400);
  });

  it('returns 400 when filePath is missing', async () => {
    const workspace = await createWorkspace();
    const handlers = await importRouteHandlers();

    const req = {
      ...sessionAuth('sid-1', workspace.id),
      params: { workspaceId: workspace.id },
      body: { sessionId: 'sid-1', toUser: 'bob' },
    };
    const res = createMockRes();
    await handlers['/'].post(req, res);
    assert.strictEqual(res.statusCode, 400);
  });

  it('returns 400 when session is unknown', async () => {
    const workspace = await createWorkspace();
    createWecomBot(workspace.id);

    const handlers = await importRouteHandlers();

    const req = {
      ...sessionAuth('sid-1', workspace.id),
      params: { workspaceId: workspace.id },
      body: { sessionId: 'sid-1', toUser: 'bob', filePath: 'docs/report.pdf' },
    };
    const res = createMockRes();

    await handlers['/'].post(req, res);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual((res.jsonBody as { error: string }).error, 'unknown_session');
  });

  it('returns 400 when sendFile throws a permission error', async () => {
    const workspace = await createWorkspace();
    const bot = createWecomBot(workspace.id);
    const user = addWecomUser(bot.id, 'enc-alice');
    const session = await createWecomSession(workspace.id, user.id);

    const handlers = await importRouteHandlers();

    const { wecomBotService } = await import('../services/wecom-bot-service.js');
    wecomBotService.sendFile = async () => {
      throw new Error('File access denied: other-user-dir');
    };

    const req = {
      ...sessionAuth(session.id, workspace.id),
      params: { workspaceId: workspace.id },
      body: { sessionId: session.id, toUser: 'bob', filePath: 'data/ZhangWei/private.pdf' },
    };
    const res = createMockRes();

    await handlers['/'].post(req, res);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual((res.jsonBody as { error: string }).error, 'send_file_failed');
    assert.ok(((res.jsonBody as { message: string }).message).includes('other-user-dir'));
  });

  it('returns 503 when bot is not connected', async () => {
    const workspace = await createWorkspace();
    const bot = createWecomBot(workspace.id);
    const user = addWecomUser(bot.id, 'enc-alice');
    const session = await createWecomSession(workspace.id, user.id);

    const handlers = await importRouteHandlers();

    const { wecomBotService } = await import('../services/wecom-bot-service.js');
    wecomBotService.sendFile = async () => {
      throw new Error(`Bot for workspace ${workspace.id} is not connected`);
    };

    const req = {
      ...sessionAuth(session.id, workspace.id),
      params: { workspaceId: workspace.id },
      body: { sessionId: session.id, toUser: 'bob', filePath: 'docs/report.pdf' },
    };
    const res = createMockRes();

    await handlers['/'].post(req, res);

    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual((res.jsonBody as { error: string }).error, 'bot_not_connected');
  });

  it('returns 500 when sendFile throws an upload error', async () => {
    const workspace = await createWorkspace();
    const bot = createWecomBot(workspace.id);
    const user = addWecomUser(bot.id, 'enc-alice');
    const session = await createWecomSession(workspace.id, user.id);

    const handlers = await importRouteHandlers();

    const { wecomBotService } = await import('../services/wecom-bot-service.js');
    wecomBotService.sendFile = async () => {
      throw new Error('upload failed');
    };

    const req = {
      ...sessionAuth(session.id, workspace.id),
      params: { workspaceId: workspace.id },
      body: { sessionId: session.id, toUser: 'bob', filePath: 'docs/report.pdf' },
    };
    const res = createMockRes();

    await handlers['/'].post(req, res);

    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual((res.jsonBody as { error: string }).error, 'send_file_failed');
  });
});
