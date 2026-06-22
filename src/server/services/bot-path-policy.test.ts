import '../test-utils/test-env.js';
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createPathPolicyContext,
  validateToolInput,
  resolveAndCheckPath,
  checkUserPath,
} from './bot-path-policy.js';
import type { Workspace } from '../models/workspace.js';

function createWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    name: 'Test',
    description: '',
    folderPath: '/tmp/test',
    settings: {},
    skills: [],
    mcpServers: [],
    hooks: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('createPathPolicyContext', () => {
  it('resolves workspace folder and user directory', () => {
    const workspace = createWorkspace({ folderPath: '/tmp/test' });
    const ctx = createPathPolicyContext(workspace, 'user-a', ['user-b']);
    assert.equal(ctx.workspaceFolder, path.resolve('/tmp/test'));
    assert.equal(ctx.userDirName, 'user-a');
    assert.equal(ctx.userDir, path.join(path.resolve('/tmp/test'), 'user-a'));
    assert.deepEqual(ctx.knownUserDirNames, ['user-b']);
  });

  it('excludes the current user from knownUserDirNames', () => {
    const workspace = createWorkspace({ folderPath: '/tmp/test' });
    const ctx = createPathPolicyContext(workspace, 'user-a', ['user-a', 'user-b']);
    assert.deepEqual(ctx.knownUserDirNames, ['user-b']);
  });
});

describe('validateToolInput', () => {
  let tmpDir = '';
  let workspace: Workspace;
  let ctx: ReturnType<typeof createPathPolicyContext>;

  before(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bot-path-policy-')));
    const userDir = path.join(tmpDir, 'user-a');
    const otherDir = path.join(tmpDir, 'user-b');
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(userDir);
    fs.mkdirSync(otherDir);
    fs.mkdirSync(claudeDir);
    fs.writeFileSync(path.join(userDir, 'note.txt'), 'hello');
    fs.writeFileSync(path.join(otherDir, 'secret.txt'), 'secret');
    fs.writeFileSync(path.join(tmpDir, 'shared.txt'), 'shared');

    workspace = createWorkspace({ folderPath: tmpDir });
    ctx = createPathPolicyContext(workspace, 'user-a', ['user-b']);
  });

  it('allows reading a file inside the user directory', () => {
    const result = validateToolInput(ctx, 'Read', { file_path: path.join(tmpDir, 'user-a', 'note.txt') });
    assert.equal(result.allowed, true);
  });

  it('denies reading a file inside another user directory', () => {
    const result = validateToolInput(ctx, 'Read', { file_path: path.join(tmpDir, 'user-b', 'secret.txt') });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'other-user-dir');
  });

  it('denies reading a denylisted path such as .claude', () => {
    const result = validateToolInput(ctx, 'Read', { file_path: path.join(tmpDir, '.claude', 'settings.json') });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'denylist');
  });

  it('allows reading a shared workspace file', () => {
    const result = validateToolInput(ctx, 'Read', { file_path: path.join(tmpDir, 'shared.txt') });
    assert.equal(result.allowed, true);
  });

  it('denies reading outside the workspace', () => {
    const result = validateToolInput(ctx, 'Read', { file_path: '/etc/passwd' });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'outside-workspace');
  });

  it('rejects invalid path input', () => {
    assert.equal(validateToolInput(ctx, 'Read', { file_path: '' }).allowed, false);
    assert.equal(validateToolInput(ctx, 'Read', { file_path: 123 }).allowed, false);
  });

  it('allows writing inside the user directory', () => {
    const result = validateToolInput(ctx, 'Write', { file_path: path.join(tmpDir, 'user-a', 'new.txt') });
    assert.equal(result.allowed, true);
  });

  it('denies writing shared workspace files', () => {
    const result = validateToolInput(ctx, 'Edit', { file_path: path.join(tmpDir, 'shared.txt') });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'outside-user-dir-write');
  });

  it('allows NotebookEdit inside the user directory', () => {
    const result = validateToolInput(ctx, 'NotebookEdit', { notebook_path: path.join(tmpDir, 'user-a', 'book.ipynb') });
    assert.equal(result.allowed, true);
  });

  it('rejects Glob patterns with parent traversal', () => {
    const result = validateToolInput(ctx, 'Glob', { pattern: '../etc/*' });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'invalid-pattern');
  });

  it('rejects Glob patterns targeting protected segments', () => {
    assert.equal(validateToolInput(ctx, 'Glob', { pattern: '.claude/**' }).allowed, false);
    assert.equal(validateToolInput(ctx, 'Glob', { pattern: 'node_modules/**' }).allowed, false);
    assert.equal(validateToolInput(ctx, 'Glob', { pattern: '.git/**' }).allowed, false);
  });

  it('rejects Glob patterns targeting another user directory', () => {
    const result = validateToolInput(ctx, 'Glob', { pattern: 'user-b/**' });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'other-user-dir');
  });

  it('allows Glob patterns inside the user directory', () => {
    const result = validateToolInput(ctx, 'Glob', { pattern: 'user-a/**/*.txt' });
    assert.equal(result.allowed, true);
  });

  it('validates absolute Glob patterns against the path policy', () => {
    const result = validateToolInput(ctx, 'Glob', {
      pattern: path.join(tmpDir, 'user-a', '*.txt'),
    });
    assert.equal(result.allowed, true);
  });

  it('rejects Grep path targeting another user directory', () => {
    const result = validateToolInput(ctx, 'Grep', {
      path: path.join(tmpDir, 'user-b'),
      pattern: 'secret',
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'other-user-dir');
  });

  it('allows Grep with no path (defaults to workspace root)', () => {
    const result = validateToolInput(ctx, 'Grep', { pattern: 'shared' });
    assert.equal(result.allowed, true);
  });

  it('rejects Grep with invalid glob filter', () => {
    const result = validateToolInput(ctx, 'Grep', {
      path: tmpDir,
      glob: '.claude/**',
      pattern: 'x',
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'denylist');
  });
});

