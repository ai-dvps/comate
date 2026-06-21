import '../test-utils/test-env.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { SqliteStore } from './sqlite-store.js';

const testDbDir = mkdtempSync(join(tmpdir(), 'sqlite-store-test-'));
const testDbPath = join(testDbDir, 'data.db');

describe('SqliteStore proactive messages', { concurrency: false }, () => {
  let store: SqliteStore;
  let db: Database.Database;

  beforeEach(() => {
    store = new SqliteStore(testDbPath);
    // Access internal db for direct state verification
    db = (store as unknown as { db: Database.Database }).db;
    // Clean tables before each test
    db.prepare('DELETE FROM wecom_proactive_messages').run();
    db.prepare('DELETE FROM wecom_user_sessions').run();
  });

  function createMessageInput(overrides: Partial<{
    senderSessionId: string;
    recipientEncryptedUserId: string;
    recipientPlaintextUserId: string;
    messageContent: string;
  }> = {}) {
    return {
      senderSessionId: overrides.senderSessionId ?? 'session-a',
      recipientEncryptedUserId: overrides.recipientEncryptedUserId ?? 'enc-b',
      recipientPlaintextUserId: overrides.recipientPlaintextUserId ?? 'plain-b',
      messageContent: overrides.messageContent ?? 'Hello B',
    };
  }

  it('enqueueProactiveMessage creates a pending message', () => {
    const msg = store.enqueueProactiveMessage('ws-1', createMessageInput());
    assert.strictEqual(msg.workspaceId, 'ws-1');
    assert.strictEqual(msg.status, 'pending');
    assert.strictEqual(msg.senderSessionId, 'session-a');
    assert.strictEqual(msg.recipientEncryptedUserId, 'enc-b');
    assert.strictEqual(msg.recipientPlaintextUserId, 'plain-b');
    assert.strictEqual(msg.messageContent, 'Hello B');
    assert.strictEqual(msg.errorReason, null);
    assert.strictEqual(msg.deliveredAt, null);
    assert.strictEqual(msg.claimedAt, null);
    assert.strictEqual(msg.retryCount, 0);
    assert.ok(msg.id);
    assert.ok(msg.createdAt);
    assert.ok(msg.updatedAt);
  });

  it('listProactiveMessages returns all messages for workspace ordered by created_at ASC', () => {
    store.enqueueProactiveMessage('ws-1', createMessageInput({ messageContent: 'First' }));
    store.enqueueProactiveMessage('ws-1', createMessageInput({ messageContent: 'Second' }));
    store.enqueueProactiveMessage('ws-2', createMessageInput({ messageContent: 'Other ws' }));

    const msgs = store.listProactiveMessages('ws-1');
    assert.strictEqual(msgs.length, 2);
    assert.strictEqual(msgs[0].messageContent, 'First');
    assert.strictEqual(msgs[1].messageContent, 'Second');
  });

  it('listProactiveMessages with statusFilter returns only matching rows', () => {
    store.enqueueProactiveMessage('ws-1', createMessageInput({ messageContent: 'Pending' }));
    const failed = store.enqueueProactiveMessage('ws-1', createMessageInput({ messageContent: 'Failed' }));
    store.updateProactiveMessage(failed.id, { status: 'failed', errorReason: 'error' });

    const pending = store.listProactiveMessages('ws-1', 'pending');
    assert.strictEqual(pending.length, 1);
    assert.strictEqual(pending[0].messageContent, 'Pending');

    const failedList = store.listProactiveMessages('ws-1', 'failed');
    assert.strictEqual(failedList.length, 1);
    assert.strictEqual(failedList[0].messageContent, 'Failed');
  });

  it('getProactiveMessage returns message by id', () => {
    const msg = store.enqueueProactiveMessage('ws-1', createMessageInput());
    const found = store.getProactiveMessage(msg.id);
    assert.ok(found);
    assert.strictEqual(found.id, msg.id);
  });

  it('getProactiveMessage returns null for non-existent id', () => {
    const found = store.getProactiveMessage('non-existent');
    assert.strictEqual(found, null);
  });

  it('claimNextPendingMessage atomically claims one pending row', () => {
    const msg1 = store.enqueueProactiveMessage('ws-1', createMessageInput({ messageContent: 'First' }));
    store.enqueueProactiveMessage('ws-1', createMessageInput({ messageContent: 'Second' }));

    const claimed = store.claimNextPendingMessage('ws-1');
    assert.ok(claimed);
    assert.strictEqual(claimed.id, msg1.id);
    assert.strictEqual(claimed.status, 'delivering');
    assert.ok(claimed.claimedAt);

    // Second claim should get the other pending row
    const claimed2 = store.claimNextPendingMessage('ws-1');
    assert.ok(claimed2);
    assert.strictEqual(claimed2.status, 'delivering');

    // No more pending rows
    const claimed3 = store.claimNextPendingMessage('ws-1');
    assert.strictEqual(claimed3, null);
  });

  it('claimNextPendingMessage returns null when no pending rows exist', () => {
    const claimed = store.claimNextPendingMessage('ws-1');
    assert.strictEqual(claimed, null);
  });

  it('claimNextPendingMessage skips rows already in delivering', () => {
    const msg = store.enqueueProactiveMessage('ws-1', createMessageInput());
    store.updateProactiveMessage(msg.id, { status: 'delivering', claimedAt: new Date().toISOString() });

    const claimed = store.claimNextPendingMessage('ws-1');
    assert.strictEqual(claimed, null);
  });

  it('updateProactiveMessage updates status and timestamps', () => {
    const msg = store.enqueueProactiveMessage('ws-1', createMessageInput());
    const updated = store.updateProactiveMessage(msg.id, {
      status: 'delivered',
      deliveredAt: new Date().toISOString(),
    });

    assert.ok(updated);
    assert.strictEqual(updated.status, 'delivered');
    assert.ok(updated.deliveredAt);
  });

  it('updateProactiveMessage returns null for non-existent id', () => {
    const updated = store.updateProactiveMessage('non-existent', { status: 'failed' });
    assert.strictEqual(updated, null);
  });

  it('updateProactiveMessage returns existing when no changes provided', () => {
    const msg = store.enqueueProactiveMessage('ws-1', createMessageInput());
    const updated = store.updateProactiveMessage(msg.id, {});
    assert.ok(updated);
    assert.strictEqual(updated.id, msg.id);
    assert.strictEqual(updated.status, 'pending');
  });

  it('deleteProactiveMessage removes the row', () => {
    const msg = store.enqueueProactiveMessage('ws-1', createMessageInput());
    const deleted = store.deleteProactiveMessage(msg.id);
    assert.strictEqual(deleted, true);
    assert.strictEqual(store.getProactiveMessage(msg.id), null);
  });

  it('deleteProactiveMessage returns false for non-existent id', () => {
    const deleted = store.deleteProactiveMessage('non-existent');
    assert.strictEqual(deleted, false);
  });

  it('delete workspace cascades to proactive messages', async () => {
    // Create a workspace so delete actually removes it and triggers cascade
    const ws = await store.create({
      name: 'Cascade Test',
      folderPath: '/tmp/cascade-test',
    });
    store.enqueueProactiveMessage(ws.id, createMessageInput());

    // Verify message exists
    const before = store.listProactiveMessages(ws.id);
    assert.strictEqual(before.length, 1);

    // Workspace deletion cascades
    await store.delete(ws.id);

    const after = store.listProactiveMessages(ws.id);
    assert.strictEqual(after.length, 0);
  });

  it('retry resets failed to pending and increments retry count', () => {
    const msg = store.enqueueProactiveMessage('ws-1', createMessageInput());
    store.updateProactiveMessage(msg.id, { status: 'failed', errorReason: 'timeout', retryCount: 1 });

    const updated = store.updateProactiveMessage(msg.id, {
      status: 'pending',
      errorReason: null,
      retryCount: 2,
    });

    assert.ok(updated);
    assert.strictEqual(updated.status, 'pending');
    assert.strictEqual(updated.errorReason, null);
    assert.strictEqual(updated.retryCount, 2);
  });

  it('getWecomUserIdBySession returns correct userId for existing mapping', () => {
    db.prepare(
      'INSERT INTO wecom_user_sessions (workspaceId, wecomUserId, sessionId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)'
    ).run('ws-1', 'user-alice', 'session-123', new Date().toISOString(), new Date().toISOString());

    const userId = store.getWecomUserIdBySession('ws-1', 'session-123');
    assert.strictEqual(userId, 'user-alice');
  });

  it('getWecomUserIdBySession returns null for unknown sessionId', () => {
    const userId = store.getWecomUserIdBySession('ws-1', 'unknown-session');
    assert.strictEqual(userId, null);
  });

  it('getWecomUserIdBySession returns null when session exists in different workspace', () => {
    db.prepare(
      'INSERT INTO wecom_user_sessions (workspaceId, wecomUserId, sessionId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)'
    ).run('ws-1', 'user-alice', 'session-123', new Date().toISOString(), new Date().toISOString());

    const userId = store.getWecomUserIdBySession('ws-2', 'session-123');
    assert.strictEqual(userId, null);
  });
});

