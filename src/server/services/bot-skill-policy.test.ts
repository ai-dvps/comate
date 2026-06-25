import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { evaluateSkill } from './bot-skill-policy.js';
import type { WeComBotIsolationSettings } from '../models/workspace.js';

function createIsolation(overrides: Partial<WeComBotIsolationSettings> = {}): WeComBotIsolationSettings {
  return {
    adminUserIds: [],
    defaultAllowedSkills: [],
    adminAllowedSkills: [],
    ...overrides,
  };
}

describe('evaluateSkill', () => {
  it('allows non-Skill tools unconditionally', () => {
    const result = evaluateSkill({ isolation: createIsolation(), isAdmin: false }, 'Bash', { command: 'echo hi' });
    assert.equal(result.allowed, true);
  });

  it('rejects Skill calls with no skill name', () => {
    assert.equal(evaluateSkill({ isolation: createIsolation(), isAdmin: false }, 'Skill', {}).allowed, false);
    assert.equal(evaluateSkill({ isolation: createIsolation(), isAdmin: false }, 'Skill', { name: '' }).allowed, false);
    assert.equal(evaluateSkill({ isolation: createIsolation(), isAdmin: false }, 'Skill', { skill: 123 }).allowed, false);
  });

  it('allows any skill when isolation is not configured', () => {
    const result = evaluateSkill({ isolation: undefined, isAdmin: false }, 'Skill', { skill_name: 'any-skill' });
    assert.equal(result.allowed, true);
    assert.equal(result.skillName, 'any-skill');
  });

  it('allows skills in the default allowlist', () => {
    const isolation = createIsolation({ defaultAllowedSkills: ['my-skill'] });
    const result = evaluateSkill({ isolation, isAdmin: false }, 'Skill', { name: 'My Skill' });
    assert.equal(result.allowed, true);
    assert.equal(result.skillName, 'my-skill');
  });

  it('allows admin skills only for admins', () => {
    const isolation = createIsolation({ adminAllowedSkills: ['admin-skill'] });
    const adminResult = evaluateSkill({ isolation, isAdmin: true }, 'Skill', { skill: 'admin_skill' });
    assert.equal(adminResult.allowed, true);
    assert.equal(adminResult.skillName, 'admin-skill');

    const userResult = evaluateSkill({ isolation, isAdmin: false }, 'Skill', { skill: 'admin_skill' });
    assert.equal(userResult.allowed, false);
    assert.equal(userResult.reason, 'skill-not-allowed');
  });

  it('denies skills not in any allowlist', () => {
    const isolation = createIsolation({ defaultAllowedSkills: ['allowed'] });
    const result = evaluateSkill({ isolation, isAdmin: false }, 'Skill', { skill_name: 'other' });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'skill-not-allowed');
    assert.equal(result.skillName, 'other');
  });

  it('normalizes skill names to lowercase kebab-case', () => {
    const isolation = createIsolation({ defaultAllowedSkills: ['my-skill'] });
    const result = evaluateSkill({ isolation, isAdmin: false }, 'Skill', { name: '  My_Skill  ' });
    assert.equal(result.allowed, true);
    assert.equal(result.skillName, 'my-skill');
  });

  it('extracts skill name from skill_name, name, or skill fields', () => {
    const isolation = createIsolation({ defaultAllowedSkills: ['x'] });
    assert.equal(evaluateSkill({ isolation, isAdmin: false }, 'Skill', { skill_name: 'x' }).allowed, true);
    assert.equal(evaluateSkill({ isolation, isAdmin: false }, 'Skill', { name: 'x' }).allowed, true);
    assert.equal(evaluateSkill({ isolation, isAdmin: false }, 'Skill', { skill: 'x' }).allowed, true);
  });

  it('normalizes configured allowlist entries', () => {
    const isolation = createIsolation({ defaultAllowedSkills: ['My Skill', 'another_skill'] });
    const result = evaluateSkill({ isolation, isAdmin: false }, 'Skill', { name: 'my-skill' });
    assert.equal(result.allowed, true);
  });
});