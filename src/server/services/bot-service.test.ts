import '../test-utils/test-env.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { SqliteStore } from '../storage/sqlite-store.js';
import {
  BotAuthorizationError,
  BotNotFoundError,
  BotService,
  BotUserNotFoundError,
  BotValidationError,
  BotWorkspaceBoundError,
} from './bot-service.js';
import type { BotRoleKey, CreateBotInput, BotChannelSettings, BotRolePolicy, BotPersona } from '../models/bot.js';

const systemActor = { type: 'system' as const };
const wecomOwner = { type: 'wecom' as const, channelKey: 'wecom' as const, channelUserId: 'owner-1' };
const wecomNormal = { type: 'wecom' as const, channelKey: 'wecom' as const, channelUserId: 'normal-1' };

function createBotInput(overrides: Partial<CreateBotInput> = {}): CreateBotInput {
  return {
    name: 'Test Bot',
    activeWorkspaceId: 'ws-1',
    ...overrides,
  };
}

function createBotWithDefaults(
  service: BotService,
  overrides: Partial<CreateBotInput> & {
    channelSettings?: BotChannelSettings;
    rolePolicy?: BotRolePolicy;
    rolePersonas?: Partial<Record<BotRoleKey, BotPersona>>;
  } = {},
) {
  const { channelSettings, rolePolicy, rolePersonas, ...botInput } = overrides;
  const bot = service.createBot({
    name: botInput.name ?? 'Test Bot',
    activeWorkspaceId: botInput.activeWorkspaceId ?? 'ws-1',
    persona: botInput.persona,
  });

  if (channelSettings) {
    for (const channelKey of Object.keys(channelSettings) as BotRoleKey[]) {
      const settings = channelSettings[channelKey as keyof BotChannelSettings];
      if (settings) {
        service.updateChannelSettings(bot.id, channelKey as 'wecom' | 'feishu', settings);
      }
    }
  }

  if (rolePolicy) {
    service.updateRolePolicy(bot.id, rolePolicy);
  }

  if (rolePersonas) {
    service.updateRolePersonas(bot.id, rolePersonas);
  }

  return bot;
}

