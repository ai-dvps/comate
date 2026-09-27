import '../test-utils/test-env.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { discoverInstalledSkills, skillCommands } from './skill-inventory.js';

it('discovers external installs, keeps same-name identities and merges shared aliases without stale lock entries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'comate-inventory-'));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'project');
  try {
    const project = path.join(workspace, '.agents/skills/demo');
    const global = path.join(home, '.claude/skills/demo');
    for (const directory of [project, global]) {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'SKILL.md'), '---\nname: demo\ndescription: Test skill\n---\nInstructions');
    }
    await mkdir(path.join(workspace, '.claude/skills'), { recursive: true });
    await symlink(project, path.join(workspace, '.claude/skills/demo'));
    await symlink(path.join(workspace, '.claude/skills'), path.join(workspace, '.claude/skills/loop'));
    await writeFile(path.join(workspace, 'skills-lock.json'), JSON.stringify({ skills: { ghost: { source: 'old/repo' } } }));
    const skills = await discoverInstalledSkills(workspace, home);
    const demos = skills.filter((s) => s.name === 'demo');
    assert.equal(demos.length, 2);
    assert.notEqual(demos[0].id, demos[1].id);
    assert.ok(demos.every((s) => s.invocationName === 'demo'));
    assert.equal(demos.find((s) => s.scope === 'project')?.aliases.length, 1);
    assert.ok(!skills.some((s) => s.name === 'ghost'));
    assert.equal(skillCommands(demos, 'claude').length, 2);
    await rm(project, { recursive: true });
    assert.equal((await discoverInstalledSkills(workspace, home)).filter((s) => s.name === 'demo').length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('keeps legacy expert orchestration files visible without reviving deleted lock entries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'comate-legacy-skills-'));
  try {
    const directory = path.join(root, '.claude/skills/expert');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'SKILL.md'), '# Expert\nRun its installed child Skills.');
    const entry = { source: 'skillhub-package:expert', packageSlug: 'expert', packageCatalog: { summary: 'Legacy workflow' } };
    await writeFile(path.join(root, 'skills-lock.json'), JSON.stringify({ skills: { expert: entry, deleted: entry } }));
    const installed = await discoverInstalledSkills(root, path.join(root, 'home'));
    const expert = installed.find(skill => skill.name === 'expert');
    assert.equal(expert?.description, 'Legacy workflow');
    assert.equal(expert?.kind, 'expert-package-orchestrator');
    assert.equal(installed.some(skill => skill.name === 'deleted'), false);
    await rm(directory, { recursive: true });
    assert.equal((await discoverInstalledSkills(root)).some(skill => skill.name === 'expert'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('reads declared versions from installed files and excludes other projects', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'comate-version-'));
  try {
    for (const [base, version] of [['a', '1.2'], ['b', '1.4'], ['home', '1.3']]) {
      const dir = path.join(root, base, '.agents/skills/versioned');
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'SKILL.md'), `---\nname: versioned\ndescription: Test\nmetadata:\n  version: "${version}"\n---\nBody`);
    }
    const installed = (await discoverInstalledSkills(path.join(root, 'a'), path.join(root, 'home'))).filter(s => s.name === 'versioned');
    assert.equal(installed.length, 2);
    assert.deepEqual(installed.map(s => s.version).sort(), ['1.2', '1.3']);
    assert.ok(installed.every(s => !s.installPath.includes('/b/')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
