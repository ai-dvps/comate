import '../test-utils/test-env.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { builtinSkillRoots } from './builtin-skills.js';
import { SdkClient } from './sdk-client.js';
import { resolveSdkBinary } from '../utils/resolve-sdk-binary.js';
import { OpencodeServerManager } from './opencode-server-manager.js';

it('native Claude discovers the bundled manager through an app-owned additional directory', { timeout: 30000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'comate-claude-skill-host-'));
  const workspace = path.join(home, 'project'); await mkdir(workspace);
  try {
    const result = await new SdkClient().fetchInitialization({
      cwd: workspace, pathToClaudeCodeExecutable: resolveSdkBinary(),
      additionalDirectories: builtinSkillRoots(['skill-manager']).map(root => path.dirname(path.dirname(root))),
      settingSources: ['project'],
      env: { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ANTHROPIC_API_KEY: 'fixture-not-used-for-a-model-request' },
    });
    assert.ok(result.commands.some(command => command.name === 'skill-manager'), 'native initialization must expose the standard Skill');
  } finally { await rm(home, { recursive: true, force: true }); }
});
it('native OpenCode discovers bundled standard Skills and retains their reference directory', { timeout: 30000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'comate-opencode-skill-host-'));
  const workspace = path.join(home, 'project'); await mkdir(workspace);
  const manager = new OpencodeServerManager();
  try {
    const instance = await manager.ensureServer('skill-fixture', workspace, {
      config: { skills: { paths: builtinSkillRoots(['skill-manager']) }, plugin: [], permission: 'deny' },
      env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache') },
    });
    const response = await fetch(`${instance.baseUrl}/skill?directory=${encodeURIComponent(workspace)}`, { headers: instance.authHeaders });
    assert.equal(response.status, 200);
    const skills = await response.json() as Array<{ name: string; location: string }>;
    const skill = skills.find(skill => skill.name === 'skill-manager');
    assert.ok(skill);
    const references = await readFile(path.join(path.dirname(skill.location), 'references/repository-patterns.md'), 'utf8');
    assert.match(references, /ui-ux-pro-max/);
  } finally { await manager.stopAll(); await rm(home, { recursive: true, force: true }); }
});
