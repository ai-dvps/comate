import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { getBuiltinSkills, isBuiltinSkillFile, skillCatalogPrompt, appendSystemPrompt, systemPromptText } from './builtin-skills.js';

describe('bundled standard Skills', () => {
  it('discovers complete skills without a plugin manifest', () => {
    const skills = getBuiltinSkills();
    assert.deepEqual(skills.map((s) => s.name).sort(), ['send-wecom-file', 'send-wecom-msg', 'skill-manager', 'wecom-doc']);
    assert.ok(skills.every((s) => path.basename(s.path) === 'SKILL.md'));
    assert.ok(skills.every((s) => isBuiltinSkillFile(s.path)));
  });

  it('filters the catalog and preserves persona instructions', () => {
    const skills = getBuiltinSkills().filter((s) => s.name === 'skill-manager');
    const prompt = skillCatalogPrompt(skills);
    assert.match(prompt, /skill-manager/);
    assert.doesNotMatch(prompt, /send-wecom/);
    assert.match(String(appendSystemPrompt('Existing persona', prompt)), /^Existing persona/);
    assert.deepEqual(appendSystemPrompt({ type: 'preset', preset: 'claude_code', append: 'Persona' }, prompt), {
      type: 'preset', preset: 'claude_code', append: `Persona\n\n${prompt}`,
    });
  });

  it('does not allow a bundled path to escape through a symlink', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'comate-skills-'));
    try {
      const skills = path.join(root, 'skills');
      mkdirSync(skills);
      writeFileSync(path.join(root, 'secret'), 'private');
      symlinkSync(path.join(root, 'secret'), path.join(skills, 'escape'));
      assert.equal(isBuiltinSkillFile(path.join(skills, 'escape'), skills), false);
      assert.equal(isBuiltinSkillFile(path.join(root, 'missing'), skills), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('preserves custom prompt text and snapshot policy when adding the Skill catalog', () => {
    const prompt = { type: 'custom' as const, prompt: 'Bot persona', snapshot: false };
    const appended = appendSystemPrompt(prompt, 'Skill catalog');
    assert.deepEqual(appended, { ...prompt, prompt: 'Bot persona\n\nSkill catalog' });
    assert.equal(systemPromptText(appended), 'Bot persona\n\nSkill catalog');
  });

  it('preserves custom prompt array boundaries when adding the Skill catalog', () => {
    const prompt = { type: 'custom' as const, prompt: ['Shared instructions', 'Bot persona'], snapshot: true };
    const appended = appendSystemPrompt(prompt, 'Skill catalog');
    assert.deepEqual(appended, { ...prompt, prompt: ['Shared instructions', 'Bot persona', 'Skill catalog'] });
    assert.equal(systemPromptText(appended), 'Shared instructions\n\nBot persona\n\nSkill catalog');
    assert.deepEqual(prompt.prompt, ['Shared instructions', 'Bot persona']);
  });
});
