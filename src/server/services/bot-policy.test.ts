import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  evaluateBotToolPermission,
  evaluateBotSkill,
  isBashCommandAllowed,
  isOwnerOrAdmin,
} from './bot-policy.js';
import type { BotRolePolicy } from '../models/bot.js';

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
      const policy = createPolicy();
      assert.strictEqual(evaluateBotToolPermission(policy.normalToolPolicy, 'owner', 'Edit'), 'allow');
      assert.strictEqual(evaluateBotToolPermission(policy.normalToolPolicy, 'owner', 'Bash'), 'allow');
    });

    it('allows any categorized tool for admin', () => {
      const policy = createPolicy();
      assert.strictEqual(evaluateBotToolPermission(policy.normalToolPolicy, 'admin', 'Edit'), 'allow');
    });

    it('applies normal tool policy for normal users', () => {
      const policy = createPolicy();
      assert.strictEqual(evaluateBotToolPermission(policy.normalToolPolicy, 'normal', 'Read'), 'allow');
      assert.strictEqual(evaluateBotToolPermission(policy.normalToolPolicy, 'normal', 'Edit'), 'deny');
      assert.strictEqual(evaluateBotToolPermission(policy.normalToolPolicy, 'normal', 'Bash'), 'deny');
    });

    it('returns unknown for tools outside categories', () => {
      const policy = createPolicy();
      assert.strictEqual(evaluateBotToolPermission(policy.normalToolPolicy, 'normal', 'FutureTool'), 'unknown');
    });
  });

  describe('evaluateBotSkill', () => {
    it('allows any skill for owner/admin', () => {
      const policy = createPolicy();
      const owner = evaluateBotSkill(policy, 'owner', 'Skill', { name: 'secret-skill' });
      assert.strictEqual(owner.allowed, true);

      const admin = evaluateBotSkill(policy, 'admin', 'Skill', { name: 'secret-skill' });
      assert.strictEqual(admin.allowed, true);
    });

    it('allows allowlisted skills for normal users', () => {
      const policy = createPolicy();
      const result = evaluateBotSkill(policy, 'normal', 'Skill', { name: 'allowed-skill' });
      assert.strictEqual(result.allowed, true);
    });

    it('denies non-allowlisted skills for normal users', () => {
      const policy = createPolicy();
      const result = evaluateBotSkill(policy, 'normal', 'Skill', { name: 'unlisted-skill' });
      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.reason, 'skill-not-allowed');
    });
  });

  describe('isBashCommandAllowed', () => {
    it('allows any command for owner/admin', () => {
      const policy = createPolicy();
      assert.strictEqual(isBashCommandAllowed(policy.bashWhitelist, 'owner', 'rm -rf /'), true);
      assert.strictEqual(isBashCommandAllowed(policy.bashWhitelist, 'admin', 'curl example.com'), true);
    });

    it('allows exact whitelisted commands for normal users', () => {
      const policy = createPolicy();
      assert.strictEqual(isBashCommandAllowed(policy.bashWhitelist, 'normal', 'ls'), true);
      assert.strictEqual(isBashCommandAllowed(policy.bashWhitelist, 'normal', 'cat file.txt'), true);
    });

    it('denies non-whitelisted commands for normal users', () => {
      const policy = createPolicy();
      assert.strictEqual(isBashCommandAllowed(policy.bashWhitelist, 'normal', 'rm -rf /'), false);
      assert.strictEqual(isBashCommandAllowed(policy.bashWhitelist, 'normal', 'curl example.com'), false);
    });

    it('denies all commands when whitelist is empty', () => {
      const policy = createPolicy({ bashWhitelist: [] });
      assert.strictEqual(isBashCommandAllowed(policy.bashWhitelist, 'normal', 'ls'), false);
    });
  });
});
