import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { Workspace, CreateWorkspaceInput, UpdateWorkspaceInput } from '../models/workspace.js';
import type { ChatSession, ApprovalMode } from '../models/session.js';
import type {
  Bot,
  BotMember,
  BotRole,
  CreateBotInput,
  CreateBotAuditLogInput,
  UpdateBotInput,
  BotChannelSettings,
  BotRolePolicy,
  BotPersona,
  BotAuditLogEntry,
} from '../models/bot.js';
import { encryptChannelSettings, decryptChannelSettings } from '../utils/bot-channel-crypto.js';
import type { Todo, CreateTodoInput, UpdateTodoInput, TodoStatus } from '../models/todo.js';
import type { Provider, CreateProviderInput, UpdateProviderInput } from '../models/provider.js';
import type { WeComProactiveMessage, CreateProactiveMessageInput, ProactiveMessageStatus, UpdateProactiveMessageInput } from '../models/wecom-proactive-message.js';
import type { WeComMediaCacheEntry, CreateWeComMediaCacheInput } from '../models/wecom-media-cache.js';
import { getStorageDir } from './data-dir.js';
import { getNativeBindingPath } from './native-binding.js';
import { ensureAnalyticsCacheSchema, AnalyticsCache } from './analytics-cache.js';

const STORAGE_DIR = getStorageDir();
const DB_FILE = join(STORAGE_DIR, 'data.db');
const LEGACY_FILE = join(STORAGE_DIR, 'workspaces.json');
const SESSIONS_FILE = join(STORAGE_DIR, 'sessions.json');
const BACKUP_FILE = join(STORAGE_DIR, 'workspaces.json.bak');

interface LegacyStorageData {
  workspaces: Workspace[];
  sessions: ChatSession[];
}

function getDatabaseOptions(): Database.Options | undefined {
  const nativeBinding = getNativeBindingPath();
  if (nativeBinding) {
    return { nativeBinding };
  }
  return undefined;
}

export class SqliteStore {
  private db: Database.Database;
  private analyticsCache?: AnalyticsCache;

  constructor(dbPath?: string) {
    const dbFile = dbPath ?? DB_FILE;
    const inMemory = dbFile === ':memory:';
    // An in-memory database has no parent directory to create; only ensure
    // the directory when we are opening a real file on disk.
    if (!inMemory) {
      ensureDirSync(dirname(dbFile));
    }
    const options = getDatabaseOptions();
    this.db = new Database(dbFile, options);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
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

    // Migration: add lastOpenedAt column to existing workspaces table
    const workspaceColumns = this.db.prepare("PRAGMA table_info(workspaces)").all() as { name: string }[];
    if (!workspaceColumns.some(col => col.name === 'lastOpenedAt')) {
      this.db.exec('ALTER TABLE workspaces ADD COLUMN lastOpenedAt TEXT');
    }

    this.db.exec(`
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

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wecom_user_id_mappings (
        encryptedUserId TEXT PRIMARY KEY,
        plaintextUserId TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wecom_workspace_users (
        workspaceId TEXT NOT NULL,
        encryptedUserId TEXT NOT NULL,
        firstSeenAt TEXT NOT NULL,
        lastSeenAt TEXT NOT NULL,
        PRIMARY KEY (workspaceId, encryptedUserId)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feishu_bot_binding (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        activeWorkspaceId TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feishu_user_sessions (
        workspaceId TEXT NOT NULL,
        feishuUserId TEXT NOT NULL,
        sessionId TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (workspaceId, feishuUserId, sessionId)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feishu_active_sessions (
        workspaceId TEXT NOT NULL,
        feishuUserId TEXT NOT NULL,
        sessionId TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (workspaceId, feishuUserId)
      )
    `);

    this.db.exec(`
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

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_metadata (
        session_id TEXT PRIMARY KEY,
        is_wip INTEGER NOT NULL DEFAULT 0
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        active_workspace_id TEXT UNIQUE,
        channel_settings_json TEXT NOT NULL DEFAULT '{}',
        role_policy_json TEXT NOT NULL DEFAULT '{}',
        persona_json TEXT,
        role_personas_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // Migration: add persona_json column to existing bots table
    const botColumns = this.db.prepare("PRAGMA table_info(bots)").all() as { name: string }[];
    if (!botColumns.some(col => col.name === 'persona_json')) {
      this.db.exec('ALTER TABLE bots ADD COLUMN persona_json TEXT');
    }

    // Migration: add role_personas_json column to existing bots table
    if (!botColumns.some(col => col.name === 'role_personas_json')) {
      this.db.exec('ALTER TABLE bots ADD COLUMN role_personas_json TEXT');
    }

    this.db.exec(`
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

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_audit_logs (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_migration_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        run_at TEXT NOT NULL,
        snapshot_json TEXT NOT NULL DEFAULT '{}'
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        is_draft INTEGER NOT NULL DEFAULT 1,
        is_wip INTEGER NOT NULL DEFAULT 0,
        is_archived INTEGER NOT NULL DEFAULT 0,
        source TEXT,
        approval_mode TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        summary TEXT,
        last_modified INTEGER,
        first_prompt TEXT,
        git_branch TEXT,
        custom_title TEXT,
        bot_id TEXT
      )
    `);

    // Migration: add approval_mode column to existing sessions table
    const sessionColumns = this.db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    if (!sessionColumns.some(col => col.name === 'approval_mode')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN approval_mode TEXT');
    }

    // Migration: add provider_id column to existing sessions table
    if (!sessionColumns.some(col => col.name === 'provider_id')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN provider_id TEXT');
    }

    // Migration: add bot_id column to existing sessions table
    if (!sessionColumns.some(col => col.name === 'bot_id')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN bot_id TEXT');
    }

    // Migration: add is_archived column to existing sessions table
    if (!sessionColumns.some(col => col.name === 'is_archived')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0');
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_prompt_history (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_workspace_prompt_history_workspace_created
        ON workspace_prompt_history (workspace_id, created_at DESC)
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        base_url TEXT NOT NULL,
        auth_token TEXT NOT NULL,
        model TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        options_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    this.db.exec(`
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

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wecom_media_cache (
        workspace_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        md5 TEXT NOT NULL,
        filename TEXT NOT NULL,
        media_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, relative_path, md5)
      )
    `);

    ensureAnalyticsCacheSchema(this.db);

    this.migrateTodoDetailColumn();
    this.migrateMappingTable();
    this.migrateWecomUserSessions();
    this.migrateWecomUserSessionsActiveColumn();
    this.migrateFromLegacy();
    this.migrateDraftSessions();
    this.migrateSessionMetadataToSessions();
    this.backfillWeComSessionSource();
    this.migrateBotSettingsColumn();
    this.migrateBotMembersChannelColumns();
  }

  /**
   * Per-session analytics cache, lazily constructed on the store's own
   * connection. See src/server/storage/analytics-cache.ts.
   */
  getAnalyticsCache(): AnalyticsCache {
    if (!this.analyticsCache) {
      this.analyticsCache = new AnalyticsCache(this.db);
    }
    return this.analyticsCache;
  }

  /**
   * Wipe every user table in a single transaction. Intended for tests so they
   * can reset state between cases without reaching into the private `db`
   * handle. The table list is derived from the live schema at call time, so
   * newly added tables are covered automatically — there is no hard-coded list
   * to keep in sync. The schema declares no foreign keys, so deletion order is
   * irrelevant.
   */
  resetData(): void {
    const tables = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    const wipe = this.db.transaction(() => {
      for (const { name } of tables) {
        this.db.prepare(`DELETE FROM "${name}"`).run();
      }
    });
    wipe();
  }

  runInTransaction<T>(fn: () => T): T {
    const run = this.db.transaction(fn);
    return run();
  }

  private migrateTodoDetailColumn(): void {
    const tableInfo = this.db.prepare("PRAGMA table_info(todos)").all() as Array<{ name: string }>;
    const hasDetail = tableInfo.some((col) => col.name === 'detail');
    if (!hasDetail) return;

    try {
      this.db.exec(`
        ALTER TABLE todos RENAME TO todos_old;
        CREATE TABLE todos (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          text TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          session_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO todos (id, workspace_id, text, status, session_id, created_at, updated_at)
        SELECT id, workspace_id, text, status, session_id, created_at, updated_at
        FROM todos_old;
        DROP TABLE todos_old;
      `);
      console.log('[SqliteStore] Migrated todos table: dropped detail column');
    } catch (err) {
      console.error('[SqliteStore] Failed to migrate todos table:', err);
    }
  }

  private migrateBotSettingsColumn(): void {
    const tableInfo = this.db.prepare("PRAGMA table_info(bots)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    if (!tableInfo.some((col) => col.name === 'provider_settings_json')) return;

    try {
      const oldColumns = tableInfo.map((col) => col.name);
      const columnDefs = tableInfo.map((col) => {
        const name = col.name === 'provider_settings_json' ? 'channel_settings_json' : col.name;
        const notNull = col.notnull ? ' NOT NULL' : '';
        const defaultClause = col.dflt_value !== null ? ` DEFAULT ${col.dflt_value}` : '';
        return `"${name}" ${col.type}${notNull}${defaultClause}`;
      });
      const newColumns = oldColumns.map((col) => (col === 'provider_settings_json' ? 'channel_settings_json' : col));
      const selectColumns = oldColumns.map((col) => `"${col}"`).join(', ');
      const insertColumns = newColumns.map((col) => `"${col}"`).join(', ');

      this.db.exec(`
        ALTER TABLE bots RENAME TO bots_old;
        CREATE TABLE bots (
          ${columnDefs.join(', ')},
          PRIMARY KEY (id),
          UNIQUE (active_workspace_id)
        );
        INSERT INTO bots (${insertColumns})
        SELECT ${selectColumns}
        FROM bots_old;
        DROP TABLE bots_old;
      `);
      console.log('[SqliteStore] Migrated bots table: renamed provider_settings_json to channel_settings_json');
    } catch (err) {
      console.error('[SqliteStore] Failed to migrate bots table:', err);
    }
  }

  private migrateBotMembersChannelColumns(): void {
    const tableInfo = this.db.prepare("PRAGMA table_info(bot_members)").all() as Array<{ name: string }>;
    const hasOldColumns = tableInfo.some((col) => col.name === 'provider');
    if (!hasOldColumns) return;

    try {
      this.db.exec(`
        ALTER TABLE bot_members RENAME TO bot_members_old;
        CREATE TABLE bot_members (
          bot_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          channel_user_id TEXT NOT NULL,
          role TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (bot_id, channel, channel_user_id)
        );
        INSERT INTO bot_members (bot_id, channel, channel_user_id, role, created_at, updated_at)
        SELECT bot_id, provider, provider_user_id, role, created_at, updated_at
        FROM bot_members_old;
        DROP TABLE bot_members_old;
      `);
      console.log('[SqliteStore] Migrated bot_members table: renamed provider columns to channel columns');
    } catch (err) {
      console.error('[SqliteStore] Failed to migrate bot_members table:', err);
    }

    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_members_owner_per_channel
      ON bot_members (bot_id, channel)
      WHERE role = 'owner'
    `);
  }

