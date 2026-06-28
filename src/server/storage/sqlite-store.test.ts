import '../test-utils/test-env.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteStore } from './sqlite-store.js';

const testDbDir = mkdtempSync(join(tmpdir(), 'sqlite-store-test-'));
const testDbPath = join(testDbDir, 'data.db');

describe('SqliteStore proactive messages', { concurrency: false }, () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore(testDbPath);
    store.resetData();
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
    store.setWecomSession('ws-1', 'user-alice', 'session-123');

    const userId = store.getWecomUserIdBySession('ws-1', 'session-123');
    assert.strictEqual(userId, 'user-alice');
  });

  it('getWecomUserIdBySession returns null for unknown sessionId', () => {
    const userId = store.getWecomUserIdBySession('ws-1', 'unknown-session');
    assert.strictEqual(userId, null);
  });

  it('getWecomUserIdBySession returns null when session exists in different workspace', () => {
    store.setWecomSession('ws-1', 'user-alice', 'session-123');

    const userId = store.getWecomUserIdBySession('ws-2', 'session-123');
    assert.strictEqual(userId, null);
  });
});

describe('SqliteStore WeCom user ID mappings', { concurrency: false }, () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore(':memory:');
    store.resetData();
  });

  async function createWorkspace(name: string) {
    return store.create({ name, folderPath: `/tmp/${name}` });
  }

  it('isPlaintextUserIdUsedInWorkspace returns false when checking the same user', async () => {
    const ws = await createWorkspace('WeCom Dup');
    store.setWecomWorkspaceUser(ws.id, 'E123');
    store.setWecomUserMapping('E123', 'U456');

    assert.strictEqual(
      store.isPlaintextUserIdUsedInWorkspace(ws.id, 'U456', 'E123'),
      false,
    );
  });

  it('isPlaintextUserIdUsedInWorkspace returns true when another user has the same plaintext', async () => {
    const ws = await createWorkspace('WeCom Dup');
    store.setWecomWorkspaceUser(ws.id, 'E123');
    store.setWecomWorkspaceUser(ws.id, 'E789');
    store.setWecomUserMapping('E123', 'U456');
    store.setWecomUserMapping('E789', 'U456');

    assert.strictEqual(
      store.isPlaintextUserIdUsedInWorkspace(ws.id, 'U456', 'E123'),
      true,
    );
  });

  it('isPlaintextUserIdUsedInWorkspace isolates workspaces', async () => {
    const ws1 = await createWorkspace('WeCom A');
    const ws2 = await createWorkspace('WeCom B');
    store.setWecomWorkspaceUser(ws2.id, 'E999');
    store.setWecomUserMapping('E999', 'U456');

    assert.strictEqual(
      store.isPlaintextUserIdUsedInWorkspace(ws1.id, 'U456', 'E123'),
      false,
    );
  });

  it('isPlaintextUserIdUsedInWorkspace returns false for unmapped users', async () => {
    const ws = await createWorkspace('WeCom Unmapped');
    store.setWecomWorkspaceUser(ws.id, 'E789');

    assert.strictEqual(
      store.isPlaintextUserIdUsedInWorkspace(ws.id, 'U456', 'E123'),
      false,
    );
  });
});

