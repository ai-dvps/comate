import '../test-utils/test-env.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { store as workspaceStore } from '../storage/sqlite-store.js';

const execFileAsync = promisify(execFile);

async function routeHandler() {
  const { default: router } = await import('./git-graph.js');
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