  /**
   * Add the isActive column to wecom_user_sessions for existing databases and
   * backfill the latest session per user as active. Fresh databases get the
   * column from the CREATE TABLE statement; this migration covers databases
   * created before the column existed. Rows that already have an active marker
   * are left untouched.
   *
   * Idempotent: the PRAGMA table_info guard skips adding the column when it is
   * already present, and the backfill only operates on (workspaceId,
   * wecomUserId) pairs that have no active row.
   */
  private migrateWecomUserSessionsActiveColumn(): void {
    const columns = this.db.prepare("PRAGMA table_info(wecom_user_sessions)").all() as Array<{ name: string }>;
    if (!columns.some((col) => col.name === 'isActive')) {
      this.db.exec('ALTER TABLE wecom_user_sessions ADD COLUMN isActive INTEGER NOT NULL DEFAULT 0');
    }

    const now = new Date().toISOString();

    // Find every workspace/user pair that has no active session marker.
    const pairsWithoutActive = this.db
      .prepare(`
        SELECT workspaceId, wecomUserId
        FROM wecom_user_sessions
        GROUP BY workspaceId, wecomUserId
        HAVING SUM(isActive) = 0
      `)
      .all() as Array<{ workspaceId: string; wecomUserId: string }>;

    const selectLatest = this.db.prepare(`
      SELECT wus.sessionId FROM wecom_user_sessions AS wus
      JOIN sessions AS s ON s.id = wus.sessionId
      WHERE wus.workspaceId = ? AND wus.wecomUserId = ?
      ORDER BY wus.createdAt DESC, wus.rowid DESC
      LIMIT 1
    `);

    const markActive = this.db.prepare(`
      UPDATE wecom_user_sessions
      SET isActive = 1, updatedAt = ?
      WHERE workspaceId = ? AND wecomUserId = ? AND sessionId = ?
    `);

    const backfill = this.db.transaction(() => {
      for (const pair of pairsWithoutActive) {
        const latest = selectLatest.get(pair.workspaceId, pair.wecomUserId) as
          | { sessionId: string }
          | undefined;
        if (latest) {
          markActive.run(now, pair.workspaceId, pair.wecomUserId, latest.sessionId);
        }
      }
    });
    backfill();

    if (pairsWithoutActive.length > 0) {
      console.log(
        `[SqliteStore] Backfilled ${pairsWithoutActive.length} WeCom user session mapping(s) with active marker`,
      );
    }
  }

  private migrateMappingTable(): void {
    // Check if the old per-workspace mapping table exists and migrate to global
    const tableInfo = this.db.prepare("PRAGMA table_info(wecom_user_id_mappings)").all() as Array<{ name: string }>;
    const hasWorkspaceId = tableInfo.some((col) => col.name === 'workspaceId');
    if (!hasWorkspaceId) return;

    try {
      this.db.exec(`
        ALTER TABLE wecom_user_id_mappings RENAME TO wecom_user_id_mappings_old;
        CREATE TABLE wecom_user_id_mappings (
          encryptedUserId TEXT PRIMARY KEY,
          plaintextUserId TEXT NOT NULL,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        );
        INSERT INTO wecom_user_id_mappings (encryptedUserId, plaintextUserId, createdAt, updatedAt)
        SELECT encryptedUserId, plaintextUserId, createdAt, updatedAt
        FROM wecom_user_id_mappings_old
        GROUP BY encryptedUserId
        HAVING rowid = (SELECT rowid FROM wecom_user_id_mappings_old AS sub WHERE sub.encryptedUserId = wecom_user_id_mappings_old.encryptedUserId ORDER BY updatedAt DESC LIMIT 1);
        DROP TABLE wecom_user_id_mappings_old;
      `);
      console.log('[SqliteStore] Migrated wecom_user_id_mappings to global schema');
    } catch (err) {
      console.error('[SqliteStore] Failed to migrate wecom_user_id_mappings:', err);
    }
  }

  private migrateWecomUserSessions(): void {
    // Check if the old single-session-per-user schema is still in place
    const indexInfo = this.db.prepare("PRAGMA index_list(wecom_user_sessions)").all() as Array<{ name: string; unique: number }>;
    const hasOldUniqueIndex = indexInfo.some(
      (idx) => idx.name === 'sqlite_autoindex_wecom_user_sessions_1' && idx.unique === 1
    );
    if (!hasOldUniqueIndex) return;

    try {
      this.db.exec(`
        ALTER TABLE wecom_user_sessions RENAME TO wecom_user_sessions_old;
        CREATE TABLE wecom_user_sessions (
          workspaceId TEXT NOT NULL,
          wecomUserId TEXT NOT NULL,
          sessionId TEXT NOT NULL,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL,
          PRIMARY KEY (workspaceId, wecomUserId, sessionId)
        );
        INSERT INTO wecom_user_sessions (workspaceId, wecomUserId, sessionId, createdAt, updatedAt)
        SELECT workspaceId, wecomUserId, sessionId, createdAt, updatedAt
        FROM wecom_user_sessions_old;
        DROP TABLE wecom_user_sessions_old;
      `);
      console.log('[SqliteStore] Migrated wecom_user_sessions to multi-session schema');
    } catch (err) {
      console.error('[SqliteStore] Failed to migrate wecom_user_sessions:', err);
    }
  }

  private backfillWeComSessionSource(): void {
    try {
      const result = this.db.prepare(`
        UPDATE sessions
        SET source = 'wecom'
        WHERE source IS NULL
          AND id IN (SELECT sessionId FROM wecom_user_sessions)
      `).run();
      if (result.changes > 0) {
        console.log(`[SqliteStore] Backfilled source='wecom' for ${result.changes} sessions`);
      }
    } catch (err) {
      console.error('[SqliteStore] Failed to backfill WeCom session source:', err);
    }
  }

