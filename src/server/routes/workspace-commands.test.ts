import '../test-utils/test-env.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import router from './workspace-commands.js';
import { store } from '../storage/sqlite-store.js';
import { commandsService } from '../services/commands-service.js';
import { codexAppServerManager } from '../services/codex-app-server-manager.js';
const originals = { get: store.get, session: store.getLocalSession, commands: commandsService.getCommands, skills: codexAppServerManager.listSkills };
afterEach(() => { store.get = originals.get; store.getLocalSession = originals.session; commandsService.getCommands = originals.commands; codexAppServerManager.listSkills = originals.skills; });
const handler = (router as unknown as { stack: Array<{ route: { stack: Array<{ handle: (req: unknown, res: unknown) => Promise<void> }> } }> }).stack[0].route.stack[0].handle;
function response() { return { statusCode: 200, body: undefined as unknown, status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { this.body = body; } }; }
it('validates the session belongs to the requested workspace', async () => {
  store.get = async () => ({ id: 'a', folderPath: '/a' }) as never;
  store.getLocalSession = () => ({ workspaceId: 'b', backend: 'opencode' }) as never;
  const res = response(); await handler({ params: { id: 'a' }, query: { sessionId: 'foreign' } }, res);
  assert.equal(res.statusCode, 404);
});
it('discovers current files without adding suffixes to duplicate names', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'comate-picker-'));
  try {
    const paths = ['.claude/skills/one', '.claude/skills/two'].map(relative => path.join(root, relative));
    for (const directory of paths) { await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'SKILL.md'), '---\nname: same\ndescription: Example\n---\nUse me'); }
    store.get = async () => ({ id: 'workspace', folderPath: root }) as never;
    commandsService.getCommands = async () => ({ commands: [{ name: 'ordinary-command', description: 'Command' }], partial: false });
    codexAppServerManager.listSkills = async () => paths.map(directory => ({ name: 'same', description: 'Example', path: realpathSync(path.join(directory, 'SKILL.md')) }));
    for (const backend of ['claude', 'codex', 'opencode']) {
      const res = response(); await handler({ params: { id: 'workspace' }, query: { backend } }, res);
      assert.equal(res.statusCode, 200);
      const same = (res.body as { commands: Array<{ name: string; skillPath: string }> }).commands.filter(command => command.name === 'same');
      assert.equal(same.length, 2); assert.equal(same[0].name, same[1].name); assert.notEqual(same[0].skillPath, same[1].skillPath);
    }
    await rm(paths[0], { recursive: true });
    const refreshed = response(); await handler({ params: { id: 'workspace' }, query: { backend: 'opencode' } }, refreshed);
    assert.equal((refreshed.body as { commands: Array<{ name: string }> }).commands.filter(command => command.name === 'same').length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
