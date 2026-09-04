import '../test-utils/test-env.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { withSkillReferences, permittedSkills } from './skill-input.js';
import { discoverInstalledSkills } from './skill-inventory.js';

it('uses original names, leaves collisions unresolved and preserves attachments', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'comate-skill-input-'));
  try {
    const dirs = ['one', 'two'].map(name => path.join(root, '.claude/skills', name));
    for (const directory of dirs) { await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'SKILL.md'), '---\nname: collision\ndescription: Selected skill\n---\nRead references/example.md'); }
    const selected = (await discoverInstalledSkills(root)).find(skill => skill.installPath === dirs[0])!;
    const attachment = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'fixture' } };
    const user = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: `/${selected.invocationName} inspect` }, attachment] }, parent_tool_use_id: null } as SDKUserMessage;
    const input = async function* () { yield user; };
    const invoke = async (options: Options = {}) => {
      for await (const message of withSkillReferences(input(), { cwd: root, ...options }, 'claude')) return message.message.content as Array<{ type: string; text?: string }>;
      throw new Error('No message');
    };
    const blocks = await invoke();
    assert.equal(blocks[0].text, "/collision inspect"); assert.deepEqual(blocks[1], attachment);
    await rm(dirs[1], { recursive: true });
    assert.match((await invoke())[0].text!, /\/one\/SKILL.md/, 'a unique original name resolves after the user removes the collision');
    assert.match((await invoke({ settings: { permissions: { deny: ['Skill(collision)'] } } }))[0].text!, /\/collision /, 'denied reference is never expanded into a file read');
    await writeFile(path.join(root, '.claude/settings.local.json'), JSON.stringify({ permissions: { deny: ['Skill(coll*)'] } }));
    assert.match((await invoke())[0].text!, /\/collision /, 'native project denials are not bypassed by the file-read bridge');
    assert.match((await invoke({ settingSources: [] }))[0].text!, /\/one\/SKILL.md/, 'isolated sessions do not inherit project settings');
    await rm(dirs[0], { recursive: true });
    assert.match((await invoke())[0].text!, /\/collision /, 'deleted installation is not resurrected');
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('excludes user-level installations and unmounted builtins from isolated sessions', async () => {
  const installed = await discoverInstalledSkills();
  const filtered = permittedSkills(installed, 'claude', { settingSources: [], skills: [], env: { COMATE_BUILTIN_SKILLS: '' } });
  assert.equal(filtered.length, 0);
});
