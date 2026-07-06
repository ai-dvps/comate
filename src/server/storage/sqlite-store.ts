import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { Workspace, CreateWorkspaceInput, UpdateWorkspaceInput } from '../models/workspace.js';
import type { ChatSession, ApprovalMode } from '../models/session.js';
import type {
  Bot,
  BotChannel,
  BotChannelKey,
  BotChannelSettings,
  BotRole,
  BotRoleKey,
  BotRolePolicy,
  BotPersona,
  BotAuditLogEntry,
  CreateBotInput,
  CreateBotAuditLogInput,
  UpdateBotInput,
} from '../models/bot.js';
import type {
  BotUser,
  CreateBotUserInput,
  UpdateBotUserInput,
} from '../models/bot-user.js';
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
  private readonly inMemory: boolean;

  constructor(dbPath?: string) {
    const dbFile = dbPath ?? DB_FILE;
    this.inMemory = dbFile === ':memory:';
    if (!this.inMemory) {
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

    const workspaceColumns = this.db.prepare("PRAGMA table_info(workspaces)").all() as { name: string }[];
    if (!workspaceColumns.some(col => col.name === 'lastOpenedAt')) {
      this.db.exec('ALTER TABLE workspaces ADD COLUMN lastOpenedAt TEXT');
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_migration_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        run_at TEXT NOT NULL,
        snapshot_json TEXT NOT NULL DEFAULT '{}'
      )
    `);
    const migrationVersion = this.getMigrationVersion();

    if (migrationVersion === null || migrationVersion < 5) {
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
    }
    if (migrationVersion === null || migrationVersion < 5) {
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
    }
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
    if (migrationVersion === null || migrationVersion < 5) {
      const botColumns = this.db.prepare("PRAGMA table_info(bots)").all() as { name: string }[];
      if (!botColumns.some(col => col.name === 'persona_json')) {
        this.db.exec('ALTER TABLE bots ADD COLUMN persona_json TEXT');
      }
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
    }
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
    const sessionColumns = this.db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    if (!sessionColumns.some(col => col.name === 'approval_mode')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN approval_mode TEXT');
    }
    if (!sessionColumns.some(col => col.name === 'provider_id')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN provider_id TEXT');
    }
    if (!sessionColumns.some(col => col.name === 'bot_id')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN bot_id TEXT');
    }
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
        retry_count INTEGER NOT NULL DEFAULT 0,
        bot_id TEXT,
        channel_id TEXT
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
    this.migrateToUnifiedSchema();
  }

  getAnalyticsCache(): AnalyticsCache {
    if (!this.analyticsCache) {
      this.analyticsCache = new AnalyticsCache(this.db);
    }
    return this.analyticsCache;
  }

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

  private migrateWecomUserSessionsActiveColumn(): void {
    const columns = this.db.prepare("PRAGMA table_info(wecom_user_sessions)").all() as Array<{ name: string }>;
    if (columns.length === 0) return;
    if (!columns.some((col) => col.name === 'isActive')) {
      this.db.exec('ALTER TABLE wecom_user_sessions ADD COLUMN isActive INTEGER NOT NULL DEFAULT 0');
    }
    const now = new Date().toISOString();
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
    const columns = this.db.prepare("PRAGMA table_info(wecom_user_sessions)").all() as Array<{ name: string }>;
    if (columns.length === 0) return;
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
    if (!existsSync(LEGACY_FILE)) return;
    const count = this.db.prepare('SELECT COUNT(*) as count FROM workspaces').get() as { count: number };
    if (count.count > 0) return;
    let data: LegacyStorageData;
    try {
      const raw = readFileSync(LEGACY_FILE, 'utf-8');
      data = JSON.parse(raw) as LegacyStorageData;
    } catch {
      return;
    }
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
    try {
      writeFileSync(
        SESSIONS_FILE,
        JSON.stringify({ sessions: data.sessions || [] }, null, 2) + '\n',
        'utf-8'
      );
    } catch (err) {
      console.error('Failed to preserve sessions during migration:', err);
    }
    try {
      renameSync(LEGACY_FILE, BACKUP_FILE);
    } catch (err) {
      console.error('Failed to rename legacy storage file:', err);
    }
  }

  private migrateDraftSessions(): void {
    const DRAFTS_FILE = join(STORAGE_DIR, 'draft-sessions.json');
    if (!existsSync(DRAFTS_FILE)) return;
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

  private migrateToUnifiedSchema(): void {
    const version = this.getMigrationVersion();
    if (version !== null && version >= 5) {
      return;
    }

    const oldTables = this.db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
        AND name IN ('bot_members','wecom_user_sessions','wecom_user_id_mappings',
                     'wecom_workspace_users','feishu_bot_binding','feishu_user_sessions',
                     'feishu_active_sessions','feishu_workspace_users')
    `).all() as Array<{ name: string }>;
    if (oldTables.length === 0) {
      this.setMigrationState(5, new Date().toISOString(), { reason: 'old_tables_already_absent' });
      return;
    }

    if (!this.inMemory) {
      const backupDir = join(STORAGE_DIR, 'backup');
      ensureDirSync(backupDir);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = join(backupDir, `pre-unified-schema-${timestamp}.db`);
      try {
        copyFileSync(DB_FILE, backupPath);
        console.log(`[SqliteStore] Created pre-migration backup: ${backupPath}`);
      } catch (err) {
        console.error('[SqliteStore] Failed to create pre-migration backup:', err);
      }
    }

    const now = new Date().toISOString();

    const migrate = this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS bot_channels (
          id TEXT PRIMARY KEY,
          bot_id TEXT NOT NULL,
          channel_key TEXT NOT NULL,
          display_name TEXT NOT NULL,
          config_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_channels_bot_channel_key
        ON bot_channels (bot_id, channel_key)
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS bot_roles (
          id TEXT PRIMARY KEY,
          bot_id TEXT NOT NULL,
          role_key TEXT NOT NULL,
          permissions_json TEXT NOT NULL DEFAULT '{}',
          persona_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_roles_bot_role_key
        ON bot_roles (bot_id, role_key)
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS bot_users (
          id TEXT PRIMARY KEY,
          bot_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          role_id TEXT NOT NULL,
          channel_user_id TEXT NOT NULL,
          plaintext_user_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_users_bot_channel_channel_user
        ON bot_users (bot_id, channel_id, channel_user_id)
      `);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_bot_users_bot_id ON bot_users (bot_id)
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS user_sessions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          is_active INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions (user_id)
      `);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_user_sessions_workspace_session ON user_sessions (workspace_id, session_id)
      `);
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_user_sessions_user_session
        ON user_sessions (user_id, session_id)
      `);
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_user_sessions_active_per_user
        ON user_sessions (user_id)
        WHERE is_active = 1
      `);

      const botColumns = this.db.prepare("PRAGMA table_info(bots)").all() as Array<{ name: string }>;
      const hasLegacyBotCols = botColumns.some((col) => ['channel_settings_json','role_policy_json','role_personas_json'].includes(col.name));

      let oldBots: Array<{
        id: string;
        name: string;
        active_workspace_id: string | null;
        channel_settings_json: string;
        role_policy_json: string;
        persona_json: string | null;
        role_personas_json: string | null;
        created_at: string;
        updated_at: string;
      }> = [];
      if (hasLegacyBotCols) {
        oldBots = this.db.prepare('SELECT * FROM bots').all() as typeof oldBots;
        this.db.exec(`
          ALTER TABLE bots RENAME TO bots_old;
          CREATE TABLE bots (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            active_workspace_id TEXT UNIQUE,
            persona_json TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO bots (id, name, active_workspace_id, persona_json, created_at, updated_at)
          SELECT id, name, active_workspace_id, persona_json, created_at, updated_at
          FROM bots_old;
        `);
      }

      for (const bot of oldBots) {
        const settings = safeJsonParse(bot.channel_settings_json, {} as BotChannelSettings);
        for (const key of ['wecom', 'feishu'] as BotChannelKey[]) {
          const config = settings[key];
          if (config && Object.keys(config).length > 0) {
            const channelId = uuidv4();
            const displayName = key === 'wecom' ? 'WeCom' : 'Feishu';
            const encrypted = encryptChannelSettings({ [key]: config } as BotChannelSettings);
            this.db.prepare(`
              INSERT OR IGNORE INTO bot_channels (id, bot_id, channel_key, display_name, config_json, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(channelId, bot.id, key, displayName, JSON.stringify(encrypted), now, now);
          }
        }
      }

      for (const bot of oldBots) {
        const policy = safeJsonParse(bot.role_policy_json, {
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
        } as BotRolePolicy);
        const rolePersonas = safeJsonParse(bot.role_personas_json ?? '{}', {} as Partial<Record<BotRoleKey, BotPersona>>);
        for (const roleKey of ['owner', 'admin', 'normal'] as BotRoleKey[]) {
          const roleId = uuidv4();
          const permissions: BotRolePolicy = roleKey === 'normal'
            ? policy
            : {
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
                skillAllowlist: [],
                bashWhitelist: [],
              };
          const persona = rolePersonas[roleKey];
          this.db.prepare(`
            INSERT OR IGNORE INTO bot_roles (id, bot_id, role_key, permissions_json, persona_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(roleId, bot.id, roleKey, JSON.stringify(permissions), persona ? JSON.stringify(persona) : null, now, now);
        }
      }

      const memberRows = this.db.prepare('SELECT * FROM bot_members').all() as Array<{
        bot_id: string;
        channel: string;
        channel_user_id: string;
        role: string;
        created_at: string;
        updated_at: string;
      }>;
      for (const member of memberRows) {
        const channelRow = this.db.prepare(`
          SELECT id FROM bot_channels WHERE bot_id = ? AND channel_key = ?
        `).get(member.bot_id, member.channel) as { id: string } | undefined;
        const roleRow = this.db.prepare(`
          SELECT id FROM bot_roles WHERE bot_id = ? AND role_key = ?
        `).get(member.bot_id, member.role) as { id: string } | undefined;
        if (!channelRow || !roleRow) {
          console.log(`[SqliteStore] Skipping bot_members migration: missing channel or role for bot=${member.bot_id} channel=${member.channel} role=${member.role}`);
          continue;
        }
        const userId = uuidv4();
        this.db.prepare(`
          INSERT OR IGNORE INTO bot_users (id, bot_id, channel_id, role_id, channel_user_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(userId, member.bot_id, channelRow.id, roleRow.id, member.channel_user_id, member.created_at, member.updated_at);
      }

      const wecomUsers = this.db.prepare('SELECT * FROM wecom_workspace_users').all() as Array<{
        workspaceId: string;
        encryptedUserId: string;
        firstSeenAt: string;
        lastSeenAt: string;
      }>;
      for (const wu of wecomUsers) {
        const botRow = this.db.prepare('SELECT id FROM bots WHERE active_workspace_id = ?').get(wu.workspaceId) as { id: string } | undefined;
        if (!botRow) {
          console.log(`[SqliteStore] Skipping wecom_workspace_users migration: no active bot for workspace=${wu.workspaceId}`);
          continue;
        }
        const channelRow = this.db.prepare('SELECT id FROM bot_channels WHERE bot_id = ? AND channel_key = ?').get(botRow.id, 'wecom') as { id: string } | undefined;
        if (!channelRow) {
          console.log(`[SqliteStore] Skipping wecom_workspace_users migration: no wecom channel for bot=${botRow.id}`);
          continue;
        }
        const roleRow = this.db.prepare('SELECT id FROM bot_roles WHERE bot_id = ? AND role_key = ?').get(botRow.id, 'normal') as { id: string } | undefined;
        if (!roleRow) continue;
        const mapping = this.db.prepare('SELECT plaintextUserId FROM wecom_user_id_mappings WHERE encryptedUserId = ?').get(wu.encryptedUserId) as { plaintextUserId: string } | undefined;
        const userId = uuidv4();
        this.db.prepare(`
          INSERT OR IGNORE INTO bot_users (id, bot_id, channel_id, role_id, channel_user_id, plaintext_user_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(userId, botRow.id, channelRow.id, roleRow.id, wu.encryptedUserId, mapping?.plaintextUserId ?? null, wu.firstSeenAt, wu.lastSeenAt);
      }

      const wecomSessions = this.db.prepare('SELECT * FROM wecom_user_sessions').all() as Array<{
        workspaceId: string;
        wecomUserId: string;
        sessionId: string;
        createdAt: string;
        updatedAt: string;
        isActive: number;
      }>;
      // A bot_user may have several source sessions marked active (the same person
      // across workspaces that resolve to one bot row). The unified schema allows
      // at most one active session per bot_user (idx_user_sessions_active_per_user),
      // so insert every session inactive and promote a single winner per bot_user
      // afterwards. Promoting inline would either silently drop rows (INSERT OR
      // IGNORE against the active-per-user index) or throw a UNIQUE constraint;
      // demote-all-then-promote-one avoids both.
      const wecomActiveWinner = new Map<string, { sessionId: string; updatedAt: string }>();
      for (const ws of wecomSessions) {
        const botRow = this.db.prepare('SELECT id FROM bots WHERE active_workspace_id = ?').get(ws.workspaceId) as { id: string } | undefined;
        if (!botRow) continue;
        const channelRow = this.db.prepare('SELECT id FROM bot_channels WHERE bot_id = ? AND channel_key = ?').get(botRow.id, 'wecom') as { id: string } | undefined;
        if (!channelRow) continue;
        const userRow = this.db.prepare(`
          SELECT id FROM bot_users WHERE bot_id = ? AND channel_id = ? AND channel_user_id = ?
        `).get(botRow.id, channelRow.id, ws.wecomUserId) as { id: string } | undefined;
        if (!userRow) continue;
        const sessionId = uuidv4();
        this.db.prepare(`
          INSERT OR IGNORE INTO user_sessions (id, workspace_id, session_id, user_id, is_active, created_at, updated_at)
          VALUES (?, ?, ?, ?, 0, ?, ?)
        `).run(sessionId, ws.workspaceId, ws.sessionId, userRow.id, ws.createdAt, ws.updatedAt);
        if (ws.isActive === 1) {
          const existing = wecomActiveWinner.get(userRow.id);
          if (!existing || ws.updatedAt > existing.updatedAt) {
            wecomActiveWinner.set(userRow.id, { sessionId: ws.sessionId, updatedAt: ws.updatedAt });
          }
        }
      }
      for (const [userId, winner] of wecomActiveWinner) {
        this.db.prepare('UPDATE user_sessions SET is_active = 0 WHERE user_id = ?').run(userId);
        this.db.prepare('UPDATE user_sessions SET is_active = 1, updated_at = ? WHERE user_id = ? AND session_id = ?').run(winner.updatedAt, userId, winner.sessionId);
      }

      const feishuBinding = this.db.prepare('SELECT activeWorkspaceId FROM feishu_bot_binding WHERE id = 1').get() as { activeWorkspaceId: string } | undefined;
      if (feishuBinding) {
        let feishuBotId = (this.db.prepare('SELECT id FROM bots WHERE active_workspace_id = ?').get(feishuBinding.activeWorkspaceId) as { id: string } | undefined)?.id;
        if (!feishuBotId) {
          feishuBotId = uuidv4();
          const botName = `Feishu Bot (${feishuBinding.activeWorkspaceId})`;
          this.db.prepare(`
            INSERT INTO bots (id, name, active_workspace_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(feishuBotId, botName, feishuBinding.activeWorkspaceId, now, now);
          const wecomChannelId = uuidv4();
          this.db.prepare(`
            INSERT INTO bot_channels (id, bot_id, channel_key, display_name, config_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(wecomChannelId, feishuBotId, 'wecom', 'WeCom', '{}', now, now);
          const feishuChannelId = uuidv4();
          this.db.prepare(`
            INSERT INTO bot_channels (id, bot_id, channel_key, display_name, config_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(feishuChannelId, feishuBotId, 'feishu', 'Feishu', '{}', now, now);
          for (const roleKey of ['owner', 'admin', 'normal'] as BotRoleKey[]) {
            const roleId = uuidv4();
            const permissions: BotRolePolicy = roleKey === 'normal'
              ? {
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
                }
              : {
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
                  skillAllowlist: [],
                  bashWhitelist: [],
                };
            this.db.prepare(`
              INSERT INTO bot_roles (id, bot_id, role_key, permissions_json, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(roleId, feishuBotId, roleKey, JSON.stringify(permissions), now, now);
          }
        }

        const feishuChannelRow = this.db.prepare('SELECT id FROM bot_channels WHERE bot_id = ? AND channel_key = ?').get(feishuBotId, 'feishu') as { id: string } | undefined;
        if (feishuChannelRow) {
          const feishuUsers = this.db.prepare('SELECT * FROM feishu_workspace_users').all() as Array<{
            workspaceId: string;
            openId: string;
            userId: string | null;
            name: string | null;
            firstSeenAt: string;
            lastSeenAt: string;
          }>;
          for (const fu of feishuUsers) {
            const roleRow = this.db.prepare('SELECT id FROM bot_roles WHERE bot_id = ? AND role_key = ?').get(feishuBotId, 'normal') as { id: string } | undefined;
            if (!roleRow) continue;
            const userId = uuidv4();
            this.db.prepare(`
              INSERT OR IGNORE INTO bot_users (id, bot_id, channel_id, role_id, channel_user_id, plaintext_user_id, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(userId, feishuBotId, feishuChannelRow.id, roleRow.id, fu.openId, fu.userId ?? fu.name ?? null, fu.firstSeenAt, fu.lastSeenAt);
          }

          const feishuSessions = this.db.prepare('SELECT * FROM feishu_user_sessions').all() as Array<{
            workspaceId: string;
            feishuUserId: string;
            sessionId: string;
            createdAt: string;
            updatedAt: string;
          }>;
          for (const fs of feishuSessions) {
            const userRow = this.db.prepare(`
              SELECT id FROM bot_users WHERE bot_id = ? AND channel_id = ? AND channel_user_id = ?
            `).get(feishuBotId, feishuChannelRow.id, fs.feishuUserId) as { id: string } | undefined;
            if (!userRow) continue;
            const sessionId = uuidv4();
            this.db.prepare(`
              INSERT OR IGNORE INTO user_sessions (id, workspace_id, session_id, user_id, is_active, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(sessionId, fs.workspaceId, fs.sessionId, userRow.id, 0, fs.createdAt, fs.updatedAt);
          }

          const feishuActive = this.db.prepare('SELECT * FROM feishu_active_sessions').all() as Array<{
            workspaceId: string;
            feishuUserId: string;
            sessionId: string;
            updatedAt: string;
          }>;
          // feishu_active_sessions records one active session per workspace; the
          // same person across workspaces resolves to a single bot_user, so collect
          // one winning (latest) active session per bot_user and promote only that.
          // Promoting each row inline would set two rows active for one bot_user and
          // violate idx_user_sessions_active_per_user; demote-all-then-promote-one
          // never leaves two active simultaneously.
          const feishuActiveWinner = new Map<string, { sessionId: string; updatedAt: string }>();
          for (const fa of feishuActive) {
            const userRow = this.db.prepare(`
              SELECT id FROM bot_users WHERE bot_id = ? AND channel_id = ? AND channel_user_id = ?
            `).get(feishuBotId, feishuChannelRow.id, fa.feishuUserId) as { id: string } | undefined;
            if (!userRow) continue;
            const existing = feishuActiveWinner.get(userRow.id);
            if (!existing || fa.updatedAt > existing.updatedAt) {
              feishuActiveWinner.set(userRow.id, { sessionId: fa.sessionId, updatedAt: fa.updatedAt });
            }
          }
          for (const [userId, winner] of feishuActiveWinner) {
            this.db.prepare('UPDATE user_sessions SET is_active = 0 WHERE user_id = ?').run(userId);
            this.db.prepare('UPDATE user_sessions SET is_active = 1, updated_at = ? WHERE user_id = ? AND session_id = ?').run(winner.updatedAt, userId, winner.sessionId);
          }
        }
      }

      this.db.prepare(`
        UPDATE sessions SET source = 'wecom' WHERE source IS NULL AND id IN (
          SELECT session_id FROM user_sessions WHERE user_id IN (
            SELECT id FROM bot_users WHERE channel_id IN (
              SELECT id FROM bot_channels WHERE channel_key = 'wecom'
            )
          )
        )
      `).run();
      this.db.prepare(`
        UPDATE sessions SET source = 'feishu' WHERE source IS NULL AND id IN (
          SELECT session_id FROM user_sessions WHERE user_id IN (
            SELECT id FROM bot_users WHERE channel_id IN (
              SELECT id FROM bot_channels WHERE channel_key = 'feishu'
            )
          )
        )
      `).run();

      const botUsersCount = (this.db.prepare('SELECT COUNT(*) as count FROM bot_users').get() as { count: number }).count;
      const sourceCounts = {
        bot_members: (this.db.prepare('SELECT COUNT(*) as count FROM bot_members').get() as { count: number }).count,
        wecom_workspace_users: (this.db.prepare('SELECT COUNT(*) as count FROM wecom_workspace_users').get() as { count: number }).count,
        feishu_workspace_users: (this.db.prepare('SELECT COUNT(*) as count FROM feishu_workspace_users').get() as { count: number }).count,
      };
      // Source tables may overlap (e.g. the same channel user id can appear in
      // both bot_members and wecom_workspace_users). Compute the expected number
      // of distinct (bot_id, channel_id, channel_user_id) rows after migration,
      // ignoring workspace users whose workspace has no active bot.
      const expectedBotUserKeys = new Set<string>();
      const verifyMemberRows = this.db.prepare('SELECT bot_id, channel, channel_user_id FROM bot_members').all() as Array<{
        bot_id: string;
        channel: string;
        channel_user_id: string;
      }>;
      for (const row of verifyMemberRows) {
        const channelRow = this.db.prepare('SELECT id FROM bot_channels WHERE bot_id = ? AND channel_key = ?').get(
          row.bot_id,
          row.channel,
        ) as { id: string } | undefined;
        if (channelRow) {
          expectedBotUserKeys.add(`${row.bot_id}:${channelRow.id}:${row.channel_user_id}`);
        }
      }
      const verifyWecomUserRows = this.db.prepare('SELECT workspaceId, encryptedUserId FROM wecom_workspace_users').all() as Array<{
        workspaceId: string;
        encryptedUserId: string;
      }>;
      for (const row of verifyWecomUserRows) {
        const botRow = this.db.prepare('SELECT id FROM bots WHERE active_workspace_id = ?').get(
          row.workspaceId,
        ) as { id: string } | undefined;
        if (!botRow) continue;
        const channelRow = this.db.prepare('SELECT id FROM bot_channels WHERE bot_id = ? AND channel_key = ?').get(
          botRow.id,
          'wecom',
        ) as { id: string } | undefined;
        if (channelRow) {
          expectedBotUserKeys.add(`${botRow.id}:${channelRow.id}:${row.encryptedUserId}`);
        }
      }
      if (feishuBinding) {
        const feishuBotRow = this.db.prepare('SELECT id FROM bots WHERE active_workspace_id = ?').get(
          feishuBinding.activeWorkspaceId,
        ) as { id: string } | undefined;
        if (feishuBotRow) {
          const channelRow = this.db.prepare('SELECT id FROM bot_channels WHERE bot_id = ? AND channel_key = ?').get(
            feishuBotRow.id,
            'feishu',
          ) as { id: string } | undefined;
          if (channelRow) {
            const verifyFeishuUserRows = this.db.prepare('SELECT openId FROM feishu_workspace_users').all() as Array<{
              openId: string;
            }>;
            for (const row of verifyFeishuUserRows) {
              expectedBotUserKeys.add(`${feishuBotRow.id}:${channelRow.id}:${row.openId}`);
            }
          }
        }
      }
      const expectedBotUsers = expectedBotUserKeys.size;
      if (botUsersCount < expectedBotUsers) {
        throw new Error(
          `Migration count verification failed: bot_users (${botUsersCount}) < expected (${expectedBotUsers}) ` +
            `(bot_members=${sourceCounts.bot_members}, wecom_workspace_users=${sourceCounts.wecom_workspace_users}, feishu_workspace_users=${sourceCounts.feishu_workspace_users})`,
        );
      }

      const userSessionsCount = (this.db.prepare('SELECT COUNT(*) as count FROM user_sessions').get() as { count: number }).count;
      // Expected = number of RESOLVABLE source sessions (those whose bot/channel/
      // bot_user all exist), not the raw source count. Population legitimately
      // skips sessions whose user has no workspace_user row (no bot_user created)
      // or whose workspace has no active bot; the raw count would abort on those.
      // UNION (not UNION ALL) dedups (user_id, session_id) pairs, mirroring the
      // INSERT OR IGNORE against idx_user_sessions_user_session. The old tables
      // still exist at this point (they are dropped further below).
      const expectedSessions = (this.db.prepare(`
        SELECT COUNT(*) as count FROM (
          SELECT u.id AS uid, w.sessionId AS sid
          FROM wecom_user_sessions w
          JOIN bots b ON b.active_workspace_id = w.workspaceId
          JOIN bot_channels c ON c.bot_id = b.id AND c.channel_key = 'wecom'
          JOIN bot_users u ON u.bot_id = b.id AND u.channel_id = c.id AND u.channel_user_id = w.wecomUserId
          UNION
          SELECT u.id AS uid, f.sessionId AS sid
          FROM feishu_user_sessions f
          JOIN feishu_bot_binding fb ON fb.id = 1
          JOIN bots b ON b.active_workspace_id = fb.activeWorkspaceId
          JOIN bot_channels c ON c.bot_id = b.id AND c.channel_key = 'feishu'
          JOIN bot_users u ON u.bot_id = b.id AND u.channel_id = c.id AND u.channel_user_id = f.feishuUserId
        )
      `).get() as { count: number }).count;
      if (userSessionsCount < expectedSessions) {
        throw new Error(`Migration count verification failed: user_sessions (${userSessionsCount}) < resolvable (${expectedSessions})`);
      }

      const pmColumns = this.db.prepare("PRAGMA table_info(wecom_proactive_messages)").all() as Array<{ name: string }>;
      if (!pmColumns.some((col) => col.name === 'bot_id')) {
        this.db.exec('ALTER TABLE wecom_proactive_messages ADD COLUMN bot_id TEXT');
        this.db.exec('ALTER TABLE wecom_proactive_messages ADD COLUMN channel_id TEXT');
      }
      const proactiveMessages = this.db.prepare('SELECT id, workspace_id, recipient_encrypted_user_id FROM wecom_proactive_messages WHERE bot_id IS NULL').all() as Array<{ id: string; workspace_id: string; recipient_encrypted_user_id: string }>;
      for (const pm of proactiveMessages) {
        const botRow = this.db.prepare('SELECT id FROM bots WHERE active_workspace_id = ?').get(pm.workspace_id) as { id: string } | undefined;
        if (!botRow) continue;
        const channelRow = this.db.prepare('SELECT id FROM bot_channels WHERE bot_id = ? AND channel_key = ?').get(botRow.id, 'wecom') as { id: string } | undefined;
        if (!channelRow) continue;
        this.db.prepare('UPDATE wecom_proactive_messages SET bot_id = ?, channel_id = ? WHERE id = ?').run(botRow.id, channelRow.id, pm.id);
      }

      this.db.exec('DROP TABLE IF EXISTS bot_members');
      this.db.exec('DROP TABLE IF EXISTS wecom_user_sessions');
      this.db.exec('DROP TABLE IF EXISTS wecom_user_id_mappings');
      this.db.exec('DROP TABLE IF EXISTS wecom_workspace_users');
      this.db.exec('DROP TABLE IF EXISTS feishu_bot_binding');
      this.db.exec('DROP TABLE IF EXISTS feishu_user_sessions');
      this.db.exec('DROP TABLE IF EXISTS feishu_active_sessions');
      this.db.exec('DROP TABLE IF EXISTS feishu_workspace_users');
      if (hasLegacyBotCols) {
        this.db.exec('DROP TABLE IF EXISTS bots_old');
      }

      const auditLogsCleared = (this.db.prepare('DELETE FROM bot_audit_logs').run() as { changes: number }).changes;

      this.setMigrationState(5, now, {
        botUsersCount,
        userSessionsCount,
        sourceCounts,
        auditLogsCleared,
      });
      console.log('[SqliteStore] Unified schema migration completed successfully');
    });

    try {
      migrate();
    } catch (err) {
      console.error('[SqliteStore] Unified schema migration failed:', err);
      throw err;
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
      this.db.prepare(`
        DELETE FROM user_sessions WHERE session_id IN (SELECT id FROM sessions WHERE workspace_id = ?)
      `).run(id);
      this.db.prepare('DELETE FROM session_metadata WHERE session_id IN (SELECT id FROM sessions WHERE workspace_id = ?)').run(id);
      this.db.prepare('DELETE FROM sessions WHERE workspace_id = ?').run(id);
      this.db.prepare('DELETE FROM todos WHERE workspace_id = ?').run(id);
      this.db.prepare('DELETE FROM wecom_proactive_messages WHERE workspace_id = ?').run(id);
      this.db.prepare('DELETE FROM wecom_media_cache WHERE workspace_id = ?').run(id);
      this.db.prepare('DELETE FROM workspace_prompt_history WHERE workspace_id = ?').run(id);
      this.getAnalyticsCache().clearByWorkspace(id);
    }
    return result.changes > 0;
  }

  addUserSession(workspaceId: string, sessionId: string, userId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO user_sessions (id, workspace_id, session_id, user_id, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), workspaceId, sessionId, userId, 0, now, now);
  }

  listUserSessionsByUser(userId: string): Array<{ sessionId: string; createdAt: string }> {
    const rows = this.db
      .prepare('SELECT session_id, created_at FROM user_sessions WHERE user_id = ? ORDER BY created_at ASC')
      .all(userId) as Array<{ session_id: string; created_at: string }>;
    return rows.map((r) => ({ sessionId: r.session_id, createdAt: r.created_at }));
  }

  listUserSessionsForBot(botId: string): Array<{ sessionId: string; userId: string; workspaceId: string }> {
    const rows = this.db.prepare(`
      SELECT us.session_id, us.user_id, us.workspace_id
      FROM user_sessions us
      JOIN bot_users bu ON bu.id = us.user_id
      WHERE bu.bot_id = ?
      ORDER BY us.created_at ASC
    `).all(botId) as Array<{ session_id: string; user_id: string; workspace_id: string }>;
    return rows.map((r) => ({ sessionId: r.session_id, userId: r.user_id, workspaceId: r.workspace_id }));
  }

  listBotSessionsForWorkspace(workspaceId: string): Array<{ sessionId: string; channelKey: BotChannelKey }> {
    const rows = this.db.prepare(`
      SELECT DISTINCT us.session_id, bc.channel_key
      FROM user_sessions us
      JOIN bot_users bu ON bu.id = us.user_id
      JOIN bot_channels bc ON bc.id = bu.channel_id
      WHERE us.workspace_id = ?
      ORDER BY us.created_at ASC
    `).all(workspaceId) as Array<{ session_id: string; channel_key: string }>;
    return rows.map((r) => ({ sessionId: r.session_id, channelKey: r.channel_key as BotChannelKey }));
  }

  getActiveUserSession(userId: string): string | null {
    const row = this.db
      .prepare('SELECT session_id FROM user_sessions WHERE user_id = ? AND is_active = 1 LIMIT 1')
      .get(userId) as { session_id: string } | undefined;
    if (!row) return null;
    const exists = this.db
      .prepare('SELECT 1 FROM sessions WHERE id = ?')
      .get(row.session_id) as { '1': number } | undefined;
    if (!exists) {
      this.db
        .prepare('UPDATE user_sessions SET is_active = 0, updated_at = ? WHERE user_id = ? AND session_id = ?')
        .run(new Date().toISOString(), userId, row.session_id);
      return null;
    }
    return row.session_id;
  }

  setActiveUserSession(userId: string, sessionId: string): void {
    const now = new Date().toISOString();
    const activate = this.db.transaction(() => {
      this.db
        .prepare('UPDATE user_sessions SET is_active = 0 WHERE user_id = ?')
        .run(userId);
      this.db
        .prepare('UPDATE user_sessions SET is_active = 1, updated_at = ? WHERE user_id = ? AND session_id = ?')
        .run(now, userId, sessionId);
    });
    activate();
  }

  getSessionUsers(sessionId: string): string[] {
    const rows = this.db
      .prepare('SELECT user_id FROM user_sessions WHERE session_id = ?')
      .all(sessionId) as Array<{ user_id: string }>;
    return rows.map((r) => r.user_id);
  }

  listLocalSessions(workspaceId?: string): ChatSession[] {
    const sql = workspaceId
      ? 'SELECT * FROM sessions WHERE workspace_id = ? ORDER BY updated_at DESC'
      : 'SELECT * FROM sessions ORDER BY updated_at DESC';
    const rows = workspaceId
      ? (this.db.prepare(sql).all(workspaceId) as RawSessionRow[])
      : (this.db.prepare(sql).all() as RawSessionRow[]);
    return rows.map(parseSessionRow);
  }

  listSessionsForBot(botId: string): ChatSession[] {
    const rows = this.db.prepare('SELECT * FROM sessions WHERE bot_id = ? ORDER BY updated_at DESC').all(botId) as RawSessionRow[];
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
    this.db.prepare('DELETE FROM user_sessions WHERE session_id = ?').run(id);
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
    this.db.prepare(`UPDATE sessions SET is_wip = ? WHERE id = ?`).run(isWip ? 1 : 0, sessionId);
  }

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

  createBot(input: CreateBotInput): Bot {
    const now = new Date().toISOString();
    const bot: Bot = {
      id: uuidv4(),
      name: input.name,
      activeWorkspaceId: input.activeWorkspaceId ?? null,
      persona: input.persona,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO bots (id, name, active_workspace_id, persona_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      bot.id,
      bot.name,
      bot.activeWorkspaceId,
      bot.persona ? JSON.stringify(bot.persona) : null,
      bot.createdAt,
      bot.updatedAt,
    );
    const inputChannelSettings = (input as { channelSettings?: import('../models/bot.js').BotChannelSettings }).channelSettings;
    for (const channelKey of ['wecom', 'feishu'] as BotChannelKey[]) {
      const channelId = uuidv4();
      this.db.prepare(`
        INSERT INTO bot_channels (id, bot_id, channel_key, display_name, config_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(channelId, bot.id, channelKey, channelKey === 'wecom' ? 'WeCom' : 'Feishu', '{}', now, now);
      if (inputChannelSettings?.[channelKey]) {
        this.updateBotChannel(channelId, { [channelKey]: inputChannelSettings[channelKey] });
      }
    }
    for (const roleKey of ['owner', 'admin', 'normal'] as BotRoleKey[]) {
      const roleId = uuidv4();
      const permissions: BotRolePolicy = roleKey === 'normal'
        ? {
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
          }
        : {
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
            skillAllowlist: [],
            bashWhitelist: [],
          };
      this.db.prepare(`
        INSERT INTO bot_roles (id, bot_id, role_key, permissions_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(roleId, bot.id, roleKey, JSON.stringify(permissions), now, now);
    }
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
      ...(input.persona !== undefined && { persona: input.persona ?? undefined }),
      updatedAt: new Date().toISOString(),
    };
    this.db.prepare(`
      UPDATE bots
      SET name = ?, active_workspace_id = ?, persona_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      bot.name,
      bot.activeWorkspaceId,
      bot.persona ? JSON.stringify(bot.persona) : null,
      bot.updatedAt,
      id,
    );
    return bot;
  }

  deleteBot(id: string): boolean {
    const result = this.db.prepare('DELETE FROM bots WHERE id = ?').run(id);
    if (result.changes > 0) {
      this.db.prepare(`
        DELETE FROM user_sessions WHERE user_id IN (SELECT id FROM bot_users WHERE bot_id = ?)
      `).run(id);
      this.db.prepare('DELETE FROM bot_users WHERE bot_id = ?').run(id);
      this.db.prepare('DELETE FROM bot_roles WHERE bot_id = ?').run(id);
      this.db.prepare('DELETE FROM bot_channels WHERE bot_id = ?').run(id);
      this.db.prepare('DELETE FROM bot_audit_logs WHERE bot_id = ?').run(id);
    }
    return result.changes > 0;
  }

  createBotChannel(botId: string, channelKey: BotChannelKey, displayName: string, config: BotChannelSettings): BotChannel {
    const now = new Date().toISOString();
    const channel: BotChannel = {
      id: uuidv4(),
      botId,
      channelKey,
      displayName,
      config,
      createdAt: now,
      updatedAt: now,
    };
    const encrypted = encryptChannelSettings(config);
    this.db.prepare(`
      INSERT INTO bot_channels (id, bot_id, channel_key, display_name, config_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(channel.id, channel.botId, channel.channelKey, channel.displayName, JSON.stringify(encrypted), channel.createdAt, channel.updatedAt);
    return channel;
  }

  getBotChannel(id: string): BotChannel | null {
    const row = this.db.prepare('SELECT * FROM bot_channels WHERE id = ?').get(id) as RawBotChannelRow | undefined;
    return row ? parseBotChannelRow(row) : null;
  }

  getBotChannelByKey(botId: string, channelKey: BotChannelKey): BotChannel | null {
    const row = this.db.prepare('SELECT * FROM bot_channels WHERE bot_id = ? AND channel_key = ?').get(botId, channelKey) as RawBotChannelRow | undefined;
    return row ? parseBotChannelRow(row) : null;
  }

  listBotChannels(botId: string): BotChannel[] {
    const rows = this.db.prepare('SELECT * FROM bot_channels WHERE bot_id = ? ORDER BY created_at').all(botId) as RawBotChannelRow[];
    return rows.map(parseBotChannelRow);
  }

  updateBotChannel(id: string, config: BotChannelSettings): BotChannel | null {
    const existing = this.getBotChannel(id);
    if (!existing) return null;
    const now = new Date().toISOString();
    const encrypted = encryptChannelSettings(config);
    this.db.prepare(`
      UPDATE bot_channels SET config_json = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(encrypted), now, id);
    return { ...existing, config, updatedAt: now };
  }

  deleteBotChannel(id: string): boolean {
    const result = this.db.prepare('DELETE FROM bot_channels WHERE id = ?').run(id);
    return result.changes > 0;
  }

  createBotRole(botId: string, roleKey: BotRoleKey, permissions: BotRolePolicy, persona?: BotPersona): BotRole {
    const now = new Date().toISOString();
    const role: BotRole = {
      id: uuidv4(),
      botId,
      roleKey,
      permissions,
      persona,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO bot_roles (id, bot_id, role_key, permissions_json, persona_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(role.id, role.botId, role.roleKey, JSON.stringify(role.permissions), role.persona ? JSON.stringify(role.persona) : null, role.createdAt, role.updatedAt);
    return role;
  }

  getBotRole(id: string): BotRole | null {
    const row = this.db.prepare('SELECT * FROM bot_roles WHERE id = ?').get(id) as RawBotRoleRow | undefined;
    return row ? parseBotRoleRow(row) : null;
  }

  getBotRoleByKey(botId: string, roleKey: BotRoleKey): BotRole | null {
    const row = this.db.prepare('SELECT * FROM bot_roles WHERE bot_id = ? AND role_key = ?').get(botId, roleKey) as RawBotRoleRow | undefined;
    return row ? parseBotRoleRow(row) : null;
  }

  listBotRoles(botId: string): BotRole[] {
    const rows = this.db.prepare('SELECT * FROM bot_roles WHERE bot_id = ? ORDER BY created_at').all(botId) as RawBotRoleRow[];
    return rows.map(parseBotRoleRow);
  }

  updateBotRole(id: string, permissions: BotRolePolicy, persona?: BotPersona | null): BotRole | null {
    const existing = this.getBotRole(id);
    if (!existing) return null;
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE bot_roles SET permissions_json = ?, persona_json = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(permissions), persona ? JSON.stringify(persona) : null, now, id);
    return { ...existing, permissions, persona: persona ?? undefined, updatedAt: now };
  }

  deleteBotRole(id: string): boolean {
    const result = this.db.prepare('DELETE FROM bot_roles WHERE id = ?').run(id);
    return result.changes > 0;
  }

  createBotUser(input: CreateBotUserInput): BotUser {
    const now = new Date().toISOString();
    const roleRow = this.db.prepare('SELECT role_key FROM bot_roles WHERE id = ?').get(input.roleId) as { role_key: string } | undefined;
    const roleKey = (roleRow?.role_key ?? 'normal') as import('../models/bot.js').BotRoleKey;
    const channelRow = this.db.prepare('SELECT channel_key FROM bot_channels WHERE id = ?').get(input.channelId) as { channel_key: string } | undefined;
    const channelKey = (channelRow?.channel_key ?? 'wecom') as import('../models/bot.js').BotChannelKey;
    const user: BotUser = {
      id: uuidv4(),
      botId: input.botId,
      channelId: input.channelId,
      channelKey,
      roleId: input.roleId,
      channelUserId: input.channelUserId,
      plaintextUserId: input.plaintextUserId ?? null,
      createdAt: now,
      updatedAt: now,
      roleKey,
      resolutionStatus: input.plaintextUserId ? 'resolved' : 'pending',
    };
    this.db.prepare(`
      INSERT INTO bot_users (id, bot_id, channel_id, role_id, channel_user_id, plaintext_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(user.id, user.botId, user.channelId, user.roleId, user.channelUserId, user.plaintextUserId, user.createdAt, user.updatedAt);
    return user;
  }

  getBotUser(id: string): BotUser | null {
    const row = this.db.prepare('SELECT * FROM bot_users WHERE id = ?').get(id) as RawBotUserRow | undefined;
    return row ? parseBotUserRow(row, this.db) : null;
  }

  getBotUserByChannelIdentity(botId: string, channelId: string, channelUserId: string): BotUser | null {
    const row = this.db.prepare(`
      SELECT * FROM bot_users WHERE bot_id = ? AND channel_id = ? AND channel_user_id = ?
    `).get(botId, channelId, channelUserId) as RawBotUserRow | undefined;
    return row ? parseBotUserRow(row, this.db) : null;
  }

  listBotUsers(botId: string): BotUser[] {
    const rows = this.db.prepare('SELECT * FROM bot_users WHERE bot_id = ? ORDER BY created_at').all(botId) as RawBotUserRow[];
    return rows.map((r) => parseBotUserRow(r, this.db));
  }

  listBotUsersByChannel(botId: string, channelId: string): BotUser[] {
    const rows = this.db.prepare('SELECT * FROM bot_users WHERE bot_id = ? AND channel_id = ? ORDER BY created_at').all(botId, channelId) as RawBotUserRow[];
    return rows.map((r) => parseBotUserRow(r, this.db));
  }

  getBotUserByPlaintext(plaintextUserId: string): BotUser | null {
    const row = this.db.prepare('SELECT * FROM bot_users WHERE plaintext_user_id = ? LIMIT 1').get(plaintextUserId) as RawBotUserRow | undefined;
    return row ? parseBotUserRow(row, this.db) : null;
  }

  updateBotUser(id: string, input: UpdateBotUserInput): BotUser | null {
    const existing = this.getBotUser(id);
    if (!existing) return null;
    const sets: string[] = [];
    const values: unknown[] = [];
    if (input.roleId !== undefined) {
      sets.push('role_id = ?');
      values.push(input.roleId);
    }
    if (input.plaintextUserId !== undefined) {
      sets.push('plaintext_user_id = ?');
      values.push(input.plaintextUserId);
    }
    if (sets.length === 0) return existing;
    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);
    this.db.prepare(`UPDATE bot_users SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getBotUser(id);
  }

  deleteBotUser(id: string): boolean {
    this.db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(id);
    const result = this.db.prepare('DELETE FROM bot_users WHERE id = ?').run(id);
    return result.changes > 0;
  }

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

  getMigrationVersion(): number | null {
    const row = this.db
      .prepare('SELECT version FROM bot_migration_state WHERE id = 1')
      .get() as { version: number } | undefined;
    return row?.version ?? null;
  }

  getMigrationState(): { version: number | null; runAt: string | null; snapshot: Record<string, unknown> } {
    const row = this.db
      .prepare('SELECT version, run_at, snapshot_json FROM bot_migration_state WHERE id = 1')
      .get() as { version: number | null; run_at: string | null; snapshot_json: string | null } | undefined;
    return {
      version: row?.version ?? null,
      runAt: row?.run_at ?? null,
      snapshot: row?.snapshot_json ? safeJsonParse(row.snapshot_json, {}) : {},
    };
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

  setSessionBotId(sessionId: string, botId: string): void {
    this.db.prepare('UPDATE sessions SET bot_id = ? WHERE id = ?').run(botId, sessionId);
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
    source: (row.source as 'gui' | 'wecom' | 'feishu') ?? undefined,
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
  persona_json: string | null;
  created_at: string;
  updated_at: string;
}

function parseBotRow(row: RawBotRow): Bot {
  return {
    id: row.id,
    name: row.name,
    activeWorkspaceId: row.active_workspace_id,
    persona: row.persona_json ? safeJsonParse(row.persona_json, undefined as unknown as BotPersona) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface RawBotChannelRow {
  id: string;
  bot_id: string;
  channel_key: string;
  display_name: string;
  config_json: string;
  created_at: string;
  updated_at: string;
}

function parseBotChannelRow(row: RawBotChannelRow): BotChannel {
  const encryptedConfig = safeJsonParse(row.config_json, {} as BotChannelSettings);
  return {
    id: row.id,
    botId: row.bot_id,
    channelKey: row.channel_key as BotChannelKey,
    displayName: row.display_name,
    config: decryptChannelSettings(encryptedConfig),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface RawBotRoleRow {
  id: string;
  bot_id: string;
  role_key: string;
  permissions_json: string;
  persona_json: string | null;
  created_at: string;
  updated_at: string;
}

function parseBotRoleRow(row: RawBotRoleRow): BotRole {
  return {
    id: row.id,
    botId: row.bot_id,
    roleKey: row.role_key as BotRoleKey,
    permissions: safeJsonParse(row.permissions_json, {
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface RawBotUserRow {
  id: string;
  bot_id: string;
  channel_id: string;
  role_id: string;
  channel_user_id: string;
  plaintext_user_id: string | null;
  created_at: string;
  updated_at: string;
}

function parseBotUserRow(row: RawBotUserRow, db: Database.Database): BotUser {
  const roleRow = db.prepare('SELECT role_key FROM bot_roles WHERE id = ?').get(row.role_id) as { role_key: string } | undefined;
  const channelRow = db.prepare('SELECT channel_key FROM bot_channels WHERE id = ?').get(row.channel_id) as { channel_key: string } | undefined;
  return {
    id: row.id,
    botId: row.bot_id,
    channelId: row.channel_id,
    channelKey: (channelRow?.channel_key ?? 'wecom') as BotChannelKey,
    roleId: row.role_id,
    channelUserId: row.channel_user_id,
    plaintextUserId: row.plaintext_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    roleKey: (roleRow?.role_key ?? 'normal') as BotRoleKey,
    resolutionStatus: row.plaintext_user_id ? 'resolved' : 'pending',
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
