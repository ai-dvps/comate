import '../test-utils/test-env.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { SqliteStore } from '../storage/sqlite-store.js';
import { BotAuditLogger } from './bot-audit-logger.js';

describe('BotAuditLogger', { concurrency: false }, () => {
  let store: SqliteStore;
  let logger: BotAuditLogger;

  beforeEach(() => {
    store = new SqliteStore(':memory:');
    store.resetData();
    logger = new BotAuditLogger(store);
  });

  it('records a basic audit log entry', () => {
    logger.log('bot-1', { type: 'system' }, 'bot_created', { name: 'Test Bot' });
    const logs = store.listAuditLogs('bot-1');
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].eventType, 'bot_created');
    assert.deepStrictEqual(logs[0].details, { name: 'Test Bot' });
  });

  it('redacts long string values that may be secrets', () => {
    logger.log('bot-1', { type: 'system' }, 'channel_credentials_changed', {
      channels: ['wecom'],
      secret: 'a'.repeat(64),
    });
    const [entry] = store.listAuditLogs('bot-1');
    assert.strictEqual(entry.details.secret, '<redacted>');
    assert.deepStrictEqual(entry.details.channels, ['wecom']);
  });

  it('redacts nested long string values', () => {
    logger.log('bot-1', { type: 'system' }, 'file_access_denied', {
      sessionId: 's-1',
      toolName: 'Read',
      nested: { ciphertext: 'b'.repeat(100) },
    });
    const [entry] = store.listAuditLogs('bot-1');
    assert.strictEqual((entry.details.nested as Record<string, unknown>).ciphertext, '<redacted>');
  });

  it('leaves short values unchanged', () => {
    logger.log('bot-1', { type: 'wecom', channel: 'wecom', channelUserId: 'u-1' }, 'member_added', {
      channel: 'wecom',
      channelUserId: 'u-1',
      role: 'normal',
    });
    const [entry] = store.listAuditLogs('bot-1');
    assert.strictEqual(entry.actorType, 'wecom');
    assert.strictEqual(entry.actorId, 'u-1');
    assert.strictEqual(entry.details.role, 'normal');
  });

  it('records channel credential change events', () => {
    logger.logChannelCredentialsChanged('bot-1', { type: 'system' }, ['wecom', 'feishu']);
    const [entry] = store.listAuditLogs('bot-1');
    assert.strictEqual(entry.eventType, 'channel_credentials_changed');
    assert.deepStrictEqual(entry.details.channels, ['wecom', 'feishu']);
  });

  it('records active workspace switch events', () => {
    logger.logActiveWorkspaceSwitched('bot-1', { type: 'system' }, 'ws-old', 'ws-new');
    const [entry] = store.listAuditLogs('bot-1');
    assert.strictEqual(entry.eventType, 'active_workspace_switched');
    assert.strictEqual(entry.details.previousWorkspaceId, 'ws-old');
    assert.strictEqual(entry.details.newWorkspaceId, 'ws-new');
  });

  it('records member role change events', () => {
    logger.logMemberRoleChanged(
      'bot-1',
      { type: 'wecom', channel: 'wecom', channelUserId: 'owner-1' },
      'wecom',
      'u-1',
      'normal',
      'admin',
    );
    const [entry] = store.listAuditLogs('bot-1');
    assert.strictEqual(entry.eventType, 'member_role_changed');
    assert.strictEqual(entry.details.channel, 'wecom');
    assert.strictEqual(entry.details.channelUserId, 'u-1');
    assert.strictEqual(entry.details.previousRole, 'normal');
    assert.strictEqual(entry.details.newRole, 'admin');
  });

  it('records file access denied events', () => {
    logger.logFileAccessDenied(
      'bot-1',
      { type: 'wecom', channel: 'wecom', channelUserId: 'u-1' },
      {
        sessionId: 's-1',
        toolName: 'Read',
        reason: 'denylist-hit',
        path: '/workspace/x.secret',
      },
    );
    const [entry] = store.listAuditLogs('bot-1');
    assert.strictEqual(entry.eventType, 'file_access_denied');
    assert.strictEqual(entry.details.sessionId, 's-1');
    assert.strictEqual(entry.details.toolName, 'Read');
    assert.strictEqual(entry.details.reason, 'denylist-hit');
    assert.strictEqual(entry.details.path, '/workspace/x.secret');
  });
});
