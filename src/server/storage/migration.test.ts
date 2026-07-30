import '../test-utils/test-env.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'fs';
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

    assert.strictEqual(store.getMigrationVersion(), 8);

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
    assert.strictEqual(secondStore.getMigrationVersion(), 8);

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
    assert.strictEqual(store.getMigrationVersion(), 8);
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
    assert.strictEqual(store.getMigrationVersion(), 8);

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
    assert.strictEqual(t3!.status, 'did-but-need-verify');
    assert.strictEqual(t3!.workspaceId, 'ws-b');
    assert.strictEqual(t3!.origin, 'local');
    assert.deepStrictEqual(t3!.labels, []);
    assert.strictEqual(t3!.originDeleted, false);
  });

  it('a fresh db lands on the new shape without a rebuild (shape-keyed gate)', () => {
    const store = new SqliteStore(dbPath); // file does not exist yet -> fresh construction
    assert.strictEqual(store.getMigrationVersion(), 8);
    const db = openRawDb(store);
    const cols = todoColumns(db);
    assert.strictEqual(cols.find((c) => c.name === 'workspace_id')!.notnull, 0);
    assert.ok(cols.some((c) => c.name === 'origin'));
    const todo = store.createTodo(null, { text: 'global todo' });
    assert.strictEqual(todo.workspaceId, null);
    assert.strictEqual(store.getAllTodos().length, 1);
  });

  it('is idempotent: a second construction leaves new rows intact and the version at 8', () => {
    const ts = now();
    const seedDb = seedOldTodosDb(dbPath, [
      { id: 't1', workspace_id: 'ws-a', text: 'legacy', status: 'pending', session_id: null, created_at: ts, updated_at: ts },
    ]);
    seedDb.close();
    const first = new SqliteStore(dbPath);
    first.createTodo(null, { text: 'new global todo' });
    const second = new SqliteStore(dbPath);
    assert.strictEqual(second.getMigrationVersion(), 8);
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
