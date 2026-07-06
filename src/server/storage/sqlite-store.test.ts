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

    const claimed2 = store.claimNextPendingMessage('ws-1');
    assert.ok(claimed2);
    assert.strictEqual(claimed2.status, 'delivering');

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
    const ws = await store.create({
      name: 'Cascade Test',
      folderPath: '/tmp/cascade-test',
    });
    store.enqueueProactiveMessage(ws.id, createMessageInput());

    const before = store.listProactiveMessages(ws.id);
    assert.strictEqual(before.length, 1);

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

describe('SqliteStore in-memory + resetData', { concurrency: false }, () => {
  let store: SqliteStore;

  beforeEach(() => {
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

    assert.strictEqual((await store.list()).length, 0);
    assert.strictEqual(store.listLocalSessions().length, 0);
    assert.strictEqual(store.getTodosByWorkspace(ws.id).length, 0);
    assert.strictEqual(store.listPromptHistory(ws.id).length, 0);
    assert.strictEqual(store.getAnalyticsCache().listAll().length, 0);
  });

  it('resetData on a freshly constructed (empty) store completes without error', () => {
    assert.doesNotThrow(() => store.resetData());
  });

  it('separate in-memory stores are isolated from each other', async () => {
    const other = new SqliteStore(':memory:');
    const ws = await store.create({ name: 'Owner', folderPath: '/tmp/owner' });

    assert.ok(await store.get(ws.id));
    assert.strictEqual(await other.get(ws.id), null);
  });
});

describe('SqliteStore unified user sessions', { concurrency: false }, () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore(':memory:');
    store.resetData();
  });

  async function createWorkspace(name: string) {
    return store.create({ name, folderPath: `/tmp/${name}` });
  }

  it('adds and lists user sessions', async () => {
    const ws = await createWorkspace('US Test');
    const bot = store.createBot({ name: 'Test Bot', activeWorkspaceId: ws.id });
    const channel = store.listBotChannels(bot.id)[0];
    const role = store.getBotRoleByKey(bot.id, 'normal');
    assert.ok(role);
    const user = store.createBotUser({
      botId: bot.id,
      channelId: channel.id,
      roleId: role!.id,
      channelUserId: 'user-1',
    });

    const session = store.createLocalSession(ws.id, 'Test');
    store.addUserSession(ws.id, session.id, user.id);

    const sessions = store.listUserSessionsByUser(user.id);
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].sessionId, session.id);
  });

  it('getActiveUserSession returns null when no active session', async () => {
    const ws = await createWorkspace('US Active');
    const bot = store.createBot({ name: 'Test Bot', activeWorkspaceId: ws.id });
    const channel = store.listBotChannels(bot.id)[0];
    const role = store.getBotRoleByKey(bot.id, 'normal');
    assert.ok(role);
    const user = store.createBotUser({
      botId: bot.id,
      channelId: channel.id,
      roleId: role!.id,
      channelUserId: 'user-1',
    });

    assert.strictEqual(store.getActiveUserSession(user.id), null);
  });

  it('setActiveUserSession marks session active and demotes previous', async () => {
    const ws = await createWorkspace('US Switch');
    const bot = store.createBot({ name: 'Test Bot', activeWorkspaceId: ws.id });
    const channel = store.listBotChannels(bot.id)[0];
    const role = store.getBotRoleByKey(bot.id, 'normal');
    assert.ok(role);
    const user = store.createBotUser({
      botId: bot.id,
      channelId: channel.id,
      roleId: role!.id,
      channelUserId: 'user-1',
    });

    const session1 = store.createLocalSession(ws.id, 'S1');
    const session2 = store.createLocalSession(ws.id, 'S2');
    store.addUserSession(ws.id, session1.id, user.id);
    store.addUserSession(ws.id, session2.id, user.id);

    store.setActiveUserSession(user.id, session1.id);
    assert.strictEqual(store.getActiveUserSession(user.id), session1.id);

    store.setActiveUserSession(user.id, session2.id);
    assert.strictEqual(store.getActiveUserSession(user.id), session2.id);

    const all = store.listUserSessionsByUser(user.id);
    assert.strictEqual(all.length, 2);
  });

  it('getActiveUserSession self-heals when session is deleted', async () => {
    const ws = await createWorkspace('US Heal');
    const bot = store.createBot({ name: 'Test Bot', activeWorkspaceId: ws.id });
    const channel = store.listBotChannels(bot.id)[0];
    const role = store.getBotRoleByKey(bot.id, 'normal');
    assert.ok(role);
    const user = store.createBotUser({
      botId: bot.id,
      channelId: channel.id,
      roleId: role!.id,
      channelUserId: 'user-1',
    });

    const session = store.createLocalSession(ws.id, 'S1');
    store.addUserSession(ws.id, session.id, user.id);
    store.setActiveUserSession(user.id, session.id);
    assert.strictEqual(store.getActiveUserSession(user.id), session.id);

    store.deleteLocalSession(session.id);
    assert.strictEqual(store.getActiveUserSession(user.id), null);
  });

  it('getSessionUsers returns linked user ids', async () => {
    const ws = await createWorkspace('US Owners');
    const bot = store.createBot({ name: 'Test Bot', activeWorkspaceId: ws.id });
    const channel = store.listBotChannels(bot.id)[0];
    const role = store.getBotRoleByKey(bot.id, 'normal');
    assert.ok(role);
    const user = store.createBotUser({
      botId: bot.id,
      channelId: channel.id,
      roleId: role!.id,
      channelUserId: 'user-1',
    });

    const session = store.createLocalSession(ws.id, 'S1');
    store.addUserSession(ws.id, session.id, user.id);

    const users = store.getSessionUsers(session.id);
    assert.strictEqual(users.length, 1);
    assert.strictEqual(users[0], user.id);
  });

  it('workspace delete cascades to user_sessions', async () => {
    const ws = await createWorkspace('US Cascade');
    const bot = store.createBot({ name: 'Test Bot', activeWorkspaceId: ws.id });
    const channel = store.listBotChannels(bot.id)[0];
    const role = store.getBotRoleByKey(bot.id, 'normal');
    assert.ok(role);
    const user = store.createBotUser({
      botId: bot.id,
      channelId: channel.id,
      roleId: role!.id,
      channelUserId: 'user-1',
    });

    const session = store.createLocalSession(ws.id, 'S1');
    store.addUserSession(ws.id, session.id, user.id);
    store.setActiveUserSession(user.id, session.id);

    assert.strictEqual(store.getActiveUserSession(user.id), session.id);

    await store.delete(ws.id);

    assert.strictEqual(store.getActiveUserSession(user.id), null);
    assert.strictEqual(store.listUserSessionsByUser(user.id).length, 0);
  });
});