describe('SqliteStore workspace delete cascade', { concurrency: false }, () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore(testDbPath);
    store.resetData();
  });

  function createWorkspace(name: string) {
    return store.create({ name, folderPath: `/tmp/${name}` });
  }

  function createSession(workspaceId: string): string {
    return store.createLocalSession(workspaceId, 'Test session').id;
  }

  function seedSessionMetadata(sessionId: string): void {
    store.setSessionMetadata(sessionId, true);
  }

  function seedAnalyticsCache(workspaceId: string, sessionId: string): void {
    store.getAnalyticsCache().upsert({
      sessionId,
      workspaceId,
      transcriptMtime: Date.now(),
      extractedAt: Date.now(),
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedCostUsd: 0,
      costCoveragePercent: 100,
      durationMs: 0,
      messageCount: 0,
      firstMessageTs: null,
      lastMessageTs: null,
      hasCompaction: false,
      modelUsage: [],
      toolUsage: [],
      dailyStats: [],
      heatmap: [],
    });
  }

  it('deleting a workspace removes sessions, session_metadata, and analytics cache rows', async () => {
    const ws = await createWorkspace('Cascade Sessions');
    const sessionId = createSession(ws.id);
    seedSessionMetadata(sessionId);
    seedAnalyticsCache(ws.id, sessionId);

    assert.strictEqual(store.listLocalSessions(ws.id).length, 1);
    assert.strictEqual(Object.keys(store.getSessionMetadata([sessionId])).length, 1);
    assert.strictEqual(store.getAnalyticsCache().listByWorkspace(ws.id).length, 1);

    await store.delete(ws.id);

    assert.strictEqual(store.listLocalSessions(ws.id).length, 0);
    assert.strictEqual(Object.keys(store.getSessionMetadata([sessionId])).length, 0);
    assert.strictEqual(store.getAnalyticsCache().listByWorkspace(ws.id).length, 0);
  });

  it('deleting a non-existent workspace leaves sessions and cache untouched', async () => {
    const ws = await createWorkspace('Untouched');
    const sessionId = createSession(ws.id);
    seedSessionMetadata(sessionId);
    seedAnalyticsCache(ws.id, sessionId);

    const deleted = await store.delete('non-existent-id');
    assert.strictEqual(deleted, false);

    assert.strictEqual(store.listLocalSessions(ws.id).length, 1);
    assert.strictEqual(Object.keys(store.getSessionMetadata([sessionId])).length, 1);
    assert.strictEqual(store.getAnalyticsCache().listByWorkspace(ws.id).length, 1);
  });

  it('deleting one workspace does not affect sessions in another workspace', async () => {
    const wsA = await createWorkspace('Workspace A');
    const wsB = await createWorkspace('Workspace B');
    const sessionA = createSession(wsA.id);
    const sessionB = createSession(wsB.id);

    seedSessionMetadata(sessionA);
    seedAnalyticsCache(wsA.id, sessionA);

    seedSessionMetadata(sessionB);
    seedAnalyticsCache(wsB.id, sessionB);

    await store.delete(wsA.id);

    assert.strictEqual(store.listLocalSessions(wsA.id).length, 0);
    assert.strictEqual(store.listLocalSessions(wsB.id).length, 1);
    assert.strictEqual(Object.keys(store.getSessionMetadata([sessionB])).length, 1);
    assert.strictEqual(store.getAnalyticsCache().listByWorkspace(wsB.id).length, 1);
  });
});

