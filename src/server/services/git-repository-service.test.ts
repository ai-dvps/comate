import '../test-utils/test-env.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitRepositoryService } from './git-repository-service.js';

const roots: string[] = [];
const services: GitRepositoryService[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'comate-repositories-'));
  roots.push(root);
  const service = new GitRepositoryService({ batchSize: 2 });
  services.push(service);
  return { root, service };
}
async function init(root: string, relative: string) {
  const cwd = path.join(root, relative);
  await mkdir(cwd, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd, stdio: 'ignore' });
  return cwd;
}
async function scan(service: GitRepositoryService, root: string) {
  let result = await service.discover('ws', root, true);
  for (let batch = 0; !result.done && batch < 1000; batch++) {
    result = await service.discover('ws', root);
  }
  assert.equal(result.done, true);
  return result;
}
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('continues batches, sorts deep repositories and skips dependencies and outside links', async () => {
  const { root, service } = await fixture();
  await init(root, 'z');
  await init(root, 'apps/web');
  await init(root, 'ignored');
  await init(root, 'node_modules/dependency');
  await writeFile(path.join(root, '.gitignore'), 'ignored/\n');
  const outside = await mkdtemp(path.join(os.tmpdir(), 'comate-repositories-outside-'));
  roots.push(outside);
  await init(outside, '.');
  await symlink(outside, path.join(root, 'external'));
  await symlink(root, path.join(root, 'loop'));
  const result = await scan(service, root);
  assert.deepEqual(result.repositories.map((repo) => repo.relativePath), ['ignored', 'z', 'apps/web']);
  assert.deepEqual(result.errors, []);
  const again = await scan(service, root);
  assert.deepEqual(again.repositories, result.repositories);
});

it('never falls back to a parent after a nested repository is removed or replaced', async () => {
  const { root, service } = await fixture();
  await init(root, '.');
  const child = await init(root, 'child');
  const result = await scan(service, root);
  assert.equal(result.repositories[0].relativePath, '.');
  const repo = result.repositories.find((item) => item.relativePath === 'child')!;
  assert.equal((await service.resolve('ws', root, repo.id)).folderPath, await realpath(child));
  await assert.rejects(service.resolve('other', root, repo.id));
  await rm(path.join(child, '.git'), { recursive: true });
  await assert.rejects(service.resolve('ws', root, repo.id));
  await init(root, 'child');
  await assert.rejects(service.resolve('ws', root, repo.id));
});

it('preserves a Workspace subtree as the root read scope', async () => {
  const { root, service } = await fixture();
  await init(root, '.');
  const folder = path.join(root, 'sub');
  await mkdir(folder);
  const result = await scan(service, folder);
  assert.equal(result.repositories.length, 1);
  assert.equal((await service.resolve('ws', folder, result.repositories[0].id)).folderPath, await realpath(folder));
});

it('discovers initialized submodules and distinct linked worktrees with external metadata', async () => {
  const { root, service } = await fixture();
  const source = await init(root, 'source');
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'root'], { cwd: source });
  execFileSync('git', ['worktree', 'add', '-b', 'linked', path.join(root, 'linked')], { cwd: source, stdio: 'ignore' });
  const parent = await init(root, 'parent');
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'module'], { cwd: parent, stdio: 'ignore' });
  const result = await scan(service, root);
  assert.deepEqual(result.repositories.map((repo) => repo.relativePath), ['linked', 'parent', 'source', 'parent/module']);
  assert.equal(new Set(result.repositories.map((repo) => repo.id)).size, 4);
  assert.deepEqual(result.errors, []);
});

it('finishes with usable repositories and a partial error for invalid metadata', async () => {
  const { root, service } = await fixture();
  await init(root, 'good');
  await mkdir(path.join(root, 'broken'));
  await writeFile(path.join(root, 'broken/.git'), 'gitdir: /missing/comate-test-metadata\n');
  const result = await scan(service, root);
  assert.deepEqual(result.repositories.map((repo) => repo.relativePath), ['good']);
  assert.equal(result.errors[0].relativePath, 'broken');
});

it('keeps previous bindings readable during a forced multi-batch refresh', async () => {
  const { root, service } = await fixture();
  await init(root, 'deep/nested/repo');
  const first = await scan(service, root);
  const refreshing = await service.discover('ws', root, true);
  assert.equal(refreshing.done, false);
  assert.equal((await service.resolve('ws', root, first.repositories[0].id)).id, first.repositories[0].id);
});

it('does not abandon sibling repositories after a dangling symbolic link', async () => {
  const { root, service } = await fixture();
  await symlink(path.join(root, 'missing-target'), path.join(root, 'broken-link'));
  await init(root, 'repository');
  const result = await scan(service, root);
  assert.deepEqual(result.repositories.map((repo) => repo.relativePath), ['repository']);
  assert.deepEqual(result.errors, []);
});

it('expires a completed catalog even when focus repeatedly reads the cache', async (t) => {
  const { root, service } = await fixture();
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  await init(root, 'first');
  const first = await scan(service, root);
  await init(root, 'second');
  now += 20_000;
  assert.equal((await service.discover('ws', root)).generation, first.generation);
  now += 20_000;
  assert.notEqual((await service.discover('ws', root)).generation, first.generation);
});