describe('SqliteStore bot management (unified schema)', { concurrency: false }, () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore(':memory:');
    store.resetData();
  });

  it('createBot persists a bot and default channels/roles', () => {
    const bot = store.createBot({ name: 'Test Bot' });

    assert.strictEqual(bot.name, 'Test Bot');
    assert.ok(bot.id);
    assert.ok(bot.createdAt);
    assert.ok(bot.updatedAt);
    assert.strictEqual(bot.activeWorkspaceId, null);

    const channels = store.listBotChannels(bot.id);
    assert.strictEqual(channels.length, 2);
    assert.ok(channels.some((c) => c.channelKey === 'wecom'));
    assert.ok(channels.some((c) => c.channelKey === 'feishu'));

    const roles = store.listBotRoles(bot.id);
    assert.strictEqual(roles.length, 3);
    assert.ok(roles.some((r) => r.roleKey === 'owner'));
    assert.ok(roles.some((r) => r.roleKey === 'admin'));
    assert.ok(roles.some((r) => r.roleKey === 'normal'));
  });

  it('createBot stores and returns a persona', () => {
    const persona = { prompt: '你是运维助手', mode: 'append' as const };
    const bot = store.createBot({ name: 'Persona Bot', persona });

    assert.deepStrictEqual(bot.persona, persona);
    const found = store.getBot(bot.id);
    assert.deepStrictEqual(found?.persona, persona);
  });

  it('getBot returns null for unknown id', () => {
    assert.strictEqual(store.getBot('unknown'), null);
  });

  it('listBots returns all bots', () => {
    store.createBot({ name: 'A' });
    store.createBot({ name: 'B' });

    const bots = store.listBots();
    assert.strictEqual(bots.length, 2);
    assert.ok(bots.some((b) => b.name === 'A'));
    assert.ok(bots.some((b) => b.name === 'B'));
  });

  it('listBotsForWorkspace filters by active workspace', () => {
    store.createBot({ name: 'In WS1', activeWorkspaceId: 'ws-1' });
    store.createBot({ name: 'In WS2', activeWorkspaceId: 'ws-2' });
    store.createBot({ name: 'Unbound' });

    const ws1Bots = store.listBotsForWorkspace('ws-1');
    assert.strictEqual(ws1Bots.length, 1);
    assert.strictEqual(ws1Bots[0].name, 'In WS1');
  });

  it('updateBot modifies name and workspace', () => {
    const bot = store.createBot({ name: 'Original' });
    const updated = store.updateBot(bot.id, {
      name: 'Renamed',
      activeWorkspaceId: 'ws-updated',
    });

    assert.ok(updated);
    assert.strictEqual(updated!.name, 'Renamed');
    assert.strictEqual(updated!.activeWorkspaceId, 'ws-updated');

    const fromDb = store.getBot(bot.id);
    assert.strictEqual(fromDb!.name, 'Renamed');
  });

  it('updateBot clears persona when set to null', () => {
    const persona = { prompt: '你是运维助手', mode: 'append' as const };
    const bot = store.createBot({ name: 'Persona Bot', persona });
    assert.deepStrictEqual(store.getBot(bot.id)?.persona, persona);

    const updated = store.updateBot(bot.id, { persona: null });
    assert.strictEqual(updated?.persona, undefined);
    assert.strictEqual(store.getBot(bot.id)?.persona, undefined);
  });

  it('updateBot returns null for unknown id', () => {
    const updated = store.updateBot('unknown', { name: 'X' });
    assert.strictEqual(updated, null);
  });

  it('deleteBot removes the bot and cascades to channels, roles, users, audit logs', () => {
    const bot = store.createBot({ name: 'Test Bot' });
    const channel = store.listBotChannels(bot.id)[0];
    const role = store.getBotRoleByKey(bot.id, 'normal');
    assert.ok(role);
    const user = store.createBotUser({
      botId: bot.id,
      channelId: channel.id,
      roleId: role!.id,
      channelUserId: 'user-1',
    });
    store.recordAuditLog({ botId: bot.id, actorType: 'system', actorId: 'test', eventType: 'created' });

    assert.strictEqual(store.deleteBot(bot.id), true);
    assert.strictEqual(store.getBot(bot.id), null);
    assert.strictEqual(store.listBotChannels(bot.id).length, 0);
    assert.strictEqual(store.listBotRoles(bot.id).length, 0);
    assert.strictEqual(store.listBotUsers(bot.id).length, 0);
    assert.strictEqual(store.listAuditLogs(bot.id).length, 0);
    assert.strictEqual(store.getBotUser(user.id), null);
  });

  it('deleteBot returns false for unknown id', () => {
    assert.strictEqual(store.deleteBot('unknown'), false);
  });

  it('createBotUser and getBotUser round-trip', () => {
    const bot = store.createBot({ name: 'Test Bot' });
    const channel = store.listBotChannels(bot.id)[0];
    const role = store.getBotRoleByKey(bot.id, 'normal');
    assert.ok(role);

    const user = store.createBotUser({
      botId: bot.id,
      channelId: channel.id,
      roleId: role!.id,
      channelUserId: 'user-1',
      plaintextUserId: 'plain-1',
    });

    assert.strictEqual(user.botId, bot.id);
    assert.strictEqual(user.channelId, channel.id);
    assert.strictEqual(user.roleId, role!.id);
    assert.strictEqual(user.channelUserId, 'user-1');
    assert.strictEqual(user.plaintextUserId, 'plain-1');
    assert.strictEqual(user.resolutionStatus, 'resolved');
    assert.strictEqual(user.roleKey, 'normal');

    const found = store.getBotUser(user.id);
    assert.ok(found);
    assert.strictEqual(found!.channelUserId, 'user-1');
    assert.strictEqual(found!.plaintextUserId, 'plain-1');
  });

  it('getBotUserByChannelIdentity finds user by channel identity', () => {
    const bot = store.createBot({ name: 'Test Bot' });
    const channel = store.listBotChannels(bot.id)[0];
    const role = store.getBotRoleByKey(bot.id, 'normal');
    assert.ok(role);

    store.createBotUser({
      botId: bot.id,
      channelId: channel.id,
      roleId: role!.id,
      channelUserId: 'user-1',
    });

    const found = store.getBotUserByChannelIdentity(bot.id, channel.id, 'user-1');
    assert.ok(found);
    assert.strictEqual(found!.channelUserId, 'user-1');

    const notFound = store.getBotUserByChannelIdentity(bot.id, channel.id, 'unknown');
    assert.strictEqual(notFound, null);
  });

  it('listBotUsers returns users scoped to bot', () => {
    const bot1 = store.createBot({ name: 'Bot 1' });
    const bot2 = store.createBot({ name: 'Bot 2' });
    const ch1 = store.listBotChannels(bot1.id)[0];
    const r1 = store.getBotRoleByKey(bot1.id, 'normal');
    assert.ok(r1);
    const ch2 = store.listBotChannels(bot2.id)[0];
    const r2 = store.getBotRoleByKey(bot2.id, 'normal');
    assert.ok(r2);

    store.createBotUser({ botId: bot1.id, channelId: ch1.id, roleId: r1!.id, channelUserId: 'u1' });
    store.createBotUser({ botId: bot2.id, channelId: ch2.id, roleId: r2!.id, channelUserId: 'u2' });

    assert.strictEqual(store.listBotUsers(bot1.id).length, 1);
    assert.strictEqual(store.listBotUsers(bot2.id).length, 1);
  });

  it('updateBotUser changes role and plaintext', () => {
    const bot = store.createBot({ name: 'Test Bot' });
    const channel = store.listBotChannels(bot.id)[0];
    const normalRole = store.getBotRoleByKey(bot.id, 'normal');
    assert.ok(normalRole);
    const adminRole = store.getBotRoleByKey(bot.id, 'admin');
    assert.ok(adminRole);

    const user = store.createBotUser({
      botId: bot.id,
      channelId: channel.id,
      roleId: normalRole!.id,
      channelUserId: 'user-1',
    });

    const updated = store.updateBotUser(user.id, { roleId: adminRole!.id, plaintextUserId: 'resolved-1' });
    assert.ok(updated);
    assert.strictEqual(updated!.roleId, adminRole!.id);
    assert.strictEqual(updated!.roleKey, 'admin');
    assert.strictEqual(updated!.plaintextUserId, 'resolved-1');
    assert.strictEqual(updated!.resolutionStatus, 'resolved');
  });

  it('deleteBotUser removes user and linked sessions', async () => {
    const ws = await store.create({ name: 'WS', folderPath: '/tmp/ws' });
    const bot = store.createBot({ name: 'Test Bot', activeWorkspaceId: ws.id });
    const channel = store.listBotChannels(bot.id)[0];
    const role = store.getBotRoleByKey(bot.id, 'normal');
    assert.ok(role);
    const user = store.createBotUser({
      botId: bot.id,
      channelId: channel.id,
      roleId: role!.id,
      channelUserId: 'user-1',
    });

    const session = store.createLocalSession(ws.id, 'S1');
    store.addUserSession(ws.id, session.id, user.id);
    store.setActiveUserSession(user.id, session.id);

    assert.strictEqual(store.deleteBotUser(user.id), true);
    assert.strictEqual(store.getBotUser(user.id), null);
    assert.strictEqual(store.listUserSessionsByUser(user.id).length, 0);
  });

  it('recordAuditLog creates entries ordered newest-first', () => {
    const bot = store.createBot({ name: 'Audit Bot' });
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
    const bot = store.createBot({ name: 'Test Bot', activeWorkspaceId: 'ws-1' });
    const session = store.createLocalSession('ws-1', 'Test');

    store.setSessionBotId(session.id, bot.id);
    const botSessions = store.listSessionsForBot(bot.id);
    assert.strictEqual(botSessions.length, 1);
    assert.strictEqual(botSessions[0].id, session.id);
    assert.strictEqual(botSessions[0].botId, bot.id);
  });

  it('bot channel config encrypts and decrypts at rest', () => {
    const bot = store.createBot({ name: 'Encrypted' });
    const channel = store.listBotChannels(bot.id)[0];
    const config: import('../models/bot.js').BotChannelSettings = {
      wecom: { botId: 'wecom-bot-id', botSecret: 'wecom-bot-secret', corpSecret: 'wecom-corp-secret' },
    };

    store.updateBotChannel(channel.id, config);
    const updated = store.getBotChannel(channel.id);
    assert.deepStrictEqual(updated!.config, config);

    const row = (store as unknown as { db: { prepare: (sql: string) => { get: (id: string) => { config_json: string } | undefined } } }).db
      .prepare('SELECT config_json FROM bot_channels WHERE id = ?')
      .get(channel.id);
    assert.ok(row);
    const json = JSON.parse(row!.config_json);
    assert.notStrictEqual(json.wecom.botSecret, 'wecom-bot-secret');
  });

  it('bot role permissions round-trip', () => {
    const bot = store.createBot({ name: 'Role Test' });
    const role = store.getBotRoleByKey(bot.id, 'normal');
    assert.ok(role);

    const newPerms: import('../models/bot.js').BotRolePolicy = {
      normalToolPolicy: {
        posture: 'allow-all',
        categoryDefaults: {
          fileRead: 'allow',
          fileWrite: 'allow',
          shell: 'allow',
          network: 'allow',
          subagents: 'allow',
          reply: 'allow',
        },
      },
      skillAllowlist: ['skill-a'],
      bashWhitelist: ['ls'],
    };

    store.updateBotRole(role!.id, newPerms);
    const updated = store.getBotRole(role!.id);
    assert.deepStrictEqual(updated!.permissions, newPerms);
  });

  it('bot role persona round-trip', () => {
    const bot = store.createBot({ name: 'Role Persona Test' });
    const role = store.getBotRoleByKey(bot.id, 'admin');
    assert.ok(role);

    const persona = { prompt: 'Admin helper', mode: 'replace' as const };
    store.updateBotRole(role!.id, role!.permissions, persona);
    const updated = store.getBotRole(role!.id);
    assert.deepStrictEqual(updated!.persona, persona);
  });
});

