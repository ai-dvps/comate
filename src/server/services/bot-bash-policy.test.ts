import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateBash, buildSanitizedEnv } from './bot-bash-policy.js';
import { createPathPolicyContext } from './bot-path-policy.js';
import type { Workspace } from '../models/workspace.js';
import type { BashPolicyContext } from './bot-bash-policy.js';

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

describe('evaluateBash', () => {
  let tmpDir = '';
  let ctx: BashPolicyContext;

  before(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bot-bash-')));
    fs.mkdirSync(path.join(tmpDir, 'user-a'));
    fs.writeFileSync(path.join(tmpDir, 'shared.txt'), 'shared');
    const workspace = createWorkspace({ folderPath: tmpDir });
    ctx = {
      whitelist: [
        { command: 'cat', args: [{ type: 'user_path' }], description: 'read user file' },
        { command: 'cat', args: [{ type: 'shared_path' }], description: 'read shared file' },
        { command: 'head', args: [{ type: 'user_path' }], description: 'read user file only' },
        { command: 'echo', args: [{ type: 'any' }], description: 'echo anything safe' },
        { command: 'git', args: ['status'], description: 'literal status' },
      ],
      pathContext: createPathPolicyContext(workspace, 'user-a'),
    };
  });

  it('denies Bash when the whitelist is empty', () => {
    const result = evaluateBash({ ...ctx, whitelist: [] }, { command: 'echo hello' });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'bash-disabled');
  });

  it('rejects missing or empty command', () => {
    assert.equal(evaluateBash(ctx, {}).allowed, false);
    assert.equal(evaluateBash(ctx, { command: '' }).allowed, false);
    assert.equal(evaluateBash(ctx, { command: 123 }).allowed, false);
  });

  it('rejects commands containing control characters', () => {
    const result = evaluateBash(ctx, { command: 'echo\nrm -rf /' });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'control-characters');
  });

  it('rejects unbalanced quotes', () => {
    const result = evaluateBash(ctx, { command: 'echo "hello' });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'unbalanced-quotes');
  });

  it('rejects trailing backslash', () => {
    const result = evaluateBash(ctx, { command: 'echo hello\\' });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'trailing-backslash');
  });

  it('rejects shell metacharacters after tokenization', () => {
    const result = evaluateBash(ctx, { command: 'echo hello; rm -rf /' });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'shell-metacharacter');
  });

  it('rejects commands not in the whitelist', () => {
    const result = evaluateBash(ctx, { command: 'rm file.txt' });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'whitelist-mismatch');
  });

  it('rejects commands with argument count mismatch', () => {
    const result = evaluateBash(ctx, { command: 'echo hello world' });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'whitelist-mismatch');
  });

  it('allows a literal string argument match', () => {
    const result = evaluateBash(ctx, { command: 'git status' });
    assert.equal(result.allowed, true);
  });

  it('allows a user_path argument inside the user directory', () => {
    const result = evaluateBash(ctx, {
      command: `cat ${path.join(tmpDir, 'user-a', 'file.txt')}`,
    });
    assert.equal(result.allowed, true);
  });

  it('denies a user_path argument outside the user directory', () => {
    const result = evaluateBash(ctx, {
      command: `head ${path.join(tmpDir, 'shared.txt')}`,
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'whitelist-mismatch');
  });

  it('allows a shared_path argument for reading shared files', () => {
    const result = evaluateBash(ctx, {
      command: `cat ${path.join(tmpDir, 'shared.txt')}`,
    });
    assert.equal(result.allowed, true);
  });

  it('allows any placeholder with safe arguments', () => {
    const result = evaluateBash(ctx, { command: 'echo hello-world' });
    assert.equal(result.allowed, true);
  });

  it('rejects any placeholder containing shell metacharacters', () => {
    const result = evaluateBash(ctx, { command: 'echo hello;world' });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'shell-metacharacter');
  });

  it('supports quoted arguments', () => {
    const result = evaluateBash(ctx, { command: 'echo "hello world"' });
    assert.equal(result.allowed, true);
  });
});

describe('buildSanitizedEnv', () => {
  it('strips provider and bot credentials while preserving harmless variables', () => {
    const env = {
      PATH: '/usr/bin',
      HOME: '/home/user',
      ANTHROPIC_API_KEY: 'secret',
      WECOM_BOT_SECRET: 'secret',
      AWS_ACCESS_KEY_ID: 'secret',
      GOOGLE_API_KEY: 'secret',
      AZURE_CLIENT_SECRET: 'secret',
      OPENAI_API_KEY: 'secret',
      CLAUDE_API_KEY: 'secret',
      CLAUDE_AUTH_TOKEN: 'secret',
    };
    const result = buildSanitizedEnv(env);
    assert.equal(result.PATH, '/usr/bin');
    assert.equal(result.HOME, '/home/user');
    assert.equal(result.ANTHROPIC_API_KEY, undefined);
    assert.equal(result.WECOM_BOT_SECRET, undefined);
    assert.equal(result.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(result.GOOGLE_API_KEY, undefined);
    assert.equal(result.AZURE_CLIENT_SECRET, undefined);
    assert.equal(result.OPENAI_API_KEY, undefined);
    assert.equal(result.CLAUDE_API_KEY, undefined);
    assert.equal(result.CLAUDE_AUTH_TOKEN, undefined);
  });
});