describe('resolveAndCheckPath', () => {
  it('allows reading a shared file and denies writing it', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bot-resolve-')));
    fs.mkdirSync(path.join(tmpDir, 'user-a'));
    fs.writeFileSync(path.join(tmpDir, 'shared.txt'), 'shared');
    const workspace = createWorkspace({ folderPath: tmpDir });
    const ctx = createPathPolicyContext(workspace, 'user-a');

    const readResult = resolveAndCheckPath(ctx, path.join(tmpDir, 'shared.txt'), { write: false });
    assert.equal(readResult.allowed, true);

    const writeResult = resolveAndCheckPath(ctx, path.join(tmpDir, 'shared.txt'), { write: true });
    assert.equal(writeResult.allowed, false);
    assert.equal(writeResult.reason, 'outside-user-dir-write');
  });
});

describe('checkUserPath', () => {
  it('allows paths inside the user directory', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bot-user-')));
    fs.mkdirSync(path.join(tmpDir, 'user-a'));
    const workspace = createWorkspace({ folderPath: tmpDir });
    const ctx = createPathPolicyContext(workspace, 'user-a');

    const result = checkUserPath(ctx, path.join(tmpDir, 'user-a', 'file.txt'));
    assert.equal(result.allowed, true);
  });

  it('denies paths outside the user directory', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bot-user-')));
    fs.mkdirSync(path.join(tmpDir, 'user-a'));
    fs.writeFileSync(path.join(tmpDir, 'shared.txt'), 'shared');
    const workspace = createWorkspace({ folderPath: tmpDir });
    const ctx = createPathPolicyContext(workspace, 'user-a');

    const result = checkUserPath(ctx, path.join(tmpDir, 'shared.txt'));
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'outside-user-dir-write');
  });
});