describe('SqliteStore unified schema migration', { concurrency: false }, () => {
  const migrationDbPath = join(testDbDir, 'migration-data.db');

  beforeEach(() => {
    try {
      const store = new SqliteStore(migrationDbPath);
      store.resetData();
    } catch {
      // If the DB does not exist yet, resetData is not needed.
    }
  });

  it('fresh database initializes to version 5 with new tables', () => {
    const freshStore = new SqliteStore(':memory:');
    assert.strictEqual(freshStore.getMigrationVersion(), 5);

    // Old tables should not exist
    const tables = (freshStore as unknown as { db: { prepare: (sql: string) => { all: () => Array<{ name: string }> } } }).db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all();
    const tableNames = tables.map((t) => t.name);
    assert.ok(!tableNames.includes('bot_members'));
    assert.ok(!tableNames.includes('wecom_user_sessions'));
    assert.ok(!tableNames.includes('wecom_user_id_mappings'));
    assert.ok(!tableNames.includes('wecom_workspace_users'));
    assert.ok(!tableNames.includes('feishu_user_sessions'));
    assert.ok(!tableNames.includes('feishu_active_sessions'));
    assert.ok(!tableNames.includes('feishu_workspace_users'));
    assert.ok(!tableNames.includes('feishu_bot_binding'));

    // New tables should exist
    assert.ok(tableNames.includes('bot_channels'));
    assert.ok(tableNames.includes('bot_roles'));
    assert.ok(tableNames.includes('bot_users'));
    assert.ok(tableNames.includes('user_sessions'));
  });

  it('re-running migration on already-migrated database does nothing', () => {
    const firstStore = new SqliteStore(migrationDbPath);
    firstStore.createBot({ name: 'Pre-migration Bot' });

    const version = firstStore.getMigrationVersion();
    assert.strictEqual(version, 5);

    // Re-opening should not throw and version should stay 5
    const secondStore = new SqliteStore(migrationDbPath);
    assert.strictEqual(secondStore.getMigrationVersion(), 5);
    assert.strictEqual(secondStore.listBots().length, 1);
  });
});
