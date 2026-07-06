import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { botService } from '../services/bot-service.js';
import { chatService } from '../services/chat-service.js';
import { wecomBotService } from '../services/wecom-bot-service.js';
import { wecomUserResolver } from '../services/wecom-user-resolver.js';
import { feishuBotService } from '../services/feishu-bot-service.js';
import { PluginSettingsService } from '../services/plugin-settings-service.js';
import type { CreateBotInput } from '../models/bot.js';

const validWecomBot: CreateBotInput = {
  name: 'WeCom Bot',
  activeWorkspaceId: 'ws-1',
};

function createWeComBot() {
  const bot = botService.createBot(validWecomBot);
  botService.updateChannelSettings(bot.id, 'wecom', {
    enabled: true,
    botId: 'wecom-bot-id',
    botSecret: 'wecom-bot-secret',
  });
  return bot;
}

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
  const mod = await import('./bots.js');
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
  const handlers: Record<
    string,
    Record<string, (req: unknown, res: unknown) => Promise<void>>
  > = {};
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

describe('bots routes', { concurrency: false }, () => {
  let originalConnectBotWecom: typeof wecomBotService.connectBot;
  let originalDisconnectBotWecom: typeof wecomBotService.disconnectBot;
  let originalUpdateConnectionForBotWecom: typeof wecomBotService.updateConnectionForBot;
  let originalGetBotStatusWecom: typeof wecomBotService.getBotStatus;
  let originalConnectBotFeishu: typeof feishuBotService.connectBot;
  let originalDisconnectBotFeishu: typeof feishuBotService.disconnectBot;
  let originalUpdateConnectionForBotFeishu: typeof feishuBotService.updateConnectionForBot;
  let originalGetBotStatusFeishu: typeof feishuBotService.getBotStatus;
  let originalScheduleRebuildsForBot: typeof chatService.scheduleRebuildsForBot;

  beforeEach(() => {
    workspaceStore.resetData();

    originalConnectBotWecom = wecomBotService.connectBot.bind(wecomBotService);
    originalDisconnectBotWecom = wecomBotService.disconnectBot.bind(wecomBotService);
    originalUpdateConnectionForBotWecom = wecomBotService.updateConnectionForBot.bind(wecomBotService);
    originalGetBotStatusWecom = wecomBotService.getBotStatus.bind(wecomBotService);

    originalConnectBotFeishu = feishuBotService.connectBot.bind(feishuBotService);
    originalDisconnectBotFeishu = feishuBotService.disconnectBot.bind(feishuBotService);
    originalUpdateConnectionForBotFeishu = feishuBotService.updateConnectionForBot.bind(feishuBotService);
    originalGetBotStatusFeishu = feishuBotService.getBotStatus.bind(feishuBotService);

    originalScheduleRebuildsForBot = chatService.scheduleRebuildsForBot.bind(chatService);

    wecomBotService.connectBot = async () => {};
    wecomBotService.disconnectBot = () => {};
    wecomBotService.updateConnectionForBot = async () => {};
    wecomBotService.getBotStatus = () => 'not_configured';

    feishuBotService.connectBot = async () => {};
    feishuBotService.disconnectBot = () => {};
    feishuBotService.updateConnectionForBot = async () => {};
    feishuBotService.getBotStatus = () => 'not_configured';

    chatService.scheduleRebuildsForBot = () => {};
  });

  afterEach(() => {
    wecomBotService.connectBot = originalConnectBotWecom;
    wecomBotService.disconnectBot = originalDisconnectBotWecom;
    wecomBotService.updateConnectionForBot = originalUpdateConnectionForBotWecom;
    wecomBotService.getBotStatus = originalGetBotStatusWecom;

    feishuBotService.connectBot = originalConnectBotFeishu;
    feishuBotService.disconnectBot = originalDisconnectBotFeishu;
    feishuBotService.updateConnectionForBot = originalUpdateConnectionForBotFeishu;
    feishuBotService.getBotStatus = originalGetBotStatusFeishu;

    chatService.scheduleRebuildsForBot = originalScheduleRebuildsForBot;
  });

  it('GET / returns a list of bots with redacted credentials', async () => {
    createWeComBot();
    const handlers = await importRouteHandlers();
    const res = createMockRes();
    await handlers['/'].get({}, res);
    assert.strictEqual(res.statusCode, 200);
    const body = res.jsonBody as { bots: Array<{ channelSettings: { wecom?: { botSecret?: unknown } } }> };
    assert.strictEqual(body.bots.length, 1);
    assert.strictEqual(body.bots[0].channelSettings.wecom?.botSecret, true);
  });

  it('POST / creates a bot and connects enabled providers', async () => {
    let connectedBotId: string | null = null;
    wecomBotService.connectBot = async (bot) => {
      connectedBotId = bot.id;
    };

    const handlers = await importRouteHandlers();
    const res = createMockRes();
    await handlers['/'].post({ body: { ...validWecomBot, channelSettings: { wecom: { enabled: true, botId: 'wecom-bot-id', botSecret: 'wecom-bot-secret' } } } }, res);

    assert.strictEqual(res.statusCode, 201);
    const body = res.jsonBody as { bot: { id: string } };
    assert.strictEqual(body.bot.id, connectedBotId);
  });

  it('POST / installs the built-in wecom plugin when creating a WeCom-enabled bot bound to a workspace', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'comate-bots-plugin-test-'));
    const originalHome = process.env.HOME;
    const originalTauriResourceDir = process.env.TAURI_RESOURCE_DIR;

    process.env.HOME = join(tempDir, 'user');
    process.env.TAURI_RESOURCE_DIR = tempDir;

    const marketplacePath = join(tempDir, 'claude-code-plugin');
    const workspacePath = join(tempDir, 'workspace');

    try {
      mkdirSync(join(tempDir, 'user', '.claude'), { recursive: true });
      mkdirSync(join(marketplacePath, 'plugins', 'wecom', '.claude-plugin'), { recursive: true });
      writeFileSync(
        join(marketplacePath, 'plugins', 'wecom', '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'wecom', version: '0.1.0' }),
      );
      mkdirSync(join(workspacePath, '.claude'), { recursive: true });

      const workspace = await workspaceStore.create({ name: 'WeCom Workspace', folderPath: workspacePath });

      const handlers = await importRouteHandlers();
      const res = createMockRes();
      await handlers['/'].post(
        {
          body: {
            name: 'Auto Plugin Bot',
            activeWorkspaceId: workspace.id,
            channelSettings: {
              wecom: { enabled: true, botId: 'wecom-bot-id', botSecret: 'wecom-bot-secret' },
            },
          },
        },
        res,
      );

      assert.strictEqual(res.statusCode, 201);

      const settingsService = new PluginSettingsService();
      const plugin = settingsService.getInstalledPlugin('project', 'wecom', workspacePath);
      assert.ok(plugin);
      assert.strictEqual(plugin!.id, 'wecom');
      assert.strictEqual(plugin!.enabled, true);
    } finally {
      if (originalHome !== undefined) {
        process.env.HOME = originalHome;
      } else {
        delete process.env.HOME;
      }
      if (originalTauriResourceDir !== undefined) {
        process.env.TAURI_RESOURCE_DIR = originalTauriResourceDir;
      } else {
        delete process.env.TAURI_RESOURCE_DIR;
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('POST / returns field-level errors for invalid WeCom credentials', async () => {
    const handlers = await importRouteHandlers();
    const res = createMockRes();
    await handlers['/'].post(
      {
        body: {
          name: 'Bad Bot',
          channelSettings: { wecom: { enabled: true } },
        },
      },
      res,
    );
    assert.strictEqual(res.statusCode, 400);
    const body = res.jsonBody as { error: string };
    assert.match(body.error, /botId is required/i);
  });

  it('POST / returns 400 when name is missing', async () => {
    const handlers = await importRouteHandlers();
    const res = createMockRes();
    await handlers['/'].post({ body: { channelSettings: {} } }, res);
    assert.strictEqual(res.statusCode, 400);
    const body = res.jsonBody as { error: string };
    assert.match(body.error, /name is required/i);
  });

  it('GET /:id returns bot and members', async () => {
    const bot = createWeComBot();
    botService.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'u-1', roleKey: 'owner' });
    const handlers = await importRouteHandlers();
    const res = createMockRes();
    await handlers['/:id'].get({ params: { id: bot.id } }, res);
    assert.strictEqual(res.statusCode, 200);
    const body = res.jsonBody as { members: unknown[] };
    assert.strictEqual(body.members.length, 1);
  });

  it('PUT /:id updates channel settings and reconnects enabled providers', async () => {
    const bot = createWeComBot();
    let reconnectedBotId: string | null = null;
    wecomBotService.connectBot = async (b) => {
      reconnectedBotId = b.id;
    };

    const handlers = await importRouteHandlers();
    const res = createMockRes();
    await handlers['/:id'].put(
      {
        params: { id: bot.id },
        body: {
          channelSettings: {
            wecom: {
              enabled: true,
              botId: 'new-id',
              botSecret: 'new-secret',
            },
          },
        },
      },
      res,
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(reconnectedBotId, bot.id);
    const body = res.jsonBody as { bot: { channelSettings: { wecom?: { botSecret?: unknown } } } };
    assert.strictEqual(body.bot.channelSettings.wecom?.botSecret, true);
  });

  it('POST / creates a bot with a persona and returns it', async () => {
    const handlers = await importRouteHandlers();
    const res = createMockRes();
    await handlers['/'].post(
      {
        body: {
          name: "WeCom Bot", activeWorkspaceId: "ws-1",
          persona: { prompt: 'Hello, I am a bot', mode: 'append' as const },
        },
      },
      res,
    );
    assert.strictEqual(res.statusCode, 201);
    const body = res.jsonBody as { bot: { persona: { prompt: string; mode: string } } };
    assert.deepStrictEqual(body.bot.persona, { prompt: 'Hello, I am a bot', mode: 'append' });
  });

  it('PUT /:id updates the bot persona and returns it', async () => {
    const bot = createWeComBot();
    const handlers = await importRouteHandlers();
    const res = createMockRes();
    await handlers['/:id'].put(
      {
        params: { id: bot.id },
        body: { persona: { prompt: 'Updated persona', mode: 'replace' as const } },
      },
      res,
    );
    assert.strictEqual(res.statusCode, 200);
    const body = res.jsonBody as { bot: { persona: { prompt: string; mode: string } } };
    assert.deepStrictEqual(body.bot.persona, { prompt: 'Updated persona', mode: 'replace' });
  });

  it('GET /:id returns the bot persona', async () => {
    const bot = botService.createBot({
      name: "WeCom Bot", activeWorkspaceId: "ws-1",
      persona: { prompt: 'Intro persona', mode: 'append' as const },
    });
    const handlers = await importRouteHandlers();
    const res = createMockRes();
    await handlers['/:id'].get({ params: { id: bot.id } }, res);
    assert.strictEqual(res.statusCode, 200);
    const body = res.jsonBody as { bot: { persona: { prompt: string; mode: string } } };
    assert.deepStrictEqual(body.bot.persona, { prompt: 'Intro persona', mode: 'append' });
  });

  it('GET / returns bots with persona unredacted', async () => {
    botService.createBot({
      name: "WeCom Bot", activeWorkspaceId: "ws-1",
      persona: { prompt: 'Listed persona', mode: 'replace' as const },
    });
    const handlers = await importRouteHandlers();
    const res = createMockRes();
    await handlers['/'].get({}, res);
    assert.strictEqual(res.statusCode, 200);
    const body = res.jsonBody as { bots: Array<{ persona: { prompt: string; mode: string } }> };
    assert.strictEqual(body.bots.length, 1);
    assert.deepStrictEqual(body.bots[0].persona, { prompt: 'Listed persona', mode: 'replace' });
  });

  it('DELETE /:id disconnects providers and removes the bot', async () => {
    const bot = createWeComBot();
    let disconnectedWecomBotId: string | null = null;
    wecomBotService.disconnectBot = (id) => {
      disconnectedWecomBotId = id;
    };

    const handlers = await importRouteHandlers();
    const res = createMockRes();
    await handlers['/:id'].delete({ params: { id: bot.id } }, res);
    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(disconnectedWecomBotId, bot.id);
    assert.strictEqual(botService.getBot(bot.id), null);
  });

  it('POST /:id/active-workspace returns 400 for already-bound workspace', async () => {
    const workspace = await workspaceStore.create({ name: 'WS A', folderPath: '/tmp/a' });
    const botA = botService.createBot({
      name: 'A',
      activeWorkspaceId: workspace.id,
    });
    botService.updateChannelSettings(botA.id, 'wecom', { enabled: true, botId: 'a', botSecret: 's' });
    const botB = botService.createBot({
      name: 'B',
      activeWorkspaceId: 'ws-other',
    });
    botService.updateChannelSettings(botB.id, 'wecom', { enabled: true, botId: 'b', botSecret: 's' });
    botService.addMember(botB.id, { channelKey: 'wecom', channelUserId: 'owner', roleKey: 'owner' });

    const handlers = await importRouteHandlers();
    const res = createMockRes();
    await handlers['/:id/active-workspace'].post(
      { params: { id: botB.id }, body: { workspaceId: workspace.id } },
      res,
    );
    assert.strictEqual(res.statusCode, 400);
    const body = res.jsonBody as { error: string };
    assert.match(body.error, /已被其他 bot 激活绑定/);

    // botA binding should remain untouched
    assert.strictEqual(botService.getBot(botA.id)?.activeWorkspaceId, workspace.id);
  });

  it('POST /:id/active-workspace switches workspace and updates routing', async () => {
    const ws1 = await workspaceStore.create({ name: 'WS 1', folderPath: '/tmp/1' });
    const ws2 = await workspaceStore.create({ name: 'WS 2', folderPath: '/tmp/2' });
    const bot = botService.createBot({
      name: 'Mover',
      activeWorkspaceId: ws1.id,
    });
    botService.updateChannelSettings(bot.id, 'wecom', { enabled: true, botId: 'm', botSecret: 's' });

    let routedBotId: string | null = null;
    let routedWorkspaceId: string | null = null;
    wecomBotService.getBotStatus = () => 'connected';
    wecomBotService.updateConnectionForBot = async (botId, workspaceId) => {
      routedBotId = botId;
      routedWorkspaceId = workspaceId;
    };

    const handlers = await importRouteHandlers();
    const res = createMockRes();
    await handlers['/:id/active-workspace'].post(
      { params: { id: bot.id }, body: { workspaceId: ws2.id } },
      res,
    );
    assert.strictEqual(res.statusCode, 200);
    const body = res.jsonBody as { bot: { activeWorkspaceId: string } };
    assert.strictEqual(body.bot.activeWorkspaceId, ws2.id);
    assert.strictEqual(routedBotId, bot.id);
    assert.strictEqual(routedWorkspaceId, ws2.id);
  });

  it('POST /:id/members adds a member', async () => {
    const bot = createWeComBot();
    const handlers = await importRouteHandlers();
    const res = createMockRes();
    await handlers['/:id/members'].post(
      {
        params: { id: bot.id },
        body: { channel: 'wecom', channelUserId: 'admin-1', role: 'admin' },
      },
      res,
    );
    assert.strictEqual(res.statusCode, 201);
    const body = res.jsonBody as { member: { roleKey: string } };
    assert.strictEqual(body.member.roleKey, 'admin');
  });

  it('POST /:id/members validates channel', async () => {
    const bot = createWeComBot();
    const handlers = await importRouteHandlers();
    const res = createMockRes();
    await handlers['/:id/members'].post(
      {
        params: { id: bot.id },
        body: { channel: 'slack', channelUserId: 'u-1', role: 'normal' },
      },
      res,
    );
    assert.strictEqual(res.statusCode, 400);
  });

  it('PUT /:id/members/:channelUserId/role updates a role', async () => {
    const bot = createWeComBot();
    botService.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'u-1', roleKey: 'normal' });
    const handlers = await importRouteHandlers();
    const res = createMockRes();
    await handlers['/:id/members/:channelUserId/role'].put(
      {
        params: { id: bot.id, channelUserId: 'u-1' },
        query: { channel: 'wecom' },
        body: { role: 'admin' },
      },
      res,
    );
    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(botService.getMemberRole(bot.id, 'wecom', 'u-1'), 'admin');
  });

  it('DELETE /:id/members/:channelUserId removes a member', async () => {
    const bot = createWeComBot();
    botService.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'u-1', roleKey: 'normal' });
    const handlers = await importRouteHandlers();
    const res = createMockRes();
    await handlers['/:id/members/:channelUserId'].delete(
      {
        params: { id: bot.id, channelUserId: 'u-1' },
        query: { channel: 'wecom' },
      },
      res,
    );
    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(botService.getMemberRole(bot.id, 'wecom', 'u-1'), null);
  });

  it('POST /:id/members/resolve-pending resolves WeCom pending members', async () => {
    const bot = createWeComBot();
    botService.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'enc-2', roleKey: 'normal' });

    const originalResolveImmediate = wecomUserResolver.resolveImmediate.bind(wecomUserResolver);
    wecomUserResolver.resolveImmediate = async (_workspaceId: string, encryptedUserId: string) => {
      if (encryptedUserId === 'enc-2') {
        botService.setMemberPlaintext(bot.id, 'wecom', encryptedUserId, 'plain-2');
        return 'plain-2';
      }
      throw new Error('unexpected');
    };

    try {
      const handlers = await importRouteHandlers();
      const res = createMockRes();
      await handlers['/:id/members/resolve-pending'].post({ params: { id: bot.id } }, res);
      assert.strictEqual(res.statusCode, 200);
      const body = res.jsonBody as { resolved: number; failed: number };
      assert.strictEqual(body.resolved, 1);
      assert.strictEqual(body.failed, 0);
    } finally {
      wecomUserResolver.resolveImmediate = originalResolveImmediate;
    }
  });

  it('POST /:id/members/resolve-pending counts Feishu as failed when no client', async () => {
    const bot = botService.createBot({
      name: "WeCom Bot", activeWorkspaceId: "ws-1",
      activeWorkspaceId: 'ws-f',
      channelSettings: { feishu: { enabled: true, appId: 'a', appSecret: 's' } },
    });
    botService.addMember(bot.id, { channelKey: 'feishu', channelUserId: 'open-1', roleKey: 'normal' });

    const handlers = await importRouteHandlers();
    const res = createMockRes();
    await handlers['/:id/members/resolve-pending'].post({ params: { id: bot.id } }, res);
    assert.strictEqual(res.statusCode, 200);
    const body = res.jsonBody as { resolved: number; failed: number };
    assert.strictEqual(body.resolved, 0);
    assert.strictEqual(body.failed, 1);
  });

  it('PUT /:id/members/:channelUserId/plaintext stores a manual WeCom mapping', async () => {
    const bot = createWeComBot();
    botService.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'enc-1', roleKey: 'normal' });

    const handlers = await importRouteHandlers();
    const res = createMockRes();
    await handlers['/:id/members/:channelUserId/plaintext'].put(
      {
        params: { id: bot.id, channelUserId: 'enc-1' },
        query: { channel: 'wecom' },
        body: { plaintextUserId: 'manual-1' },
      },
      res,
    );

    assert.strictEqual(res.statusCode, 200);
    const body = res.jsonBody as { member: { plaintextUserId: string; resolutionStatus: string } };
    assert.strictEqual(body.member.plaintextUserId, 'manual-1');
    assert.strictEqual(body.member.resolutionStatus, 'resolved');
  });

  it('PUT /:id/members/:channelUserId/plaintext rejects duplicate plaintext in workspace', async () => {
    const bot = createWeComBot();
    botService.ensureMember(bot.id, 'wecom', 'enc-1');
    botService.setMemberPlaintext(bot.id, 'wecom', 'enc-1', 'existing');
    botService.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'enc-2', roleKey: 'normal' });

    const handlers = await importRouteHandlers();
    const res = createMockRes();
    await handlers['/:id/members/:channelUserId/plaintext'].put(
      {
        params: { id: bot.id, channelUserId: 'enc-2' },
        query: { channel: 'wecom' },
        body: { plaintextUserId: 'existing' },
      },
      res,
    );

    assert.strictEqual(res.statusCode, 409);
  });

  it('PUT /:id/members/:channelUserId/plaintext rejects empty plaintext IDs', async () => {
    const bot = createWeComBot();
    botService.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'enc-1', roleKey: 'normal' });

    const handlers = await importRouteHandlers();
    const res = createMockRes();
    await handlers['/:id/members/:channelUserId/plaintext'].put(
      {
        params: { id: bot.id, channelUserId: 'enc-1' },
        query: { channel: 'wecom' },
        body: { plaintextUserId: '   ' },
      },
      res,
    );

    assert.strictEqual(res.statusCode, 400);
  });

  it('PUT /:id/members/:channelUserId/plaintext returns 404 for unknown members', async () => {
    const bot = createWeComBot();

    const handlers = await importRouteHandlers();
    const res = createMockRes();
    await handlers['/:id/members/:channelUserId/plaintext'].put(
      {
        params: { id: bot.id, channelUserId: 'no-such' },
        query: { channel: 'wecom' },
        body: { plaintextUserId: 'manual-1' },
      },
      res,
    );

    assert.strictEqual(res.statusCode, 404);
  });

  it('PUT /:id with persona change triggers runtime invalidation', async () => {
    const bot = createWeComBot();
    let invalidatedBotId: string | null = null;
    chatService.scheduleRebuildsForBot = (botId) => {
      invalidatedBotId = botId;
    };

    const handlers = await importRouteHandlers();
    const res = createMockRes();
    await handlers['/:id'].put(
      {
        params: { id: bot.id },
        body: { persona: { prompt: 'Updated', mode: 'replace' } },
      },
      res,
    );

    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(invalidatedBotId, bot.id);
  });

  it('PUT /:id with rolePersonas change triggers runtime invalidation', async () => {
    const bot = createWeComBot();
    let invalidatedBotId: string | null = null;
    chatService.scheduleRebuildsForBot = (botId) => {
      invalidatedBotId = botId;
    };

    const handlers = await importRouteHandlers();
    const res = createMockRes();
    await handlers['/:id'].put(
      {
        params: { id: bot.id },
        body: { rolePersonas: { owner: { prompt: 'Owner', mode: 'append' } } },
      },
      res,
    );

    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(invalidatedBotId, bot.id);
  });

  it('PUT /:id persists rolePolicy and returns it', async () => {
    const bot = createWeComBot();
    const handlers = await importRouteHandlers();
    const res = createMockRes();
    const rolePolicy = {
      normalToolPolicy: { posture: 'deny-all' as const, categoryDefaults: { fileRead: 'deny' as const } },
      skillAllowlist: ['skill-a'],
      bashWhitelist: ['ls'],
    };
    await handlers['/:id'].put({ params: { id: bot.id }, body: { rolePolicy } }, res);
    assert.strictEqual(res.statusCode, 200);
    const body = res.jsonBody as { bot: { rolePolicy: unknown } };
    assert.deepStrictEqual(body.bot.rolePolicy, rolePolicy);
    assert.deepStrictEqual(botService.getRolePolicy(bot.id), rolePolicy);
  });

  it('GET / returns bots with rolePolicy unredacted', async () => {
    const bot = createWeComBot();
    botService.updateRolePolicy(bot.id, {
      normalToolPolicy: { posture: 'allow-all' as const, categoryDefaults: { fileRead: 'allow' as const } },
      skillAllowlist: ['skill-b'],
      bashWhitelist: [],
    });
    const handlers = await importRouteHandlers();
    const res = createMockRes();
    await handlers['/'].get({}, res);
    assert.strictEqual(res.statusCode, 200);
    const body = res.jsonBody as { bots: Array<{ rolePolicy: unknown }> };
    assert.strictEqual(body.bots.length, 1);
    assert.deepStrictEqual(body.bots[0].rolePolicy.normalToolPolicy, {
      posture: 'allow-all',
      categoryDefaults: { fileRead: 'allow' },
    });
    assert.deepStrictEqual(body.bots[0].rolePolicy.skillAllowlist, ['skill-b']);
  });

  it('PUT /:id with rolePolicy change triggers runtime invalidation', async () => {
    const bot = createWeComBot();
    let invalidatedBotId: string | null = null;
    chatService.scheduleRebuildsForBot = (botId) => {
      invalidatedBotId = botId;
    };

    const handlers = await importRouteHandlers();
    const res = createMockRes();
    await handlers['/:id'].put(
      {
        params: { id: bot.id },
        body: {
          rolePolicy: {
            normalToolPolicy: {
              posture: 'deny-all',
              categoryDefaults: {},
            },
            skillAllowlist: [],
            bashWhitelist: [],
          },
        },
      },
      res,
    );

    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(invalidatedBotId, bot.id);
  });

  it('PUT /:id with name change does not trigger runtime invalidation', async () => {
    const bot = createWeComBot();
    let invalidatedBotId: string | null = 'not-called';
    chatService.scheduleRebuildsForBot = (botId) => {
      invalidatedBotId = botId;
    };

    const handlers = await importRouteHandlers();
    const res = createMockRes();
    await handlers['/:id'].put(
      {
        params: { id: bot.id },
        body: { name: 'Renamed' },
      },
      res,
    );

    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(invalidatedBotId, 'not-called');
  });

  it('POST /:id/members triggers runtime invalidation', async () => {
    const bot = createWeComBot();
    let invalidatedBotId: string | null = null;
    chatService.scheduleRebuildsForBot = (botId) => {
      invalidatedBotId = botId;
    };

    const handlers = await importRouteHandlers();
    const res = createMockRes();
    await handlers['/:id/members'].post(
      {
        params: { id: bot.id },
        body: { channel: 'wecom', channelUserId: 'admin-1', role: 'admin' },
      },
      res,
    );

    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(invalidatedBotId, bot.id);
  });

  it('PUT /:id/members/:channelUserId/role triggers runtime invalidation', async () => {
    const bot = createWeComBot();
    botService.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'u-1', roleKey: 'normal' });
    let invalidatedBotId: string | null = null;
    chatService.scheduleRebuildsForBot = (botId) => {
      invalidatedBotId = botId;
    };

    const handlers = await importRouteHandlers();
    const res = createMockRes();
    await handlers['/:id/members/:channelUserId/role'].put(
      {
        params: { id: bot.id, channelUserId: 'u-1' },
        query: { channel: 'wecom' },
        body: { role: 'admin' },
      },
      res,
    );

    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(invalidatedBotId, bot.id);
  });

  it('DELETE /:id/members/:channelUserId triggers runtime invalidation', async () => {
    const bot = createWeComBot();
    botService.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'u-1', roleKey: 'normal' });
    let invalidatedBotId: string | null = null;
    chatService.scheduleRebuildsForBot = (botId) => {
      invalidatedBotId = botId;
    };

    const handlers = await importRouteHandlers();
    const res = createMockRes();
    await handlers['/:id/members/:channelUserId'].delete(
      {
        params: { id: bot.id, channelUserId: 'u-1' },
        query: { channel: 'wecom' },
      },
      res,
    );

    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(invalidatedBotId, bot.id);
  });

  it('GET /:id/status returns channel statuses', async () => {
    const bot = createWeComBot();
    wecomBotService.getBotStatus = () => 'connected';
    feishuBotService.getBotStatus = () => 'not_configured';

    const handlers = await importRouteHandlers();
    const res = createMockRes();
    await handlers['/:id/status'].get({ params: { id: bot.id } }, res);
    assert.strictEqual(res.statusCode, 200);
    const body = res.jsonBody as { status: { wecom: string; feishu: string } };
    assert.strictEqual(body.status.wecom, 'connected');
    assert.strictEqual(body.status.feishu, 'not_configured');
  });

  it('POST /migrate runs migration and reports result', async () => {
    const handlers = await importRouteHandlers();
    const res = createMockRes();
    await handlers['/migrate'].post({ body: { dryRun: true } }, res);
    assert.strictEqual(res.statusCode, 200);
    const body = res.jsonBody as { result: { dryRun: boolean } };
    assert.strictEqual(body.result.dryRun, true);
  });
});
