import '../test-utils/test-env.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import router from './skills.js';
import { store } from '../storage/sqlite-store.js';
const originalGet = store.get;
afterEach(() => { store.get = originalGet; });
const routes = (router as unknown as { stack: Array<{ route: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: unknown, res: unknown) => Promise<void> }> } }> }).stack.map(layer => layer.route);
function response() { return { statusCode: 200, body: undefined as unknown, status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { this.body = body; } }; }
it('exposes only read-only inventory, with no catalog or mutation routes', () => {
  assert.deepEqual(routes.map(route => [route.path, Object.keys(route.methods)]), [['/installed', ['get']]]);
});
it('discovers external files, preserves source records and rejects unknown workspaces', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'comate-inventory-api-'));
  try {
    await mkdir(path.join(root, '.claude/skills/external'), { recursive: true });
    await writeFile(path.join(root, '.claude/skills/external/SKILL.md'), '---\nname: external\ndescription: External\n---\nUse me');
    const lock = JSON.stringify({ version: 1, skills: { ghost: { source: 'old/repo' } } });
    await writeFile(path.join(root, 'skills-lock.json'), lock);
    store.get = async (id) => id === 'project' ? { id, folderPath: root } as never : null;
    const res = response();
    await routes[0].stack[0].handle({ query: { workspaceId: 'project' } }, res);
    const skills = (res.body as { skills: Array<{ name: string }> }).skills;
    assert.ok(skills.some(skill => skill.name === 'external'));
    assert.ok(skills.some(skill => skill.name === 'skill-manager'));
    assert.ok(!skills.some(skill => skill.name === 'ghost'));
    const missing = response();
    await routes[0].stack[0].handle({ query: { workspaceId: 'unknown' } }, missing);
    assert.equal(missing.statusCode, 404);
  } finally { await rm(root, { recursive: true, force: true }); }
});