describe('SqliteStore workspace prompt history', { concurrency: false }, () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore(testDbPath);
    store.resetData();
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
    // Backdate one entry via the optional createdAt argument so it falls
    // outside the retention window.
    store.createPromptHistory(ws.id, 'session-1', 'old', new Date(Date.now() - 31 * 86400_000).toISOString());
    store.createPromptHistory(ws.id, 'session-1', 'recent');

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

  beforeEach(() => {
    store = new SqliteStore(testDbPath);
    store.resetData();
  });

  async function createWorkspace(name: string) {
    return store.create({ name, folderPath: `/tmp/${name}` });
  }

  function createSession(workspaceId: string, id: string) {
    const now = new Date().toISOString();
    store.syncSdkSession({
      id,
      workspaceId,
      name: id,
      isDraft: false,
      isWip: false,
      source: 'feishu',
      createdAt: now,
      updatedAt: now,
    });
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

    store.deleteLocalSession('session-deleted');

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

  it('upserts Feishu workspace users preserving firstSeenAt', async () => {
    const ws = await createWorkspace('Feishu Users Upsert');

    store.setFeishuWorkspaceUser(ws.id, 'ou-alice');
    const first = store.getFeishuWorkspaceUser(ws.id, 'ou-alice');
    assert.ok(first);
    assert.strictEqual(first.openId, 'ou-alice');
    assert.strictEqual(first.name, null);
    assert.strictEqual(first.userId, null);

    // Simulate a later message and verify firstSeenAt stays the same while lastSeenAt changes.
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.setFeishuWorkspaceUser(ws.id, 'ou-alice');
    const second = store.getFeishuWorkspaceUser(ws.id, 'ou-alice');
    assert.ok(second);
    assert.strictEqual(second.firstSeenAt, first.firstSeenAt);
    assert.notStrictEqual(second.lastSeenAt, first.lastSeenAt);
  });

  it('lists Feishu workspace users ordered by lastSeenAt DESC', async () => {
    const ws = await createWorkspace('Feishu Users List');

    store.setFeishuWorkspaceUser(ws.id, 'ou-alice');
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.setFeishuWorkspaceUser(ws.id, 'ou-bob');

    const users = store.listFeishuWorkspaceUsers(ws.id);
    assert.strictEqual(users.length, 2);
    assert.strictEqual(users[0].openId, 'ou-bob');
    assert.strictEqual(users[1].openId, 'ou-alice');
  });

  it('caches display name and user_id', async () => {
    const ws = await createWorkspace('Feishu Users Name');

    store.setFeishuWorkspaceUser(ws.id, 'ou-alice');
    store.setFeishuWorkspaceUserName(ws.id, 'ou-alice', 'Alice', 'alice-uid');

    const user = store.getFeishuWorkspaceUser(ws.id, 'ou-alice');
    assert.ok(user);
    assert.strictEqual(user.name, 'Alice');
    assert.strictEqual(user.userId, 'alice-uid');

    const listed = store.listFeishuWorkspaceUsers(ws.id);
    assert.strictEqual(listed[0].name, 'Alice');
  });

  it('keeps existing userId when updating name without userId', async () => {
    const ws = await createWorkspace('Feishu Users Partial Update');

    store.setFeishuWorkspaceUser(ws.id, 'ou-alice');
    store.setFeishuWorkspaceUserName(ws.id, 'ou-alice', 'Alice', 'alice-uid');
    store.setFeishuWorkspaceUserName(ws.id, 'ou-alice', 'Alice Updated');

    const user = store.getFeishuWorkspaceUser(ws.id, 'ou-alice');
    assert.ok(user);
    assert.strictEqual(user.name, 'Alice Updated');
    assert.strictEqual(user.userId, 'alice-uid');
  });

  it('returns null for unknown Feishu workspace user', async () => {
    const ws = await createWorkspace('Feishu Users Missing');
    assert.strictEqual(store.getFeishuWorkspaceUser(ws.id, 'ou-unknown'), null);
  });

  it('deletes workspace cascades to Feishu workspace users', async () => {
    const ws = await createWorkspace('Feishu Users Cascade');
    store.setFeishuWorkspaceUser(ws.id, 'ou-alice');

    await store.delete(ws.id);

    assert.strictEqual(store.listFeishuWorkspaceUsers(ws.id).length, 0);
  });
});

describe('SqliteStore in-memory + resetData', { concurrency: false }, () => {
  let store: SqliteStore;

  beforeEach(() => {
    // ':memory:' opens a hermetic per-instance database with no file artifacts.
    // Constructing it successfully also proves the unconditional WAL pragma in
    // the constructor does not throw against an in-memory database.
    store = new SqliteStore(':memory:');
  });

  it('round-trips a workspace create/get/delete against an in-memory database', async () => {
    const created = await store.create({ name: 'InMem', folderPath: '/tmp/inmem' });
    const fetched = await store.get(created.id);
    assert.ok(fetched);
    assert.strictEqual(fetched!.name, 'InMem');

    const deleted = await store.delete(created.id);
    assert.strictEqual(deleted, true);
    assert.strictEqual(await store.get(created.id), null);
  });

  it('resetData clears rows across every table family', async () => {
    const ws = await store.create({ name: 'WS', folderPath: '/tmp/ws' });
    const session = store.createLocalSession(ws.id, 's1');
    store.createTodo(ws.id, { text: 'do thing' });
    store.setWecomSession(ws.id, 'enc-user', session.id);
    store.setWecomUserMapping('enc-user', 'plain-user');
    store.setFeishuActiveWorkspace(ws.id);
    store.addFeishuUserSession(ws.id, 'feishu-user', session.id);
    store.createPromptHistory(ws.id, session.id, 'hello');
    store.getAnalyticsCache().upsert({
      sessionId: session.id,
      workspaceId: ws.id,
      transcriptMtime: 1,
      extractedAt: 1,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedCostUsd: 0,
      costCoveragePercent: 100,
      durationMs: 0,
      messageCount: 0,
      firstMessageTs: null,
      lastMessageTs: null,
      hasCompaction: false,
      modelUsage: [],
      toolUsage: [],
      dailyStats: [],
      heatmap: [],
    });

    store.resetData();

    // Every table family is empty after reset — proving resetData derived the
    // full table set from the schema rather than a hard-coded subset.
    assert.strictEqual((await store.list()).length, 0);
    assert.strictEqual(store.listLocalSessions().length, 0);
    assert.strictEqual(store.getTodosByWorkspace(ws.id).length, 0);
    assert.strictEqual(store.listWecomSessions(ws.id).length, 0);
    assert.strictEqual(store.getWecomUserMapping('enc-user'), null);
    assert.strictEqual(store.getFeishuActiveWorkspace(), null);
    assert.strictEqual(store.listFeishuSessionsForWorkspace(ws.id).length, 0);
    assert.strictEqual(store.listPromptHistory(ws.id).length, 0);
    assert.strictEqual(store.getAnalyticsCache().listAll().length, 0);
  });

  it('resetData on a freshly constructed (empty) store completes without error', () => {
    assert.doesNotThrow(() => store.resetData());
  });

  it('separate in-memory stores are isolated from each other', async () => {
    // Each ':memory:' instance is a distinct database on its own connection.
    const other = new SqliteStore(':memory:');
    const ws = await store.create({ name: 'Owner', folderPath: '/tmp/owner' });

    assert.ok(await store.get(ws.id));
    // The workspace is not visible in the independent in-memory instance.
    assert.strictEqual(await other.get(ws.id), null);
  });
});

