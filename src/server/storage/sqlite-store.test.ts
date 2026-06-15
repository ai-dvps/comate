import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { SqliteStore } from './sqlite-store.js';

describe('SqliteStore proactive messages', { concurrency: false }, () => {
  let store: SqliteStore;
  let db: Database.Database;

  beforeEach(() => {
    store = new SqliteStore();
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
    store = new SqliteStore();
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
