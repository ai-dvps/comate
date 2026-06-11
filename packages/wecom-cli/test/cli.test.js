import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('../dist/index.js', import.meta.url).pathname;

function run(args, cwd) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf-8',
  });
  return result;
}

describe('wecom cli', () => {
  describe('help', () => {
    it('shows help with bin name', () => {
      const result = run(['--help']);
      assert.strictEqual(result.status, 0);
      assert(result.stdout.includes('$ wecom [COMMAND]'));
    });

    it('shows msg:send help', () => {
      const result = run(['msg:send', '--help']);
      assert.strictEqual(result.status, 0);
      assert(result.stdout.includes('--to-user'));
      assert(result.stdout.includes('--message'));
      assert(result.stdout.includes('--msg-type'));
    });

    it('shows queue:enqueue help', () => {
      const result = run(['queue:enqueue', '--help']);
      assert.strictEqual(result.status, 0);
      assert(result.stdout.includes('--to-user'));
      assert(result.stdout.includes('--message'));
    });
  });

  describe('missing context file', () => {
    it('exits 2 for msg:send', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      const result = run(['msg:send', '--to-user', 'u', '--message', 'm'], tmpDir);
      assert.strictEqual(result.status, 2);
      assert(result.stderr.includes('No WeCom bot context file found'));
    });

    it('exits 2 for queue:enqueue', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      const result = run(['queue:enqueue', '--to-user', 'u', '--message', 'm'], tmpDir);
      assert.strictEqual(result.status, 2);
      assert(result.stderr.includes('No WeCom bot context file found'));
    });
  });

  describe('invalid context file', () => {
    it('exits 1 for msg:send with malformed context', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      mkdirSync(join(tmpDir, '.claude'));
      writeFileSync(join(tmpDir, '.claude/wecom-context.json'), '{}');
      const result = run(['msg:send', '--to-user', 'u', '--message', 'm'], tmpDir);
      assert.strictEqual(result.status, 1);
      assert(result.stderr.includes('Invalid context file format'));
    });
  });

  describe('missing workspaceId', () => {
    it('exits 1 for queue:enqueue', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      mkdirSync(join(tmpDir, '.claude'));
      writeFileSync(
        join(tmpDir, '.claude/wecom-context.json'),
        JSON.stringify({ botId: 'b', serverUrl: 'http://localhost' })
      );
      const result = run(['queue:enqueue', '--to-user', 'u', '--message', 'm'], tmpDir);
      assert.strictEqual(result.status, 1);
      assert(result.stderr.includes('missing workspaceId'));
    });
  });

  describe('missing required flags', () => {
    it('exits 1 for msg:send without --to-user', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      mkdirSync(join(tmpDir, '.claude'));
      writeFileSync(
        join(tmpDir, '.claude/wecom-context.json'),
        JSON.stringify({ botId: 'b', serverUrl: 'http://localhost' })
      );
      const result = run(['msg:send', '--message', 'm'], tmpDir);
      assert.strictEqual(result.status, 1);
      assert(result.stderr.includes('Missing required flag to-user'));
    });

    it('exits 1 for msg:send without --message', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      mkdirSync(join(tmpDir, '.claude'));
      writeFileSync(
        join(tmpDir, '.claude/wecom-context.json'),
        JSON.stringify({ botId: 'b', serverUrl: 'http://localhost' })
      );
      const result = run(['msg:send', '--to-user', 'u'], tmpDir);
      assert.strictEqual(result.status, 1);
      assert(result.stderr.includes('Missing required flag message'));
    });

    it('exits 1 for queue:enqueue without --to-user', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      mkdirSync(join(tmpDir, '.claude'));
      writeFileSync(
        join(tmpDir, '.claude/wecom-context.json'),
        JSON.stringify({ botId: 'b', serverUrl: 'http://localhost', workspaceId: 'w' })
      );
      const result = run(['queue:enqueue', '--message', 'm'], tmpDir);
      assert.strictEqual(result.status, 1);
      assert(result.stderr.includes('Missing required flag to-user'));
    });
  });

  describe('invalid --msg-type', () => {
    it('exits 1 for msg:send with bad msg-type', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      mkdirSync(join(tmpDir, '.claude'));
      writeFileSync(
        join(tmpDir, '.claude/wecom-context.json'),
        JSON.stringify({ botId: 'b', serverUrl: 'http://localhost' })
      );
      const result = run(['msg:send', '--to-user', 'u', '--message', 'm', '--msg-type', 'bad'], tmpDir);
      assert.strictEqual(result.status, 1);
      assert(result.stderr.includes('Expected --msg-type='));
    });
  });
});
