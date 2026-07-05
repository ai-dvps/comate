import '../test-utils/test-env.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { SqliteStore } from '../storage/sqlite-store.js';
import {
  BotAuthorizationError,
  BotNotFoundError,
  BotService,
  BotValidationError,
  BotWorkspaceBoundError,
} from './bot-service.js';
import type { BotRole, CreateBotInput } from '../models/bot.js';

const systemActor = { type: 'system' as const };
const wecomOwner = { type: 'wecom' as const, channelKey: 'wecom' as const, channelUserId: 'owner-1' };
const wecomNormal = { type: 'wecom' as const, channelKey: 'wecom' as const, channelUserId: 'normal-1' };

function createBotInput(overrides: Partial<CreateBotInput> = {}): CreateBotInput {
  return {
    name: 'Test Bot',
    activeWorkspaceId: 'ws-1',
    channelSettings: {
      wecom: {
        enabled: true,
        botId: 'wecom-bot',
        botSecret: 'wecom-secret',
      },
    },
    ...overrides,
  };
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
      const bot = service.createBot(createBotInput());
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
      const rolePersonas: Partial<Record<BotRole, { prompt: string; mode: 'append' | 'replace' }>> = {
        owner: { prompt: 'Owner persona.', mode: 'append' },
        normal: { prompt: 'Normal persona.', mode: 'replace' },
      };
      const bot = service.createBot(createBotInput({ rolePersonas }));
      assert.deepStrictEqual(service.getRolePersona(bot.id, 'owner'), rolePersonas.owner);
      assert.deepStrictEqual(service.getRolePersona(bot.id, 'normal'), rolePersonas.normal);
    });

    it('throws when enabled WeCom credentials are missing', () => {
      assert.throws(
        () => service.createBot(createBotInput({ channelSettings: { wecom: { enabled: true } } })),
        BotValidationError,
      );
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
      const bot = service.createBot(createBotInput());
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
      const bot = service.createBot(createBotInput());
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'owner-1', roleKey: 'owner' });
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'normal-1', roleKey: 'normal' });

      assert.throws(
        () => service.setActiveWorkspace(bot.id, 'ws-2', wecomNormal),
        BotAuthorizationError,
      );
    });

    it('rejects binding an already-bound workspace', () => {
      service.createBot(createBotInput({ activeWorkspaceId: 'ws-shared' }));
      const botB = service.createBot(createBotInput({ name: 'B', activeWorkspaceId: 'ws-2' }));
      service.addMember(botB.id, { channelKey: 'wecom', channelUserId: 'owner-2', roleKey: 'owner' });

      assert.throws(
        () => service.setActiveWorkspace(botB.id, 'ws-shared', { type: 'wecom', channelKey: 'wecom', channelUserId: 'owner-2' }),
        BotWorkspaceBoundError,
      );
    });
  });

  describe('member roles', () => {
    it('defaults new members to normal', () => {
      const bot = service.createBot(createBotInput());
      const member = service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'u-1' });
      assert.strictEqual(member.roleKey, 'normal');
    });

    it('allows only one owner', () => {
      const bot = service.createBot(createBotInput());
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'owner-1', roleKey: 'owner' });

      assert.throws(
        () => service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'owner-2', roleKey: 'owner' }),
        BotAuthorizationError,
      );
    });

    it('rejects promoting a second owner before demoting the first', () => {
      const bot = service.createBot(createBotInput());
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'u-1', roleKey: 'owner' });
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'u-2', roleKey: 'admin' });

      assert.throws(
        () => service.setMemberRole(bot.id, 'wecom', 'u-2', 'owner', systemActor),
        BotAuthorizationError,
      );
    });

    it('allows changing a non-owner role', () => {
      const bot = service.createBot(createBotInput());
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'u-1', roleKey: 'owner' });
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'u-2', roleKey: 'normal' });

      service.setMemberRole(bot.id, 'wecom', 'u-2', 'admin', systemActor);
      assert.strictEqual(service.getMemberRole(bot.id, 'wecom', 'u-2'), 'admin');
    });

    it('rejects demoting the only owner', () => {
      const bot = service.createBot(createBotInput());
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'u-1', roleKey: 'owner' });

      assert.throws(
        () => service.setMemberRole(bot.id, 'wecom', 'u-1', 'admin', systemActor),
        BotAuthorizationError,
      );
    });

    it('rejects removing the only owner', () => {
      const bot = service.createBot(createBotInput());
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'u-1', roleKey: 'owner' });

      assert.throws(
        () => service.removeMember(bot.id, 'wecom', 'u-1', systemActor),
        BotAuthorizationError,
      );
    });

    it('records audit logs for member changes', () => {
      const bot = service.createBot(createBotInput());
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'u-1', roleKey: 'owner' });
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'u-2', roleKey: 'normal' });
      service.setMemberRole(bot.id, 'wecom', 'u-2', 'admin', systemActor);

      const logs = store.listAuditLogs(bot.id);
      assert.ok(logs.some((l) => l.eventType === 'member_added'));
      assert.ok(logs.some((l) => l.eventType === 'member_role_changed'));
    });
  });

  describe('updateBot', () => {
    it('updates channel settings', () => {
      const bot = service.createBot(createBotInput());
      service.updateBot(bot.id, {
        channelSettings: { wecom: { enabled: true, botId: 'new-id', botSecret: 'new-secret' } },
      });
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
      const initial: Partial<Record<BotRole, { prompt: string; mode: 'append' | 'replace' }>> = {
        owner: { prompt: 'Owner v1.', mode: 'append' },
      };
      const bot = service.createBot(createBotInput({ rolePersonas: initial }));

      const next: Partial<Record<BotRole, { prompt: string; mode: 'append' | 'replace' }>> = {
        admin: { prompt: 'Admin v2.', mode: 'replace' },
      };
      service.updateBot(bot.id, { rolePersonas: next });
      assert.deepStrictEqual(service.getRolePersona(bot.id, 'admin'), next.admin);
      assert.strictEqual(service.getRolePersona(bot.id, 'owner'), null);
    });

    it('clears role personas when rolePersonas is null', () => {
      const rolePersonas: Partial<Record<BotRole, { prompt: string; mode: 'append' | 'replace' }>> = {
        owner: { prompt: 'Owner.', mode: 'append' },
      };
      const bot = service.createBot(createBotInput({ rolePersonas }));

      const updated = service.updateBot(bot.id, { rolePersonas: null });
      assert.strictEqual(updated.rolePersonas, undefined);
      assert.strictEqual(service.getBot(bot.id)?.rolePersonas, undefined);
    });

    it('emits channel_enabled and channel_disabled audit events', () => {
      const bot = service.createBot(createBotInput());
      service.updateBot(bot.id, {
        channelSettings: {
          wecom: { enabled: false, botId: 'wecom-bot', botSecret: 'wecom-secret' },
          feishu: { enabled: true, appId: 'feishu-app', appSecret: 'feishu-secret' },
        },
      });

      const logs = store.listAuditLogs(bot.id);
      assert.ok(logs.some((l) => l.eventType === 'channel_disabled' && l.details.channel === 'wecom'));
      assert.ok(logs.some((l) => l.eventType === 'channel_enabled' && l.details.channel === 'feishu'));
    });

    it('throws for invalid channel settings', () => {
      const bot = service.createBot(createBotInput());
      assert.throws(
        () => service.updateBot(bot.id, { channelSettings: { wecom: { enabled: true } } }),
        BotValidationError,
      );
    });

    it('throws for unknown bot', () => {
      assert.throws(() => service.updateBot('unknown', { name: 'X' }), BotNotFoundError);
    });
  });

  describe('deleteBot', () => {
    it('deletes an existing bot', () => {
      const bot = service.createBot(createBotInput());
      assert.strictEqual(service.deleteBot(bot.id), true);
      assert.strictEqual(service.getBot(bot.id), null);
    });

    it('records a bot_deleted audit log', () => {
      const bot = service.createBot(createBotInput());
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
      const bot = service.createBot(createBotInput());
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'owner-1', roleKey: 'owner' });
      service.addMember(bot.id, { channelKey: 'feishu', channelUserId: 'owner-f', roleKey: 'owner' });

      assert.strictEqual(service.getMemberRole(bot.id, 'wecom', 'owner-1'), 'owner');
      assert.strictEqual(service.getMemberRole(bot.id, 'feishu', 'owner-f'), 'owner');
    });

    it('allows any channel owner to switch active workspace', () => {
      const bot = service.createBot(createBotInput());
      service.addMember(bot.id, { channelKey: 'feishu', channelUserId: 'owner-f', roleKey: 'owner' });

      const updated = service.setActiveWorkspace(bot.id, 'ws-2', feishuOwner);
      assert.strictEqual(updated.activeWorkspaceId, 'ws-2');
    });

    it('isolates ownership between channels', () => {
      const bot = service.createBot(createBotInput());
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
      const bot = service.createBot(createBotInput());
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
      const bot = service.createBot(createBotInput());
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'owner-1', roleKey: 'owner' });

      assert.throws(
        () => service.setActiveWorkspace(bot.id, 'ws-2', feishuOwner),
        BotAuthorizationError,
      );
    });

    it('protects the last owner of a channel even when another channel has an owner', () => {
      const bot = service.createBot(createBotInput());
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
      const bot = service.createBot(createBotInput());
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
      const bot = service.createBot(createBotInput());

      const member = service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'enc-1', roleKey: 'normal', plaintextUserId: 'plain-1' });
      assert.strictEqual(member.plaintextUserId, 'plain-1');
      assert.strictEqual(member.resolutionStatus, 'resolved');
    });

    it('returns pending when no WeCom mapping exists', () => {
      const bot = service.createBot(createBotInput());
      service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'enc-1', roleKey: 'normal' });

      const [member] = service.listMembers(bot.id);
      assert.strictEqual(member.plaintextUserId, null);
      assert.strictEqual(member.resolutionStatus, 'pending');
    });

    it('returns resolved Feishu member with userId and name', () => {
      const bot = service.createBot(createBotInput({ activeWorkspaceId: 'ws-f', channelSettings: { wecom: { enabled: true, botId: 'wecom-bot', botSecret: 'wecom-secret' }, feishu: { enabled: true, appId: 'feishu-app', appSecret: 'feishu-secret' } } }));
      store.setFeishuWorkspaceUser('ws-f', 'open-1');
      store.setFeishuWorkspaceUserName('ws-f', 'open-1', 'Alice', 'alice-id');
      service.addMember(bot.id, { channelKey: 'feishu', channelUserId: 'open-1', roleKey: 'normal' });

      const [member] = service.listMembers(bot.id);
      assert.strictEqual(member.plaintextUserId, 'alice-id');
      assert.strictEqual(member.resolutionStatus, 'resolved');
    });

    it('returns pending Feishu member when userId is missing', () => {
      const bot = service.createBot(createBotInput({ activeWorkspaceId: 'ws-f', channelSettings: { wecom: { enabled: true, botId: 'wecom-bot', botSecret: 'wecom-secret' }, feishu: { enabled: true, appId: 'feishu-app', appSecret: 'feishu-secret' } } }));
      store.setFeishuWorkspaceUser('ws-f', 'open-1');
      service.addMember(bot.id, { channelKey: 'feishu', channelUserId: 'open-1', roleKey: 'normal' });

      const [member] = service.listMembers(bot.id);
      assert.strictEqual(member.plaintextUserId, null);
      assert.strictEqual(member.resolutionStatus, 'pending');
    });

    it('returns enriched member from addMember when mapping already exists', () => {
      const bot = service.createBot(createBotInput());

      const member = service.addMember(bot.id, { channelKey: 'wecom', channelUserId: 'enc-1', roleKey: 'normal', plaintextUserId: 'plain-1' });
      assert.strictEqual(member.plaintextUserId, 'plain-1');
      assert.strictEqual(member.resolutionStatus, 'resolved');
    });
  });
});