describe('SqliteStore wecom active session + customTitle', { concurrency: false }, () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore(':memory:');
    store.resetData();
  });

  // Helper mirroring the real bot flow: create the sessions-table row, the
  // wecom_user_sessions mapping row, then (optionally) flip it active.
  function makeSession(workspaceId: string, wecomUserId: string, active = false): string {
    const session = store.createLocalSession(workspaceId, wecomUserId, undefined, undefined, 'wecom');
    store.setWecomSession(workspaceId, wecomUserId, session.id);
    if (active) store.setActiveWecomSession(workspaceId, wecomUserId, session.id);
    return session.id;
  }

  it('newly inserted wecom session rows default to non-active (no backfill)', () => {
    makeSession('ws-1', 'user-a');
    // isActive defaults to 0; no setActiveWecomSession called
    assert.strictEqual(store.getActiveWecomSession('ws-1', 'user-a'), null);
  });

  it('migration is idempotent (constructing a second store does not throw)', () => {
    assert.doesNotThrow(() => new SqliteStore(':memory:'));
  });

  it('setActiveWecomSession marks the row active and getActiveWecomSession returns it', () => {
    const id = makeSession('ws-1', 'user-a', true);
    assert.strictEqual(store.getActiveWecomSession('ws-1', 'user-a'), id);
  });

  it('activating a second session demotes the first (single-active invariant)', () => {
    const first = makeSession('ws-1', 'user-a', true);
    const second = makeSession('ws-1', 'user-a', true);
    assert.strictEqual(store.getActiveWecomSession('ws-1', 'user-a'), second);
    // first is preserved but no longer active
    const ids = store.listWecomSessionsByUser('ws-1', 'user-a').map((s) => s.sessionId);
    assert.ok(ids.includes(first));
    assert.ok(ids.includes(second));
  });

  it('getActiveWecomSession self-heals when the active session is absent from sessions', () => {
    // wecom_user_sessions row exists, but 'sess-gone' was never inserted into sessions
    store.setWecomSession('ws-1', 'user-a', 'sess-gone');
    store.setActiveWecomSession('ws-1', 'user-a', 'sess-gone');
    assert.strictEqual(store.getActiveWecomSession('ws-1', 'user-a'), null);
  });

  it('two users each keep their own independent active session', () => {
    const a = makeSession('ws-1', 'user-a', true);
    const b = makeSession('ws-1', 'user-b', true);
    assert.strictEqual(store.getActiveWecomSession('ws-1', 'user-a'), a);
    assert.strictEqual(store.getActiveWecomSession('ws-1', 'user-b'), b);
  });

  it('createLocalSession persists customTitle when provided', () => {
    const session = store.createLocalSession('ws-1', 'Project X', undefined, undefined, 'wecom', 'Project X');
    assert.strictEqual(session.customTitle, 'Project X');
    const fromDb = store.getLocalSession(session.id);
    assert.ok(fromDb);
    assert.strictEqual(fromDb!.customTitle, 'Project X');
  });

  it('createLocalSession leaves customTitle unset when not provided', () => {
    const session = store.createLocalSession('ws-1', 'user-1', undefined, undefined, 'wecom');
    assert.strictEqual(session.customTitle, undefined);
    const fromDb = store.getLocalSession(session.id);
    assert.ok(fromDb);
    assert.strictEqual(fromDb!.customTitle, undefined);
  });
});