  private migrateFromLegacy(): void {
    // Check if legacy JSON file exists
    if (!existsSync(LEGACY_FILE)) return;

    // Check if SQLite already has workspace data (idempotent)
    const count = this.db.prepare('SELECT COUNT(*) as count FROM workspaces').get() as { count: number };
    if (count.count > 0) return;

    // Read legacy data
    let data: LegacyStorageData;
    try {
      const raw = readFileSync(LEGACY_FILE, 'utf-8');
      data = JSON.parse(raw) as LegacyStorageData;
    } catch {
      return;
    }

    // Migrate workspaces
    const insert = this.db.prepare(`
      INSERT INTO workspaces (id, name, description, folderPath, settings, skills, mcpServers, hooks, createdAt, updatedAt, lastOpenedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((workspaces: Workspace[]) => {
      for (const ws of workspaces) {
        insert.run(
          ws.id,
          ws.name,
          ws.description || '',
          ws.folderPath,
          JSON.stringify(ws.settings || {}),
          JSON.stringify(ws.skills || []),
          JSON.stringify(ws.mcpServers || []),
          JSON.stringify(ws.hooks || []),
          ws.createdAt,
          ws.updatedAt,
          ws.lastOpenedAt ?? null
        );
      }
    });

    try {
      insertMany(data.workspaces || []);
    } catch (err) {
      console.error('Failed to migrate workspaces to SQLite:', err);
      return;
    }

    // Preserve sessions to a new JSON file
    try {
      writeFileSync(
        SESSIONS_FILE,
        JSON.stringify({ sessions: data.sessions || [] }, null, 2) + '\n',
        'utf-8'
      );
    } catch (err) {
      console.error('Failed to preserve sessions during migration:', err);
      // Continue anyway — sessions can be recreated
    }

    // Rename legacy file to backup
    try {
      renameSync(LEGACY_FILE, BACKUP_FILE);
    } catch (err) {
      console.error('Failed to rename legacy storage file:', err);
    }
  }

  private migrateDraftSessions(): void {
    const DRAFTS_FILE = join(STORAGE_DIR, 'draft-sessions.json');
    if (!existsSync(DRAFTS_FILE)) return;

    // Check if sessions table already has data (idempotent)
    const count = this.db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
    if (count.count > 0) return;

    try {
      const raw = readFileSync(DRAFTS_FILE, 'utf-8');
      const data = JSON.parse(raw) as { sessions?: ChatSession[] };
      const sessions = data.sessions || [];
      if (sessions.length === 0) return;

      const insert = this.db.prepare(`
        INSERT INTO sessions (id, workspace_id, name, is_draft, is_wip, source, created_at, updated_at, summary, last_modified, first_prompt, git_branch, custom_title)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertMany = this.db.transaction((items: ChatSession[]) => {
        for (const s of items) {
          insert.run(
            s.id,
            s.workspaceId,
            s.name,
            s.isDraft ? 1 : 0,
            s.isWip ? 1 : 0,
            s.source ?? null,
            s.createdAt,
            s.updatedAt,
            s.summary ?? null,
            s.lastModified ?? null,
            s.firstPrompt ?? null,
            s.gitBranch ?? null,
            s.customTitle ?? null
          );
        }
      });

      insertMany(sessions);
      console.log(`[SqliteStore] Migrated ${sessions.length} sessions from draft-sessions.json`);

      // Rename draft file to backup after successful migration
      try {
        renameSync(DRAFTS_FILE, `${DRAFTS_FILE}.bak`);
      } catch (err) {
        console.error('[SqliteStore] Failed to rename draft-sessions.json:', err);
      }
    } catch (err) {
      console.error('[SqliteStore] Failed to migrate draft sessions:', err);
    }
  }

  private migrateSessionMetadataToSessions(): void {
    // Pull is_wip from old session_metadata table into sessions table for any rows that exist there
    try {
      const rows = this.db.prepare('SELECT session_id, is_wip FROM session_metadata').all() as Array<{ session_id: string; is_wip: number }>;
      if (rows.length === 0) return;

      const update = this.db.prepare('UPDATE sessions SET is_wip = ? WHERE id = ?');
      const updateMany = this.db.transaction((items: Array<{ session_id: string; is_wip: number }>) => {
        for (const row of items) {
          update.run(row.is_wip, row.session_id);
        }
      });
      updateMany(rows);
      console.log(`[SqliteStore] Migrated ${rows.length} session_metadata entries into sessions table`);
    } catch (err) {
      console.error('[SqliteStore] Failed to migrate session_metadata:', err);
    }
  }

  async list(): Promise<Workspace[]> {
    const rows = this.db.prepare('SELECT * FROM workspaces ORDER BY createdAt').all() as RawWorkspaceRow[];
    return rows.map(parseRow);
  }

  async get(id: string): Promise<Workspace | null> {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as RawWorkspaceRow | undefined;
    return row ? parseRow(row) : null;
  }

  async create(input: CreateWorkspaceInput): Promise<Workspace> {
    const now = new Date().toISOString();
    const workspace: Workspace = {
      id: uuidv4(),
      name: input.name,
      description: input.description || '',
      folderPath: input.folderPath,
      settings: input.settings || {},
      skills: input.skills || [],
      mcpServers: input.mcpServers || [],
      hooks: input.hooks || [],
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: null,
    };

    this.db.prepare(`
      INSERT INTO workspaces (id, name, description, folderPath, settings, skills, mcpServers, hooks, createdAt, updatedAt, lastOpenedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      workspace.id,
      workspace.name,
      workspace.description,
      workspace.folderPath,
      JSON.stringify(workspace.settings),
      JSON.stringify(workspace.skills),
      JSON.stringify(workspace.mcpServers),
      JSON.stringify(workspace.hooks),
      workspace.createdAt,
      workspace.updatedAt,
      workspace.lastOpenedAt
    );

    return workspace;
  }

  async update(id: string, input: UpdateWorkspaceInput): Promise<Workspace | null> {
    const existing = await this.get(id);
    if (!existing) return null;

    const workspace: Workspace = {
      ...existing,
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.folderPath !== undefined && { folderPath: input.folderPath }),
      ...(input.settings !== undefined && { settings: input.settings }),
      ...(input.skills !== undefined && { skills: input.skills }),
      ...(input.mcpServers !== undefined && { mcpServers: input.mcpServers }),
      ...(input.hooks !== undefined && { hooks: input.hooks }),
      updatedAt: new Date().toISOString(),
    };

    this.db.prepare(`
      UPDATE workspaces
      SET name = ?, description = ?, folderPath = ?, settings = ?, skills = ?, mcpServers = ?, hooks = ?, updatedAt = ?
      WHERE id = ?
    `).run(
      workspace.name,
      workspace.description,
      workspace.folderPath,
      JSON.stringify(workspace.settings),
      JSON.stringify(workspace.skills),
      JSON.stringify(workspace.mcpServers),
      JSON.stringify(workspace.hooks),
      workspace.updatedAt,
      id
    );

    return workspace;
  }

  async recordLastOpened(id: string): Promise<Workspace | null> {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE workspaces SET lastOpenedAt = ? WHERE id = ?
    `).run(now, id);
    if (result.changes === 0) return null;
    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
    if (result.changes > 0) {
      this.db.prepare('DELETE FROM wecom_user_sessions WHERE workspaceId = ?').run(id);
      this.db.prepare('DELETE FROM wecom_workspace_users WHERE workspaceId = ?').run(id);
      this.db.prepare('DELETE FROM feishu_bot_binding WHERE activeWorkspaceId = ?').run(id);
      this.db.prepare('DELETE FROM feishu_user_sessions WHERE workspaceId = ?').run(id);
      this.db.prepare('DELETE FROM feishu_active_sessions WHERE workspaceId = ?').run(id);
      this.db.prepare('DELETE FROM feishu_workspace_users WHERE workspaceId = ?').run(id);
      this.db.prepare('DELETE FROM todos WHERE workspace_id = ?').run(id);
      this.db.prepare('DELETE FROM wecom_proactive_messages WHERE workspace_id = ?').run(id);
      this.db.prepare('DELETE FROM wecom_media_cache WHERE workspace_id = ?').run(id);
      this.db.prepare('DELETE FROM workspace_prompt_history WHERE workspace_id = ?').run(id);
      this.db.prepare('DELETE FROM session_metadata WHERE session_id IN (SELECT id FROM sessions WHERE workspace_id = ?)').run(id);
      this.db.prepare('DELETE FROM sessions WHERE workspace_id = ?').run(id);
      this.getAnalyticsCache().clearByWorkspace(id);
    }
    return result.changes > 0;
  }

  // WeCom user session mapping

