import '../test-utils/test-env.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { SqliteStore } from '../storage/sqlite-store.js';
import { BotMigrationService } from './bot-migration-service.js';
import type { CreateWorkspaceInput } from '../models/workspace.js';

function createWorkspaceInput(overrides: Partial<CreateWorkspaceInput> = {}): CreateWorkspaceInput {
  return {
    name: 'Legacy Workspace',
    folderPath: '/tmp/legacy',
    settings: {
      wecomBotEnabled: true,
      wecomBotId: 'wecom-bot-1',
      wecomBotSecret: 'wecom-secret',
      wecomBotName: 'Legacy WeCom Bot',
      wecomToolPermissions: {
        posture: 'safe',
        categoryDefaults: {
          fileRead: 'allow',
          fileWrite: 'deny',
          shell: 'deny',
          network: 'deny',
          subagents: 'deny',
          reply: 'allow',
        },
      },
      wecomBotIsolation: {
        adminUserIds: ['admin-1'],
        defaultAllowedSkills: ['skill-a'],
        adminAllowedSkills: ['skill-b'],
      },
      feishuBotEnabled: true,
      feishuAppId: 'feishu-app-1',
      feishuAppSecret: 'feishu-secret',
      feishuAdminUserIds: ['feishu-admin-1'],
    },
    ...overrides,
  };
}

describe('BotMigrationService', { concurrency: false }, () => {
  let store: SqliteStore;
  let service: BotMigrationService;

  beforeEach(() => {
    store = new SqliteStore(':memory:');
    store.resetData();
    service = new BotMigrationService(store);
  });

  it('reports that migration has not run initially', () => {
    assert.strictEqual(service.hasMigrationRun(), false);
  });

  it('dry-run returns a preview without writing bots', async () => {
    const workspace = await store.create(createWorkspaceInput());
    store.setWecomWorkspaceUser(workspace.id, 'user-1');
    store.setFeishuWorkspaceUser(workspace.id, 'feishu-user-1');

    const result = await service.migrate({ dryRun: true });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.dryRun, true);
    assert.strictEqual(result.createdBots, 1);
    assert.strictEqual(result.preview?.length, 1);

    const preview = result.preview![0];
    assert.strictEqual(preview.workspaceId, workspace.id);
    assert.strictEqual(preview.botName, 'Legacy WeCom Bot');
    assert.deepStrictEqual(preview.providers.sort(), ['feishu', 'wecom']);

    assert.strictEqual(store.listBots().length, 0);
    assert.strictEqual(service.hasMigrationRun(), false);
  });

  it('migrates a workspace to a bot and cleans workspace settings', async () => {
    const workspace = await store.create(createWorkspaceInput());
    store.setWecomWorkspaceUser(workspace.id, 'user-1');
    store.setFeishuWorkspaceUser(workspace.id, 'feishu-user-1');

    const result = await service.migrate();

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.createdBots, 1);
    assert.strictEqual(service.hasMigrationRun(), true);

    const bots = store.listBots();
    assert.strictEqual(bots.length, 1);
    const bot = bots[0];
    assert.strictEqual(bot.name, 'Legacy WeCom Bot');
    assert.strictEqual(bot.activeWorkspaceId, workspace.id);
    assert.strictEqual(bot.providerSettings.wecom?.enabled, true);
    assert.strictEqual(bot.providerSettings.wecom?.botId, 'wecom-bot-1');
    assert.strictEqual(bot.providerSettings.feishu?.enabled, true);
    assert.strictEqual(bot.providerSettings.feishu?.appId, 'feishu-app-1');
    assert.deepStrictEqual(bot.rolePolicy.skillAllowlist, ['skill-a', 'skill-b']);

    const members = store.listBotMembers(bot.id);
    assert.ok(members.some((m) => m.provider === 'wecom' && m.providerUserId === 'admin-1' && m.role === 'admin'));
    assert.ok(members.some((m) => m.provider === 'wecom' && m.providerUserId === 'user-1' && m.role === 'normal'));
    assert.ok(members.some((m) => m.provider === 'feishu' && m.providerUserId === 'feishu-admin-1' && m.role === 'admin'));
    assert.ok(members.some((m) => m.provider === 'feishu' && m.providerUserId === 'feishu-user-1' && m.role === 'normal'));

    const migratedWorkspace = await store.get(workspace.id);
    assert.ok(migratedWorkspace);
    assert.strictEqual(migratedWorkspace!.settings.wecomBotId, undefined);
    assert.strictEqual(migratedWorkspace!.settings.wecomBotSecret, undefined);
    assert.strictEqual(migratedWorkspace!.settings.feishuAppId, undefined);
    assert.strictEqual(migratedWorkspace!.settings.feishuAppSecret, undefined);
    assert.deepStrictEqual(migratedWorkspace!.settings.sensitiveFileDenylist, []);
  });

  it('backfills bot_id for existing sessions', async () => {
    const workspace = await store.create(createWorkspaceInput());
    const session = store.createLocalSession(workspace.id, 'Legacy Session', undefined, undefined, 'wecom');

    const result = await service.migrate();

    assert.strictEqual(result.success, true);
    const bots = store.listBots();
    assert.strictEqual(bots.length, 1);
    const rows = (store as unknown as { db: { prepare: (sql: string) => { get: (...params: unknown[]) => unknown } } }).db
      .prepare('SELECT bot_id FROM sessions WHERE id = ?')
      .get(session.id) as { bot_id: string };
    assert.strictEqual(rows.bot_id, bots[0].id);
  });

  it('skips workspaces without bot credentials', async () => {
    await store.create({ name: 'Plain Workspace', folderPath: '/tmp/plain' });

    const result = await service.migrate();

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.createdBots, 0);
    assert.strictEqual(result.skippedWorkspaces, 1);
  });

  it('is idempotent and returns existing bots on rerun', async () => {
    await store.create(createWorkspaceInput());

    const first = await service.migrate();
    assert.strictEqual(first.success, true);
    assert.strictEqual(first.createdBots, 1);

    const second = await service.migrate();
    assert.strictEqual(second.success, true);
    assert.strictEqual(second.createdBots, 1);
    assert.strictEqual(store.listBots().length, 1);
  });

  it('rolls back and leaves settings intact when a write fails', async () => {
    const workspace = await store.create(createWorkspaceInput());

    const originalCreateBot = store.createBot.bind(store);
    store.createBot = (input) => {
      if (input.name === 'Legacy WeCom Bot') {
        throw new Error('simulated bot creation failure');
      }
      return originalCreateBot(input);
    };

    const result = await service.migrate();

    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.includes('simulated bot creation failure')));
    assert.strictEqual(store.listBots().length, 0);
    assert.strictEqual(service.hasMigrationRun(), false);

    const unchanged = await store.get(workspace.id);
    assert.strictEqual(unchanged?.settings.wecomBotId, 'wecom-bot-1');
  });
});
