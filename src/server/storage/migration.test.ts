import '../test-utils/test-env.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { SqliteStore } from './sqlite-store.js';

const WS1 = 'ws-legacy-1';
const WS2 = 'ws-legacy-2';
const BOT1 = 'bot-legacy-1';
const WECOM_SESSION_1 = 'wecom-session-1';
const WECOM_SESSION_2 = 'wecom-session-2';
const FEISHU_SESSION_1 = 'feishu-session-1';

function now() {
  return new Date().toISOString();
}

function tableNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

function openRawDb(store: SqliteStore): Database.Database {
  return (store as unknown as { db: Database.Database }).db;
}

/**
 * Build a pre-unification database on disk. The migration_state table is
 * pre-seeded to version 5 so the SqliteStore constructor creates the legacy
 * schema but skips the rewrite migration. The returned SqliteStore holds an
 * open connection whose underlying Database can be used to seed legacy rows.
 */
function prepareLegacyDb(dbPath: string): { setupStore: SqliteStore; seedDb: Database.Database } {
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');

  // Pre-create proactive_messages without the unified-schema columns so the
  // migration has to backfill them.
  db.exec(`
    CREATE TABLE IF NOT EXISTS wecom_proactive_messages (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      sender_session_id TEXT NOT NULL,
      recipient_encrypted_user_id TEXT NOT NULL,
      recipient_plaintext_user_id TEXT NOT NULL,
      message_content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      error_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      delivered_at TEXT,
      claimed_at TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Force the store constructor to skip migration on first open so legacy
  // tables are created and can be seeded.
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_migration_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      run_at TEXT NOT NULL,
      snapshot_json TEXT NOT NULL DEFAULT '{}'
    )
  `);
  db.prepare(
    `INSERT OR REPLACE INTO bot_migration_state (id, version, run_at, snapshot_json) VALUES (1, 5, ?, '{}')`,
  ).run(now());

  // Pre-create the legacy tables that the constructor will skip because the
  // migration state is already at version 5.
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_members (
      bot_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      channel_user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (bot_id, channel, channel_user_id)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS wecom_user_sessions (
      workspaceId TEXT NOT NULL,
      wecomUserId TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      isActive INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (workspaceId, wecomUserId, sessionId)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS wecom_user_id_mappings (
      encryptedUserId TEXT PRIMARY KEY,
      plaintextUserId TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS feishu_user_sessions (
      workspaceId TEXT NOT NULL,
      feishuUserId TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      PRIMARY KEY (workspaceId, feishuUserId, sessionId)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS feishu_active_sessions (
      workspaceId TEXT NOT NULL,
      feishuUserId TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      PRIMARY KEY (workspaceId, feishuUserId)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS wecom_workspace_users (
      workspaceId TEXT NOT NULL,
      encryptedUserId TEXT NOT NULL,
      firstSeenAt TEXT NOT NULL,
      lastSeenAt TEXT NOT NULL,
      PRIMARY KEY (workspaceId, encryptedUserId)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS feishu_bot_binding (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      activeWorkspaceId TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS feishu_workspace_users (
      workspaceId TEXT NOT NULL,
      openId TEXT NOT NULL,
      userId TEXT,
      name TEXT,
      firstSeenAt TEXT NOT NULL,
      lastSeenAt TEXT NOT NULL,
      PRIMARY KEY (workspaceId, openId)
    )
  `);
  db.close();

  const setupStore = new SqliteStore(dbPath);
  const seedDb = openRawDb(setupStore);
  const ts = now();

  seedDb
    .prepare(
      `INSERT INTO workspaces (id, name, description, folderPath, settings, skills, mcpServers, hooks, createdAt, updatedAt, lastOpenedAt)
       VALUES (?, ?, '', ?, ?, '[]', '[]', '[]', ?, ?, NULL)`,
    )
    .run(WS1, 'Legacy WS 1', '/tmp/legacy-ws1', '{}', ts, ts);
  seedDb
    .prepare(
      `INSERT INTO workspaces (id, name, description, folderPath, settings, skills, mcpServers, hooks, createdAt, updatedAt, lastOpenedAt)
       VALUES (?, ?, '', ?, ?, '[]', '[]', '[]', ?, ?, NULL)`,
    )
    .run(WS2, 'Legacy WS 2', '/tmp/legacy-ws2', '{}', ts, ts);

  seedDb
    .prepare(
      `INSERT INTO bots (id, name, active_workspace_id, channel_settings_json, role_policy_json, persona_json, role_personas_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      BOT1,
      'Legacy Bot',
      WS1,
      JSON.stringify({
        wecom: { enabled: true, botId: 'wb1', botSecret: 'wecom-secret' },
        feishu: { enabled: true, appId: 'fa1', appSecret: 'feishu-secret' },
      }),
      JSON.stringify({
        normalToolPolicy: {
          posture: 'safe',
          categoryDefaults: {
            fileRead: 'allow',
            fileWrite: 'deny',
            shell: 'deny',
            network: 'deny',
            subagents: 'deny',
            reply: 'allow',
          },
        },
        skillAllowlist: [],
        bashWhitelist: [],
      }),
      JSON.stringify({ prompt: 'bot persona', mode: 'append' }),
      JSON.stringify({ owner: { prompt: 'owner persona', mode: 'replace' } }),
      ts,
      ts,
    );

  seedDb
    .prepare(
      `INSERT INTO bot_members (bot_id, channel, channel_user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(BOT1, 'wecom', 'wecom-u1', 'normal', ts, ts);
  seedDb
    .prepare(
      `INSERT INTO bot_members (bot_id, channel, channel_user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(BOT1, 'feishu', 'feishu-u1', 'admin', ts, ts);

  seedDb
    .prepare(
      `INSERT INTO wecom_workspace_users (workspaceId, encryptedUserId, firstSeenAt, lastSeenAt) VALUES (?, ?, ?, ?)`,
    )
    .run(WS1, 'wecom-u1', ts, ts);
  seedDb
    .prepare(
      `INSERT INTO wecom_workspace_users (workspaceId, encryptedUserId, firstSeenAt, lastSeenAt) VALUES (?, ?, ?, ?)`,
    )
    .run(WS1, 'wecom-u2', ts, ts);

  seedDb
    .prepare(
      `INSERT INTO wecom_user_id_mappings (encryptedUserId, plaintextUserId, createdAt, updatedAt) VALUES (?, ?, ?, ?)`,
    )
    .run('wecom-u2', 'plain-u2', ts, ts);

  seedDb
    .prepare(
      `INSERT INTO wecom_user_sessions (workspaceId, wecomUserId, sessionId, createdAt, updatedAt, isActive) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(WS1, 'wecom-u1', WECOM_SESSION_1, ts, ts, 1);
  seedDb
    .prepare(
      `INSERT INTO wecom_user_sessions (workspaceId, wecomUserId, sessionId, createdAt, updatedAt, isActive) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(WS1, 'wecom-u2', WECOM_SESSION_2, ts, ts, 0);

  seedDb
    .prepare(
      `INSERT INTO sessions (id, workspace_id, name, is_draft, is_wip, is_archived, source, approval_mode, provider_id, bot_id, created_at, updated_at, custom_title)
       VALUES (?, ?, ?, 1, 0, 0, NULL, 'manual', NULL, NULL, ?, ?, NULL)`,
    )
    .run(WECOM_SESSION_1, WS1, 'WeCom Session 1', ts, ts);
  seedDb
    .prepare(
      `INSERT INTO sessions (id, workspace_id, name, is_draft, is_wip, is_archived, source, approval_mode, provider_id, bot_id, created_at, updated_at, custom_title)
       VALUES (?, ?, ?, 1, 0, 0, NULL, 'manual', NULL, NULL, ?, ?, NULL)`,
    )
    .run(WECOM_SESSION_2, WS1, 'WeCom Session 2', ts, ts);
  seedDb
    .prepare(
      `INSERT INTO sessions (id, workspace_id, name, is_draft, is_wip, is_archived, source, approval_mode, provider_id, bot_id, created_at, updated_at, custom_title)
       VALUES (?, ?, ?, 1, 0, 0, NULL, 'manual', NULL, NULL, ?, ?, NULL)`,
    )
    .run(FEISHU_SESSION_1, WS2, 'Feishu Session 1', ts, ts);

  seedDb.prepare(`INSERT INTO feishu_bot_binding (id, activeWorkspaceId) VALUES (1, ?)`).run(WS2);

  seedDb
    .prepare(
      `INSERT INTO feishu_workspace_users (workspaceId, openId, userId, name, firstSeenAt, lastSeenAt) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(WS2, 'feishu-open-1', 'feishu-user-1', 'Feishu Name 1', ts, ts);
  seedDb
    .prepare(
      `INSERT INTO feishu_workspace_users (workspaceId, openId, userId, name, firstSeenAt, lastSeenAt) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(WS2, 'feishu-open-2', null, 'Feishu Name 2', ts, ts);

  seedDb
    .prepare(
      `INSERT INTO feishu_user_sessions (workspaceId, feishuUserId, sessionId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(WS2, 'feishu-open-1', FEISHU_SESSION_1, ts, ts);
  seedDb
    .prepare(
      `INSERT INTO feishu_active_sessions (workspaceId, feishuUserId, sessionId, updatedAt) VALUES (?, ?, ?, ?)`,
    )
    .run(WS2, 'feishu-open-1', FEISHU_SESSION_1, ts);

  seedDb
    .prepare(
      `INSERT INTO wecom_proactive_messages (id, workspace_id, sender_session_id, recipient_encrypted_user_id, recipient_plaintext_user_id, message_content, status, created_at, updated_at, retry_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('pm-1', WS1, WECOM_SESSION_1, 'wecom-u1', 'plain-u1', 'hello', 'pending', ts, ts, 0);

  return { setupStore, seedDb };
}

function triggerMigration(seedDb: Database.Database, dbPath: string): SqliteStore {
  seedDb.prepare(`UPDATE bot_migration_state SET version = 0, run_at = ? WHERE id = 1`).run(now());
  seedDb.close();
  return new SqliteStore(dbPath);
}

describe('unified schema migration', { concurrency: false }, () => {
  let dbDir: string;
  let dbPath: string;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'unified-migration-test-'));
    dbPath = join(dbDir, 'data.db');
  });

  it('rewrites a representative legacy database into the unified schema', () => {
    const { seedDb } = prepareLegacyDb(dbPath);
    const store = triggerMigration(seedDb, dbPath);
    const db = openRawDb(store);

    assert.strictEqual(store.getMigrationVersion(), 11);

    const tables = tableNames(db);
    assert.ok(tables.includes('bot_channels'));
    assert.ok(tables.includes('bot_roles'));
    assert.ok(tables.includes('bot_users'));
    assert.ok(tables.includes('user_sessions'));

    // Legacy mapping/session/workspace-user tables are dropped.
    assert.strictEqual(tables.includes('bot_members'), false);
    assert.strictEqual(tables.includes('wecom_user_sessions'), false);
    assert.strictEqual(tables.includes('wecom_user_id_mappings'), false);
    assert.strictEqual(tables.includes('wecom_workspace_users'), false);
    assert.strictEqual(tables.includes('feishu_user_sessions'), false);
    assert.strictEqual(tables.includes('feishu_active_sessions'), false);
    assert.strictEqual(tables.includes('feishu_workspace_users'), false);
    assert.strictEqual(tables.includes('feishu_bot_binding'), false);

    const bots = store.listBots();
    assert.strictEqual(bots.length, 2);
    const bot1 = bots.find((b) => b.id === BOT1);
    assert.ok(bot1);
    assert.strictEqual(bot1!.activeWorkspaceId, WS1);
    assert.deepStrictEqual(bot1!.persona, { prompt: 'bot persona', mode: 'append' });

    const feishuBot = bots.find((b) => b.id !== BOT1);
    assert.ok(feishuBot);
    assert.strictEqual(feishuBot!.activeWorkspaceId, WS2);

    const bot1Channels = store.listBotChannels(BOT1);
    assert.strictEqual(bot1Channels.length, 2);
    const wecomChannel = bot1Channels.find((c) => c.channelKey === 'wecom');
    const feishuChannel = bot1Channels.find((c) => c.channelKey === 'feishu');
    assert.ok(wecomChannel);
    assert.ok(feishuChannel);

    const decryptedWecom = wecomChannel!.config.wecom;
    assert.strictEqual(decryptedWecom?.botId, 'wb1');
    assert.strictEqual(decryptedWecom?.botSecret, 'wecom-secret');
    const decryptedFeishu = feishuChannel!.config.feishu;
    assert.strictEqual(decryptedFeishu?.appId, 'fa1');
    assert.strictEqual(decryptedFeishu?.appSecret, 'feishu-secret');

    const bot1Roles = store.listBotRoles(BOT1);
    assert.strictEqual(bot1Roles.length, 3);
    const ownerRole = bot1Roles.find((r) => r.roleKey === 'owner');
    assert.ok(ownerRole);
    assert.deepStrictEqual(ownerRole!.persona, { prompt: 'owner persona', mode: 'replace' });

    const allUsers = bots.flatMap((b) => store.listBotUsers(b.id));
    assert.strictEqual(allUsers.length, 5);

    const wecomU2 = store.getBotUserByChannelIdentity(BOT1, wecomChannel!.id, 'wecom-u2');
    assert.ok(wecomU2);
    assert.strictEqual(wecomU2!.plaintextUserId, 'plain-u2');
    assert.strictEqual(wecomU2!.resolutionStatus, 'resolved');

    const wecomU1 = store.getBotUserByChannelIdentity(BOT1, wecomChannel!.id, 'wecom-u1');
    assert.ok(wecomU1);
    assert.strictEqual(wecomU1!.roleKey, 'normal');

    const feishuU1 = store.getBotUserByChannelIdentity(BOT1, feishuChannel!.id, 'feishu-u1');
    assert.ok(feishuU1);
    assert.strictEqual(feishuU1!.roleKey, 'admin');

    const feishuChannel2 = store.listBotChannels(feishuBot!.id).find((c) => c.channelKey === 'feishu');
    assert.ok(feishuChannel2);
    const feishuOpen1 = store.getBotUserByChannelIdentity(feishuBot!.id, feishuChannel2!.id, 'feishu-open-1');
    assert.ok(feishuOpen1);
    assert.strictEqual(feishuOpen1!.plaintextUserId, 'feishu-user-1');
    const feishuOpen2 = store.getBotUserByChannelIdentity(feishuBot!.id, feishuChannel2!.id, 'feishu-open-2');
    assert.ok(feishuOpen2);
    assert.strictEqual(feishuOpen2!.plaintextUserId, 'Feishu Name 2');

    const sessions = db
      .prepare('SELECT id, source FROM sessions WHERE id IN (?, ?, ?)')
      .all(WECOM_SESSION_1, WECOM_SESSION_2, FEISHU_SESSION_1) as Array<{ id: string; source: string | null }>;
    assert.strictEqual(sessions.length, 3);
    assert.ok(sessions.every((s) => s.source !== null));
    assert.ok(sessions.filter((s) => s.id.startsWith('wecom')).every((s) => s.source === 'wecom'));
    assert.strictEqual(sessions.find((s) => s.id === FEISHU_SESSION_1)!.source, 'feishu');

    const userSessions = db.prepare('SELECT COUNT(*) as count FROM user_sessions').get() as { count: number };
    assert.strictEqual(userSessions.count, 3);

    assert.strictEqual(store.getActiveUserSession(wecomU1!.id), WECOM_SESSION_1);
    assert.strictEqual(store.getActiveUserSession(wecomU2!.id), WECOM_SESSION_2);
    assert.strictEqual(store.getActiveUserSession(feishuOpen1!.id), FEISHU_SESSION_1);

    const pm = db
      .prepare('SELECT bot_id, channel_id FROM wecom_proactive_messages WHERE id = ?')
      .get('pm-1') as { bot_id: string; channel_id: string };
    assert.strictEqual(pm.bot_id, BOT1);
    assert.strictEqual(pm.channel_id, wecomChannel!.id);

    const snapshot = db.prepare('SELECT snapshot_json FROM bot_migration_state WHERE id = 1').get() as {
      snapshot_json: string;
    };
    const snapshotData = JSON.parse(snapshot.snapshot_json) as {
      botUsersCount: number;
      userSessionsCount: number;
      sourceCounts: Record<string, number>;
    };
    assert.strictEqual(snapshotData.botUsersCount, 5);
    assert.strictEqual(snapshotData.userSessionsCount, 3);
    assert.strictEqual(snapshotData.sourceCounts.bot_members, 2);
    assert.strictEqual(snapshotData.sourceCounts.wecom_workspace_users, 2);
    assert.strictEqual(snapshotData.sourceCounts.feishu_workspace_users, 2);
  });

  it('is idempotent: a second store construction skips migration and leaves data intact', () => {
    const { seedDb } = prepareLegacyDb(dbPath);
    const firstStore = triggerMigration(seedDb, dbPath);

    const secondStore = new SqliteStore(dbPath);
    assert.strictEqual(secondStore.getMigrationVersion(), 11);

    const db = openRawDb(secondStore);
    assert.strictEqual(tableNames(db).includes('bot_members'), false);
    assert.strictEqual((db.prepare('SELECT COUNT(*) as count FROM user_sessions').get() as { count: number }).count, 3);
    assert.strictEqual(
      (db.prepare('SELECT COUNT(*) as count FROM bot_users').get() as { count: number }).count,
      5,
    );

    // Original bot and the implicit Feishu bot are both preserved.
    assert.strictEqual(firstStore.listBots().length, 2);
    assert.strictEqual(secondStore.listBots().length, 2);
  });

  it('handles multi-active feishu/wecom sessions and skipped sessions without aborting', () => {
    // Reproduces the dev-database failure: a feishu user with feishu_active_sessions
    // rows in multiple workspaces maps to ONE bot_user, so promoting each "active"
    // row used to violate idx_user_sessions_active_per_user (UNIQUE constraint).
    // Also covers a wecom user with two isActive=1 source sessions (silent loss via
    // INSERT OR IGNORE) and a "ghost" wecom session whose user has no workspace_user
    // row (legitimately skipped — must NOT trip the count verification).
    const { seedDb } = prepareLegacyDb(dbPath);
    const ts = now();

    // BOT1 owns WS1 and has a wecom channel + wecom bot_user 'wecom-u1'.
    // Give wecom-u1 a SECOND active session in the same workspace (same bot_user).
    seedDb
      .prepare(
        `INSERT INTO sessions (id, workspace_id, name, is_draft, is_wip, is_archived, source, approval_mode, provider_id, bot_id, created_at, updated_at, custom_title)
         VALUES (?, ?, ?, 1, 0, 0, NULL, 'manual', NULL, NULL, ?, ?, NULL)`,
      )
      .run('wecom-session-3', WS1, 'WeCom Session 3', ts, ts);
    seedDb
      .prepare(
        `INSERT INTO wecom_user_sessions (workspaceId, wecomUserId, sessionId, createdAt, updatedAt, isActive) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(WS1, 'wecom-u1', 'wecom-session-3', ts, ts, 1);

    // A "ghost" wecom session: its user has no wecom_workspace_users row, so no
    // bot_user is created and the session is legitimately skipped during populate.
    seedDb
      .prepare(
        `INSERT INTO sessions (id, workspace_id, name, is_draft, is_wip, is_archived, source, approval_mode, provider_id, bot_id, created_at, updated_at, custom_title)
         VALUES (?, ?, ?, 1, 0, 0, NULL, 'manual', NULL, NULL, ?, ?, NULL)`,
      )
      .run('wecom-ghost-session', WS1, 'WeCom Ghost', ts, ts);
    seedDb
      .prepare(
        `INSERT INTO wecom_user_sessions (workspaceId, wecomUserId, sessionId, createdAt, updatedAt, isActive) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(WS1, 'wecom-ghost', 'wecom-ghost-session', ts, ts, 0);

    // feishu-open-1 already has one feishu_active_session in WS2. Add a second
    // feishu session + active marker in WS1 so the SAME bot_user ends up with two
    // active sessions (the failure mode).
    seedDb
      .prepare(
        `INSERT INTO sessions (id, workspace_id, name, is_draft, is_wip, is_archived, source, approval_mode, provider_id, bot_id, created_at, updated_at, custom_title)
         VALUES (?, ?, ?, 1, 0, 0, NULL, 'manual', NULL, NULL, ?, ?, NULL)`,
      )
      .run('feishu-session-2', WS1, 'Feishu Session 2', ts, ts);
    seedDb
      .prepare(
        `INSERT INTO feishu_user_sessions (workspaceId, feishuUserId, sessionId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(WS1, 'feishu-open-1', 'feishu-session-2', ts, ts);
    seedDb
      .prepare(
        `INSERT INTO feishu_active_sessions (workspaceId, feishuUserId, sessionId, updatedAt) VALUES (?, ?, ?, ?)`,
      )
      .run(WS1, 'feishu-open-1', 'feishu-session-2', ts);

    seedDb.prepare(`UPDATE bot_migration_state SET version = 0, run_at = ? WHERE id = 1`).run(ts);
    seedDb.close();

    // Must not throw (previously: UNIQUE constraint failed: user_sessions.user_id).
    const store = new SqliteStore(dbPath);
    assert.strictEqual(store.getMigrationVersion(), 11);
    const db = openRawDb(store);

    // No row was lost to the multi-active collisions: wecom-u1 has 2 sessions,
    // feishu-open-1 has 2 sessions, plus wecom-u2 (1) = 5 user_sessions total.
    // The ghost session is legitimately skipped (not counted).
    const userSessionsCount = (db.prepare('SELECT COUNT(*) as count FROM user_sessions').get() as { count: number }).count;
    assert.strictEqual(userSessionsCount, 5);

    // Exactly one active session per bot_user (the per-user active invariant).
    const wecomChannel = store.listBotChannels(BOT1).find((c) => c.channelKey === 'wecom')!;
    const wecomU1 = store.getBotUserByChannelIdentity(BOT1, wecomChannel.id, 'wecom-u1')!;
    const activeForWecomU1 = (
      db.prepare('SELECT COUNT(*) as count FROM user_sessions WHERE user_id = ? AND is_active = 1').get(wecomU1.id) as {
        count: number;
      }
    ).count;
    assert.strictEqual(activeForWecomU1, 1);

    const feishuBot = store.listBots().find((b) => b.id !== BOT1)!;
    const feishuChannel = store.listBotChannels(feishuBot.id).find((c) => c.channelKey === 'feishu')!;
    const feishuOpen1 = store.getBotUserByChannelIdentity(feishuBot.id, feishuChannel.id, 'feishu-open-1')!;
    const activeForFeishuOpen1 = (
      db.prepare('SELECT COUNT(*) as count FROM user_sessions WHERE user_id = ? AND is_active = 1').get(feishuOpen1.id) as {
        count: number;
      }
    ).count;
    assert.strictEqual(activeForFeishuOpen1, 1);

    // The ghost session was skipped (no bot_user), and the count verification did
    // NOT abort despite the raw source count being higher.
    const ghostPresent = (
      db
        .prepare('SELECT COUNT(*) as count FROM user_sessions WHERE session_id = ?')
        .get('wecom-ghost-session') as { count: number }
    ).count;
    assert.strictEqual(ghostPresent, 0);
  });

  it('aborts and leaves old tables when bot_users count verification fails', () => {
    const { seedDb } = prepareLegacyDb(dbPath);
    const ts = now();
    // Insert a bot_members row with a channel that exists but a role that does
    // not. The migration skips it (no matching role row), but verification still
    // expects it, so bot_users count will be lower than expected and the
    // migration must abort before dropping old tables.
    seedDb
      .prepare(
        `INSERT INTO bot_members (bot_id, channel, channel_user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(BOT1, 'wecom', 'wecom-missing-role', 'unknown_role', ts, ts);
    seedDb.prepare(`UPDATE bot_migration_state SET version = 0, run_at = ? WHERE id = 1`).run(ts);
    seedDb.close();

    assert.throws(
      () => new SqliteStore(dbPath),
      /Migration count verification failed: bot_users \(\d+\) < expected \(\d+\)/,
    );

    const db = new Database(dbPath);
    // Old tables must still be present because the migration aborted.
    assert.strictEqual(tableNames(db).includes('bot_members'), true);
    assert.strictEqual(tableNames(db).includes('wecom_workspace_users'), true);
    // Version must not have been bumped.
    const version = (db.prepare('SELECT version FROM bot_migration_state WHERE id = 1').get() as { version: number }).version;
    assert.strictEqual(version, 0);
    db.close();
  });
});

function seedOldTodosDb(
  dbPath: string,
  rows: Array<{
    id: string;
    workspace_id: string;
    text: string;
    status: string;
    session_id: string | null;
    created_at: string;
    updated_at: string;
  }>,
): Database.Database {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE bot_migration_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      run_at TEXT NOT NULL,
      snapshot_json TEXT NOT NULL DEFAULT '{}'
    )
  `);
  db.exec(`
    CREATE TABLE todos (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      session_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  const insert = db.prepare(
    'INSERT INTO todos (id, workspace_id, text, status, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const r of rows) {
    insert.run(r.id, r.workspace_id, r.text, r.status, r.session_id, r.created_at, r.updated_at);
  }
  db.prepare("INSERT INTO bot_migration_state (id, version, run_at, snapshot_json) VALUES (1, 6, ?, '{}')").run(now());
  return db;
}

function todoColumns(db: Database.Database): Array<{ name: string; notnull: number }> {
  return db.prepare('PRAGMA table_info(todos)').all() as Array<{ name: string; notnull: number }>;
}

describe('todos global schema migration (v8)', { concurrency: false }, () => {
  let dbDir: string;
  let dbPath: string;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'todos-global-migration-'));
    dbPath = join(dbDir, 'data.db');
  });

  it('migrates an old-shape todos table to the global schema non-lossy (covers AE6)', () => {
    const ts = now();
    const seedDb = seedOldTodosDb(dbPath, [
      { id: 't1', workspace_id: 'ws-a', text: 'plain todo', status: 'pending', session_id: null, created_at: ts, updated_at: ts },
      { id: 't2', workspace_id: 'ws-a', text: 'session-linked', status: 'done', session_id: 'sess-1', created_at: ts, updated_at: ts },
      { id: 't3', workspace_id: 'ws-b', text: '多字节 unicode 文本', status: 'did-but-need-verify', session_id: null, created_at: ts, updated_at: ts },
    ]);
    seedDb.close();

    const store = new SqliteStore(dbPath);
    assert.strictEqual(store.getMigrationVersion(), 11);

    const db = openRawDb(store);
    const cols = todoColumns(db);
    const workspaceIdCol = cols.find((c) => c.name === 'workspace_id');
    assert.ok(workspaceIdCol);
    assert.strictEqual(workspaceIdCol!.notnull, 0, 'workspace_id is nullable');
    for (const name of ['origin', 'due_date', 'repo_full_name', 'issue_number', 'remote_snapshot_json', 'labels_json', 'origin_deleted']) {
      assert.ok(cols.some((c) => c.name === name), `${name} column present`);
    }
    assert.strictEqual((db.prepare('SELECT COUNT(*) AS c FROM todos').get() as { c: number }).c, 3);
    assert.strictEqual((db.prepare("SELECT COUNT(*) AS c FROM todos WHERE workspace_id IS NULL").get() as { c: number }).c, 0, 'no legacy row lost its workspace soft-link');

    const t3 = store.getTodoById('t3');
    assert.ok(t3);
    assert.strictEqual(t3!.text, '多字节 unicode 文本');
    assert.strictEqual(t3!.status, 'pending');
    assert.strictEqual(t3!.workspaceId, 'ws-b');
    assert.strictEqual(t3!.origin, 'local');
    assert.deepStrictEqual(t3!.labels, []);
    assert.strictEqual(t3!.originDeleted, false);
  });

  it('a fresh db lands on the new shape without a rebuild (shape-keyed gate)', () => {
    const store = new SqliteStore(dbPath); // file does not exist yet -> fresh construction
    assert.strictEqual(store.getMigrationVersion(), 11);
    const db = openRawDb(store);
    const cols = todoColumns(db);
    assert.strictEqual(cols.find((c) => c.name === 'workspace_id')!.notnull, 0);
    assert.ok(cols.some((c) => c.name === 'origin'));
    const todo = store.createTodo(null, { text: 'global todo' });
    assert.strictEqual(todo.workspaceId, null);
    assert.strictEqual(store.getAllTodos().length, 1);
  });

  it('is idempotent: a second construction leaves new rows intact and the version at 11', () => {
    const ts = now();
    const seedDb = seedOldTodosDb(dbPath, [
      { id: 't1', workspace_id: 'ws-a', text: 'legacy', status: 'pending', session_id: null, created_at: ts, updated_at: ts },
    ]);
    seedDb.close();
    const first = new SqliteStore(dbPath);
    first.createTodo(null, { text: 'new global todo' });
    const second = new SqliteStore(dbPath);
    assert.strictEqual(second.getMigrationVersion(), 11);
    const all = second.getAllTodos();
    assert.strictEqual(all.length, 2);
    assert.ok(all.some((t) => t.text === 'new global todo' && t.workspaceId === null));
  });

  it('rolls back atomically when the rebuild cannot complete', () => {
    const ts = now();
    const seedDb = seedOldTodosDb(dbPath, [
      { id: 't1', workspace_id: 'ws-a', text: 'keep me', status: 'pending', session_id: null, created_at: ts, updated_at: ts },
    ]);
    // Pre-create todos_old so the in-transaction RENAME fails -> rollback.
    seedDb.exec('CREATE TABLE todos_old (id TEXT)');
    seedDb.close();

    assert.throws(() => new SqliteStore(dbPath));
    const db = new Database(dbPath);
    const cols = todoColumns(db);
    assert.strictEqual(cols.find((c) => c.name === 'workspace_id')!.notnull, 1, 'workspace_id still NOT NULL (unchanged old shape)');
    assert.ok(!cols.some((c) => c.name === 'origin'), 'origin not added (rollback)');
    assert.strictEqual((db.prepare('SELECT COUNT(*) AS c FROM todos').get() as { c: number }).c, 1);
    assert.strictEqual(
      (db.prepare('SELECT version FROM bot_migration_state WHERE id = 1').get() as { version: number }).version,
      6,
    );
    db.close();
  });

  it('creates repo_sync_state and the linked-issue unique index', () => {
    const store = new SqliteStore(dbPath);
    const db = openRawDb(store);
    assert.strictEqual(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='repo_sync_state'").all() as unknown[]).length,
      1,
    );
    assert.strictEqual(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='todos' AND name='idx_todos_repo_issue'").all() as unknown[]).length,
      1,
    );
    db.close();
  });
});

/**
 * Seed a v7-shape todos table (global schema, version already at 7) that
 * predates the `content` column. Opening it with SqliteStore must add the
 * nullable `content` column additively without touching existing rows.
 */
function seedV7TodosWithoutContent(
  dbPath: string,
  rows: Array<{
    id: string;
    workspace_id: string | null;
    text: string;
    status: string;
    created_at: string;
    updated_at: string;
  }>,
): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE bot_migration_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      run_at TEXT NOT NULL,
      snapshot_json TEXT NOT NULL DEFAULT '{}'
    )
  `);
  // Version already at 7 so migrateTodosGlobalSchema short-circuits; the table
  // is the global shape but WITHOUT the new content column.
  db.exec(`
    CREATE TABLE todos (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      session_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'local',
      due_date TEXT,
      repo_full_name TEXT,
      issue_number INTEGER,
      remote_snapshot_json TEXT,
      remote_updated_at TEXT,
      last_synced_at TEXT,
      assignee TEXT,
      labels_json TEXT NOT NULL DEFAULT '[]',
      origin_deleted INTEGER NOT NULL DEFAULT 0
    )
  `);
  const insert = db.prepare(
    'INSERT INTO todos (id, workspace_id, text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const r of rows) {
    insert.run(r.id, r.workspace_id, r.text, r.status, r.created_at, r.updated_at);
  }
  db.prepare("INSERT INTO bot_migration_state (id, version, run_at, snapshot_json) VALUES (1, 7, ?, '{}')").run(now());
  db.close();
}

describe('todos content column migration (additive ADD COLUMN)', { concurrency: false }, () => {
  let dbDir: string;
  let dbPath: string;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'todos-content-migration-'));
    dbPath = join(dbDir, 'data.db');
  });

  it('a fresh db has the content column from creation', () => {
    const store = new SqliteStore(dbPath);
    const db = openRawDb(store);
    const cols = todoColumns(db);
    const contentCol = cols.find((c) => c.name === 'content');
    assert.ok(contentCol, 'content column present on a fresh db');
    assert.strictEqual(contentCol!.notnull, 0, 'content is nullable');
    db.close();
  });

  it('adds the content column to a v7-shape db that predates it', () => {
    const ts = now();
    seedV7TodosWithoutContent(dbPath, [
      { id: 't1', workspace_id: null, text: 'legacy v7 todo', status: 'pending', created_at: ts, updated_at: ts },
    ]);

    // Before: no content column.
    const before = new Database(dbPath);
    assert.ok(!todoColumns(before).some((c) => c.name === 'content'));
    before.close();

    // Open through SqliteStore — additive ADD COLUMN runs.
    const store = new SqliteStore(dbPath);
    const db = openRawDb(store);
    const cols = todoColumns(db);
    const contentCol = cols.find((c) => c.name === 'content');
    assert.ok(contentCol, 'content column added by migration');
    assert.strictEqual(contentCol!.notnull, 0, 'content is nullable');
    // Existing row is untouched and reads back with null content.
    assert.strictEqual((db.prepare('SELECT COUNT(*) AS c FROM todos').get() as { c: number }).c, 1);
    const todo = store.getTodoById('t1');
    assert.ok(todo);
    assert.strictEqual(todo!.text, 'legacy v7 todo');
    assert.strictEqual(todo!.content, null);
    db.close();
  });

  it('is idempotent: a second construction leaves content intact', () => {
    const store = new SqliteStore(dbPath);
    const created = store.createTodo(null, { text: 'with body', content: 'persisted body' });
    const second = new SqliteStore(dbPath);
    const fetched = second.getTodoById(created.id);
    assert.ok(fetched);
    assert.strictEqual(fetched!.content, 'persisted body');
    openRawDb(second).close();
  });
});

// ---------------------------------------------------------------------------
// last_turn_started_at (activity sort position stability, U1 / KTD1 / KTD4):
// an additive INTEGER epoch-ms ordering key on sessions and workspaces plus an
// unconditional, NULL-guarded, transaction-wrapped backfill at the end of the
// constructor migration chain, so every successful construction converges to
// zero NULL keys.
// ---------------------------------------------------------------------------

const ACT_T1 = '2025-08-10T10:00:00.000Z';
const ACT_T2 = '2025-08-12T12:30:45.678Z'; // carries milliseconds — unixepoch() floors them
const ACT_T3 = '2025-08-14T09:15:30.000Z';
const ACT_T4 = '2025-08-16T18:45:30.000Z';
const ACT_LM_BIG = 1_755_500_000_123; // ~2025-08-18, exact-ms last_modified
const ACT_LM_OLD = 1_754_900_000_000; // ~2025-08-11

const ACT_WS1 = 'ws-act-1';
const ACT_WS2 = 'ws-act-2'; // deliberately zero sessions

/** unixepoch() floors to whole seconds — the expected value for text-derived keys. */
function floorToSecondMs(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000) * 1000;
}

interface ActivitySessionSeed {
  id: string;
  workspaceId: string;
  lastModified?: number | null;
  updatedAt: string;
  createdAt: string;
}

interface ActivityFixtureSpec {
  workspaces: Array<{ id: string; createdAt: string; updatedAt: string }>;
  sessions: ActivitySessionSeed[];
}

/**
 * Build a pre-upgrade database on disk: the current sessions/workspaces shape
 * WITHOUT last_turn_started_at, version already at 11 so every version-gated
 * migration short-circuits and only the additive column guards and the
 * backfill run when SqliteStore opens it.
 */
function seedPreUpgradeActivityDb(dbPath: string, spec: ActivityFixtureSpec): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE bot_migration_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      run_at TEXT NOT NULL,
      snapshot_json TEXT NOT NULL DEFAULT '{}'
    )
  `);
  db.prepare("INSERT INTO bot_migration_state (id, version, run_at, snapshot_json) VALUES (1, 11, ?, '{}')").run(now());
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      folderPath TEXT NOT NULL,
      settings TEXT NOT NULL DEFAULT '{}',
      skills TEXT NOT NULL DEFAULT '[]',
      mcpServers TEXT NOT NULL DEFAULT '[]',
      hooks TEXT NOT NULL DEFAULT '[]',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      lastOpenedAt TEXT
    )
  `);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      is_draft INTEGER NOT NULL DEFAULT 1,
      is_wip INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      source TEXT,
      approval_mode TEXT,
      fast_mode INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      summary TEXT,
      last_modified INTEGER,
      first_prompt TEXT,
      git_branch TEXT,
      custom_title TEXT,
      bot_id TEXT,
      provider_id TEXT,
      backend TEXT,
      backend_session_id TEXT
    )
  `);
  const insertWorkspace = db.prepare(
    `INSERT INTO workspaces (id, name, description, folderPath, settings, skills, mcpServers, hooks, createdAt, updatedAt, lastOpenedAt)
     VALUES (?, ?, '', ?, '{}', '[]', '[]', '[]', ?, ?, NULL)`,
  );
  for (const ws of spec.workspaces) {
    insertWorkspace.run(ws.id, `WS ${ws.id}`, `/tmp/${ws.id}`, ws.createdAt, ws.updatedAt);
  }
  const insertSession = db.prepare(
    `INSERT INTO sessions (id, workspace_id, name, is_draft, is_wip, is_archived, source, approval_mode, fast_mode, created_at, updated_at, summary, last_modified, first_prompt, git_branch, custom_title, bot_id, provider_id, backend, backend_session_id)
     VALUES (?, ?, ?, 0, 0, 0, NULL, 'manual', 0, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
  );
  for (const s of spec.sessions) {
    insertSession.run(s.id, s.workspaceId, `Session ${s.id}`, s.createdAt, s.updatedAt, s.lastModified ?? null);
  }
  db.close();
}

function hasTurnKeyColumn(db: Database.Database, table: 'sessions' | 'workspaces'): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
    (col) => col.name === 'last_turn_started_at',
  );
}

function nullKeyCount(db: Database.Database, table: 'sessions' | 'workspaces'): number {
  return (
    db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE last_turn_started_at IS NULL`).get() as { c: number }
  ).c;
}

function turnKeyOf(db: Database.Database, table: 'sessions' | 'workspaces', id: string): number | null {
  const row = db.prepare(`SELECT last_turn_started_at AS k FROM ${table} WHERE id = ?`).get(id) as
    | { k: number | null }
    | undefined;
  return row ? row.k : null;
}

function allTurnKeys(db: Database.Database, table: 'sessions' | 'workspaces'): Record<string, number | null> {
  const rows = db.prepare(`SELECT id, last_turn_started_at AS k FROM ${table} ORDER BY id`).all() as Array<{
    id: string;
    k: number | null;
  }>;
  const out: Record<string, number | null> = {};
  for (const row of rows) out[row.id] = row.k;
  return out;
}

/** The populated pre-upgrade fixture shared by the acceptance tests below. */
function seedActivityFixture(dbPath: string): void {
  seedPreUpgradeActivityDb(dbPath, {
    workspaces: [
      { id: ACT_WS1, createdAt: ACT_T1, updatedAt: ACT_T1 },
      { id: ACT_WS2, createdAt: ACT_T4, updatedAt: ACT_T4 },
    ],
    sessions: [
      // last_modified present: the key must be exactly that value.
      { id: 's-exact', workspaceId: ACT_WS1, lastModified: ACT_LM_BIG, updatedAt: ACT_T4, createdAt: ACT_T1 },
      // No last_modified: the key derives from updated_at (floored to seconds).
      { id: 's-updated', workspaceId: ACT_WS1, lastModified: null, updatedAt: ACT_T2, createdAt: ACT_T1 },
      // Malformed updated_at: falls through to created_at.
      { id: 's-created', workspaceId: ACT_WS1, lastModified: null, updatedAt: 'not-a-date', createdAt: ACT_T3 },
      // Everything malformed: the terminal 0 fallback, never NULL.
      { id: 's-fallback', workspaceId: ACT_WS1, lastModified: null, updatedAt: '', createdAt: 'garbage' },
      // last_modified older than its own updated_at: last_modified wins (mirrors the old comparator).
      { id: 's-lm-old', workspaceId: ACT_WS1, lastModified: ACT_LM_OLD, updatedAt: ACT_T4, createdAt: ACT_T1 },
    ],
  });
}

describe('last_turn_started_at schema and backfill (U1)', { concurrency: false }, () => {
  let dbDir: string;
  let dbPath: string;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'turn-key-migration-'));
    dbPath = join(dbDir, 'data.db');
  });

  it('adds the column to a populated pre-upgrade database and backfills every row in epoch-ms scale', () => {
    seedActivityFixture(dbPath);
    const before = new Database(dbPath, { readonly: true });
    assert.strictEqual(hasTurnKeyColumn(before, 'sessions'), false, 'fixture starts without the sessions column');
    assert.strictEqual(hasTurnKeyColumn(before, 'workspaces'), false, 'fixture starts without the workspaces column');
    before.close();

    const store = new SqliteStore(dbPath);
    const db = openRawDb(store);
    assert.strictEqual(hasTurnKeyColumn(db, 'sessions'), true);
    assert.strictEqual(hasTurnKeyColumn(db, 'workspaces'), true);
    assert.strictEqual(nullKeyCount(db, 'sessions'), 0, 'every session has a key after construction');
    assert.strictEqual(nullKeyCount(db, 'workspaces'), 0, 'every workspace has a key after construction');

    // Magnitude check: 2025 epoch-ms keys are ~1.75e12; a seconds/milliseconds
    // mix-up would land near 1.75e9. Only the terminal fallback may be 0.
    const keys = allTurnKeys(db, 'sessions');
    for (const [id, key] of Object.entries(keys)) {
      if (id === 's-fallback') {
        assert.strictEqual(key, 0, 'malformed row lands on the terminal fallback');
      } else {
        assert.ok(key !== null && key >= 1e12, `${id} key ${key} is epoch-ms scale`);
      }
    }
    for (const [id, key] of Object.entries(allTurnKeys(db, 'workspaces'))) {
      assert.ok(key !== null && key >= 1e12, `${id} key ${key} is epoch-ms scale`);
    }
    db.close();
  });

  it('reproduces the pre-upgrade comparator order (lastModified ?? Date.parse(updatedAt))', () => {
    seedActivityFixture(dbPath);
    const store = new SqliteStore(dbPath);
    const db = openRawDb(store);

    // Only rows whose comparator key is defined participate; malformed rows are
    // covered by the fallback test, and sub-second ties are the accepted
    // flooring divergence (excluded here — fixture values are distinct).
    const comparable = ['s-exact', 's-updated', 's-lm-old'];
    const seeds: Record<string, { lastModified: number | null; updatedAt: string; createdAt: string }> = {
      's-exact': { lastModified: ACT_LM_BIG, updatedAt: ACT_T4, createdAt: ACT_T1 },
      's-updated': { lastModified: null, updatedAt: ACT_T2, createdAt: ACT_T1 },
      's-lm-old': { lastModified: ACT_LM_OLD, updatedAt: ACT_T4, createdAt: ACT_T1 },
    };
    const comparatorKey = (id: string) => seeds[id].lastModified ?? (Date.parse(seeds[id].updatedAt) || 0);
    const expectedOrder = [...comparable].sort((a, b) => {
      const ka = comparatorKey(a);
      const kb = comparatorKey(b);
      if (ka !== kb) return kb - ka;
      const ca = Date.parse(seeds[a].createdAt) || 0;
      const cb = Date.parse(seeds[b].createdAt) || 0;
      if (ca !== cb) return cb - ca;
      return a.localeCompare(b);
    });

    const actualOrder = [...comparable].sort((a, b) => turnKeyOf(db, 'sessions', b)! - turnKeyOf(db, 'sessions', a)!);
    assert.deepStrictEqual(actualOrder, expectedOrder);
    // Sanity: the fixture actually exercises both comparator branches.
    assert.ok(seeds['s-updated'].lastModified === null);
    assert.ok(comparatorKey('s-lm-old') < comparatorKey('s-updated'), 'last_modified beats a newer updated_at');
    db.close();
  });

  it('backfills each workspace from the max of its sessions keys and zero-session workspaces from createdAt', () => {
    seedActivityFixture(dbPath);
    const store = new SqliteStore(dbPath);
    const db = openRawDb(store);

    assert.strictEqual(turnKeyOf(db, 'workspaces', ACT_WS1), ACT_LM_BIG, 'workspace takes the max session key');
    assert.strictEqual(
      turnKeyOf(db, 'workspaces', ACT_WS2),
      floorToSecondMs(ACT_T4),
      'zero-session workspace falls back to its own createdAt',
    );
    db.close();
  });

  it('gives exact last_modified, falls back through updated_at and created_at, never leaves NULL', () => {
    seedActivityFixture(dbPath);
    const store = new SqliteStore(dbPath);
    const db = openRawDb(store);

    assert.strictEqual(turnKeyOf(db, 'sessions', 's-exact'), ACT_LM_BIG, 'last_modified is used verbatim');
    assert.strictEqual(turnKeyOf(db, 'sessions', 's-updated'), floorToSecondMs(ACT_T2), 'updated_at fallback');
    assert.strictEqual(turnKeyOf(db, 'sessions', 's-created'), floorToSecondMs(ACT_T3), 'created_at fallback');
    assert.strictEqual(turnKeyOf(db, 'sessions', 's-fallback'), 0, 'terminal fallback for malformed rows');
    db.close();
  });

  it('heals an all-NULL database on reopen and stays stable across a third construction', async () => {
    const first = new SqliteStore(dbPath);
    const ws = await first.create({ name: 'W', folderPath: '/tmp/turn-key-heal' });
    const s1 = first.createLocalSession(ws.id, 'one');
    const s2 = first.createLocalSession(ws.id, 'two');
    first.close();

    // Simulate the interrupted first run: the column exists but every key is NULL.
    const raw = new Database(dbPath);
    raw.prepare('UPDATE sessions SET last_turn_started_at = NULL').run();
    raw.prepare('UPDATE workspaces SET last_turn_started_at = NULL').run();
    raw.close();

    const second = new SqliteStore(dbPath);
    const db2 = openRawDb(second);
    assert.strictEqual(nullKeyCount(db2, 'sessions'), 0, 'reopen heals session keys');
    assert.strictEqual(nullKeyCount(db2, 'workspaces'), 0, 'reopen heals workspace keys');

    // Local sessions carry no last_modified, so healing derives from updated_at.
    const s1Key = turnKeyOf(db2, 'sessions', s1.id);
    const s2Key = turnKeyOf(db2, 'sessions', s2.id);
    assert.strictEqual(s1Key, floorToSecondMs(s1.updatedAt));
    assert.strictEqual(s2Key, floorToSecondMs(s2.updatedAt));
    assert.strictEqual(turnKeyOf(db2, 'workspaces', ws.id), Math.max(s1Key!, s2Key!));

    const healed = { sessions: allTurnKeys(db2, 'sessions'), workspaces: allTurnKeys(db2, 'workspaces') };
    second.close();

    const third = new SqliteStore(dbPath);
    const db3 = openRawDb(third);
    assert.deepStrictEqual(
      { sessions: allTurnKeys(db3, 'sessions'), workspaces: allTurnKeys(db3, 'workspaces') },
      healed,
      'double construction changes no keys',
    );
    third.close();
  });

  it('computes workspace maxima from raw session columns even when some sessions are already backfilled', async () => {
    const first = new SqliteStore(dbPath);
    const ws = await first.create({ name: 'W', folderPath: '/tmp/turn-key-partial' });
    const s1 = first.createLocalSession(ws.id, 'one');
    const s2 = first.createLocalSession(ws.id, 'two');
    first.close();

    // Partial state: one session already keyed (to a sentinel far above any
    // derivable value), the rest NULL, and the workspace key NULL.
    const SENTINEL = 9_999_999_999_999;
    const raw = new Database(dbPath);
    raw.prepare('UPDATE sessions SET last_turn_started_at = ? WHERE id = ?').run(SENTINEL, s1.id);
    raw.prepare('UPDATE sessions SET last_turn_started_at = NULL WHERE id = ?').run(s2.id);
    raw.prepare('UPDATE workspaces SET last_turn_started_at = NULL').run();
    raw.close();

    const second = new SqliteStore(dbPath);
    const db2 = openRawDb(second);
    assert.strictEqual(turnKeyOf(db2, 'sessions', s1.id), SENTINEL, 'NULL-guard keeps existing keys untouched');
    assert.strictEqual(turnKeyOf(db2, 'sessions', s2.id), floorToSecondMs(s2.updatedAt), 'NULL session healed');
    // The workspace max is computed from the raw session columns — the sentinel
    // stored in s1.last_turn_started_at must NOT leak into it.
    const expectedWsKey = Math.max(floorToSecondMs(s1.updatedAt), floorToSecondMs(s2.updatedAt));
    assert.strictEqual(turnKeyOf(db2, 'workspaces', ws.id), expectedWsKey);
    second.close();
  });

  it('heals rows inserted by the legacy JSON migrations (workspaces.json + draft-sessions.json)', () => {
    const dataDir = process.env.COMATE_DATA_DIR!;
    const wsId = 'ws-legacy-json';
    writeFileSync(
      join(dataDir, 'workspaces.json'),
      JSON.stringify({
        workspaces: [
          {
            id: wsId,
            name: 'Legacy JSON Workspace',
            description: '',
            folderPath: '/tmp/legacy-json-ws',
            settings: {},
            skills: [],
            mcpServers: [],
            hooks: [],
            createdAt: ACT_T1,
            updatedAt: ACT_T1,
            lastOpenedAt: null,
          },
        ],
        sessions: [],
      }),
    );
    writeFileSync(
      join(dataDir, 'draft-sessions.json'),
      JSON.stringify({
        sessions: [
          {
            id: 'draft-with-lm',
            workspaceId: wsId,
            name: 'Draft with lastModified',
            isDraft: true,
            createdAt: ACT_T1,
            updatedAt: ACT_T2,
            lastModified: ACT_LM_BIG,
          },
          {
            id: 'draft-no-lm',
            workspaceId: wsId,
            name: 'Draft without lastModified',
            isDraft: true,
            createdAt: ACT_T1,
            updatedAt: ACT_T2,
          },
        ],
      }),
    );

    const store = new SqliteStore(dbPath);
    const db = openRawDb(store);
    assert.strictEqual(nullKeyCount(db, 'workspaces'), 0, 'legacy-migrated workspace healed');
    assert.strictEqual(nullKeyCount(db, 'sessions'), 0, 'legacy-migrated draft sessions healed');
    assert.strictEqual(turnKeyOf(db, 'sessions', 'draft-with-lm'), ACT_LM_BIG);
    assert.strictEqual(turnKeyOf(db, 'sessions', 'draft-no-lm'), floorToSecondMs(ACT_T2));
    assert.strictEqual(
      turnKeyOf(db, 'workspaces', wsId),
      ACT_LM_BIG,
      'workspace key is the max over its sessions raw columns',
    );
    db.close();
  });

  it('downgrade round-trip: old-shape parsers and writers neither error nor lose data', () => {
    seedActivityFixture(dbPath);
    const store = new SqliteStore(dbPath);
    const db = openRawDb(store);

    // A downgraded binary reads SELECT * rows with a parser that does not know
    // the new column; the extra value is simply ignored.
    interface LegacySessionRow {
      id: string;
      workspace_id: string;
      name: string;
      created_at: string;
      updated_at: string;
      last_modified: number | null;
    }
    const legacyParse = (row: LegacySessionRow) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastModified: row.last_modified ?? undefined,
    });
    const rows = db.prepare('SELECT * FROM sessions ORDER BY id').all() as LegacySessionRow[];
    assert.strictEqual(rows.length, 5);
    const parsed = rows.map(legacyParse);
    const parsedExact = parsed.find((p) => p.id === 's-exact')!;
    assert.strictEqual(parsedExact.lastModified, ACT_LM_BIG);
    assert.strictEqual(parsedExact.name, 'Session s-exact');

    // ...and rewrites a row with an explicit column list, which must not touch
    // the key or lose any field.
    const keyBefore = turnKeyOf(db, 'sessions', 's-exact');
    db.prepare('UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?').run('Renamed by old binary', ACT_T3, 's-exact');
    const rewritten = db.prepare('SELECT * FROM sessions WHERE id = ?').get('s-exact') as LegacySessionRow & {
      last_turn_started_at: number | null;
    };
    assert.strictEqual(rewritten.name, 'Renamed by old binary');
    assert.strictEqual(rewritten.last_modified, ACT_LM_BIG, 'unrelated columns survive the rewrite');
    assert.strictEqual(rewritten.last_turn_started_at, keyBefore, 'the key survives a downgraded rewrite');

    // Rows inserted by a downgraded binary carry a NULL key until the next
    // launch heals them.
    db.prepare(
      `INSERT INTO sessions (id, workspace_id, name, is_draft, is_wip, is_archived, source, approval_mode, fast_mode, created_at, updated_at, summary, last_modified, first_prompt, git_branch, custom_title, bot_id, provider_id, backend, backend_session_id)
       VALUES ('s-downgrade-insert', ?, 'Old binary insert', 1, 0, 0, NULL, 'manual', 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
    ).run(ACT_WS1, ACT_T1, ACT_T2);
    assert.strictEqual(turnKeyOf(db, 'sessions', 's-downgrade-insert'), null, 'downgrade insert leaves a NULL key');
    db.close();

    const reopened = new SqliteStore(dbPath);
    const db2 = openRawDb(reopened);
    assert.strictEqual(turnKeyOf(db2, 'sessions', 's-downgrade-insert'), floorToSecondMs(ACT_T2), 'healed on reopen');
    assert.strictEqual(nullKeyCount(db2, 'sessions'), 0);
    assert.strictEqual(turnKeyOf(db2, 'sessions', 's-exact'), keyBefore, 'existing keys unchanged by the healing pass');
    db2.close();
  });
});