  setWecomSession(workspaceId: string, wecomUserId: string, sessionId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO wecom_user_sessions (workspaceId, wecomUserId, sessionId, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(workspaceId, wecomUserId, sessionId, now, now);
  }

  listWecomSessions(workspaceId: string): Array<{ wecomUserId: string; sessionId: string }> {
    const rows = this.db
      .prepare('SELECT wecomUserId, sessionId FROM wecom_user_sessions WHERE workspaceId = ?')
      .all(workspaceId) as Array<{ wecomUserId: string; sessionId: string }>;
    return rows;
  }

  listWecomSessionsByUser(workspaceId: string, wecomUserId: string): Array<{ sessionId: string; createdAt: string }> {
    const rows = this.db
      .prepare('SELECT sessionId, createdAt FROM wecom_user_sessions WHERE workspaceId = ? AND wecomUserId = ? ORDER BY createdAt ASC')
      .all(workspaceId, wecomUserId) as Array<{ sessionId: string; createdAt: string }>;
    return rows;
  }

  getWecomUserIdBySession(workspaceId: string, sessionId: string): string | null {
    const row = this.db
      .prepare('SELECT wecomUserId FROM wecom_user_sessions WHERE workspaceId = ? AND sessionId = ?')
      .get(workspaceId, sessionId) as { wecomUserId: string } | undefined;
    return row?.wecomUserId ?? null;
  }

  /**
   * Return the user's active (current) WeCom session id, or null if none is
   * active. Self-heals: if the active row points at a session that no longer
   * exists, the marker is cleared (demoted) and null is returned so the caller
   * creates a fresh session. Reads the explicit isActive marker rather than
   * inferring the latest session by createdAt.
   */
  getActiveWecomSession(workspaceId: string, wecomUserId: string): string | null {
    const row = this.db
      .prepare('SELECT sessionId FROM wecom_user_sessions WHERE workspaceId = ? AND wecomUserId = ? AND isActive = 1 LIMIT 1')
      .get(workspaceId, wecomUserId) as { sessionId: string } | undefined;
    if (!row) return null;
    const exists = this.db
      .prepare('SELECT 1 FROM sessions WHERE id = ?')
      .get(row.sessionId) as { '1': number } | undefined;
    if (!exists) {
      this.db
        .prepare('UPDATE wecom_user_sessions SET isActive = 0, updatedAt = ? WHERE workspaceId = ? AND wecomUserId = ? AND sessionId = ?')
        .run(new Date().toISOString(), workspaceId, wecomUserId, row.sessionId);
      return null;
    }
    return row.sessionId;
  }

  /**
   * Mark sessionId as the user's active (current) WeCom session, demoting every
   * other row for that user to inactive. Runs in a transaction so the
   * single-active invariant holds. The row must already exist (inserted via
   * setWecomSession); this only flips the marker.
   */
  setActiveWecomSession(workspaceId: string, wecomUserId: string, sessionId: string): void {
    const now = new Date().toISOString();
    const activate = this.db.transaction(() => {
      this.db
        .prepare('UPDATE wecom_user_sessions SET isActive = 0 WHERE workspaceId = ? AND wecomUserId = ?')
        .run(workspaceId, wecomUserId);
      this.db
        .prepare('UPDATE wecom_user_sessions SET isActive = 1, updatedAt = ? WHERE workspaceId = ? AND wecomUserId = ? AND sessionId = ?')
        .run(now, workspaceId, wecomUserId, sessionId);
    });
    activate();
  }

  listWecomSessionsForBackfill(): Array<{
    workspaceId: string;
    wecomUserId: string;
    sessionId: string;
    createdAt: string;
  }> {
    const rows = this.db
      .prepare(`
        SELECT
          wus.workspaceId,
          wus.wecomUserId,
          wus.sessionId,
          wus.createdAt
        FROM wecom_user_sessions wus
        JOIN sessions s ON s.id = wus.sessionId
        JOIN wecom_user_id_mappings m ON m.encryptedUserId = wus.wecomUserId
        WHERE s.source = 'wecom'
          AND s.name = wus.wecomUserId
          AND s.custom_title IS NULL
        ORDER BY wus.workspaceId, wus.wecomUserId, wus.createdAt ASC
      `)
      .all() as Array<{
        workspaceId: string;
        wecomUserId: string;
        sessionId: string;
        createdAt: string;
      }>;
    return rows;
  }

  // WeCom user ID mapping (encrypted -> plaintext), global across workspaces

  getWecomUserMapping(encryptedUserId: string): string | null {
    const row = this.db
      .prepare('SELECT plaintextUserId FROM wecom_user_id_mappings WHERE encryptedUserId = ?')
      .get(encryptedUserId) as { plaintextUserId: string } | undefined;
    return row?.plaintextUserId ?? null;
  }

  getEncryptedUserIdByPlaintext(plaintextUserId: string): string | null {
    const row = this.db
      .prepare('SELECT encryptedUserId FROM wecom_user_id_mappings WHERE plaintextUserId = ?')
      .get(plaintextUserId) as { encryptedUserId: string } | undefined;
    return row?.encryptedUserId ?? null;
  }

  setWecomUserMapping(encryptedUserId: string, plaintextUserId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO wecom_user_id_mappings (encryptedUserId, plaintextUserId, createdAt, updatedAt)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(encryptedUserId) DO UPDATE SET
          plaintextUserId = excluded.plaintextUserId,
          updatedAt = excluded.updatedAt
      `)
      .run(encryptedUserId, plaintextUserId, now, now);
  }

  listWecomUserMappings(): Array<{ encryptedUserId: string; plaintextUserId: string }> {
    const rows = this.db
      .prepare('SELECT encryptedUserId, plaintextUserId FROM wecom_user_id_mappings')
      .all() as Array<{ encryptedUserId: string; plaintextUserId: string }>;
    return rows;
  }

  // WeCom workspace user tracking

  getWecomWorkspaceUser(workspaceId: string, encryptedUserId: string): { firstSeenAt: string; lastSeenAt: string } | null {
    const row = this.db
      .prepare('SELECT firstSeenAt, lastSeenAt FROM wecom_workspace_users WHERE workspaceId = ? AND encryptedUserId = ?')
      .get(workspaceId, encryptedUserId) as { firstSeenAt: string; lastSeenAt: string } | undefined;
    return row ?? null;
  }

  setWecomWorkspaceUser(workspaceId: string, encryptedUserId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO wecom_workspace_users (workspaceId, encryptedUserId, firstSeenAt, lastSeenAt)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(workspaceId, encryptedUserId) DO UPDATE SET
          lastSeenAt = excluded.lastSeenAt
      `)
      .run(workspaceId, encryptedUserId, now, now);
  }

  listWecomWorkspaceUsers(workspaceId: string): Array<{ encryptedUserId: string; firstSeenAt: string; lastSeenAt: string }> {
    const rows = this.db
      .prepare('SELECT encryptedUserId, firstSeenAt, lastSeenAt FROM wecom_workspace_users WHERE workspaceId = ? ORDER BY lastSeenAt DESC')
      .all(workspaceId) as Array<{ encryptedUserId: string; firstSeenAt: string; lastSeenAt: string }>;
    return rows;
  }

  isPlaintextUserIdUsedInWorkspace(
    workspaceId: string,
    plaintextUserId: string,
    excludeEncryptedUserId?: string,
  ): boolean {
    const rows = this.db
      .prepare(
        `
        SELECT w.encryptedUserId, m.plaintextUserId
        FROM wecom_workspace_users w
        LEFT JOIN wecom_user_id_mappings m ON m.encryptedUserId = w.encryptedUserId
        WHERE w.workspaceId = ?
      `,
      )
      .all(workspaceId) as Array<{ encryptedUserId: string; plaintextUserId: string | null }>;

    for (const row of rows) {
      if (row.plaintextUserId === plaintextUserId) {
        if (!excludeEncryptedUserId || row.encryptedUserId !== excludeEncryptedUserId) {
          return true;
        }
      }
    }
    return false;
  }

  // Feishu bot state

  getFeishuActiveWorkspace(): string | null {
    const row = this.db
      .prepare('SELECT activeWorkspaceId FROM feishu_bot_binding WHERE id = 1')
      .get() as { activeWorkspaceId: string } | undefined;
    return row?.activeWorkspaceId ?? null;
  }

  setFeishuActiveWorkspace(workspaceId: string): void {
    this.db
      .prepare(`
        INSERT INTO feishu_bot_binding (id, activeWorkspaceId)
        VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET
          activeWorkspaceId = excluded.activeWorkspaceId
      `)
      .run(workspaceId);
  }

  clearFeishuActiveWorkspace(): void {
    this.db.prepare('DELETE FROM feishu_bot_binding WHERE id = 1').run();
  }

