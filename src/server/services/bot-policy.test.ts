import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  evaluateBotToolPermission,
  evaluateBotSkill,
  isBashCommandAllowed,
  isOwnerOrAdmin,
} from './bot-policy.js';
import type { Bot, BotRolePolicy } from '../models/bot.js';

function createPolicy(overrides: Partial<BotRolePolicy> = {}): BotRolePolicy {
  return {
    normalToolPolicy: {
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
    skillAllowlist: ['allowed-skill'],
    bashWhitelist: ['ls', 'cat'],
    ...overrides,
  };
}

function createBot(policy: BotRolePolicy = createPolicy()): Bot {
  return {
    id: 'bot-1',
    name: 'Test Bot',
    activeWorkspaceId: 'ws-1',
    providerSettings: {},
    rolePolicy: policy,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('bot-policy', () => {
  describe('isOwnerOrAdmin', () => {
    it('returns true for owner and admin', () => {
      assert.strictEqual(isOwnerOrAdmin('owner'), true);
      assert.strictEqual(isOwnerOrAdmin('admin'), true);
    });

    it('returns false for normal and null', () => {
      assert.strictEqual(isOwnerOrAdmin('normal'), false);
      assert.strictEqual(isOwnerOrAdmin(null), false);
      assert.strictEqual(isOwnerOrAdmin(undefined), false);
    });
  });

  describe('evaluateBotToolPermission', () => {
    it('allows any categorized tool for owner', () => {
      const bot = createBot();
      assert.strictEqual(evaluateBotToolPermission(bot, 'owner', 'Edit'), 'allow');
      assert.strictEqual(evaluateBotToolPermission(bot, 'owner', 'Bash'), 'allow');
    });

    it('allows any categorized tool for admin', () => {
      const bot = createBot();
      assert.strictEqual(evaluateBotToolPermission(bot, 'admin', 'Edit'), 'allow');
    });

    it('applies normal tool policy for normal users', () => {
      const bot = createBot();
      assert.strictEqual(evaluateBotToolPermission(bot, 'normal', 'Read'), 'allow');
      assert.strictEqual(evaluateBotToolPermission(bot, 'normal', 'Edit'), 'deny');
      assert.strictEqual(evaluateBotToolPermission(bot, 'normal', 'Bash'), 'deny');
    });

    it('returns unknown for tools outside categories', () => {
      const bot = createBot();
      assert.strictEqual(evaluateBotToolPermission(bot, 'normal', 'FutureTool'), 'unknown');
    });
  });

  describe('evaluateBotSkill', () => {
    it('allows any skill for owner/admin', () => {
      const bot = createBot();
      const owner = evaluateBotSkill(bot, 'owner', 'Skill', { name: 'secret-skill' });
      assert.strictEqual(owner.allowed, true);

      const admin = evaluateBotSkill(bot, 'admin', 'Skill', { name: 'secret-skill' });
      assert.strictEqual(admin.allowed, true);
    });

    it('allows allowlisted skills for normal users', () => {
      const bot = createBot();
      const result = evaluateBotSkill(bot, 'normal', 'Skill', { name: 'allowed-skill' });
      assert.strictEqual(result.allowed, true);
    });

    it('denies non-allowlisted skills for normal users', () => {
      const bot = createBot();
      const result = evaluateBotSkill(bot, 'normal', 'Skill', { name: 'unlisted-skill' });
      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.reason, 'skill-not-allowed');
    });
  });

  describe('isBashCommandAllowed', () => {
    it('allows any command for owner/admin', () => {
      const bot = createBot();
      assert.strictEqual(isBashCommandAllowed(bot, 'owner', 'rm -rf /'), true);
      assert.strictEqual(isBashCommandAllowed(bot, 'admin', 'curl example.com'), true);
    });

    it('allows exact whitelisted commands for normal users', () => {
      const bot = createBot();
      assert.strictEqual(isBashCommandAllowed(bot, 'normal', 'ls'), true);
      assert.strictEqual(isBashCommandAllowed(bot, 'normal', 'cat file.txt'), true);
    });

    it('denies non-whitelisted commands for normal users', () => {
      const bot = createBot();
      assert.strictEqual(isBashCommandAllowed(bot, 'normal', 'rm -rf /'), false);
      assert.strictEqual(isBashCommandAllowed(bot, 'normal', 'curl example.com'), false);
    });

    it('denies all commands when whitelist is empty', () => {
      const bot = createBot(createPolicy({ bashWhitelist: [] }));
      assert.strictEqual(isBashCommandAllowed(bot, 'normal', 'ls'), false);
    });
  });
});
