import '../test-utils/test-env.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getWorkspaceSkillSnapshot } from './opencode-skill-discovery.js';

const tempDirs: string[] = [];

async function createWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'comate-opencode-skills-'));
  tempDirs.push(directory);
  return directory;
}

async function writeSkill(
  workspace: string,
  root: string,
  name: string,
  content = `---\nname: ${name}\ndescription: test\n---\n`,
): Promise<string> {
  const directory = join(workspace, root, name);
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'SKILL.md');
  await writeFile(path, content);
  return path;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('OpenCode workspace skill discovery snapshot', () => {
  it('tracks every project-local skill root supported by OpenCode', async () => {
    const workspace = await createWorkspace();
    const initial = await getWorkspaceSkillSnapshot(workspace);

    for (const root of [
      '.opencode/skill',
      '.opencode/skills',
      '.claude/skills',
      '.agents/skills',
    ]) {
      await writeSkill(workspace, root, root.replaceAll('/', '-'));
      const next = await getWorkspaceSkillSnapshot(workspace);
      assert.notEqual(next, initial, `${root} should participate in the snapshot`);
      await rm(join(workspace, root), { recursive: true, force: true });
    }
  });

  it('changes when a workspace SKILL.md is added, edited, or removed', async () => {
    const workspace = await createWorkspace();
    const before = await getWorkspaceSkillSnapshot(workspace);
    const skillPath = await writeSkill(workspace, '.opencode/skills', 'workspace-probe');
    const afterAdd = await getWorkspaceSkillSnapshot(workspace);
    assert.notEqual(afterAdd, before);

    await writeFile(skillPath, '---\nname: workspace-probe\ndescription: changed\n---\n');
    const afterEdit = await getWorkspaceSkillSnapshot(workspace);
    assert.notEqual(afterEdit, afterAdd);

    await rm(skillPath);
    assert.equal(await getWorkspaceSkillSnapshot(workspace), before);
  });

  it('ignores unrelated workspace files', async () => {
    const workspace = await createWorkspace();
    const before = await getWorkspaceSkillSnapshot(workspace);
    await writeFile(join(workspace, 'README.md'), 'changed');
    assert.equal(await getWorkspaceSkillSnapshot(workspace), before);
  });

  it('is stable when multiple skill roots link to the same directory', async () => {
    const workspace = await createWorkspace();
    const shared = join(workspace, 'shared-skills', 'linked-skill');
    await mkdir(shared, { recursive: true });
    await writeFile(join(shared, 'SKILL.md'), '---\nname: linked-skill\ndescription: linked\n---\n');
    for (const root of ['.opencode/skills', '.agents/skills']) {
      const rootPath = join(workspace, root);
      await mkdir(rootPath, { recursive: true });
      await symlink(shared, join(rootPath, 'linked-skill'), 'dir');
    }

    const expected = await getWorkspaceSkillSnapshot(workspace);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      assert.equal(await getWorkspaceSkillSnapshot(workspace), expected);
    }
  });
});
