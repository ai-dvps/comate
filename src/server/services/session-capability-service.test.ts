import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import {
  SessionCapabilityService,
  writeSessionWecomContext,
  DESKTOP_AUTH_FILE_NAME,
} from './session-capability-service.js';

/**
 * Token lifecycle spec (U12, KTD-28):
 *  - mint → resolve round-trip binds session/workspace/bot
 *  - TTL: expired tokens resolve null
 *  - rotation: a second mint for the same session kills the first token
 *  - revocation: close/demote path kills the token
 *  - boot invalidation: constructing the service revokes every live token
 *  - storage: only the SHA-256 hash is persisted, never the plaintext
 *  - desktop credential: per-boot mint, 0600 file for the dev proxy
 *  - wecom context relocation: written under data/<user>/.runtime, 0600,
 *    invalid dir names fail closed
 */

describe('session-capability-service', { concurrency: false }, () => {
  let service: SessionCapabilityService;
  let tmpDir: string;

  beforeEach(() => {
    workspaceStore.resetData();
    service = new SessionCapabilityService(workspaceStore, { skipBootInvalidation: true });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-service-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('mint → resolve round-trips the bound session, workspace, and bot', () => {
    const minted = service.mintForSession({ sessionId: 's1', workspaceId: 'w1', botId: 'b1' });
    assert.strictEqual(minted.token.length, 48);
    const resolved = service.resolve(minted.token);
    assert.deepStrictEqual(resolved, { sessionId: 's1', workspaceId: 'w1', botId: 'b1' });
  });

  it('stores only the SHA-256 hash, never the plaintext token', () => {
    const minted = service.mintForSession({ sessionId: 's1', workspaceId: 'w1', botId: null });
    const tokenHash = createHash('sha256').update(minted.token).digest('hex');
    const row = workspaceStore.getCapabilityToken(tokenHash);
    assert.ok(row, 'token row must exist');
    assert.notStrictEqual(row.tokenHash, minted.token);
    assert.strictEqual(row.tokenHash, tokenHash);
  });

  it('rejects unknown tokens', () => {
    assert.strictEqual(service.resolve('nope'), null);
  });

  it('expires tokens after their TTL', () => {
    const minted = service.mintForSession({
      sessionId: 's1',
      workspaceId: 'w1',
      botId: null,
      ttlMs: 1000,
      now: new Date('2026-07-31T00:00:00Z'),
    });
    const before = service.resolve(minted.token, new Date('2026-07-31T00:00:00.500Z'));
    assert.ok(before, 'token must resolve inside its TTL');
    const after = service.resolve(minted.token, new Date('2026-07-31T00:00:02Z'));
    assert.strictEqual(after, null, 'token must not resolve past its TTL');
  });

  it('rotation: a second mint for the session kills the prior token', () => {
    const first = service.mintForSession({ sessionId: 's1', workspaceId: 'w1', botId: null });
    const second = service.mintForSession({ sessionId: 's1', workspaceId: 'w1', botId: null });
    assert.notStrictEqual(first.token, second.token);
    assert.strictEqual(service.resolve(first.token), null, 'rotated-out token must die');
    assert.ok(service.resolve(second.token), 'fresh token must live');
  });

  it('supports independently revocable simultaneous task and WeCom capabilities with explicit audiences', () => {
    const task = service.mintForSession({
      sessionId: 's1', workspaceId: 'w1', botId: null,
      kind: 'task', audiences: ['browser-mcp', 'api-broker'], runtimeGeneration: 'runtime-1',
    });
    const wecom = service.mintForSession({
      sessionId: 's1', workspaceId: 'w1', botId: 'b1',
      kind: 'wecom', audiences: ['wecom-cli'], runtimeGeneration: 'runtime-1',
    });
    assert.equal(service.resolveForAudience(task.token, 'browser-mcp')?.runtimeGeneration, 'runtime-1');
    assert.equal(service.resolveForAudience(task.token, 'api-broker')?.sessionId, 's1');
    assert.equal(service.resolveForAudience(task.token, 'wecom-cli'), null);
    assert.equal(service.resolveForAudience(wecom.token, 'browser-mcp'), null);
    assert.ok(service.resolveForAudience(wecom.token, 'wecom-cli'));
    assert.equal(service.revokeKind('s1', 'task'), 1);
    assert.equal(service.resolveForAudience(task.token, 'browser-mcp'), null);
    assert.ok(service.resolveForAudience(wecom.token, 'wecom-cli'));
  });

  it('rotates only the matching capability kind and binds the runtime generation', () => {
    const wecom = service.mintForSession({
      sessionId: 's1', workspaceId: 'w1', botId: 'b1', kind: 'wecom', audiences: ['wecom-cli'],
    });
    const first = service.mintForSession({
      sessionId: 's1', workspaceId: 'w1', botId: null,
      kind: 'task', audiences: ['browser-mcp', 'api-broker'], runtimeGeneration: 'g1',
    });
    const second = service.mintForSession({
      sessionId: 's1', workspaceId: 'w1', botId: null,
      kind: 'task', audiences: ['browser-mcp', 'api-broker'], runtimeGeneration: 'g2',
    });
    assert.equal(service.resolveForAudience(first.token, 'browser-mcp'), null);
    assert.equal(service.resolveForAudience(second.token, 'browser-mcp', { runtimeGeneration: 'g1' }), null);
    assert.ok(service.resolveForAudience(second.token, 'browser-mcp', { runtimeGeneration: 'g2' }));
    assert.ok(service.resolveForAudience(wecom.token, 'wecom-cli'));
  });

  it('refuses cross-kind or empty audience sets at the minting boundary', () => {
    assert.throws(() => service.mintForSession({
      sessionId: 's1', workspaceId: 'w1', botId: null,
      kind: 'task', audiences: ['wecom-cli'],
    }), /invalid audiences/);
    assert.throws(() => service.mintForSession({
      sessionId: 's1', workspaceId: 'w1', botId: 'b1',
      kind: 'wecom', audiences: [],
    }), /invalid audiences/);
  });

  it('revocation: revokeForSession kills the live token', () => {
    const minted = service.mintForSession({ sessionId: 's1', workspaceId: 'w1', botId: null });
    assert.strictEqual(service.revokeForSession('s1'), 1);
    assert.strictEqual(service.resolve(minted.token), null);
    // Idempotent: nothing left to revoke.
    assert.strictEqual(service.revokeForSession('s1'), 0);
  });

  it('boot invalidation: constructing the service revokes every live token', () => {
    const minted = service.mintForSession({ sessionId: 's1', workspaceId: 'w1', botId: null });
    // A new service instance = a process restart: everything dies.
    const rebooted = new SessionCapabilityService(workspaceStore);
    assert.strictEqual(rebooted.resolve(minted.token), null);
  });

  it('rejects malformed token presentations without touching the store', () => {
    assert.strictEqual(service.resolve(''), null);
    assert.strictEqual(service.resolve('x'.repeat(500)), null);
  });

  it('desktop credential: per-boot mint + 0600 file for the dev proxy', () => {
    const token = service.mintDesktopToken({ storageDir: tmpDir });
    assert.strictEqual(token.length, 48);
    assert.strictEqual(service.getDesktopToken(), token);

    const filePath = path.join(tmpDir, DESKTOP_AUTH_FILE_NAME);
    const stat = fs.statSync(filePath);
    assert.strictEqual(stat.mode & 0o777, 0o600, 'desktop token file must be owner-only');
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { token: string };
    assert.strictEqual(parsed.token, token);

    // A second mint rotates (a new boot) and overwrites the file.
    const second = service.mintDesktopToken({ storageDir: tmpDir });
    assert.notStrictEqual(second, token);
    const reparsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { token: string };
    assert.strictEqual(reparsed.token, second);
  });

  it('wecom context: written under data/<user>/.runtime with the server URL', () => {
    const ws = path.join(tmpDir, 'ws');
    fs.mkdirSync(ws, { recursive: true });
    const filePath = writeSessionWecomContext({
      workspaceFolder: ws,
      userDirName: 'alice',
      workspaceId: 'w1',
      botId: 'b1',
      serverUrl: 'http://127.0.0.1:3000',
    });
    assert.strictEqual(filePath, path.join(ws, 'data', 'alice', '.runtime', 'wecom-context.json'));
    const stat = fs.statSync(filePath);
    assert.strictEqual(stat.mode & 0o777, 0o600);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, string>;
    assert.deepStrictEqual(parsed, { workspaceId: 'w1', botId: 'b1', serverUrl: 'http://127.0.0.1:3000' });
  });

  it('wecom context: adversarial dir names fail closed', () => {
    const ws = path.join(tmpDir, 'ws');
    fs.mkdirSync(ws, { recursive: true });
    for (const bad of ['..', 'a/b', 'A*', '~x', 'anonymous', 'ANONYMOUS', '']) {
      assert.throws(
        () =>
          writeSessionWecomContext({
            workspaceFolder: ws,
            userDirName: bad,
            workspaceId: 'w1',
            botId: 'b1',
            serverUrl: 'http://127.0.0.1:3000',
          }),
        /invalid userDirName/,
        `expected fail-closed for "${bad}"`,
      );
    }
    assert.ok(!fs.existsSync(path.join(ws, 'data')), 'no directory may be created on failure');
  });
});
