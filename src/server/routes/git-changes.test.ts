import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { writeFile, rm, mkdtemp, mkdir } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import type { GitStatusItem } from '../models/git-changes.js';

const execFileAsync = promisify(execFile);

async function mkdtempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'comate-git-test-'));
}

async function importRouteHandlers() {
  const mod = await import('./git-changes.js');
  const router = mod.default;
  const layers = (router as unknown as { stack: Array<{ route?: { methods: Record<string, boolean>; path: string; stack: Array<{ handle: (req: unknown, res: unknown) => Promise<void> }> } }> }).stack;
  const handlers: Record<string, Record<string, (req: unknown, res: unknown) => Promise<void>>> = {};
  for (const layer of layers) {
    if (!layer.route) continue;
    const path = layer.route.path;
    const methods = Object.keys(layer.route.methods);
    if (!handlers[path]) handlers[path] = {};
    for (const method of methods) {
      handlers[path][method] = layer.route.stack[0].handle;
    }
  }
  return handlers;
}

function createMockRes(): {
  statusCode: number;
  jsonBody: unknown;
  status(code: number): typeof res;
  json(body: unknown): void;
} {
  const res = {
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
  return res;
}

async function initGitRepo(dir: string): Promise<void> {
  await execFileAsync('git', ['init'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });
}

async function createWorkspaceInStore(folderPath: string): Promise<string> {
  const workspace = await workspaceStore.create({
    name: 'test-ws',
    folderPath,
  });
  return workspace.id;
}

describe('git-changes routes', { concurrency: false }, () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtempDir();
    workspaceStore.resetData();
  });

  afterEach(async () => {
    workspaceStore.resetData();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('GET / returns files with correct statuses', async () => {
    await initGitRepo(tempDir);
    await writeFile(path.join(tempDir, 'tracked.txt'), 'tracked');
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: tempDir });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: tempDir });

    await writeFile(path.join(tempDir, 'tracked.txt'), 'modified');
    await writeFile(path.join(tempDir, 'staged.txt'), 'staged');
    await execFileAsync('git', ['add', 'staged.txt'], { cwd: tempDir });
    await writeFile(path.join(tempDir, 'untracked.txt'), 'untracked');

    const workspaceId = await createWorkspaceInStore(tempDir);
    const handlers = await importRouteHandlers();
    const req = { params: { id: workspaceId } };
    const res = createMockRes();

    await handlers['/'].get(req, res);

    assert.strictEqual(res.statusCode, 200);
    const items = (res.jsonBody as { items: Array<{ path: string; indexStatus: string; workingTreeStatus: string }> }).items;
    const byPath = new Map(items.map((i) => [i.path, i]));

    assert.strictEqual(byPath.get('tracked.txt')?.indexStatus, ' ');
    assert.strictEqual(byPath.get('tracked.txt')?.workingTreeStatus, 'M');
    assert.strictEqual(byPath.get('staged.txt')?.indexStatus, 'A');
    assert.strictEqual(byPath.get('staged.txt')?.workingTreeStatus, ' ');
    assert.strictEqual(byPath.get('untracked.txt')?.indexStatus, '?');
    assert.strictEqual(byPath.get('untracked.txt')?.workingTreeStatus, '?');
  });

  it('GET / lists individual untracked files inside untracked directories', async () => {
    await initGitRepo(tempDir);
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: tempDir });

    await mkdir(path.join(tempDir, 'newdir', 'subdir'), { recursive: true });
    await writeFile(path.join(tempDir, 'newdir', 'a.txt'), 'a');
    await writeFile(path.join(tempDir, 'newdir', 'subdir', 'b.txt'), 'b');

    const workspaceId = await createWorkspaceInStore(tempDir);
    const handlers = await importRouteHandlers();
    const req = { params: { id: workspaceId } };
    const res = createMockRes();

    await handlers['/'].get(req, res);

    assert.strictEqual(res.statusCode, 200);
    const items = (res.jsonBody as { items: GitStatusItem[] }).items;
    const paths = items.map((i) => i.path).sort();
    assert.deepStrictEqual(paths, ['newdir/a.txt', 'newdir/subdir/b.txt']);
    for (const item of items) {
      assert.strictEqual(item.indexStatus, '?');
      assert.strictEqual(item.workingTreeStatus, '?');
    }
  });

  it('GET / returns originalPath for renamed files', async () => {
    await initGitRepo(tempDir);
    await writeFile(path.join(tempDir, 'old.txt'), 'content');
    await execFileAsync('git', ['add', 'old.txt'], { cwd: tempDir });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: tempDir });

    await execFileAsync('git', ['mv', 'old.txt', 'new.txt'], { cwd: tempDir });

    const workspaceId = await createWorkspaceInStore(tempDir);
    const handlers = await importRouteHandlers();
    const req = { params: { id: workspaceId } };
    const res = createMockRes();

    await handlers['/'].get(req, res);

    assert.strictEqual(res.statusCode, 200);
    const items = (res.jsonBody as { items: GitStatusItem[] }).items;
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].path, 'new.txt');
    assert.strictEqual(items[0].originalPath, 'old.txt');
    assert.strictEqual(items[0].indexStatus, 'R');
  });

  it('GET / returns non-ASCII filenames verbatim (no porcelain quoting)', async () => {
    await initGitRepo(tempDir);
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: tempDir });

    // A CJK filename would be octal-escaped under git's default core.quotepath,
    // which the previous newline parser passed through verbatim and made
    // unreachable as a filesystem path. The -z parser must emit it as-is.
    await writeFile(path.join(tempDir, '中文.txt'), 'content');
    await writeFile(path.join(tempDir, 'café.md'), 'coffee');

    const workspaceId = await createWorkspaceInStore(tempDir);
    const handlers = await importRouteHandlers();
    const req = { params: { id: workspaceId } };
    const res = createMockRes();

    await handlers['/'].get(req, res);

    assert.strictEqual(res.statusCode, 200);
    const items = (res.jsonBody as { items: GitStatusItem[] }).items;
    const paths = items.map((i) => i.path).sort();
    assert.deepStrictEqual(paths, ['café.md', '中文.txt']);
  });

  it('GET / returns empty list for a clean repository', async () => {
    await initGitRepo(tempDir);
    await writeFile(path.join(tempDir, 'file.txt'), 'content');
    await execFileAsync('git', ['add', 'file.txt'], { cwd: tempDir });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: tempDir });

    const workspaceId = await createWorkspaceInStore(tempDir);
    const handlers = await importRouteHandlers();
    const req = { params: { id: workspaceId } };
    const res = createMockRes();

    await handlers['/'].get(req, res);

    assert.strictEqual(res.statusCode, 200);
    const items = (res.jsonBody as { items: GitStatusItem[] }).items;
    assert.strictEqual(items.length, 0);
  });

  it('GET / returns empty list when not a git repository', async () => {
    await writeFile(path.join(tempDir, 'file.txt'), 'content');
    const workspaceId = await createWorkspaceInStore(tempDir);
    const handlers = await importRouteHandlers();
    const req = { params: { id: workspaceId } };
    const res = createMockRes();

    await handlers['/'].get(req, res);

    assert.strictEqual(res.statusCode, 200);
    const items = (res.jsonBody as { items: GitStatusItem[] }).items;
    assert.strictEqual(items.length, 0);
  });

  it('GET / returns 404 when workspace does not exist', async () => {
    const handlers = await importRouteHandlers();
    const req = { params: { id: 'missing-ws' } };
    const res = createMockRes();

    await handlers['/'].get(req, res);

    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual((res.jsonBody as { error: string }).error, 'Workspace not found');
  });

  it('GET /compare returns original HEAD and modified working tree for an unstaged file', async () => {
    await initGitRepo(tempDir);
    await writeFile(path.join(tempDir, 'file.txt'), 'original');
    await execFileAsync('git', ['add', 'file.txt'], { cwd: tempDir });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: tempDir });

    await writeFile(path.join(tempDir, 'file.txt'), 'modified');

    const workspaceId = await createWorkspaceInStore(tempDir);
    const handlers = await importRouteHandlers();
    const req = { params: { id: workspaceId }, query: { path: 'file.txt' } };
    const res = createMockRes();

    await handlers['/compare'].get(req, res);

    assert.strictEqual(res.statusCode, 200);
    const body = res.jsonBody as {
      original: string;
      modified: string;
      isBinary: boolean;
      truncated: boolean;
      isDeleted: boolean;
    };
    assert.strictEqual(body.original, 'original');
    assert.strictEqual(body.modified, 'modified');
    assert.strictEqual(body.isBinary, false);
    assert.strictEqual(body.truncated, false);
    assert.strictEqual(body.isDeleted, false);
  });

  it('GET /compare returns original HEAD and modified index for a staged file', async () => {
    await initGitRepo(tempDir);
    await writeFile(path.join(tempDir, 'file.txt'), 'original');
    await execFileAsync('git', ['add', 'file.txt'], { cwd: tempDir });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: tempDir });

    await writeFile(path.join(tempDir, 'file.txt'), 'working');
    await execFileAsync('git', ['add', 'file.txt'], { cwd: tempDir });

    const workspaceId = await createWorkspaceInStore(tempDir);
    const handlers = await importRouteHandlers();
    const req = { params: { id: workspaceId }, query: { path: 'file.txt', staged: 'true' } };
    const res = createMockRes();

    await handlers['/compare'].get(req, res);

    assert.strictEqual(res.statusCode, 200);
    const body = res.jsonBody as {
      original: string;
      modified: string;
      isBinary: boolean;
      truncated: boolean;
      isDeleted: boolean;
    };
    assert.strictEqual(body.original, 'original');
    assert.strictEqual(body.modified, 'working');
    assert.strictEqual(body.isBinary, false);
    assert.strictEqual(body.truncated, false);
    assert.strictEqual(body.isDeleted, false);
  });

  it('GET /compare returns empty original for an added file', async () => {
    await initGitRepo(tempDir);
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: tempDir });

    await writeFile(path.join(tempDir, 'added.txt'), 'new content');

    const workspaceId = await createWorkspaceInStore(tempDir);
    const handlers = await importRouteHandlers();
    const req = { params: { id: workspaceId }, query: { path: 'added.txt' } };
    const res = createMockRes();

    await handlers['/compare'].get(req, res);

    assert.strictEqual(res.statusCode, 200);
    const body = res.jsonBody as {
      original: string;
      modified: string;
      isBinary: boolean;
      truncated: boolean;
      isDeleted: boolean;
    };
    assert.strictEqual(body.original, '');
    assert.strictEqual(body.modified, 'new content');
    assert.strictEqual(body.isBinary, false);
    assert.strictEqual(body.truncated, false);
    assert.strictEqual(body.isDeleted, false);
  });

  it('GET /compare returns empty modified and isDeleted for a deleted file', async () => {
    await initGitRepo(tempDir);
    await writeFile(path.join(tempDir, 'deleted.txt'), 'gone');
    await execFileAsync('git', ['add', 'deleted.txt'], { cwd: tempDir });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: tempDir });

    await rm(path.join(tempDir, 'deleted.txt'));

    const workspaceId = await createWorkspaceInStore(tempDir);
    const handlers = await importRouteHandlers();
    const req = { params: { id: workspaceId }, query: { path: 'deleted.txt' } };
    const res = createMockRes();

    await handlers['/compare'].get(req, res);

    assert.strictEqual(res.statusCode, 200);
    const body = res.jsonBody as {
      original: string;
      modified: string;
      isBinary: boolean;
      truncated: boolean;
      isDeleted: boolean;
    };
    assert.strictEqual(body.original, 'gone');
    assert.strictEqual(body.modified, '');
    assert.strictEqual(body.isBinary, false);
    assert.strictEqual(body.truncated, false);
    assert.strictEqual(body.isDeleted, true);
  });

  it('GET /compare marks binary files as isBinary', async () => {
    await initGitRepo(tempDir);
    await writeFile(path.join(tempDir, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02]));
    await execFileAsync('git', ['add', 'binary.bin'], { cwd: tempDir });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: tempDir });

    await writeFile(path.join(tempDir, 'binary.bin'), Buffer.from([0xff, 0xfe, 0xfd]));

    const workspaceId = await createWorkspaceInStore(tempDir);
    const handlers = await importRouteHandlers();
    const req = { params: { id: workspaceId }, query: { path: 'binary.bin' } };
    const res = createMockRes();

    await handlers['/compare'].get(req, res);

    assert.strictEqual(res.statusCode, 200);
    const body = res.jsonBody as {
      original: string;
      modified: string;
      isBinary: boolean;
      truncated: boolean;
      isDeleted: boolean;
    };
    assert.strictEqual(body.isBinary, true);
    assert.strictEqual(body.truncated, false);
    assert.strictEqual(body.isDeleted, false);
  });

  it('GET /compare marks an untracked binary file as isBinary via null-byte scan', async () => {
    await initGitRepo(tempDir);
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: tempDir });

    await writeFile(path.join(tempDir, 'untracked.bin'), Buffer.from([0x00, 0x01, 0x02]));

    const workspaceId = await createWorkspaceInStore(tempDir);
    const handlers = await importRouteHandlers();
    const req = { params: { id: workspaceId }, query: { path: 'untracked.bin' } };
    const res = createMockRes();

    await handlers['/compare'].get(req, res);

    assert.strictEqual(res.statusCode, 200);
    const body = res.jsonBody as {
      original: string;
      modified: string;
      isBinary: boolean;
      truncated: boolean;
      isDeleted: boolean;
    };
    assert.strictEqual(body.isBinary, true);
    assert.strictEqual(body.original, '');
    assert.strictEqual(body.modified, '');
    assert.strictEqual(body.isDeleted, false);
  });

  it('GET /compare returns truncated for large content', async () => {
    await initGitRepo(tempDir);
    const originalLines = Array.from({ length: 6000 }, (_, i) => `line ${i}`).join('\n');
    await writeFile(path.join(tempDir, 'big.txt'), originalLines);
    await execFileAsync('git', ['add', 'big.txt'], { cwd: tempDir });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: tempDir });

    const changedLines = Array.from({ length: 6000 }, (_, i) => `changed ${i}`).join('\n');
    await writeFile(path.join(tempDir, 'big.txt'), changedLines);

    const workspaceId = await createWorkspaceInStore(tempDir);
    const handlers = await importRouteHandlers();
    const req = { params: { id: workspaceId }, query: { path: 'big.txt' } };
    const res = createMockRes();

    await handlers['/compare'].get(req, res);

    assert.strictEqual(res.statusCode, 200);
    const body = res.jsonBody as {
      original: string;
      modified: string;
      isBinary: boolean;
      truncated: boolean;
      isDeleted: boolean;
    };
    assert.strictEqual(body.isBinary, false);
    assert.strictEqual(body.truncated, true);
    assert.ok(body.original.split('\n').length <= 5000);
    assert.ok(body.modified.split('\n').length <= 5000);
  });

  it('GET /compare returns 403 when path is outside workspace', async () => {
    await initGitRepo(tempDir);
    const workspaceId = await createWorkspaceInStore(tempDir);
    const handlers = await importRouteHandlers();
    const req = { params: { id: workspaceId }, query: { path: '../outside.txt' } };
    const res = createMockRes();

    await handlers['/compare'].get(req, res);

    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual((res.jsonBody as { error: string }).error, 'Path outside workspace');
  });

  it('GET /compare returns 400 when path is missing', async () => {
    await initGitRepo(tempDir);
    const workspaceId = await createWorkspaceInStore(tempDir);
    const handlers = await importRouteHandlers();
    const req = { params: { id: workspaceId }, query: {} };
    const res = createMockRes();

    await handlers['/compare'].get(req, res);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual((res.jsonBody as { error: string }).error, 'path is required');
  });

  it('GET /compare returns 404 when workspace does not exist', async () => {
    const handlers = await importRouteHandlers();
    const req = { params: { id: 'missing-ws' }, query: { path: 'file.txt' } };
    const res = createMockRes();

    await handlers['/compare'].get(req, res);

    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual((res.jsonBody as { error: string }).error, 'Workspace not found');
  });

  it('GET /compare honors client-sent originalPath for renamed files', async () => {
    await initGitRepo(tempDir);
    await writeFile(path.join(tempDir, 'old.txt'), 'content');
    await execFileAsync('git', ['add', 'old.txt'], { cwd: tempDir });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: tempDir });

    await execFileAsync('git', ['mv', 'old.txt', 'new.txt'], { cwd: tempDir });

    const workspaceId = await createWorkspaceInStore(tempDir);
    const handlers = await importRouteHandlers();
    // The client sends the rename source so the server does not need to run a
    // second `git status` to discover it.
    const req = { params: { id: workspaceId }, query: { path: 'new.txt', originalPath: 'old.txt' } };
    const res = createMockRes();

    await handlers['/compare'].get(req, res);

    assert.strictEqual(res.statusCode, 200);
    const body = res.jsonBody as {
      original: string;
      modified: string;
      isBinary: boolean;
      truncated: boolean;
      isDeleted: boolean;
    };
    assert.strictEqual(body.original, 'content');
    assert.strictEqual(body.modified, 'content');
    assert.strictEqual(body.isBinary, false);
    assert.strictEqual(body.truncated, false);
    assert.strictEqual(body.isDeleted, false);
  });
});

