import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  evaluateSkill,
  evaluateSkillDisabled,
  compileSkillFilter,
  compileSkillDenyRules,
  UNRESTRICTED_SKILLS,
} from './bot-skill-policy.js';
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

describe('evaluateSkillDisabled', () => {
  it('flags disabled skills with normalized matching', () => {
    const result = evaluateSkillDisabled(['Blocked Skill'], { skill_name: 'blocked-skill' });
    assert.equal(result.disabled, true);
    assert.equal(result.skillName, 'blocked-skill');
  });

  it('allows skills that are not on the disabled list', () => {
    const result = evaluateSkillDisabled(['blocked-skill'], { skill_name: 'pdf' });
    assert.equal(result.disabled, false);
    assert.equal(result.skillName, 'pdf');
  });

  it('returns not-disabled when the skill name cannot be extracted', () => {
    const result = evaluateSkillDisabled(['blocked-skill'], {});
    assert.equal(result.disabled, false);
    assert.equal(result.skillName, undefined);
  });

  it('never disables send-capable wecom skills, plain or plugin-qualified (KTD-14)', () => {
    for (const invoked of ['send-wecom-msg', 'wecom:send-wecom-msg', 'Send_WeCom_Msg']) {
      const result = evaluateSkillDisabled(['send-wecom-msg', 'wecom:send-wecom-msg'], { skill_name: invoked });
      assert.equal(result.disabled, false, `${invoked} must never be disabled`);
      assert.equal(result.skillName, invoked.toLowerCase().replace(/[\s_]+/g, '-'));
    }
  });
});

describe('compileSkillFilter (U5)', () => {
  it('keeps the closed mounted set verbatim and unions the unrestricted send skills', () => {
    const filter = compileSkillFilter(['pdf', 'wecom:custom-skill']);
    assert.ok(filter.includes('pdf'));
    assert.ok(filter.includes('wecom:custom-skill'));
    for (const name of UNRESTRICTED_SKILLS) {
      assert.ok(filter.includes(name), `missing ${name}`);
      assert.ok(filter.includes(`wecom:${name}`), `missing wecom:${name}`);
    }
  });

  it('mounts only the unrestricted send skills for an empty mounted set', () => {
    const filter = compileSkillFilter([]);
    assert.equal(filter.length, UNRESTRICTED_SKILLS.length * 2);
  });

  it('dedupes entries and drops blanks', () => {
    const filter = compileSkillFilter(['pdf', 'pdf', '  ', '']);
    assert.equal(filter.filter((name) => name === 'pdf').length, 1);
    assert.ok(!filter.includes(''));
  });
});

describe('compileSkillDenyRules (U5)', () => {
  it('compiles disabled skills into normalized Skill() deny rules', () => {
    assert.deepEqual(compileSkillDenyRules(['Blocked Skill', 'another_skill']), [
      'Skill(blocked-skill)',
      'Skill(another-skill)',
    ]);
  });

  it('dedupes after normalization and skips empty entries', () => {
    assert.deepEqual(compileSkillDenyRules(['Blocked Skill', 'blocked-skill', '']), ['Skill(blocked-skill)']);
  });

  it('never compiles deny rules for send-capable wecom skills (KTD-14)', () => {
    assert.deepEqual(
      compileSkillDenyRules(['send-wecom-msg', 'wecom:send-wecom-file', 'WeCom_Doc', 'pdf']),
      ['Skill(pdf)'],
    );
  });
});