describe('BotService', { concurrency: false }, () => {
  let store: SqliteStore;
  let service: BotService;

  beforeEach(() => {
    store = new SqliteStore(':memory:');
    store.resetData();
    service = new BotService(store);
  });

  describe('createBot', () => {
    it('creates a bot with valid credentials', () => {
      const bot = createBotWithDefaults(service, {
        channelSettings: {
          wecom: { enabled: true, botId: 'wecom-bot', botSecret: 'wecom-secret' },
        },
      });
      assert.strictEqual(bot.name, 'Test Bot');
      assert.strictEqual(bot.activeWorkspaceId, 'ws-1');

      const logs = store.listAuditLogs(bot.id);
      assert.ok(logs.some((l) => l.eventType === 'bot_created' && l.details.name === 'Test Bot'));
    });

    it('creates a bot with a persona', () => {
      const persona = { prompt: 'You are an operations assistant.', mode: 'append' as const };
      const bot = service.createBot(createBotInput({ persona }));
      assert.deepStrictEqual(bot.persona, persona);
      assert.deepStrictEqual(service.getBot(bot.id)?.persona, persona);
    });

    it('creates a bot with role personas', () => {
      const rolePersonas: Partial<Record<BotRoleKey, { prompt: string; mode: 'append' | 'replace' }>> = {
        owner: { prompt: 'Owner persona.', mode: 'append' },
        normal: { prompt: 'Normal persona.', mode: 'replace' },
      };
      const bot = createBotWithDefaults(service, { rolePersonas });
      assert.deepStrictEqual(service.getRolePersona(bot.id, 'owner'), rolePersonas.owner);
      assert.deepStrictEqual(service.getRolePersona(bot.id, 'normal'), rolePersonas.normal);
    });

    it('returns all role personas via getRolePersonas', () => {
      const rolePersonas: Partial<Record<BotRoleKey, { prompt: string; mode: 'append' | 'replace' }>> = {
        owner: { prompt: 'Owner persona.', mode: 'append' },
        admin: { prompt: 'Admin persona.', mode: 'replace' },
      };
      const bot = createBotWithDefaults(service, { rolePersonas });
      assert.deepStrictEqual(service.getRolePersonas(bot.id), {
        owner: rolePersonas.owner,
        admin: rolePersonas.admin,
      });
    });

    it('throws when enabled WeCom credentials are missing', () => {
      const bot = service.createBot(createBotInput());
      assert.throws(
        () => service.updateChannelSettings(bot.id, 'wecom', { enabled: true }),
        BotValidationError,
      );
    });

    it('normalizes a custom Feishu server URL before persistence', () => {
      const bot = service.createBot(createBotInput());

      service.updateChannelSettings(bot.id, 'feishu', {
        enabled: true,
        appId: 'feishu-app',
        appSecret: 'feishu-secret',
        serverUrl: '  https://Feishu.Internal.Example:8443/  ',
      });

      assert.strictEqual(
        service.getChannelSettings(bot.id).feishu?.serverUrl,
        'https://feishu.internal.example:8443',
      );
    });

    it('treats a blank Feishu server URL as unset', () => {
      const bot = service.createBot(createBotInput());

      service.updateChannelSettings(bot.id, 'feishu', {
        enabled: true,
        appId: 'feishu-app',
        appSecret: 'feishu-secret',
        serverUrl: '   ',
      });

      assert.strictEqual(service.getChannelSettings(bot.id).feishu?.serverUrl, undefined);
    });

    it('accepts private HTTPS hosts and rejects unsafe Feishu server URLs', () => {
      const bot = service.createBot(createBotInput());
      const validUrls = [
        'https://feishu.internal',
        'https://10.0.0.8:8443',
        'https://[fd00::8]:8443',
      ];

      for (const serverUrl of validUrls) {
        assert.doesNotThrow(() => service.updateChannelSettings(bot.id, 'feishu', {
          enabled: true,
          appId: 'feishu-app',
          appSecret: 'feishu-secret',
          serverUrl,
        }));
      }

      const invalidUrls = [
        'http://feishu.internal',
        'not-a-url',
        'https://user:password@feishu.internal',
        'https://feishu.internal?tenant=1',
        'https://feishu.internal#fragment',
        'https://feishu.internal/open-apis',
      ];
      for (const serverUrl of invalidUrls) {
        assert.throws(
          () => service.updateChannelSettings(bot.id, 'feishu', {
            enabled: true,
            appId: 'feishu-app',
            appSecret: 'feishu-secret',
            serverUrl,
          }),
          BotValidationError,
        );
      }
    });

    it('throws when binding a workspace already bound to another bot', () => {
      service.createBot(createBotInput({ activeWorkspaceId: 'ws-shared' }));
      assert.throws(
        () => service.createBot(createBotInput({ name: 'Second Bot', activeWorkspaceId: 'ws-shared' })),
        BotWorkspaceBoundError,
      );
    });
  });

  describe('setActiveWorkspace', () => {
    it('switches active workspace when actor is owner', () => {
      const bot = createBotWithDefaults(service);
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'owner-1', roleKey: 'owner' });

      const updated = service.setActiveWorkspace(bot.id, 'ws-2', wecomOwner);
      assert.strictEqual(updated.activeWorkspaceId, 'ws-2');

      const logs = store.listAuditLogs(bot.id);
      assert.ok(logs.some((l) =>
        l.eventType === 'active_workspace_switched' &&
        l.details.previousWorkspaceId === 'ws-1' &&
        l.details.newWorkspaceId === 'ws-2'
      ));
    });

    it('rejects workspace switch by non-owner', () => {
      const bot = createBotWithDefaults(service);
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'owner-1', roleKey: 'owner' });
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'normal-1', roleKey: 'normal' });

      assert.throws(
        () => service.setActiveWorkspace(bot.id, 'ws-2', wecomNormal),
        BotAuthorizationError,
      );
    });

    it('rejects binding an already-bound workspace', () => {
      service.createBot(createBotInput({ activeWorkspaceId: 'ws-shared' }));
      const botB = createBotWithDefaults(service, { name: 'B', activeWorkspaceId: 'ws-2' });
      service.addMember(botB.id, { channelKey: 'wecom', channelUserId: 'owner-2', roleKey: 'owner' });

      assert.throws(
        () => service.setActiveWorkspace(botB.id, 'ws-shared', { type: 'wecom', channelKey: 'wecom', channelUserId: 'owner-2' }),
        BotWorkspaceBoundError,
      );
    });
  });

  describe('member roles', () => {
    it('defaults new members to normal', () => {
      const bot = createBotWithDefaults(service);
      const member = service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'u-1' });
      assert.strictEqual(member.roleKey, 'normal');
    });

    it('allows only one owner', () => {
      const bot = createBotWithDefaults(service);
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'owner-1', roleKey: 'owner' });

      assert.throws(
        () => service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'owner-2', roleKey: 'owner' }),
        BotAuthorizationError,
      );
    });

    it('rejects promoting a second owner before demoting the first', () => {
      const bot = createBotWithDefaults(service);
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'u-1', roleKey: 'owner' });
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'u-2', roleKey: 'admin' });

      assert.throws(
        () => service.setMemberRole(bot.id, 'wecom', 'u-2', 'owner', systemActor),
        BotAuthorizationError,
      );
    });

    it('allows changing a non-owner role', () => {
      const bot = createBotWithDefaults(service);
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'u-1', roleKey: 'owner' });
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'u-2', roleKey: 'normal' });

      service.setMemberRole(bot.id, 'wecom', 'u-2', 'admin', systemActor);
      assert.strictEqual(service.getMemberRole(bot.id, 'wecom', 'u-2'), 'admin');
    });

    it('rejects demoting the only owner', () => {
      const bot = createBotWithDefaults(service);
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'u-1', roleKey: 'owner' });

      assert.throws(
        () => service.setMemberRole(bot.id, 'wecom', 'u-1', 'admin', systemActor),
        BotAuthorizationError,
      );
    });

    it('rejects removing the only owner', () => {
      const bot = createBotWithDefaults(service);
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'u-1', roleKey: 'owner' });

      assert.throws(
        () => service.removeMember(bot.id, 'wecom', 'u-1', systemActor),
        BotAuthorizationError,
      );
    });

    it('records audit logs for member changes', () => {
      const bot = createBotWithDefaults(service);
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'u-1', roleKey: 'owner' });
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'u-2', roleKey: 'normal' });
      service.setMemberRole(bot.id, 'wecom', 'u-2', 'admin', systemActor);

      const logs = store.listAuditLogs(bot.id);
      assert.ok(logs.some((l) => l.eventType === 'user_added'));
      assert.ok(logs.some((l) => l.eventType === 'user_role_changed'));
    });

    it('resolves role by plaintext id when member was stored with encrypted channel id', () => {
      const bot = createBotWithDefaults(service);
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'enc-1', roleKey: 'admin', plaintextUserId: 'plain-1' });

      assert.strictEqual(service.getMemberRole(bot.id, 'wecom', 'enc-1'), 'admin');
      assert.strictEqual(service.getMemberRole(bot.id, 'wecom', 'plain-1'), 'admin');
    });

    it('prefers exact channel identity over plaintext when ids differ', () => {
      const bot = createBotWithDefaults(service);
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'enc-1', roleKey: 'owner', plaintextUserId: 'plain-1' });
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'plain-1', roleKey: 'normal' });

      assert.strictEqual(service.getMemberRole(bot.id, 'wecom', 'enc-1'), 'owner');
      assert.strictEqual(service.getMemberRole(bot.id, 'wecom', 'plain-1'), 'normal');
    });
  });

  describe('updateBot', () => {
    it('updates channel settings', () => {
      const bot = createBotWithDefaults(service, {
        channelSettings: {
          wecom: { enabled: true, botId: 'wecom-bot', botSecret: 'wecom-secret' },
        },
      });
      service.updateChannelSettings(bot.id, 'wecom', { enabled: true, botId: 'new-id', botSecret: 'new-secret' });
      const settings = service.getChannelSettings(bot.id);
      assert.strictEqual(settings.wecom?.botId, 'new-id');

      const logs = store.listAuditLogs(bot.id);
      assert.ok(logs.some((l) => l.eventType === 'channel_credentials_changed'));
    });

    it('updates the bot persona', () => {
      const persona = { prompt: 'Original.', mode: 'append' as const };
      const bot = service.createBot(createBotInput({ persona }));

      const updated = service.updateBot(bot.id, {
        persona: { prompt: 'Updated.', mode: 'replace' as const },
      });
      assert.deepStrictEqual(updated.persona, { prompt: 'Updated.', mode: 'replace' });
      assert.deepStrictEqual(service.getBot(bot.id)?.persona, { prompt: 'Updated.', mode: 'replace' });
    });

    it('clears the bot persona when persona is null', () => {
      const bot = service.createBot(createBotInput({ persona: { prompt: 'To clear.', mode: 'append' as const } }));

      const updated = service.updateBot(bot.id, { persona: null });
      assert.strictEqual(updated.persona, undefined);
      assert.strictEqual(service.getBot(bot.id)?.persona, undefined);
    });

    it('updates the bot role personas', () => {
      const initial: Partial<Record<BotRoleKey, { prompt: string; mode: 'append' | 'replace' }>> = {
        owner: { prompt: 'Owner v1.', mode: 'append' },
      };
      const bot = createBotWithDefaults(service, { rolePersonas: initial });

      const next: Partial<Record<BotRoleKey, { prompt: string; mode: 'append' | 'replace' }>> = {
        admin: { prompt: 'Admin v2.', mode: 'replace' },
      };
      service.updateRolePersonas(bot.id, next);
      assert.deepStrictEqual(service.getRolePersona(bot.id, 'admin'), next.admin);
      assert.strictEqual(service.getRolePersona(bot.id, 'owner'), null);
    });

    it('clears role personas when rolePersonas is null', () => {
      const rolePersonas: Partial<Record<BotRoleKey, { prompt: string; mode: 'append' | 'replace' }>> = {
        owner: { prompt: 'Owner.', mode: 'append' },
      };
      const bot = createBotWithDefaults(service, { rolePersonas });

      service.updateRolePersonas(bot.id, null);
      assert.strictEqual(service.getRolePersona(bot.id, 'owner'), null);
    });

    it('emits channel_enabled and channel_disabled audit events', () => {
      const bot = createBotWithDefaults(service, {
        channelSettings: {
          wecom: { enabled: true, botId: 'wecom-bot', botSecret: 'wecom-secret' },
          feishu: { enabled: false },
        },
      });
      service.updateChannelSettings(bot.id, 'wecom', { enabled: false, botId: 'wecom-bot', botSecret: 'wecom-secret' });
      service.updateChannelSettings(bot.id, 'feishu', { enabled: true, appId: 'feishu-app', appSecret: 'feishu-secret' });

      const logs = store.listAuditLogs(bot.id);
      assert.ok(logs.some((l) => l.eventType === 'channel_disabled' && l.details.channel === 'wecom'));
      assert.ok(logs.some((l) => l.eventType === 'channel_enabled' && l.details.channel === 'feishu'));
    });

    it('throws for invalid channel settings', () => {
      const bot = createBotWithDefaults(service);
      assert.throws(
        () => service.updateChannelSettings(bot.id, 'wecom', { enabled: true }),
        BotValidationError,
      );
    });

    it('throws for unknown bot', () => {
      assert.throws(() => service.updateBot('unknown', { name: 'X' }), BotNotFoundError);
    });
  });

  describe('updateRolePolicy passlist audit (U6, KTD-22)', () => {
    it('emits passlist_rule_added for each newly added rule with provenance', async () => {
      const { createDefaultBotRolePolicy } = await import('./bot-access-policy.js');
      const bot = createBotWithDefaults(service);
      service.updateRolePolicy(bot.id, {
        ...createDefaultBotRolePolicy('normal'),
        passlistRules: [
          {
            rule: 'Bash(git status)',
            provenance: { addedBy: 'desktop-admin', source: 'manual', createdAt: new Date().toISOString() },
          },
          {
            rule: 'Bash(curl https://example.com/health)',
            provenance: { addedBy: 'owner-1', source: 'approval', createdAt: new Date().toISOString() },
          },
        ],
      });

      const events = store.listAuditLogs(bot.id).filter((l) => l.eventType === 'passlist_rule_added');
      assert.strictEqual(events.length, 2);
      const byRule = new Map(events.map((e) => [e.details.rule, e]));
      const manual = byRule.get('Bash(git status)');
      const approval = byRule.get('Bash(curl https://example.com/health)');
      assert.ok(manual && approval);
      assert.strictEqual(manual.details.source, 'manual');
      assert.strictEqual(manual.details.addedBy, 'desktop-admin');
      assert.strictEqual(approval.details.source, 'approval');
      assert.strictEqual(approval.details.addedBy, 'owner-1');
      // Long rule values persist in full with an integrity hash (KTD-22 exemption).
      const longRule = 'Bash(curl https://example.com/health)';
      assert.strictEqual(approval.details.rule, longRule);
      assert.strictEqual(typeof approval.details.ruleSha256, 'string');
    });

    it('does not emit for unchanged rules on a subsequent save', async () => {
      const { createDefaultBotRolePolicy } = await import('./bot-access-policy.js');
      const bot = createBotWithDefaults(service);
      const policy = {
        ...createDefaultBotRolePolicy('normal'),
        passlistRules: [
          {
            rule: 'Bash(git status)',
            provenance: { addedBy: 'desktop-admin', source: 'manual' as const, createdAt: new Date().toISOString() },
          },
        ],
      };
      service.updateRolePolicy(bot.id, policy);
      assert.strictEqual(
        store.listAuditLogs(bot.id).filter((l) => l.eventType === 'passlist_rule_added').length,
        1,
      );
      // Same rule saved again (editor round-trip) — no new event.
      service.updateRolePolicy(bot.id, policy);
      assert.strictEqual(
        store.listAuditLogs(bot.id).filter((l) => l.eventType === 'passlist_rule_added').length,
        1,
      );
    });

    it('defaults source to manual when provenance is absent', async () => {
      const { createDefaultBotRolePolicy } = await import('./bot-access-policy.js');
      const bot = createBotWithDefaults(service);
      service.updateRolePolicy(bot.id, {
        ...createDefaultBotRolePolicy('normal'),
        passlistRules: [{ rule: 'Bash(ls)' }],
      });
      const [event] = store.listAuditLogs(bot.id).filter((l) => l.eventType === 'passlist_rule_added');
      assert.ok(event);
      assert.strictEqual(event.details.source, 'manual');
      assert.strictEqual(event.details.addedBy, 'system', 'falls back to the acting identity');
    });
  });

  describe('deleteBot', () => {
    it('deletes an existing bot', () => {
      const bot = createBotWithDefaults(service);
      assert.strictEqual(service.deleteBot(bot.id), true);
      assert.strictEqual(service.getBot(bot.id), null);
    });

    it('records a bot_deleted audit log', () => {
      const bot = createBotWithDefaults(service);
      service.deleteBot(bot.id);
      const logs = store.listAuditLogs(bot.id);
      assert.ok(logs.some((l) => l.eventType === 'bot_deleted' && l.details.name === 'Test Bot'));
    });

    it('returns false for unknown bot', () => {
      assert.strictEqual(service.deleteBot('unknown'), false);
    });
  });

  describe('per-channel authorization', () => {
    const feishuOwner = { type: 'feishu' as const, channelKey: 'feishu' as const, channelUserId: 'owner-f' };

    it('allows one owner in each channel independently', () => {
      const bot = createBotWithDefaults(service);
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'owner-1', roleKey: 'owner' });
      service.addMember(bot.id, { channelKey: 'feishu', channelUserId: 'owner-f', roleKey: 'owner' });

      assert.strictEqual(service.getMemberRole(bot.id, 'wecom', 'owner-1'), 'owner');
      assert.strictEqual(service.getMemberRole(bot.id, 'feishu', 'owner-f'), 'owner');
    });

    it('allows any channel owner to switch active workspace', () => {
      const bot = createBotWithDefaults(service);
      service.addMember(bot.id, { channelKey: 'feishu', channelUserId: 'owner-f', roleKey: 'owner' });

      const updated = service.setActiveWorkspace(bot.id, 'ws-2', feishuOwner);
      assert.strictEqual(updated.activeWorkspaceId, 'ws-2');
    });

    it('isolates ownership between channels', () => {
      const bot = createBotWithDefaults(service);
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'owner-1', roleKey: 'owner' });
      service.addMember(bot.id, { channelKey: 'feishu', channelUserId: 'owner-f', roleKey: 'owner' });

      assert.throws(
        () => service.addMember(bot.id, { channelKey: 'feishu', channelUserId: 'added-by-wecom', roleKey: 'normal' }, wecomOwner),
        BotAuthorizationError,
      );
      assert.throws(
        () => service.setMemberRole(bot.id, 'feishu', 'owner-f', 'admin', wecomOwner),
        BotAuthorizationError,
      );
      assert.throws(
        () => service.removeMember(bot.id, 'feishu', 'owner-f', wecomOwner),
        BotAuthorizationError,
      );
    });

    it('rejects channel owner from bot-level update and delete', () => {
      const bot = createBotWithDefaults(service);
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'owner-1', roleKey: 'owner' });

      assert.throws(
        () => service.updateBot(bot.id, { name: 'Hacked' }, wecomOwner),
        BotAuthorizationError,
      );
      assert.throws(
        () => service.deleteBot(bot.id, wecomOwner),
        BotAuthorizationError,
      );
    });

    it('rejects cross-channel workspace switch', () => {
      const bot = createBotWithDefaults(service);
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'owner-1', roleKey: 'owner' });

      assert.throws(
        () => service.setActiveWorkspace(bot.id, 'ws-2', feishuOwner),
        BotAuthorizationError,
      );
    });

    it('protects the last owner of a channel even when another channel has an owner', () => {
      const bot = createBotWithDefaults(service);
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'owner-1', roleKey: 'owner' });
      service.addMember(bot.id, { channelKey: 'feishu', channelUserId: 'owner-f', roleKey: 'owner' });

      assert.throws(
        () => service.setMemberRole(bot.id, 'wecom', 'owner-1', 'admin', systemActor),
        BotAuthorizationError,
      );
      assert.throws(
        () => service.removeMember(bot.id, 'wecom', 'owner-1', systemActor),
        BotAuthorizationError,
      );
    });

    it('rejects non-owner channel member for member management', () => {
      const bot = createBotWithDefaults(service);
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'owner-1', roleKey: 'owner' });
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'u-2', roleKey: 'normal' });

      assert.throws(
        () => service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'added-by-normal', roleKey: 'normal' }, wecomNormal),
        BotAuthorizationError,
      );
      assert.throws(
        () => service.setMemberRole(bot.id, 'wecom', 'u-2', 'admin', wecomNormal),
        BotAuthorizationError,
      );
    });
  });

  describe('member plaintext resolution', () => {
    it('returns resolved WeCom member when a mapping exists', () => {
      const bot = createBotWithDefaults(service);

      const member = service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'enc-1', roleKey: 'normal', plaintextUserId: 'plain-1' });
      assert.strictEqual(member.plaintextUserId, 'plain-1');
      assert.strictEqual(member.resolutionStatus, 'resolved');
    });

    it('returns pending when no WeCom mapping exists', () => {
      const bot = createBotWithDefaults(service);
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'enc-1', roleKey: 'normal' });

      const [member] = service.listMembers(bot.id);
      assert.strictEqual(member.plaintextUserId, null);
      assert.strictEqual(member.resolutionStatus, 'pending');
    });

    it('returns resolved Feishu member with userId and name', () => {
      const bot = createBotWithDefaults(service, {
        activeWorkspaceId: 'ws-f',
        channelSettings: {
          wecom: { enabled: true, botId: 'wecom-bot', botSecret: 'wecom-secret' },
          feishu: { enabled: true, appId: 'feishu-app', appSecret: 'feishu-secret' },
        },
      });
      service.ensureMember(bot.id, 'feishu', 'open-1');
      service.setMemberPlaintext(bot.id, 'feishu', 'open-1', 'alice-id');
      service.addMember(bot.id, { channelKey: 'feishu', channelUserId: 'open-1', roleKey: 'normal' });

      const [member] = service.listMembers(bot.id);
      assert.strictEqual(member.plaintextUserId, 'alice-id');
      assert.strictEqual(member.resolutionStatus, 'resolved');
    });

    it('returns pending Feishu member when userId is missing', () => {
      const bot = createBotWithDefaults(service, {
        activeWorkspaceId: 'ws-f',
        channelSettings: {
          wecom: { enabled: true, botId: 'wecom-bot', botSecret: 'wecom-secret' },
          feishu: { enabled: true, appId: 'feishu-app', appSecret: 'feishu-secret' },
        },
      });
      service.ensureMember(bot.id, 'feishu', 'open-1');
      service.addMember(bot.id, { channelKey: 'feishu', channelUserId: 'open-1', roleKey: 'normal' });

      const [member] = service.listMembers(bot.id);
      assert.strictEqual(member.plaintextUserId, null);
      assert.strictEqual(member.resolutionStatus, 'pending');
    });

    it('returns enriched member from addMember when mapping already exists', () => {
      const bot = createBotWithDefaults(service);

      const member = service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'enc-1', roleKey: 'normal', plaintextUserId: 'plain-1' });
      assert.strictEqual(member.plaintextUserId, 'plain-1');
      assert.strictEqual(member.resolutionStatus, 'resolved');
    });
  });

  describe('transferChannelOwnership', () => {
    it('promotes the target to owner and demotes the prior owner to admin', () => {
      const bot = createBotWithDefaults(service);
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'a', roleKey: 'owner' });
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'b', roleKey: 'normal' });

      service.transferChannelOwnership(bot.id, 'wecom', 'b');

      const owners = service.listMembers(bot.id).filter((m) => m.channelKey === 'wecom' && m.roleKey === 'owner');
      assert.strictEqual(owners.length, 1, 'exactly one wecom owner after transfer');
      assert.strictEqual(service.getMemberRole(bot.id, 'wecom', 'b'), 'owner');
      assert.strictEqual(service.getMemberRole(bot.id, 'wecom', 'a'), 'admin');
    });

    it('is a no-op when the target is already the owner', () => {
      const bot = createBotWithDefaults(service);
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'a', roleKey: 'owner' });

      service.transferChannelOwnership(bot.id, 'wecom', 'a');

      assert.strictEqual(service.getMemberRole(bot.id, 'wecom', 'a'), 'owner');
      const owners = service.listMembers(bot.id).filter((m) => m.channelKey === 'wecom' && m.roleKey === 'owner');
      assert.strictEqual(owners.length, 1);
    });

    it('promotes the target on an owner-less channel and demotes no one', () => {
      const bot = createBotWithDefaults(service);
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'a', roleKey: 'normal' });

      service.transferChannelOwnership(bot.id, 'wecom', 'a');

      assert.strictEqual(service.getMemberRole(bot.id, 'wecom', 'a'), 'owner');
    });

    it('throws BotUserNotFoundError when the target is not a member of the channel', () => {
      const bot = createBotWithDefaults(service);
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'a', roleKey: 'owner' });

      assert.throws(
        () => service.transferChannelOwnership(bot.id, 'wecom', 'absent'),
        BotUserNotFoundError,
      );
      // Prior owner unchanged when the target is invalid.
      assert.strictEqual(service.getMemberRole(bot.id, 'wecom', 'a'), 'owner');
    });

    it('emits an audit-log entry for the transfer', () => {
      const bot = createBotWithDefaults(service);
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'a', roleKey: 'owner' });
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'b', roleKey: 'normal' });

      service.transferChannelOwnership(bot.id, 'wecom', 'b');

      const logs = store.listAuditLogs(bot.id);
      assert.ok(logs.some((l) => l.eventType === 'user_role_changed'));
    });

    it('still rejects adding a second owner via setMemberRole on the normal path', () => {
      const bot = createBotWithDefaults(service);
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'a', roleKey: 'owner' });
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'b', roleKey: 'normal' });

      assert.throws(
        () => service.setMemberRole(bot.id, 'wecom', 'b', 'owner'),
        (err: Error) => err.name === 'BotAuthorizationError',
      );
    });
  });

  describe('autoAssignOwnerIfAbsent', () => {
    it('promotes the given user on an owner-less channel', () => {
      const bot = createBotWithDefaults(service);
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'a', roleKey: 'normal' });

      service.autoAssignOwnerIfAbsent(bot.id, 'wecom', 'a');

      assert.strictEqual(service.getMemberRole(bot.id, 'wecom', 'a'), 'owner');
    });

    it('leaves roles unchanged when the channel already has an owner', () => {
      const bot = createBotWithDefaults(service);
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'a', roleKey: 'owner' });
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'b', roleKey: 'normal' });

      service.autoAssignOwnerIfAbsent(bot.id, 'wecom', 'b');

      assert.strictEqual(service.getMemberRole(bot.id, 'wecom', 'a'), 'owner');
      assert.strictEqual(service.getMemberRole(bot.id, 'wecom', 'b'), 'normal');
    });

    it('does nothing when the user is not yet a member', () => {
      const bot = createBotWithDefaults(service);

      service.autoAssignOwnerIfAbsent(bot.id, 'wecom', 'ghost');

      assert.strictEqual(service.listMembers(bot.id).length, 0);
    });

    it('promotes an existing normal member on an owner-less channel (migrated-channel path)', () => {
      const bot = createBotWithDefaults(service);
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'a', roleKey: 'normal' });
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'b', roleKey: 'normal' });

      service.autoAssignOwnerIfAbsent(bot.id, 'wecom', 'b');

      assert.strictEqual(service.getMemberRole(bot.id, 'wecom', 'b'), 'owner');
      assert.strictEqual(service.getMemberRole(bot.id, 'wecom', 'a'), 'normal');
    });
  });
});