describe('SqliteStore workspace delete cascade', { concurrency: false }, () => {
  let store: SqliteStore;
  let db: Database.Database;

  beforeEach(() => {
    store = new SqliteStore(testDbPath);
    db = (store as unknown as { db: Database.Database }).db;
    db.prepare('DELETE FROM session_analytics_cache').run();
    db.prepare('DELETE FROM session_metadata').run();
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM wecom_proactive_messages').run();
    db.prepare('DELETE FROM wecom_user_sessions').run();
    db.prepare('DELETE FROM todos').run();
    db.prepare('DELETE FROM workspaces').run();
  });

  function createWorkspace(name: string) {
    return store.create({ name, folderPath: `/tmp/${name}` });
  }

  function insertSession(workspaceId: string, id: string) {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO sessions (id, workspace_id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, workspaceId, 'Test session', now, now);
  }

  function insertSessionMetadata(sessionId: string) {
    db.prepare('INSERT INTO session_metadata (session_id, is_wip) VALUES (?, ?)').run(sessionId, 1);
  }

  function insertAnalyticsCache(workspaceId: string, sessionId: string) {
    const now = Date.now();
    db.prepare(
      `INSERT INTO session_analytics_cache (
        session_id, workspace_id, transcript_mtime, extracted_at,
        total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        estimated_cost_usd, cost_coverage_percent, duration_ms, message_count, has_compaction,
        model_usage, tool_usage, daily_stats, heatmap
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      sessionId, workspaceId, now, now,
      0, 0, 0, 0, 0,
      0, 100, 0, 0, 0,
      '[]', '[]', '[]', '[]'
    );
  }

  it('deleting a workspace removes sessions, session_metadata, and analytics cache rows', async () => {
    const ws = await createWorkspace('Cascade Sessions');
    const sessionId = randomUUID();
    insertSession(ws.id, sessionId);
    insertSessionMetadata(sessionId);
    insertAnalyticsCache(ws.id, sessionId);

    assert.strictEqual(db.prepare('SELECT COUNT(*) as count FROM sessions WHERE workspace_id = ?').get(ws.id).count, 1);
    assert.strictEqual(db.prepare('SELECT COUNT(*) as count FROM session_metadata WHERE session_id = ?').get(sessionId).count, 1);
    assert.strictEqual(db.prepare('SELECT COUNT(*) as count FROM session_analytics_cache WHERE workspace_id = ?').get(ws.id).count, 1);

    await store.delete(ws.id);

    assert.strictEqual(db.prepare('SELECT COUNT(*) as count FROM sessions WHERE workspace_id = ?').get(ws.id).count, 0);
    assert.strictEqual(db.prepare('SELECT COUNT(*) as count FROM session_metadata WHERE session_id = ?').get(sessionId).count, 0);
    assert.strictEqual(db.prepare('SELECT COUNT(*) as count FROM session_analytics_cache WHERE workspace_id = ?').get(ws.id).count, 0);
  });

  it('deleting a non-existent workspace leaves sessions and cache untouched', async () => {
    const ws = await createWorkspace('Untouched');
    const sessionId = randomUUID();
    insertSession(ws.id, sessionId);
    insertSessionMetadata(sessionId);
    insertAnalyticsCache(ws.id, sessionId);

    const deleted = await store.delete('non-existent-id');
    assert.strictEqual(deleted, false);

    assert.strictEqual(db.prepare('SELECT COUNT(*) as count FROM sessions WHERE workspace_id = ?').get(ws.id).count, 1);
    assert.strictEqual(db.prepare('SELECT COUNT(*) as count FROM session_metadata WHERE session_id = ?').get(sessionId).count, 1);
    assert.strictEqual(db.prepare('SELECT COUNT(*) as count FROM session_analytics_cache WHERE workspace_id = ?').get(ws.id).count, 1);
  });

  it('deleting one workspace does not affect sessions in another workspace', async () => {
    const wsA = await createWorkspace('Workspace A');
    const wsB = await createWorkspace('Workspace B');
    const sessionA = randomUUID();
    const sessionB = randomUUID();

    insertSession(wsA.id, sessionA);
    insertSessionMetadata(sessionA);
    insertAnalyticsCache(wsA.id, sessionA);

    insertSession(wsB.id, sessionB);
    insertSessionMetadata(sessionB);
    insertAnalyticsCache(wsB.id, sessionB);

    await store.delete(wsA.id);

    assert.strictEqual(db.prepare('SELECT COUNT(*) as count FROM sessions WHERE workspace_id = ?').get(wsA.id).count, 0);
    assert.strictEqual(db.prepare('SELECT COUNT(*) as count FROM sessions WHERE workspace_id = ?').get(wsB.id).count, 1);
    assert.strictEqual(db.prepare('SELECT COUNT(*) as count FROM session_metadata WHERE session_id = ?').get(sessionB).count, 1);
    assert.strictEqual(db.prepare('SELECT COUNT(*) as count FROM session_analytics_cache WHERE workspace_id = ?').get(wsB.id).count, 1);
  });
});

describe('SqliteStore workspace prompt history', { concurrency: false }, () => {
  let store: SqliteStore;
  let db: Database.Database;

  beforeEach(() => {
    store = new SqliteStore(testDbPath);
    db = (store as unknown as { db: Database.Database }).db;
    db.prepare('DELETE FROM workspace_prompt_history').run();
    db.prepare('DELETE FROM workspaces').run();
  });

  async function createWorkspace(name: string) {
    return store.create({ name, folderPath: `/tmp/${name}` });
  }

  it('createPromptHistory records a prompt and returns an entry', async () => {
    const ws = await createWorkspace('History Test');
    const entry = store.createPromptHistory(ws.id, 'session-1', 'hello world');

    assert.strictEqual(entry.workspaceId, ws.id);
    assert.strictEqual(entry.sessionId, 'session-1');
    assert.strictEqual(entry.prompt, 'hello world');
    assert.ok(entry.id);
    assert.ok(entry.createdAt);
  });

  it('listPromptHistory returns prompts ordered oldest-first', async () => {
    const ws = await createWorkspace('History Order');
    store.createPromptHistory(ws.id, 'session-1', 'first');
    store.createPromptHistory(ws.id, 'session-1', 'second');

    const rows = store.listPromptHistory(ws.id);
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].prompt, 'first');
    assert.strictEqual(rows[1].prompt, 'second');
  });

  it('listPromptHistory isolates workspaces', async () => {
    const wsA = await createWorkspace('History A');
    const wsB = await createWorkspace('History B');
    store.createPromptHistory(wsA.id, 'session-a', 'a');
    store.createPromptHistory(wsB.id, 'session-b', 'b');

    assert.strictEqual(store.listPromptHistory(wsA.id).length, 1);
    assert.strictEqual(store.listPromptHistory(wsA.id)[0].prompt, 'a');
    assert.strictEqual(store.listPromptHistory(wsB.id).length, 1);
    assert.strictEqual(store.listPromptHistory(wsB.id)[0].prompt, 'b');
  });

  it('prunePromptHistory removes entries older than retentionDays', async () => {
    const ws = await createWorkspace('History Prune');
    db.prepare(
      'INSERT INTO workspace_prompt_history (id, workspace_id, session_id, prompt, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(randomUUID(), ws.id, 'session-1', 'old', new Date(Date.now() - 31 * 86400_000).toISOString());
    db.prepare(
      'INSERT INTO workspace_prompt_history (id, workspace_id, session_id, prompt, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(randomUUID(), ws.id, 'session-1', 'recent', new Date().toISOString());

    const pruned = store.prunePromptHistory(ws.id, 30);
    assert.strictEqual(pruned, 1);

    const rows = store.listPromptHistory(ws.id);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].prompt, 'recent');
  });

  it('prunePromptHistory returns 0 for non-positive retentionDays', async () => {
    const ws = await createWorkspace('History No Prune');
    store.createPromptHistory(ws.id, 'session-1', 'kept');

    assert.strictEqual(store.prunePromptHistory(ws.id, 0), 0);
    assert.strictEqual(store.prunePromptHistory(ws.id, -1), 0);
    assert.strictEqual(store.listPromptHistory(ws.id).length, 1);
  });

  it('deleting a workspace cascades to prompt history', async () => {
    const ws = await createWorkspace('History Cascade');
    store.createPromptHistory(ws.id, 'session-1', 'goodbye');

    await store.delete(ws.id);

    assert.strictEqual(store.listPromptHistory(ws.id).length, 0);
  });
});

describe('SqliteStore Feishu state', { concurrency: false }, () => {
  let store: SqliteStore;
  let db: Database.Database;

  beforeEach(() => {
    store = new SqliteStore(testDbPath);
    db = (store as unknown as { db: Database.Database }).db;
    db.prepare('DELETE FROM feishu_bot_binding').run();
    db.prepare('DELETE FROM feishu_user_sessions').run();
    db.prepare('DELETE FROM feishu_active_sessions').run();
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM workspaces').run();
  });

  async function createWorkspace(name: string) {
    return store.create({ name, folderPath: `/tmp/${name}` });
  }

  function createSession(workspaceId: string, id: string) {
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO sessions (id, workspace_id, name, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, workspaceId, id, 'feishu', now, now);
  }

  it('sets and reads the active workspace binding', async () => {
    const ws = await createWorkspace('Feishu Binding');
    assert.strictEqual(store.getFeishuActiveWorkspace(), null);

    store.setFeishuActiveWorkspace(ws.id);
    assert.strictEqual(store.getFeishuActiveWorkspace(), ws.id);

    const ws2 = await createWorkspace('Feishu Binding 2');
    store.setFeishuActiveWorkspace(ws2.id);
    assert.strictEqual(store.getFeishuActiveWorkspace(), ws2.id);
  });

  it('clears the active workspace binding', async () => {
    const ws = await createWorkspace('Feishu Clear');
    store.setFeishuActiveWorkspace(ws.id);
    store.clearFeishuActiveWorkspace();
    assert.strictEqual(store.getFeishuActiveWorkspace(), null);
  });

  it('lists sessions per Feishu user and isolates users', async () => {
    const ws = await createWorkspace('Feishu Users');
    createSession(ws.id, 'session-a');
    createSession(ws.id, 'session-b');
    createSession(ws.id, 'session-c');

    store.addFeishuUserSession(ws.id, 'user-alice', 'session-a');
    store.addFeishuUserSession(ws.id, 'user-alice', 'session-b');
    store.addFeishuUserSession(ws.id, 'user-bob', 'session-c');

    const alice = store.listFeishuSessionsByUser(ws.id, 'user-alice');
    assert.strictEqual(alice.length, 2);
    assert.ok(alice.some((s) => s.sessionId === 'session-a'));
    assert.ok(alice.some((s) => s.sessionId === 'session-b'));

    const bob = store.listFeishuSessionsByUser(ws.id, 'user-bob');
    assert.strictEqual(bob.length, 1);
    assert.strictEqual(bob[0].sessionId, 'session-c');
  });

  it('lists all Feishu sessions for a workspace', async () => {
    const ws = await createWorkspace('Feishu Workspace List');
    createSession(ws.id, 'session-a');
    createSession(ws.id, 'session-b');

    store.addFeishuUserSession(ws.id, 'user-alice', 'session-a');
    store.addFeishuUserSession(ws.id, 'user-bob', 'session-b');

    const all = store.listFeishuSessionsForWorkspace(ws.id);
    assert.strictEqual(all.length, 2);
    assert.ok(all.some((s) => s.sessionId === 'session-a' && s.feishuUserId === 'user-alice'));
    assert.ok(all.some((s) => s.sessionId === 'session-b' && s.feishuUserId === 'user-bob'));
  });

  it('sets and reads the active session', async () => {
    const ws = await createWorkspace('Feishu Active');
    createSession(ws.id, 'session-1');

    store.setFeishuActiveSession(ws.id, 'user-alice', 'session-1');
    assert.strictEqual(store.getFeishuActiveSession(ws.id, 'user-alice'), 'session-1');

    createSession(ws.id, 'session-2');
    store.setFeishuActiveSession(ws.id, 'user-alice', 'session-2');
    assert.strictEqual(store.getFeishuActiveSession(ws.id, 'user-alice'), 'session-2');
  });

  it('returns session owner for Feishu sessions', async () => {
    const ws = await createWorkspace('Feishu Owner');
    createSession(ws.id, 'session-x');
    store.addFeishuUserSession(ws.id, 'user-alice', 'session-x');
    assert.strictEqual(store.getFeishuSessionOwner(ws.id, 'session-x'), 'user-alice');
    assert.strictEqual(store.getFeishuSessionOwner(ws.id, 'session-y'), null);
  });

  it('drops orphaned mappings and active sessions when the session is deleted', async () => {
    const ws = await createWorkspace('Feishu Orphan');
    createSession(ws.id, 'session-alive');
    createSession(ws.id, 'session-deleted');

    store.addFeishuUserSession(ws.id, 'user-alice', 'session-alive');
    store.addFeishuUserSession(ws.id, 'user-alice', 'session-deleted');
    store.setFeishuActiveSession(ws.id, 'user-alice', 'session-deleted');

    db.prepare('DELETE FROM sessions WHERE id = ?').run('session-deleted');

    const sessions = store.listFeishuSessionsByUser(ws.id, 'user-alice');
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].sessionId, 'session-alive');

    assert.strictEqual(store.getFeishuActiveSession(ws.id, 'user-alice'), null);
  });

  it('deletes workspace cascades to Feishu state', async () => {
    const ws = await createWorkspace('Feishu Cascade');
    createSession(ws.id, 'session-1');
    store.setFeishuActiveWorkspace(ws.id);
    store.addFeishuUserSession(ws.id, 'user-alice', 'session-1');
    store.setFeishuActiveSession(ws.id, 'user-alice', 'session-1');

    await store.delete(ws.id);

    assert.strictEqual(store.getFeishuActiveWorkspace(), null);
    assert.strictEqual(store.listFeishuSessionsByUser(ws.id, 'user-alice').length, 0);
    assert.strictEqual(store.getFeishuActiveSession(ws.id, 'user-alice'), null);
  });
});