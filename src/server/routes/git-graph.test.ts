import '../test-utils/test-env.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { store as workspaceStore } from '../storage/sqlite-store.js';

const execFileAsync = promisify(execFile);

async function routeHandler(routePath = '/') {
  const { default: router } = await import('./git-graph.js');
  const layer = (router as unknown as {
    stack: Array<{
      route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: Array<{ handle: (req: unknown, res: unknown) => Promise<void> }>;
      };
    }>;
  }).stack.find((candidate) => candidate.route?.path === routePath);
  assert.ok(layer?.route?.methods.get);
  return layer.route.stack[0].handle;
}

async function gitStatusHandler() {
  const { default: router } = await import('./git-status.js');
  const layer = (router as unknown as {
    stack: Array<{
      route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: Array<{ handle: (req: unknown, res: unknown) => Promise<void> }>;
      };
    }>;
  }).stack.find((candidate) => candidate.route?.path === '/');
  assert.ok(layer?.route?.methods.get);
  return layer.route.stack[0].handle;
}

function mockResponse() {
  return {
    statusCode: 200,
    jsonBody: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.jsonBody = body;
    },
  };
}

describe('git-graph route', { concurrency: false }, () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'comate-git-graph-route-'));
    workspaceStore.resetData();
  });

  afterEach(async () => {
    workspaceStore.resetData();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns a bounded snapshot for a Workspace', async () => {
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: tempDir });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: tempDir });
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'one'], { cwd: tempDir });
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'two'], { cwd: tempDir });
    const workspace = await workspaceStore.create({ name: 'repo', folderPath: tempDir });
    const handler = await routeHandler();
    const res = mockResponse();

    await handler({ params: { id: workspace.id }, query: { limit: '1' } }, res);

    assert.equal(res.statusCode, 200);
    const body = res.jsonBody as { commits: unknown[]; limit: number; hasMore: boolean };
    assert.equal(body.commits.length, 1);
    assert.equal(body.limit, 1);
    assert.equal(body.hasMore, true);
  });

  it('discovers clean child repositories and binds all reads to a repository ID', async () => {
    const child = path.join(tempDir, 'child');
    await mkdir(child);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: child });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: child });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: child });
    await writeFile(path.join(child, 'file.txt'), 'child content\n');
    await execFileAsync('git', ['add', '.'], { cwd: child });
    await execFileAsync('git', ['commit', '-m', 'child'], { cwd: child });
    const workspace = await workspaceStore.create({ name: 'container', folderPath: tempDir });
    const catalogRes = mockResponse();
    await (await routeHandler('/repositories'))({ params: { id: workspace.id }, query: {} }, catalogRes);
    const { repositories } = catalogRes.jsonBody as { repositories: { id: string }[] };
    assert.equal(repositories.length, 1);
    const repositoryId = repositories[0].id;
    const res = mockResponse();
    await (await routeHandler())({ params: { id: workspace.id }, query: { repositoryId } }, res);
    assert.equal(res.statusCode, 200);
    const snapshot = res.jsonBody as { repositoryId: string; commits: { hash: string }[] };
    assert.equal(snapshot.repositoryId, repositoryId);
    const hash = snapshot.commits[0].hash;
    const diff = mockResponse();
    await (await routeHandler('/:hash/diff'))({ params: { id: workspace.id, hash }, query: { repositoryId, path: 'file.txt' } }, diff);
    assert.equal((diff.jsonBody as { modified: string }).modified, 'child content\n');
    const legacy = mockResponse();
    await (await routeHandler())({ params: { id: workspace.id }, query: {} }, legacy);
    assert.equal(legacy.statusCode, 409);
    await rm(path.join(child, '.git'), { recursive: true });
    for (const route of ['/', '/:hash', '/:hash/diff']) {
      const unavailable = mockResponse();
      await (await routeHandler(route))({ params: { id: workspace.id, hash }, query: { repositoryId, path: 'file.txt' } }, unavailable);
      assert.equal(unavailable.statusCode, 409);
    }
  });

  it('returns commit details and historical file comparisons', async () => {
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: tempDir });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: tempDir });
    await writeFile(path.join(tempDir, 'file.txt'), 'before\n');
    await execFileAsync('git', ['add', '.'], { cwd: tempDir });
    await execFileAsync('git', ['commit', '-m', 'root'], { cwd: tempDir });
    await writeFile(path.join(tempDir, 'file.txt'), 'after\n');
    await execFileAsync('git', ['commit', '-am', 'change'], { cwd: tempDir });
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: tempDir, encoding: 'utf8' });
    const hash = stdout.trim();
    const workspace = await workspaceStore.create({ name: 'repo', folderPath: tempDir });

    const detailRes = mockResponse();
    await (await routeHandler('/:hash'))({ params: { id: workspace.id, hash }, query: {} }, detailRes);
    assert.equal(detailRes.statusCode, 200);
    assert.deepStrictEqual((detailRes.jsonBody as { files: Array<{ path: string }> }).files.map((file) => file.path), ['file.txt']);

    const diffRes = mockResponse();
    await (await routeHandler('/:hash/diff'))(
      { params: { id: workspace.id, hash }, query: { path: 'file.txt' } },
      diffRes,
    );
    assert.equal(diffRes.statusCode, 200);
    assert.equal((diffRes.jsonBody as { original: string }).original, 'before\n');
    assert.equal((diffRes.jsonBody as { modified: string }).modified, 'after\n');
  });

  it('maps invalid commit and path requests to stable 400 errors', async () => {
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: tempDir });
    const workspace = await workspaceStore.create({ name: 'repo', folderPath: tempDir });
    const detailRes = mockResponse();
    await (await routeHandler('/:hash'))(
      { params: { id: workspace.id, hash: 'HEAD' }, query: {} },
      detailRes,
    );
    assert.equal(detailRes.statusCode, 400);
    assert.equal((detailRes.jsonBody as { code: string }).code, 'INVALID_GIT_GRAPH_REQUEST');

    const diffRes = mockResponse();
    await (await routeHandler('/:hash/diff'))(
      { params: { id: workspace.id, hash: 'a'.repeat(40) }, query: {} },
      diffRes,
    );
    assert.equal(diffRes.statusCode, 400);
    assert.equal((diffRes.jsonBody as { error: string }).error, 'path is required');
  });

  it('extends git-ref with capability while preserving its ref field', async () => {
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: tempDir });
    const workspace = await workspaceStore.create({ name: 'empty repo', folderPath: tempDir });
    const handler = await gitStatusHandler();
    const res = mockResponse();

    await handler({ params: { id: workspace.id } }, res);

    assert.deepStrictEqual(res.jsonBody, {
      isGitWorktree: true,
      state: 'unborn',
      branch: 'main',
      ref: 'main',
      headHash: null,
    });
  });

  it('rejects non-Git Workspaces and invalid filters', async () => {
    const workspace = await workspaceStore.create({ name: 'plain', folderPath: tempDir });
    const handler = await routeHandler();
    const nonGitRes = mockResponse();

    await handler({ params: { id: workspace.id }, query: {} }, nonGitRes);
    assert.equal(nonGitRes.statusCode, 409);
    assert.deepStrictEqual(nonGitRes.jsonBody, {
      error: 'Workspace is not a Git worktree',
      code: 'GIT_GRAPH_UNAVAILABLE',
    });

    await execFileAsync('git', ['init', '-b', 'main'], { cwd: tempDir });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: tempDir });
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'one'], { cwd: tempDir });
    const invalidRes = mockResponse();
    await handler(
      { params: { id: workspace.id }, query: { ref: 'refs/heads/missing' } },
      invalidRes,
    );
    assert.equal(invalidRes.statusCode, 400);
    assert.deepStrictEqual(invalidRes.jsonBody, {
      error: 'Unknown Git ref: refs/heads/missing',
      code: 'INVALID_GIT_GRAPH_REQUEST',
    });
  });

  it('returns 404 for an unknown Workspace', async () => {
    const handler = await routeHandler();
    const res = mockResponse();
    await handler({ params: { id: 'missing' }, query: {} }, res);
    assert.equal(res.statusCode, 404);
    assert.deepStrictEqual(res.jsonBody, {
      error: 'Workspace not found',
      code: 'WORKSPACE_NOT_FOUND',
    });
  });

  it('rejects malformed query shapes instead of silently using defaults', async () => {
    const workspace = await workspaceStore.create({ name: 'plain', folderPath: tempDir });
    const handler = await routeHandler();
    const res = mockResponse();
    await handler({ params: { id: workspace.id }, query: { limit: ['5'] } }, res);
    assert.equal(res.statusCode, 400);
    assert.deepStrictEqual(res.jsonBody, {
      error: 'limit must be an integer',
      code: 'INVALID_GIT_GRAPH_REQUEST',
    });
  });
});
