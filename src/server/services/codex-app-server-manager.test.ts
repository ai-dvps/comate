import '../test-utils/test-env.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { CodexAppServerManager } from './codex-app-server-manager.js';

describe('CodexAppServerManager', () => {
  it('initializes the pinned server and lists an isolated native history', async () => {
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = mkdtempSync(path.join(tmpdir(), 'comate-manager-codex-home-'));
    const manager = new CodexAppServerManager();
    try {
      const response = await manager.request<{ data: unknown[] }>('thread/list', {
        limit: 1,
        useStateDbOnly: true,
      });
      assert.deepEqual(response.data, []);
    } finally {
      await manager.stop();
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });

  it('registers Comate skill roots with the pinned Codex catalog', async () => {
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = mkdtempSync(path.join(tmpdir(), 'comate-manager-codex-home-'));
    const workspace = mkdtempSync(path.join(tmpdir(), 'comate-manager-workspace-'));
    const skillsRoot = path.join(workspace, '.claude', 'skills');
    const skillDir = path.join(skillsRoot, 'comate-test-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), [
      '---',
      'name: comate-test-skill',
      'description: Test Comate skill discovery',
      '---',
      '',
      '# Test',
    ].join('\n'));
    const manager = new CodexAppServerManager();
    try {
      const skills = await manager.listSkills(workspace);
      assert.deepStrictEqual(
        skills.find((skill) => skill.name === 'comate-test-skill'),
        {
          name: 'comate-test-skill',
          description: 'Test Comate skill discovery',
          path: realpathSync(path.join(skillDir, 'SKILL.md')),
        },
      );
    } finally {
      await manager.stop();
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });
});
