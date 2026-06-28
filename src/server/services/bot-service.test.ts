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
import type { CreateBotInput } from '../models/bot.js';

const systemActor = { type: 'system' as const };
const wecomOwner = { type: 'wecom' as const, provider: 'wecom' as const, providerUserId: 'owner-1' };
const wecomNormal = { type: 'wecom' as const, provider: 'wecom' as const, providerUserId: 'normal-1' };

function createBotInput(overrides: Partial<CreateBotInput> = {}): CreateBotInput {
  return {
    name: 'Test Bot',
    activeWorkspaceId: 'ws-1',
    providerSettings: {
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
    });

    it('throws when enabled WeCom credentials are missing', () => {
      assert.throws(
        () => service.createBot(createBotInput({ providerSettings: { wecom: { enabled: true } } })),
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
      service.addMember(bot.id, { provider: 'wecom', providerUserId: 'owner-1', role: 'owner' });

      const updated = service.setActiveWorkspace(bot.id, 'ws-2', wecomOwner);
      assert.strictEqual(updated.activeWorkspaceId, 'ws-2');
    });

    it('rejects workspace switch by non-owner', () => {
      const bot = service.createBot(createBotInput());
      service.addMember(bot.id, { provider: 'wecom', providerUserId: 'owner-1', role: 'owner' });
      service.addMember(bot.id, { provider: 'wecom', providerUserId: 'normal-1', role: 'normal' });

      assert.throws(
        () => service.setActiveWorkspace(bot.id, 'ws-2', wecomNormal),
        BotAuthorizationError,
      );
    });

    it('rejects binding an already-bound workspace', () => {
      service.createBot(createBotInput({ activeWorkspaceId: 'ws-shared' }));
      const botB = service.createBot(createBotInput({ name: 'B', activeWorkspaceId: 'ws-2' }));
      service.addMember(botB.id, { provider: 'wecom', providerUserId: 'owner-2', role: 'owner' });

      assert.throws(
        () => service.setActiveWorkspace(botB.id, 'ws-shared', { type: 'wecom', provider: 'wecom', providerUserId: 'owner-2' }),
        BotWorkspaceBoundError,
      );
    });
  });

  describe('member roles', () => {
    it('defaults new members to normal', () => {
      const bot = service.createBot(createBotInput());
      const member = service.addMember(bot.id, { provider: 'wecom', providerUserId: 'u-1' });
      assert.strictEqual(member.role, 'normal');
    });

    it('allows only one owner', () => {
      const bot = service.createBot(createBotInput());
      service.addMember(bot.id, { provider: 'wecom', providerUserId: 'owner-1', role: 'owner' });

      assert.throws(
        () => service.addMember(bot.id, { provider: 'wecom', providerUserId: 'owner-2', role: 'owner' }),
        BotAuthorizationError,
      );
    });

    it('rejects promoting a second owner before demoting the first', () => {
      const bot = service.createBot(createBotInput());
      service.addMember(bot.id, { provider: 'wecom', providerUserId: 'u-1', role: 'owner' });
      service.addMember(bot.id, { provider: 'wecom', providerUserId: 'u-2', role: 'admin' });

      assert.throws(
        () => service.setMemberRole(bot.id, 'wecom', 'u-2', 'owner', systemActor),
        BotAuthorizationError,
      );
    });

    it('allows changing a non-owner role', () => {
      const bot = service.createBot(createBotInput());
      service.addMember(bot.id, { provider: 'wecom', providerUserId: 'u-1', role: 'owner' });
      service.addMember(bot.id, { provider: 'wecom', providerUserId: 'u-2', role: 'normal' });

      service.setMemberRole(bot.id, 'wecom', 'u-2', 'admin', systemActor);
      assert.strictEqual(service.getMemberRole(bot.id, 'wecom', 'u-2'), 'admin');
    });

    it('rejects demoting the only owner', () => {
      const bot = service.createBot(createBotInput());
      service.addMember(bot.id, { provider: 'wecom', providerUserId: 'u-1', role: 'owner' });

      assert.throws(
        () => service.setMemberRole(bot.id, 'wecom', 'u-1', 'admin', systemActor),
        BotAuthorizationError,
      );
    });

    it('rejects removing the only owner', () => {
      const bot = service.createBot(createBotInput());
      service.addMember(bot.id, { provider: 'wecom', providerUserId: 'u-1', role: 'owner' });

      assert.throws(
        () => service.removeMember(bot.id, 'wecom', 'u-1', systemActor),
        BotAuthorizationError,
      );
    });

    it('records audit logs for member changes', () => {
      const bot = service.createBot(createBotInput());
      service.addMember(bot.id, { provider: 'wecom', providerUserId: 'u-1', role: 'owner' });
      service.addMember(bot.id, { provider: 'wecom', providerUserId: 'u-2', role: 'normal' });
      service.setMemberRole(bot.id, 'wecom', 'u-2', 'admin', systemActor);

      const logs = store.listAuditLogs(bot.id);
      assert.ok(logs.some((l) => l.eventType === 'member_added'));
      assert.ok(logs.some((l) => l.eventType === 'member_role_changed'));
    });
  });

  describe('updateBot', () => {
    it('updates provider settings', () => {
      const bot = service.createBot(createBotInput());
      const updated = service.updateBot(bot.id, {
        providerSettings: { wecom: { enabled: true, botId: 'new-id', botSecret: 'new-secret' } },
      });
      assert.strictEqual(updated.providerSettings.wecom?.botId, 'new-id');
    });

    it('throws for invalid provider settings', () => {
      const bot = service.createBot(createBotInput());
      assert.throws(
        () => service.updateBot(bot.id, { providerSettings: { wecom: { enabled: true } } }),
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

    it('returns false for unknown bot', () => {
      assert.strictEqual(service.deleteBot('unknown'), false);
    });
  });
});