  addFeishuUserSession(workspaceId: string, feishuUserId: string, sessionId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO feishu_user_sessions (workspaceId, feishuUserId, sessionId, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(workspaceId, feishuUserId, sessionId, now, now);
  }

  getFeishuSessionOwner(workspaceId: string, sessionId: string): string | null {
    const row = this.db
      .prepare('SELECT feishuUserId FROM feishu_user_sessions WHERE workspaceId = ? AND sessionId = ?')
      .get(workspaceId, sessionId) as { feishuUserId: string } | undefined;
    return row?.feishuUserId ?? null;
  }

  listFeishuSessionsByUser(workspaceId: string, feishuUserId: string): Array<{ sessionId: string; createdAt: string }> {
    const rows = this.db
      .prepare(`
        SELECT s.sessionId, s.createdAt
        FROM feishu_user_sessions s
        JOIN sessions sess ON sess.id = s.sessionId
        WHERE s.workspaceId = ? AND s.feishuUserId = ?
        ORDER BY s.createdAt ASC
      `)
      .all(workspaceId, feishuUserId) as Array<{ sessionId: string; createdAt: string }>;
    return rows;
  }

  listFeishuSessionsForWorkspace(workspaceId: string): Array<{ sessionId: string; feishuUserId: string; createdAt: string }> {
    const rows = this.db
      .prepare(`
        SELECT s.sessionId, s.feishuUserId, s.createdAt
        FROM feishu_user_sessions s
        JOIN sessions sess ON sess.id = s.sessionId
        WHERE s.workspaceId = ?
        ORDER BY s.createdAt ASC
      `)
      .all(workspaceId) as Array<{ sessionId: string; feishuUserId: string; createdAt: string }>;
    return rows;
  }

  setFeishuActiveSession(workspaceId: string, feishuUserId: string, sessionId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO feishu_active_sessions (workspaceId, feishuUserId, sessionId, updatedAt)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(workspaceId, feishuUserId) DO UPDATE SET
          sessionId = excluded.sessionId,
          updatedAt = excluded.updatedAt
      `)
      .run(workspaceId, feishuUserId, sessionId, now);
  }

  getFeishuActiveSession(workspaceId: string, feishuUserId: string): string | null {
    const row = this.db
      .prepare('SELECT sessionId FROM feishu_active_sessions WHERE workspaceId = ? AND feishuUserId = ?')
      .get(workspaceId, feishuUserId) as { sessionId: string } | undefined;
    if (!row) return null;
    const exists = this.db
      .prepare('SELECT 1 FROM sessions WHERE id = ?')
      .get(row.sessionId) as { '1': number } | undefined;
    if (!exists) {
      this.db.prepare('DELETE FROM feishu_active_sessions WHERE workspaceId = ? AND feishuUserId = ?').run(workspaceId, feishuUserId);
      return null;
    }
    return row.sessionId;
  }

  clearFeishuActiveSession(workspaceId: string, feishuUserId: string): void {
    this.db
      .prepare('DELETE FROM feishu_active_sessions WHERE workspaceId = ? AND feishuUserId = ?')
      .run(workspaceId, feishuUserId);
  }

  // Feishu workspace user directory

  getFeishuWorkspaceUser(
    workspaceId: string,
    openId: string,
  ): { openId: string; userId: string | null; name: string | null; firstSeenAt: string; lastSeenAt: string } | null {
    const row = this.db
      .prepare('SELECT openId, userId, name, firstSeenAt, lastSeenAt FROM feishu_workspace_users WHERE workspaceId = ? AND openId = ?')
      .get(workspaceId, openId) as { openId: string; userId: string | null; name: string | null; firstSeenAt: string; lastSeenAt: string } | undefined;
    return row ?? null;
  }

  setFeishuWorkspaceUser(workspaceId: string, openId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO feishu_workspace_users (workspaceId, openId, firstSeenAt, lastSeenAt)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(workspaceId, openId) DO UPDATE SET
          lastSeenAt = excluded.lastSeenAt
      `)
      .run(workspaceId, openId, now, now);
  }

