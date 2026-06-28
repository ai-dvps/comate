import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { evaluateSkill } from './bot-skill-policy.js';
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
    skillAllowlist: [],
    bashWhitelist: [],
    ...overrides,
  };
}

describe('evaluateSkill', () => {
  it('allows non-Skill tools unconditionally', () => {
    const result = evaluateSkill({ policy: createPolicy(), isAdminOrOwner: false }, 'Bash', { command: 'echo hi' });
    assert.equal(result.allowed, true);
  });

  it('rejects Skill calls with no skill name', () => {
    assert.equal(evaluateSkill({ policy: createPolicy(), isAdminOrOwner: false }, 'Skill', {}).allowed, false);
    assert.equal(evaluateSkill({ policy: createPolicy(), isAdminOrOwner: false }, 'Skill', { name: '' }).allowed, false);
    assert.equal(evaluateSkill({ policy: createPolicy(), isAdminOrOwner: false }, 'Skill', { skill: 123 }).allowed, false);
  });

  it('allows any skill when policy is not configured', () => {
    const result = evaluateSkill({ policy: undefined, isAdminOrOwner: false }, 'Skill', { skill_name: 'any-skill' });
    assert.equal(result.allowed, true);
    assert.equal(result.skillName, 'any-skill');
  });

  it('allows skills in the bot allowlist', () => {
    const policy = createPolicy({ skillAllowlist: ['my-skill'] });
    const result = evaluateSkill({ policy, isAdminOrOwner: false }, 'Skill', { name: 'My Skill' });
    assert.equal(result.allowed, true);
    assert.equal(result.skillName, 'my-skill');
  });

  it('allows owners and admins to invoke any skill', () => {
    const policy = createPolicy({ skillAllowlist: ['allowed'] });
    const result = evaluateSkill({ policy, isAdminOrOwner: true }, 'Skill', { skill_name: 'unlisted-skill' });
    assert.equal(result.allowed, true);
    assert.equal(result.skillName, 'unlisted-skill');
  });

  it('still rejects owners/admins invoking a skill with an empty name', () => {
    const policy = createPolicy({});
    const result = evaluateSkill({ policy, isAdminOrOwner: true }, 'Skill', { skill_name: '' });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'missing-skill-name');
  });

  it('denies normal users skills not in the allowlist', () => {
    const policy = createPolicy({ skillAllowlist: ['allowed'] });
    const result = evaluateSkill({ policy, isAdminOrOwner: false }, 'Skill', { skill_name: 'unlisted-skill' });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'skill-not-allowed');
  });

  it('normalizes skill names to lowercase kebab-case', () => {
    const policy = createPolicy({ skillAllowlist: ['my-skill'] });
    const result = evaluateSkill({ policy, isAdminOrOwner: false }, 'Skill', { name: '  My_Skill  ' });
    assert.equal(result.allowed, true);
    assert.equal(result.skillName, 'my-skill');
  });

  it('extracts skill name from skill_name, name, or skill fields', () => {
    const policy = createPolicy({ skillAllowlist: ['x'] });
    assert.equal(evaluateSkill({ policy, isAdminOrOwner: false }, 'Skill', { skill_name: 'x' }).allowed, true);
    assert.equal(evaluateSkill({ policy, isAdminOrOwner: false }, 'Skill', { name: 'x' }).allowed, true);
    assert.equal(evaluateSkill({ policy, isAdminOrOwner: false }, 'Skill', { skill: 'x' }).allowed, true);
  });

  it('normalizes configured allowlist entries', () => {
    const policy = createPolicy({ skillAllowlist: ['My Skill', 'another_skill'] });
    const result = evaluateSkill({ policy, isAdminOrOwner: false }, 'Skill', { name: 'my-skill' });
    assert.equal(result.allowed, true);
  });
});
