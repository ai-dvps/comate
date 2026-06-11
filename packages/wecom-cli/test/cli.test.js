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

    it('shows send help', () => {
      const result = run(['send', '--help']);
      assert.strictEqual(result.status, 0);
      assert(result.stdout.includes('--to-user'));
      assert(result.stdout.includes('--message'));
      assert(result.stdout.includes('--session-id'));
      assert(result.stdout.includes('--msg-type'));
    });

    it('does not show old msg:send command', () => {
      const result = run(['--help']);
      assert.strictEqual(result.status, 0);
      assert(!result.stdout.includes('msg:send'));
    });

    it('does not show old queue:enqueue command', () => {
      const result = run(['--help']);
      assert.strictEqual(result.status, 0);
      assert(!result.stdout.includes('queue:enqueue'));
    });
  });

  describe('missing context file', () => {
    it('exits 2 for send', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      const result = run(['send', '--to-user', 'u', '--message', 'm', '--session-id', 's'], tmpDir);
      assert.strictEqual(result.status, 2);
      assert(result.stderr.includes('No WeCom bot context file found'));
    });
  });

  describe('invalid context file', () => {
    it('exits 1 for send with malformed context', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      mkdirSync(join(tmpDir, '.claude'));
      writeFileSync(join(tmpDir, '.claude/wecom-context.json'), '{}');
      const result = run(['send', '--to-user', 'u', '--message', 'm', '--session-id', 's'], tmpDir);
      assert.strictEqual(result.status, 1);
      assert(result.stderr.includes('Invalid context file format'));
    });
  });

  describe('missing workspaceId', () => {
    it('exits 1 for send', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      mkdirSync(join(tmpDir, '.claude'));
      writeFileSync(
        join(tmpDir, '.claude/wecom-context.json'),
        JSON.stringify({ botId: 'b', serverUrl: 'http://localhost' })
      );
      const result = run(['send', '--to-user', 'u', '--message', 'm', '--session-id', 's'], tmpDir);
      assert.strictEqual(result.status, 1);
      assert(result.stderr.includes('missing workspaceId'));
    });
  });

  describe('missing required flags', () => {
    it('exits 1 for send without --to-user', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      mkdirSync(join(tmpDir, '.claude'));
      writeFileSync(
        join(tmpDir, '.claude/wecom-context.json'),
        JSON.stringify({ botId: 'b', serverUrl: 'http://localhost', workspaceId: 'w' })
      );
      const result = run(['send', '--message', 'm', '--session-id', 's'], tmpDir);
      assert.strictEqual(result.status, 1);
      assert(result.stderr.includes('Missing required flag to-user'));
    });

    it('exits 1 for send without --message', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      mkdirSync(join(tmpDir, '.claude'));
      writeFileSync(
        join(tmpDir, '.claude/wecom-context.json'),
        JSON.stringify({ botId: 'b', serverUrl: 'http://localhost', workspaceId: 'w' })
      );
      const result = run(['send', '--to-user', 'u', '--session-id', 's'], tmpDir);
      assert.strictEqual(result.status, 1);
      assert(result.stderr.includes('Missing required flag message'));
    });

    it('exits 1 for send without --session-id and no env var', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      mkdirSync(join(tmpDir, '.claude'));
      writeFileSync(
        join(tmpDir, '.claude/wecom-context.json'),
        JSON.stringify({ botId: 'b', serverUrl: 'http://localhost', workspaceId: 'w' })
      );
      const result = run(['send', '--to-user', 'u', '--message', 'm'], tmpDir);
      assert.strictEqual(result.status, 1);
      assert(result.stderr.includes('Missing session ID'));
    });
  });

  describe('invalid --msg-type', () => {
    it('exits 1 for send with bad msg-type', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
      mkdirSync(join(tmpDir, '.claude'));
      writeFileSync(
        join(tmpDir, '.claude/wecom-context.json'),
        JSON.stringify({ botId: 'b', serverUrl: 'http://localhost', workspaceId: 'w' })
      );
      const result = run(['send', '--to-user', 'u', '--message', 'm', '--session-id', 's', '--msg-type', 'bad'], tmpDir);
      assert.strictEqual(result.status, 1);
      assert(result.stderr.includes('Expected --msg-type='));
    });
  });
});