describe('SqliteStore wecom active session backfill', { concurrency: false }, () => {
  const backfillDbPath = join(testDbDir, 'backfill-data.db');

  beforeEach(() => {
    try {
      const store = new SqliteStore(backfillDbPath);
      store.resetData();
    } catch {
      // If the DB does not exist yet, resetData is not needed.
    }
  });

  it('backfills the latest inactive session as active on store construction', () => {
    // Simulate pre-backfill state: a WeCom user has sessions but no active marker.
    const firstStore = new SqliteStore(backfillDbPath);
    firstStore.resetData();

    const oldSession = firstStore.createLocalSession('ws-1', 'user-a', undefined, undefined, 'wecom');
    firstStore.setWecomSession('ws-1', 'user-a', oldSession.id);
    // Intentionally not calling setActiveWecomSession, mimicking rows created
    // before the active-marker feature existed.

    // Constructing a new store (e.g. after Comate restart) should run the
    // migration/backfill and mark the latest session active.
    const restartedStore = new SqliteStore(backfillDbPath);
    assert.strictEqual(restartedStore.getActiveWecomSession('ws-1', 'user-a'), oldSession.id);
  });

  it('does not overwrite an existing active session when backfilling', () => {
    const firstStore = new SqliteStore(backfillDbPath);
    firstStore.resetData();

    const oldSession = firstStore.createLocalSession('ws-1', 'user-a', undefined, undefined, 'wecom');
    firstStore.setWecomSession('ws-1', 'user-a', oldSession.id);

    const activeSession = firstStore.createLocalSession('ws-1', 'user-a', undefined, undefined, 'wecom');
    firstStore.setWecomSession('ws-1', 'user-a', activeSession.id);
    firstStore.setActiveWecomSession('ws-1', 'user-a', activeSession.id);

    const restartedStore = new SqliteStore(backfillDbPath);
    assert.strictEqual(restartedStore.getActiveWecomSession('ws-1', 'user-a'), activeSession.id);
  });

  it('backfills independently per workspace and per user', () => {
    const firstStore = new SqliteStore(backfillDbPath);
    firstStore.resetData();

    const aSession = firstStore.createLocalSession('ws-1', 'user-a', undefined, undefined, 'wecom');
    firstStore.setWecomSession('ws-1', 'user-a', aSession.id);

    const bSession = firstStore.createLocalSession('ws-1', 'user-b', undefined, undefined, 'wecom');
    firstStore.setWecomSession('ws-1', 'user-b', bSession.id);

    const otherWsSession = firstStore.createLocalSession('ws-2', 'user-a', undefined, undefined, 'wecom');
    firstStore.setWecomSession('ws-2', 'user-a', otherWsSession.id);

    const restartedStore = new SqliteStore(backfillDbPath);
    assert.strictEqual(restartedStore.getActiveWecomSession('ws-1', 'user-a'), aSession.id);
    assert.strictEqual(restartedStore.getActiveWecomSession('ws-1', 'user-b'), bSession.id);
    assert.strictEqual(restartedStore.getActiveWecomSession('ws-2', 'user-a'), otherWsSession.id);
  });

  it('does not backfill a session whose row is missing from sessions table', () => {
    const firstStore = new SqliteStore(backfillDbPath);
    firstStore.resetData();

    // Insert a mapping to a session that no longer exists.
    firstStore.setWecomSession('ws-1', 'user-a', 'deleted-session-id');

    const restartedStore = new SqliteStore(backfillDbPath);
    assert.strictEqual(restartedStore.getActiveWecomSession('ws-1', 'user-a'), null);
  });
});