  setFeishuWorkspaceUserName(workspaceId: string, openId: string, name: string, userId?: string | null): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        UPDATE feishu_workspace_users
        SET name = ?, userId = COALESCE(?, userId), lastSeenAt = ?
        WHERE workspaceId = ? AND openId = ?
      `)
      .run(name, userId ?? null, now, workspaceId, openId);
  }

  listFeishuWorkspaceUsers(workspaceId: string): Array<{
    openId: string;
    userId: string | null;
    name: string | null;
    firstSeenAt: string;
    lastSeenAt: string;
  }> {
    const rows = this.db
      .prepare('SELECT openId, userId, name, firstSeenAt, lastSeenAt FROM feishu_workspace_users WHERE workspaceId = ? ORDER BY lastSeenAt DESC')
      .all(workspaceId) as Array<{ openId: string; userId: string | null; name: string | null; firstSeenAt: string; lastSeenAt: string }>;
    return rows;
  }

  // Session metadata (WIP, etc.)

  getSessionMetadata(sessionIds: string[]): Record<string, { isWip: boolean }> {
    if (sessionIds.length === 0) return {};
    const placeholders = sessionIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT session_id, is_wip FROM session_metadata WHERE session_id IN (${placeholders})`)
      .all(...sessionIds) as Array<{ session_id: string; is_wip: number }>;
    const result: Record<string, { isWip: boolean }> = {};
    for (const row of rows) {
      result[row.session_id] = { isWip: row.is_wip === 1 };
    }
    return result;
  }

  setSessionMetadata(sessionId: string, isWip: boolean): void {
    this.db
      .prepare(`
        INSERT INTO session_metadata (session_id, is_wip)
        VALUES (?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          is_wip = excluded.is_wip
      `)
      .run(sessionId, isWip ? 1 : 0);

    // Also keep sessions table in sync
    this.db.prepare(`UPDATE sessions SET is_wip = ? WHERE id = ?`).run(isWip ? 1 : 0, sessionId);
  }

  // Session CRUD (replaces draft-sessions.json)

  listLocalSessions(workspaceId?: string): ChatSession[] {
    const sql = workspaceId
      ? 'SELECT * FROM sessions WHERE workspace_id = ? ORDER BY updated_at DESC'
      : 'SELECT * FROM sessions ORDER BY updated_at DESC';
    const rows = workspaceId
      ? (this.db.prepare(sql).all(workspaceId) as RawSessionRow[])
      : (this.db.prepare(sql).all() as RawSessionRow[]);
    return rows.map(parseSessionRow);
  }

  getLocalSession(id: string): ChatSession | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as RawSessionRow | undefined;
    return row ? parseSessionRow(row) : null;
  }

  createLocalSession(
    workspaceId: string,
    name: string,
    approvalMode?: string,
    providerId?: string,
    source?: 'gui' | 'wecom' | 'feishu',
    customTitle?: string,
    botId?: string,
  ): ChatSession {
    const now = new Date().toISOString();
    const mode = approvalMode ?? 'manual';
    const session: ChatSession = {
      id: uuidv4(),
      workspaceId,
      name,
      isDraft: true,
      source,
      approvalMode: mode as ChatSession['approvalMode'],
      botId,
      createdAt: now,
      updatedAt: now,
      customTitle,
    };
    this.db.prepare(`
      INSERT INTO sessions (id, workspace_id, name, is_draft, is_wip, is_archived, source, approval_mode, provider_id, bot_id, created_at, updated_at, custom_title)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(session.id, session.workspaceId, session.name, 1, 0, 0, source ?? null, mode, providerId ?? null, botId ?? null, session.createdAt, session.updatedAt, customTitle ?? null);
    return session;
  }

  updateLocalSession(id: string, input: { name?: string; isWip?: boolean; isArchived?: boolean; approvalMode?: string; providerId?: string | null }): ChatSession | null {
    const existing = this.getLocalSession(id);
    if (!existing) return null;

    const sets: string[] = [];
    const values: unknown[] = [];
    if (input.name !== undefined) {
      sets.push('name = ?');
      values.push(input.name);
    }
    if (input.isWip !== undefined) {
      sets.push('is_wip = ?');
      values.push(input.isWip ? 1 : 0);
    }
    if (input.isArchived !== undefined) {
      sets.push('is_archived = ?');
      values.push(input.isArchived ? 1 : 0);
    }
    if (input.approvalMode !== undefined) {
      sets.push('approval_mode = ?');
      values.push(input.approvalMode);
    }
    if (input.providerId !== undefined) {
      sets.push('provider_id = ?');
      values.push(input.providerId);
    }
    if (sets.length === 0) return existing;

    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getLocalSession(id);
  }

  deleteLocalSession(id: string): boolean {
    const result = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return result.changes > 0;
  }

  clearDraftFlag(id: string): boolean {
    const result = this.db.prepare(`
      UPDATE sessions SET is_draft = 0, updated_at = ? WHERE id = ?
    `).run(new Date().toISOString(), id);
    return result.changes > 0;
  }

  setSessionDraft(id: string, isDraft: boolean): boolean {
    const result = this.db.prepare(`
      UPDATE sessions SET is_draft = ?, updated_at = ? WHERE id = ?
    `).run(isDraft ? 1 : 0, new Date().toISOString(), id);
    return result.changes > 0;
  }

  syncSdkSession(session: ChatSession): void {
    this.db.prepare(`
      INSERT INTO sessions (id, workspace_id, name, is_draft, is_wip, is_archived, source, provider_id, bot_id, created_at, updated_at, summary, last_modified, first_prompt, git_branch, custom_title)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        is_draft = excluded.is_draft,
        source = COALESCE(excluded.source, sessions.source),
        provider_id = COALESCE(excluded.provider_id, sessions.provider_id),
        bot_id = COALESCE(excluded.bot_id, sessions.bot_id),
        updated_at = excluded.updated_at,
        summary = excluded.summary,
        last_modified = excluded.last_modified,
        first_prompt = excluded.first_prompt,
        git_branch = excluded.git_branch,
        custom_title = excluded.custom_title
    `).run(
      session.id,
      session.workspaceId,
      session.name,
      session.isDraft ? 1 : 0,
      session.isWip ? 1 : 0,
      0,
      session.source ?? null,
      session.providerId ?? null,
      session.botId ?? null,
      session.createdAt,
      session.updatedAt,
      session.summary ?? null,
      session.lastModified ?? null,
      session.firstPrompt ?? null,
      session.gitBranch ?? null,
      session.customTitle ?? null
    );
  }

  // Provider CRUD

  listProviders(): Provider[] {
    const rows = this.db.prepare('SELECT * FROM providers ORDER BY created_at DESC').all() as RawProviderRow[];
    return rows.map(parseProviderRow);
  }

  getProvider(id: string): Provider | null {
    const row = this.db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as RawProviderRow | undefined;
    return row ? parseProviderRow(row) : null;
  }

  getProviderByName(name: string): Provider | null {
    const row = this.db.prepare('SELECT * FROM providers WHERE name = ?').get(name) as RawProviderRow | undefined;
    return row ? parseProviderRow(row) : null;
  }

  getDefaultProvider(): Provider | null {
    const row = this.db.prepare('SELECT * FROM providers WHERE is_default = 1 LIMIT 1').get() as RawProviderRow | undefined;
    return row ? parseProviderRow(row) : null;
  }

  createProvider(input: CreateProviderInput): Provider {
    const now = new Date().toISOString();
    const provider: Provider = {
      id: uuidv4(),
      name: input.name.trim(),
      baseUrl: input.baseUrl.trim(),
      authToken: input.authToken,
      model: input.model,
      isDefault: input.isDefault ?? false,
      defaultOpusModel: input.defaultOpusModel,
      defaultSonnetModel: input.defaultSonnetModel,
      defaultHaikuModel: input.defaultHaikuModel,
      subagentModel: input.subagentModel,
      effortLevel: input.effortLevel,
      customEnvVars: input.customEnvVars,
      createdAt: now,
      updatedAt: now,
    };

    const optionsJson = JSON.stringify({
      defaultOpusModel: provider.defaultOpusModel,
      defaultSonnetModel: provider.defaultSonnetModel,
      defaultHaikuModel: provider.defaultHaikuModel,
      subagentModel: provider.subagentModel,
      effortLevel: provider.effortLevel,
      customEnvVars: provider.customEnvVars,
    });

    this.db.prepare(`
      INSERT INTO providers (id, name, base_url, auth_token, model, is_default, options_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      provider.id,
      provider.name,
      provider.baseUrl,
      provider.authToken,
      provider.model ?? null,
      provider.isDefault ? 1 : 0,
      optionsJson,
      provider.createdAt,
      provider.updatedAt
    );

    if (provider.isDefault) {
      this.db.prepare('UPDATE providers SET is_default = 0 WHERE id != ?').run(provider.id);
    }

    return provider;
  }

  updateProvider(id: string, input: UpdateProviderInput): Provider | null {
    const existing = this.getProvider(id);
    if (!existing) return null;

    const provider: Provider = {
      ...existing,
      ...(input.name !== undefined && { name: input.name.trim() }),
      ...(input.baseUrl !== undefined && { baseUrl: input.baseUrl.trim() }),
      ...(input.authToken !== undefined && { authToken: input.authToken }),
      ...(input.model !== undefined && { model: input.model }),
      ...(input.isDefault !== undefined && { isDefault: input.isDefault }),
      ...(input.defaultOpusModel !== undefined && { defaultOpusModel: input.defaultOpusModel }),
      ...(input.defaultSonnetModel !== undefined && { defaultSonnetModel: input.defaultSonnetModel }),
      ...(input.defaultHaikuModel !== undefined && { defaultHaikuModel: input.defaultHaikuModel }),
      ...(input.subagentModel !== undefined && { subagentModel: input.subagentModel }),
      ...(input.effortLevel !== undefined && { effortLevel: input.effortLevel }),
      ...(input.customEnvVars !== undefined && { customEnvVars: input.customEnvVars }),
      updatedAt: new Date().toISOString(),
    };

    const optionsJson = JSON.stringify({
      defaultOpusModel: provider.defaultOpusModel,
      defaultSonnetModel: provider.defaultSonnetModel,
      defaultHaikuModel: provider.defaultHaikuModel,
      subagentModel: provider.subagentModel,
      effortLevel: provider.effortLevel,
      customEnvVars: provider.customEnvVars,
    });

    this.db.prepare(`
      UPDATE providers
      SET name = ?, base_url = ?, auth_token = ?, model = ?, is_default = ?, options_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      provider.name,
      provider.baseUrl,
      provider.authToken,
      provider.model ?? null,
      provider.isDefault ? 1 : 0,
      optionsJson,
      provider.updatedAt,
      id
    );

    if (provider.isDefault) {
      this.db.prepare('UPDATE providers SET is_default = 0 WHERE id != ?').run(id);
    }

    return provider;
  }

  deleteProvider(id: string): boolean {
    const result = this.db.prepare('DELETE FROM providers WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // Todo CRUD

  createTodo(workspaceId: string, input: CreateTodoInput): Todo {
    const now = new Date().toISOString();
    const todo: Todo = {
      id: uuidv4(),
      workspaceId,
      text: input.text.trim(),
      status: 'pending',
      sessionId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO todos (id, workspace_id, text, status, session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(todo.id, todo.workspaceId, todo.text, todo.status, todo.sessionId, todo.createdAt, todo.updatedAt);
    return todo;
  }

  getTodosByWorkspace(workspaceId: string): Todo[] {
    const rows = this.db
      .prepare('SELECT * FROM todos WHERE workspace_id = ? ORDER BY created_at DESC')
      .all(workspaceId) as RawTodoRow[];
    return rows.map(parseTodoRow);
  }

  getTodoById(id: string): Todo | null {
    const row = this.db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as RawTodoRow | undefined;
    return row ? parseTodoRow(row) : null;
  }

  updateTodo(id: string, input: UpdateTodoInput): Todo | null {
    const existing = this.getTodoById(id);
    if (!existing) return null;

    const sets: string[] = [];
    const values: unknown[] = [];

    if (input.text !== undefined) {
      sets.push('text = ?');
      values.push(input.text.trim());
    }
    if (input.status !== undefined) {
      sets.push('status = ?');
      values.push(input.status);
    }
    if (input.sessionId !== undefined) {
      sets.push('session_id = ?');
      values.push(input.sessionId);
    }
    if (sets.length === 0) return existing;

    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    this.db.prepare(`UPDATE todos SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getTodoById(id);
  }

  deleteTodo(id: string): boolean {
    const result = this.db.prepare('DELETE FROM todos WHERE id = ?').run(id);
    return result.changes > 0;
  }

  linkTodoToSession(todoId: string, sessionId: string): Todo | null {
    return this.updateTodo(todoId, { sessionId });
  }

  unlinkTodoBySessionId(sessionId: string): boolean {
    const result = this.db.prepare(`
      UPDATE todos SET session_id = NULL, updated_at = ? WHERE session_id = ?
    `).run(new Date().toISOString(), sessionId);
    return result.changes > 0;
  }

  // WeCom proactive message queue CRUD

  enqueueProactiveMessage(workspaceId: string, input: CreateProactiveMessageInput): WeComProactiveMessage {
    const now = new Date().toISOString();
    const message: WeComProactiveMessage = {
      id: uuidv4(),
      workspaceId,
      senderSessionId: input.senderSessionId,
      recipientEncryptedUserId: input.recipientEncryptedUserId,
      recipientPlaintextUserId: input.recipientPlaintextUserId,
      messageContent: input.messageContent,
      status: 'pending',
      errorReason: null,
      createdAt: now,
      updatedAt: now,
      deliveredAt: null,
      claimedAt: null,
      retryCount: 0,
    };
    this.db.prepare(`
      INSERT INTO wecom_proactive_messages (
        id, workspace_id, sender_session_id, recipient_encrypted_user_id, recipient_plaintext_user_id,
        message_content, status, error_reason, created_at, updated_at, delivered_at, claimed_at, retry_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      message.workspaceId,
      message.senderSessionId,
      message.recipientEncryptedUserId,
      message.recipientPlaintextUserId,
      message.messageContent,
      message.status,
      message.errorReason,
      message.createdAt,
      message.updatedAt,
      message.deliveredAt,
      message.claimedAt,
      message.retryCount
    );
    return message;
  }

  listProactiveMessages(workspaceId: string, statusFilter?: ProactiveMessageStatus): WeComProactiveMessage[] {
    const sql = statusFilter
      ? 'SELECT * FROM wecom_proactive_messages WHERE workspace_id = ? AND status = ? ORDER BY created_at ASC'
      : 'SELECT * FROM wecom_proactive_messages WHERE workspace_id = ? ORDER BY created_at ASC';
    const rows = statusFilter
      ? (this.db.prepare(sql).all(workspaceId, statusFilter) as RawProactiveMessageRow[])
      : (this.db.prepare(sql).all(workspaceId) as RawProactiveMessageRow[]);
    return rows.map(parseProactiveMessageRow);
  }

  getProactiveMessage(id: string): WeComProactiveMessage | null {
    const row = this.db.prepare('SELECT * FROM wecom_proactive_messages WHERE id = ?').get(id) as RawProactiveMessageRow | undefined;
    return row ? parseProactiveMessageRow(row) : null;
  }

  claimNextPendingMessage(workspaceId: string): WeComProactiveMessage | null {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE wecom_proactive_messages
      SET status = 'delivering', claimed_at = ?, updated_at = ?
      WHERE id = (
        SELECT id FROM wecom_proactive_messages
        WHERE workspace_id = ? AND status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1
      )
      RETURNING *
    `).get(now, now, workspaceId) as RawProactiveMessageRow | undefined;
    return result ? parseProactiveMessageRow(result) : null;
  }

  updateProactiveMessage(id: string, input: UpdateProactiveMessageInput): WeComProactiveMessage | null {
    const existing = this.getProactiveMessage(id);
    if (!existing) return null;

    const sets: string[] = [];
    const values: unknown[] = [];

    if (input.status !== undefined) {
      sets.push('status = ?');
      values.push(input.status);
    }
    if (input.errorReason !== undefined) {
      sets.push('error_reason = ?');
      values.push(input.errorReason);
    }
    if (input.deliveredAt !== undefined) {
      sets.push('delivered_at = ?');
      values.push(input.deliveredAt);
    }
    if (input.claimedAt !== undefined) {
      sets.push('claimed_at = ?');
      values.push(input.claimedAt);
    }
    if (input.retryCount !== undefined) {
      sets.push('retry_count = ?');
      values.push(input.retryCount);
    }
    if (sets.length === 0) return existing;

    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    this.db.prepare(`UPDATE wecom_proactive_messages SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getProactiveMessage(id);
  }

  deleteProactiveMessage(id: string): boolean {
    const result = this.db.prepare('DELETE FROM wecom_proactive_messages WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // WeCom media cache for proactive file sends

  getWecomMediaCacheEntry(workspaceId: string, relativePath: string, md5: string): WeComMediaCacheEntry | null {
    const row = this.db
      .prepare(`
        SELECT workspace_id, relative_path, md5, filename, media_id, created_at
        FROM wecom_media_cache
        WHERE workspace_id = ? AND relative_path = ? AND md5 = ?
          AND datetime(created_at) > datetime('now', '-71 hours')
        ORDER BY created_at DESC
        LIMIT 1
      `)
      .get(workspaceId, relativePath, md5) as RawMediaCacheRow | undefined;
    return row ? parseMediaCacheRow(row) : null;
  }

  createWecomMediaCacheEntry(input: CreateWeComMediaCacheInput): WeComMediaCacheEntry {
    const entry: WeComMediaCacheEntry = {
      workspaceId: input.workspaceId,
      relativePath: input.relativePath,
      md5: input.md5,
      filename: input.filename,
      mediaId: input.mediaId,
      createdAt: input.createdAt,
    };
    this.db.prepare(`
      INSERT OR REPLACE INTO wecom_media_cache (workspace_id, relative_path, md5, filename, media_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      entry.workspaceId,
      entry.relativePath,
      entry.md5,
      entry.filename,
      entry.mediaId,
      entry.createdAt,
    );
    return entry;
  }

  // Workspace prompt history

  createPromptHistory(
    workspaceId: string,
    sessionId: string,
    prompt: string,
    createdAt: string = new Date().toISOString(),
  ): WorkspacePromptHistoryEntry {
    const entry: WorkspacePromptHistoryEntry = {
      id: uuidv4(),
      workspaceId,
      sessionId,
      prompt: prompt.trim(),
      createdAt,
    };
    this.db.prepare(`
      INSERT INTO workspace_prompt_history (id, workspace_id, session_id, prompt, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(entry.id, entry.workspaceId, entry.sessionId, entry.prompt, entry.createdAt);
    return entry;
  }

  listPromptHistory(workspaceId: string): WorkspacePromptHistoryEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM workspace_prompt_history WHERE workspace_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(workspaceId) as RawPromptHistoryRow[];
    return rows.map(parsePromptHistoryRow);
  }

  prunePromptHistory(workspaceId: string, retentionDays: number): number {
    if (retentionDays <= 0) return 0;
    const cutoffMs = Date.now() - retentionDays * 86400_000;
    const cutoff = new Date(cutoffMs).toISOString();
    const result = this.db.prepare(`
      DELETE FROM workspace_prompt_history
      WHERE workspace_id = ? AND created_at < ?
    `).run(workspaceId, cutoff);
    return result.changes as number;
  }

  // Bot management

  createBot(input: CreateBotInput): Bot {
    const now = new Date().toISOString();
    const bot: Bot = {
      id: uuidv4(),
      name: input.name,
      activeWorkspaceId: input.activeWorkspaceId ?? null,
      channelSettings: input.channelSettings ?? {},
      rolePolicy: input.rolePolicy ?? {
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
      },
      persona: input.persona,
      rolePersonas: input.rolePersonas,
      createdAt: now,
      updatedAt: now,
    };

    const encryptedSettings = encryptChannelSettings(bot.channelSettings);
    this.db.prepare(`
      INSERT INTO bots (id, name, active_workspace_id, channel_settings_json, role_policy_json, persona_json, role_personas_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      bot.id,
      bot.name,
      bot.activeWorkspaceId,
      JSON.stringify(encryptedSettings),
      JSON.stringify(bot.rolePolicy),
      bot.persona ? JSON.stringify(bot.persona) : null,
      bot.rolePersonas ? JSON.stringify(bot.rolePersonas) : null,
      bot.createdAt,
      bot.updatedAt,
    );

    return bot;
  }

  getBot(id: string): Bot | null {
    const row = this.db.prepare('SELECT * FROM bots WHERE id = ?').get(id) as RawBotRow | undefined;
    return row ? parseBotRow(row) : null;
  }

  listBots(): Bot[] {
    const rows = this.db.prepare('SELECT * FROM bots ORDER BY created_at').all() as RawBotRow[];
    return rows.map(parseBotRow);
  }

  listBotsForWorkspace(workspaceId: string): Bot[] {
    const rows = this.db
      .prepare('SELECT * FROM bots WHERE active_workspace_id = ? ORDER BY created_at')
      .all(workspaceId) as RawBotRow[];
    return rows.map(parseBotRow);
  }

  updateBot(id: string, input: UpdateBotInput): Bot | null {
    const existing = this.getBot(id);
    if (!existing) return null;

    const bot: Bot = {
      ...existing,
      ...(input.name !== undefined && { name: input.name }),
      ...(input.activeWorkspaceId !== undefined && { activeWorkspaceId: input.activeWorkspaceId }),
      ...(input.channelSettings !== undefined && { channelSettings: input.channelSettings }),
      ...(input.rolePolicy !== undefined && { rolePolicy: input.rolePolicy }),
      ...(input.persona !== undefined && { persona: input.persona ?? undefined }),
      ...(input.rolePersonas !== undefined && { rolePersonas: input.rolePersonas ?? undefined }),
      updatedAt: new Date().toISOString(),
    };

    const encryptedSettings = encryptChannelSettings(bot.channelSettings);
    this.db.prepare(`
      UPDATE bots
      SET name = ?, active_workspace_id = ?, channel_settings_json = ?, role_policy_json = ?, persona_json = ?, role_personas_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      bot.name,
      bot.activeWorkspaceId,
      JSON.stringify(encryptedSettings),
      JSON.stringify(bot.rolePolicy),
      bot.persona ? JSON.stringify(bot.persona) : null,
      bot.rolePersonas ? JSON.stringify(bot.rolePersonas) : null,
      bot.updatedAt,
      id,
    );

    return bot;
  }

  deleteBot(id: string): boolean {
    const result = this.db.prepare('DELETE FROM bots WHERE id = ?').run(id);
    if (result.changes > 0) {
      this.db.prepare('DELETE FROM bot_members WHERE bot_id = ?').run(id);
      this.db.prepare('DELETE FROM bot_audit_logs WHERE bot_id = ?').run(id);
    }
    return result.changes > 0;
  }

  // Bot members

  setBotMember(botId: string, channel: string, channelUserId: string, role: BotRole): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO bot_members (bot_id, channel, channel_user_id, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(bot_id, channel, channel_user_id) DO UPDATE SET
        role = excluded.role,
        updated_at = excluded.updated_at
    `).run(botId, channel, channelUserId, role, now, now);
  }

  removeBotMember(botId: string, channel: string, channelUserId: string): void {
    this.db.prepare(`
      DELETE FROM bot_members WHERE bot_id = ? AND channel = ? AND channel_user_id = ?
    `).run(botId, channel, channelUserId);
  }

  getBotMemberRole(botId: string, channel: string, channelUserId: string): BotRole | null {
    const row = this.db
      .prepare('SELECT role FROM bot_members WHERE bot_id = ? AND channel = ? AND channel_user_id = ?')
      .get(botId, channel, channelUserId) as { role: BotRole } | undefined;
    return row?.role ?? null;
  }

  listBotMembers(botId: string): BotMember[] {
    const rows = this.db
      .prepare('SELECT * FROM bot_members WHERE bot_id = ? ORDER BY created_at')
      .all(botId) as RawBotMemberRow[];
    return rows.map(parseBotMemberRow);
  }

  // Bot audit logs

  recordAuditLog(input: CreateBotAuditLogInput): BotAuditLogEntry {
    const now = new Date().toISOString();
    const entry: BotAuditLogEntry = {
      id: uuidv4(),
      botId: input.botId,
      actorType: input.actorType,
      actorId: input.actorId,
      eventType: input.eventType,
      details: input.details ?? {},
      createdAt: now,
    };
    this.db.prepare(`
      INSERT INTO bot_audit_logs (id, bot_id, actor_type, actor_id, event_type, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      entry.botId,
      entry.actorType,
      entry.actorId,
      entry.eventType,
      JSON.stringify(entry.details),
      entry.createdAt,
    );
    return entry;
  }

  listAuditLogs(botId: string): BotAuditLogEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM bot_audit_logs WHERE bot_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(botId) as RawAuditLogRow[];
    return rows.map(parseAuditLogRow);
  }

  // Bot migration state

  getMigrationVersion(): number | null {
    const row = this.db
      .prepare('SELECT version FROM bot_migration_state WHERE id = 1')
      .get() as { version: number } | undefined;
    return row?.version ?? null;
  }

  setMigrationState(version: number, runAt: string, snapshot: Record<string, unknown>): void {
    this.db.prepare(`
      INSERT INTO bot_migration_state (id, version, run_at, snapshot_json)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        version = excluded.version,
        run_at = excluded.run_at,
        snapshot_json = excluded.snapshot_json
    `).run(version, runAt, JSON.stringify(snapshot));
  }

  // Session bot_id backfill

  setSessionBotId(sessionId: string, botId: string): void {
    this.db.prepare('UPDATE sessions SET bot_id = ? WHERE id = ?').run(botId, sessionId);
  }

  listSessionsForBot(botId: string): ChatSession[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE bot_id = ? ORDER BY created_at')
      .all(botId) as RawSessionRow[];
    return rows.map(parseSessionRow);
  }
}

export interface WorkspacePromptHistoryEntry {
  id: string;
  workspaceId: string;
  sessionId: string;
  prompt: string;
  createdAt: string;
}

interface RawWorkspaceRow {
  id: string;
  name: string;
  description: string;
  folderPath: string;
  settings: string;
  skills: string;
  mcpServers: string;
  hooks: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
}

function parseRow(row: RawWorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    folderPath: row.folderPath,
    settings: safeJsonParse(row.settings, {}),
    skills: safeJsonParse(row.skills, []),
    mcpServers: safeJsonParse(row.mcpServers, []),
    hooks: safeJsonParse(row.hooks, []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastOpenedAt: row.lastOpenedAt ?? null,
  };
}

interface RawSessionRow {
  id: string;
  workspace_id: string;
  name: string;
  is_draft: number;
  is_wip: number;
  is_archived: number;
  source: string | null;
  approval_mode: string | null;
  provider_id: string | null;
  bot_id: string | null;
  created_at: string;
  updated_at: string;
  summary: string | null;
  last_modified: number | null;
  first_prompt: string | null;
  git_branch: string | null;
  custom_title: string | null;
}

function parseSessionRow(row: RawSessionRow): ChatSession {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    isDraft: row.is_draft === 1,
    isWip: row.is_wip === 1,
    isArchived: row.is_archived === 1,
    source: (row.source as 'gui' | 'wecom') ?? undefined,
    approvalMode: (row.approval_mode as ApprovalMode) ?? undefined,
    providerId: row.provider_id ?? undefined,
    botId: row.bot_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    summary: row.summary ?? undefined,
    lastModified: row.last_modified ?? undefined,
    firstPrompt: row.first_prompt ?? undefined,
    gitBranch: row.git_branch ?? undefined,
    customTitle: row.custom_title ?? undefined,
  };
}

interface RawBotRow {
  id: string;
  name: string;
  active_workspace_id: string | null;
  channel_settings_json: string;
  role_policy_json: string;
  persona_json: string | null;
  role_personas_json: string | null;
  created_at: string;
  updated_at: string;
}

function parseBotRow(row: RawBotRow): Bot {
  const encryptedSettings = safeJsonParse(row.channel_settings_json, {} as BotChannelSettings);
  return {
    id: row.id,
    name: row.name,
    activeWorkspaceId: row.active_workspace_id,
    channelSettings: decryptChannelSettings(encryptedSettings),
    rolePolicy: safeJsonParse(row.role_policy_json, {
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
    } as BotRolePolicy),
    persona: row.persona_json ? safeJsonParse(row.persona_json, undefined as unknown as BotPersona) : undefined,
    rolePersonas: row.role_personas_json ? safeJsonParse(row.role_personas_json, undefined as unknown as Partial<Record<BotRole, BotPersona>>) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface RawBotMemberRow {
  bot_id: string;
  channel: string;
  channel_user_id: string;
  role: BotRole;
  created_at: string;
  updated_at: string;
}

function parseBotMemberRow(row: RawBotMemberRow): BotMember {
  return {
    botId: row.bot_id,
    channel: row.channel as BotMember['channel'],
    channelUserId: row.channel_user_id,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface RawAuditLogRow {
  id: string;
  bot_id: string;
  actor_type: string;
  actor_id: string;
  event_type: string;
  details_json: string;
  created_at: string;
}

function parseAuditLogRow(row: RawAuditLogRow): BotAuditLogEntry {
  return {
    id: row.id,
    botId: row.bot_id,
    actorType: row.actor_type as BotAuditLogEntry['actorType'],
    actorId: row.actor_id,
    eventType: row.event_type,
    details: safeJsonParse(row.details_json, {}),
    createdAt: row.created_at,
  };
}

interface RawTodoRow {
  id: string;
  workspace_id: string;
  text: string;
  status: string;
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

function parseTodoRow(row: RawTodoRow): Todo {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    text: row.text,
    status: row.status as TodoStatus,
    sessionId: row.session_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface RawProviderRow {
  id: string;
  name: string;
  base_url: string;
  auth_token: string;
  model: string | null;
  is_default: number;
  options_json: string;
  created_at: string;
  updated_at: string;
}

function parseProviderRow(row: RawProviderRow): Provider {
  const options = safeJsonParse(row.options_json, {} as Record<string, unknown>);
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    authToken: row.auth_token,
    model: row.model ?? undefined,
    isDefault: row.is_default === 1,
    defaultOpusModel: typeof options.defaultOpusModel === 'string' ? options.defaultOpusModel : undefined,
    defaultSonnetModel: typeof options.defaultSonnetModel === 'string' ? options.defaultSonnetModel : undefined,
    defaultHaikuModel: typeof options.defaultHaikuModel === 'string' ? options.defaultHaikuModel : undefined,
    subagentModel: typeof options.subagentModel === 'string' ? options.subagentModel : undefined,
    effortLevel: typeof options.effortLevel === 'string' ? options.effortLevel : undefined,
    customEnvVars: typeof options.customEnvVars === 'object' && options.customEnvVars !== null
      ? (options.customEnvVars as Record<string, string>)
      : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface RawProactiveMessageRow {
  id: string;
  workspace_id: string;
  sender_session_id: string;
  recipient_encrypted_user_id: string;
  recipient_plaintext_user_id: string;
  message_content: string;
  status: string;
  error_reason: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
  claimed_at: string | null;
  retry_count: number;
}

function parseProactiveMessageRow(row: RawProactiveMessageRow): WeComProactiveMessage {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    senderSessionId: row.sender_session_id,
    recipientEncryptedUserId: row.recipient_encrypted_user_id,
    recipientPlaintextUserId: row.recipient_plaintext_user_id,
    messageContent: row.message_content,
    status: row.status as ProactiveMessageStatus,
    errorReason: row.error_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at,
    claimedAt: row.claimed_at,
    retryCount: row.retry_count,
  };
}

interface RawMediaCacheRow {
  workspace_id: string;
  relative_path: string;
  md5: string;
  filename: string;
  media_id: string;
  created_at: string;
}

function parseMediaCacheRow(row: RawMediaCacheRow): WeComMediaCacheEntry {
  return {
    workspaceId: row.workspace_id,
    relativePath: row.relative_path,
    md5: row.md5,
    filename: row.filename,
    mediaId: row.media_id,
    createdAt: row.created_at,
  };
}

interface RawPromptHistoryRow {
  id: string;
  workspace_id: string;
  session_id: string;
  prompt: string;
  created_at: string;
}

function parsePromptHistoryRow(row: RawPromptHistoryRow): WorkspacePromptHistoryEntry {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    prompt: row.prompt,
    createdAt: row.created_at,
  };
}

function safeJsonParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function ensureDirSync(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export const store = new SqliteStore();