describe('SqliteStore bot management', { concurrency: false }, () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore(':memory:');
    store.resetData();
  });

  function createBotInput(overrides: Partial<{
    name: string;
    activeWorkspaceId: string;
  }> = {}) {
    return {
      name: overrides.name ?? 'Test Bot',
      activeWorkspaceId: overrides.activeWorkspaceId,
      providerSettings: {
        wecom: {
          botId: 'wecom-bot-id',
          botSecret: 'wecom-bot-secret',
          corpSecret: 'wecom-corp-secret',
        },
        feishu: {
          appId: 'feishu-app-id',
          appSecret: 'feishu-app-secret',
          encryptKey: 'feishu-encrypt-key',
          verificationToken: 'feishu-verification-token',
        },
      },
      rolePolicy: {
        normalToolPolicy: {
          posture: 'safe' as const,
          categoryDefaults: {
            fileRead: 'allow' as const,
            fileWrite: 'deny' as const,
            shell: 'deny' as const,
            network: 'deny' as const,
            subagents: 'deny' as const,
            reply: 'allow' as const,
          },
        },
        skillAllowlist: [],
        bashWhitelist: [],
      },
    };
  }

  it('createBot persists a bot and returns it', () => {
    const bot = store.createBot(createBotInput({ name: 'WeCom Bot' }));

    assert.strictEqual(bot.name, 'WeCom Bot');
    assert.ok(bot.id);
    assert.ok(bot.createdAt);
    assert.ok(bot.updatedAt);
    assert.deepStrictEqual(bot.providerSettings, createBotInput().providerSettings);
  });

  it('getBot returns a persisted bot by id', () => {
    const bot = store.createBot(createBotInput());
    const found = store.getBot(bot.id);

    assert.ok(found);
    assert.strictEqual(found!.name, bot.name);
    assert.strictEqual(found!.activeWorkspaceId, bot.activeWorkspaceId);
    assert.deepStrictEqual(found!.providerSettings, bot.providerSettings);
  });

  it('getBot returns null for unknown id', () => {
    assert.strictEqual(store.getBot('unknown'), null);
  });

  it('listBots returns all bots', () => {
    store.createBot(createBotInput({ name: 'A' }));
    store.createBot(createBotInput({ name: 'B' }));

    const bots = store.listBots();
    assert.strictEqual(bots.length, 2);
    assert.ok(bots.some((b) => b.name === 'A'));
    assert.ok(bots.some((b) => b.name === 'B'));
  });

  it('listBotsForWorkspace filters by active workspace', () => {
    store.createBot(createBotInput({ name: 'In WS1', activeWorkspaceId: 'ws-1' }));
    store.createBot(createBotInput({ name: 'In WS2', activeWorkspaceId: 'ws-2' }));
    store.createBot(createBotInput({ name: 'Unbound' }));

    const ws1Bots = store.listBotsForWorkspace('ws-1');
    assert.strictEqual(ws1Bots.length, 1);
    assert.strictEqual(ws1Bots[0].name, 'In WS1');
  });

  it('updateBot modifies name, workspace, settings and policy', () => {
    const bot = store.createBot(createBotInput());
    const updated = store.updateBot(bot.id, {
      name: 'Renamed',
      activeWorkspaceId: 'ws-updated',
      providerSettings: { wecom: { botId: 'new-id' } },
      rolePolicy: {
        normalToolPolicy: {
          posture: 'allow-all' as const,
          categoryDefaults: {
            fileRead: 'allow' as const,
            fileWrite: 'allow' as const,
            shell: 'deny' as const,
            network: 'deny' as const,
            subagents: 'deny' as const,
            reply: 'allow' as const,
          },
        },
        skillAllowlist: ['skill-a'],
        bashWhitelist: ['ls'],
      },
    });

    assert.ok(updated);
    assert.strictEqual(updated!.name, 'Renamed');
    assert.strictEqual(updated!.activeWorkspaceId, 'ws-updated');
    assert.deepStrictEqual(updated!.providerSettings, { wecom: { botId: 'new-id' } });
    assert.deepStrictEqual(updated!.rolePolicy.skillAllowlist, ['skill-a']);

    const fromDb = store.getBot(bot.id);
    assert.strictEqual(fromDb!.name, 'Renamed');
  });

  it('updateBot returns null for unknown id', () => {
    const updated = store.updateBot('unknown', { name: 'X' });
    assert.strictEqual(updated, null);
  });

  it('deleteBot removes the bot and its members and audit logs', () => {
    const bot = store.createBot(createBotInput());
    store.setBotMember(bot.id, 'wecom', 'user-1', 'owner');
    store.recordAuditLog({ botId: bot.id, actorType: 'system', actorId: 'test', eventType: 'created' });

    assert.strictEqual(store.deleteBot(bot.id), true);
    assert.strictEqual(store.getBot(bot.id), null);
    assert.strictEqual(store.listBotMembers(bot.id).length, 0);
    assert.strictEqual(store.listAuditLogs(bot.id).length, 0);
  });

  it('deleteBot returns false for unknown id', () => {
    assert.strictEqual(store.deleteBot('unknown'), false);
  });

  it('setBotMember creates and updates member roles', () => {
    const bot = store.createBot(createBotInput());
    store.setBotMember(bot.id, 'wecom', 'user-1', 'owner');
    assert.strictEqual(store.getBotMemberRole(bot.id, 'wecom', 'user-1'), 'owner');

    store.setBotMember(bot.id, 'wecom', 'user-1', 'admin');
    assert.strictEqual(store.getBotMemberRole(bot.id, 'wecom', 'user-1'), 'admin');

    const members = store.listBotMembers(bot.id);
    assert.strictEqual(members.length, 1);
    assert.strictEqual(members[0].providerUserId, 'user-1');
  });

  it('removeBotMember deletes a member', () => {
    const bot = store.createBot(createBotInput());
    store.setBotMember(bot.id, 'feishu', 'user-2', 'normal');
    store.removeBotMember(bot.id, 'feishu', 'user-2');

    assert.strictEqual(store.getBotMemberRole(bot.id, 'feishu', 'user-2'), null);
    assert.strictEqual(store.listBotMembers(bot.id).length, 0);
  });

  it('getBotMemberRole returns null for unknown member', () => {
    const bot = store.createBot(createBotInput());
    assert.strictEqual(store.getBotMemberRole(bot.id, 'wecom', 'nobody'), null);
  });

  it('recordAuditLog creates entries ordered newest-first', () => {
    const bot = store.createBot(createBotInput());
    store.recordAuditLog({ botId: bot.id, actorType: 'system', actorId: 'a', eventType: 'one' });
    store.recordAuditLog({ botId: bot.id, actorType: 'user', actorId: 'b', eventType: 'two' });

    const logs = store.listAuditLogs(bot.id);
    assert.strictEqual(logs.length, 2);
    assert.strictEqual(logs[0].eventType, 'two');
    assert.strictEqual(logs[1].eventType, 'one');
    assert.strictEqual(logs[0].actorType, 'user');
  });

  it('migration state stores and retrieves version and snapshot', () => {
    assert.strictEqual(store.getMigrationVersion(), null);

    store.setMigrationState(1, new Date().toISOString(), { workspaces: 3 });
    assert.strictEqual(store.getMigrationVersion(), 1);
  });

  it('setSessionBotId links sessions to a bot', () => {
    const bot = store.createBot(createBotInput({ activeWorkspaceId: 'ws-1' }));
    const session = store.createLocalSession('ws-1', 'Test');

    store.setSessionBotId(session.id, bot.id);
    const botSessions = store.listSessionsForBot(bot.id);
    assert.strictEqual(botSessions.length, 1);
    assert.strictEqual(botSessions[0].id, session.id);
    assert.strictEqual(botSessions[0].botId, bot.id);
  });

  it('encrypts and decrypts sensitive provider settings at rest', () => {
    const settings = createBotInput().providerSettings;
    const bot = store.createBot({ name: 'Encrypted', providerSettings: settings });
    const found = store.getBot(bot.id);

    assert.deepStrictEqual(found!.providerSettings, settings);

    // Verify the raw DB does not contain plaintext secrets.
    const row = (store as unknown as { db: { prepare: (sql: string) => { get: (id: string) => { provider_settings_json: string } | undefined } } }).db
      .prepare('SELECT provider_settings_json FROM bots WHERE id = ?')
      .get(bot.id);
    assert.ok(row);
    const json = JSON.parse(row!.provider_settings_json);
    assert.notStrictEqual(json.wecom.botSecret, 'wecom-bot-secret');
    assert.notStrictEqual(json.feishu.appSecret, 'feishu-app-secret');
  });
});

