import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { Workspace, WorkspaceSettings, CreateWorkspaceInput, UpdateWorkspaceInput, BrowserSiteAuthEntry, BrowserSiteAuthStoredEntry } from '../models/workspace.js';
import { BrowserSiteAuthReadError, decodeSiteAuthEntry, encodeSiteAuthEntry, isEncryptedSiteAuthEntry } from '../services/browser-site-auth.js';
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
import type { Todo, CreateTodoInput, UpdateTodoInput, TodoStatus, TodoOrigin, TodoComment, TodoConflict, TodoExecutionStatus } from '../models/todo.js';
import type { TodoRun, CreateTodoRunInput, UpdateTodoRunInput, TodoRunStatus } from '../models/todo-run.js';
import { sanitizeBotRolePolicy, createDefaultBotRolePolicy } from '../services/bot-access-policy.js';
import type { Provider, CreateProviderInput, UpdateProviderInput } from '../models/provider.js';
import { providerSupportsFastMode } from '../utils/provider-capability.js';
import type { WeComProactiveMessage, CreateProactiveMessageInput, ProactiveMessageStatus, UpdateProactiveMessageInput } from '../models/wecom-proactive-message.js';
import type { WeComMediaCacheEntry, CreateWeComMediaCacheInput } from '../models/wecom-media-cache.js';
import type {
  ScheduledTask,
  CreateScheduledTaskInput,
  UpdateScheduledTaskInput,
  ListScheduledTasksOptions,
  ScheduledTaskStatus,
  TaskRun,
  CreateTaskRunInput,
  UpdateTaskRunInput,
  TaskRunStatus,
  ConfirmedTaskSnapshot,
} from '../models/scheduled-task.js';
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
    if (!workspaceColumns.some(col => col.name === 'last_turn_started_at')) {
      // Activity sort stability (KTD1): per-item MRU ordering key, epoch ms.
      this.db.exec('ALTER TABLE workspaces ADD COLUMN last_turn_started_at INTEGER');
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_migration_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        run_at TEXT NOT NULL,
        snapshot_json TEXT NOT NULL DEFAULT '{}'
      )
    `);
    // KTD5: app-global singleton row. The encrypted GitHub connection blob
    // (credential-crypto ciphertext of the access+refresh token bundle — never
    // plaintext) lives here; WorkspaceSettings carries only public repo names.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        github_connection_json TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT ''
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
    // browser_audit (U8, KTD-9): positive-shape action audit for the embedded
    // browser. Field-level contract — tool names / categories / URL origins /
    // field NAMES only; field values and images are never persisted (the
    // bot-audit ">32 chars" redaction heuristic would mangle URLs, so this
    // table's contract is structural: there is no values column at all).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS browser_audit (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        session_id TEXT,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        origin TEXT,
        site_key TEXT,
        field_names TEXT NOT NULL DEFAULT '[]',
        outcome TEXT NOT NULL,
        potential_submit INTEGER NOT NULL DEFAULT 0,
        detail TEXT,
        created_at TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_browser_audit_workspace_created
        ON browser_audit (workspace_id, created_at DESC)
    `);
    // Browser mutation ledger (U8/KTD6-KTD7). Its shape is deliberately
    // private and minimal: the only parameter-derived value is the replay
    // binding digest. There are no raw parameter, page text, URL, path,
    // filename, or exception columns.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS browser_operation_ledger (
        operation_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        runtime_generation TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        action TEXT NOT NULL,
        parameter_digest TEXT NOT NULL,
        state TEXT NOT NULL,
        receipt_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (principal_id, operation_id)
      )
    `);
    this.ensureBrowserOperationLedgerPrincipalScope();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_browser_operation_session_state
        ON browser_operation_ledger (session_id, state, created_at)
    `);
    // Goal-scoped browser task state. Every column is positive-shape: no page
    // prose, authored values, URLs, coordinates, pixels, or filenames fit.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS browser_task_heads (
        workspace_id TEXT NOT NULL, session_id TEXT NOT NULL,
        task_id TEXT NOT NULL, goal_epoch TEXT NOT NULL,
        PRIMARY KEY (workspace_id, session_id)
      );
      CREATE TABLE IF NOT EXISTS browser_tasks (
        task_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL,
        principal_id TEXT NOT NULL, goal_epoch TEXT NOT NULL,
        runtime_generation TEXT NOT NULL, capability_id TEXT NOT NULL,
        version INTEGER NOT NULL, lifecycle TEXT NOT NULL,
        observation_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS browser_task_slots (
        task_id TEXT NOT NULL, slot_key TEXT NOT NULL,
        discovery TEXT NOT NULL, required INTEGER NOT NULL,
        population TEXT NOT NULL, validation TEXT NOT NULL, authority TEXT NOT NULL,
        population_bucket TEXT NOT NULL, evidence_id TEXT, observation_epoch INTEGER,
        pending_operation_id TEXT, baseline_observation_epoch INTEGER,
        baseline_observation_id TEXT, baseline_document_identity TEXT, baseline_structural_checksum TEXT,
        pending_target_binding TEXT, pending_runtime_generation TEXT,
        pending_capability_id TEXT, pending_control_epoch TEXT, pending_evidence_class TEXT,
        PRIMARY KEY (task_id, slot_key)
      );
      CREATE TABLE IF NOT EXISTS browser_task_bindings (
        task_id TEXT NOT NULL, purpose TEXT NOT NULL, key_version INTEGER NOT NULL,
        binding_digest TEXT NOT NULL, PRIMARY KEY (task_id, purpose)
      );
      CREATE TABLE IF NOT EXISTS browser_task_recoveries (
        task_id TEXT NOT NULL, task_version INTEGER NOT NULL,
        target_binding_digest TEXT NOT NULL, failure_class TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        PRIMARY KEY (task_id, task_version, target_binding_digest, failure_class)
      );
      CREATE TABLE IF NOT EXISTS browser_final_actions (
        operation_id TEXT NOT NULL, task_id TEXT NOT NULL, task_version INTEGER NOT NULL,
        slot_key TEXT NOT NULL, target_binding_digest TEXT NOT NULL, control_epoch TEXT NOT NULL,
        review_key_version INTEGER NOT NULL, review_binding_digest TEXT NOT NULL,
        predicate_key_version INTEGER NOT NULL, predicate_binding_digest TEXT NOT NULL,
        state TEXT NOT NULL, evidence_status TEXT NOT NULL DEFAULT 'none',
        durable_evidence_id TEXT, last_checked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (task_id, operation_id)
      );
      CREATE INDEX IF NOT EXISTS idx_browser_tasks_session ON browser_tasks (workspace_id, session_id);
      CREATE INDEX IF NOT EXISTS idx_browser_final_actions_task ON browser_final_actions (task_id, updated_at);
    `);
    this.ensureBrowserTaskCausalColumns();
    // bot_escalation_ledger (U8 phase-2, KTD-16): persistent approval ledger
    // for out-of-sandbox escalation requests. One row per pending approval
    // (id = the approval requestId); the row is the durable record a boot
    // recovery pass can expire (fail-closed) when the process died with
    // approvals still pending.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_escalation_ledger (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        audience TEXT NOT NULL,
        requester_channel TEXT NOT NULL,
        requester_channel_user_id TEXT NOT NULL,
        requester_role TEXT,
        recipients_json TEXT NOT NULL DEFAULT '[]',
        rule_payload_json TEXT NOT NULL DEFAULT '{}',
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        resolved_at TEXT,
        resolution_json TEXT
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_bot_escalation_ledger_state
        ON bot_escalation_ledger (state, bot_id)
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
        fast_mode INTEGER NOT NULL DEFAULT 0,
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
    if (!sessionColumns.some(col => col.name === 'backend')) {
      // KTD-9: sessions lock to an agent backend at first runtime; legacy
      // rows read as undefined and resolve to claude (grandfathered).
      this.db.exec('ALTER TABLE sessions ADD COLUMN backend TEXT');
    }
    if (!sessionColumns.some(col => col.name === 'backend_session_id')) {
      // The backend-side session identifier (e.g. opencode ses_*), so a
      // resumed runtime reattaches to the same remote session (U4).
      this.db.exec('ALTER TABLE sessions ADD COLUMN backend_session_id TEXT');
    }
    if (!sessionColumns.some(col => col.name === 'bot_id')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN bot_id TEXT');
    }
    if (!sessionColumns.some(col => col.name === 'is_archived')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0');
    }
    if (!sessionColumns.some(col => col.name === 'fast_mode')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN fast_mode INTEGER NOT NULL DEFAULT 0');
    }
    if (!sessionColumns.some(col => col.name === 'last_turn_started_at')) {
      // Activity sort stability (KTD1): per-item MRU ordering key, epoch ms.
      this.db.exec('ALTER TABLE sessions ADD COLUMN last_turn_started_at INTEGER');
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
    // Global (app-level) remembered site-auth: a captured web-login session
    // context keyed by site, reusable across workspaces (e.g. the Kimi login
    // captured for usage also auto-fills the chat browser). Server-only — the
    // entry JSON is never returned to clients.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS global_site_auth (
        site_key TEXT PRIMARY KEY,
        entry_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        workspace_id TEXT,
        text TEXT NOT NULL,
        content TEXT,
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
        origin_deleted INTEGER NOT NULL DEFAULT 0,
        execution_type TEXT NOT NULL DEFAULT 'manual',
        instruction TEXT,
        schedule_time TEXT,
        cron_expr TEXT,
        execution_status TEXT NOT NULL DEFAULT 'active',
        next_fire_at TEXT,
        notify_desktop INTEGER NOT NULL DEFAULT 1,
        notify_in_app INTEGER NOT NULL DEFAULT 1,
        notify_wecom INTEGER NOT NULL DEFAULT 0,
        wecom_recipient TEXT,
        confirmed_snapshot TEXT,
        deleted_at TEXT,
        legacy_scheduled_task_id TEXT UNIQUE
      )
    `);
    // KTD4: additive `content` column (nullable markdown body). Idempotent on
    // column existence; fresh DBs have it from the CREATE above, and the rebuild
    // migrations below also declare it, so this ADD COLUMN is the backfill path
    // for v7-shape DBs that predate the column.
    const todoColumns = this.db.prepare("PRAGMA table_info(todos)").all() as { name: string }[];
    if (!todoColumns.some((col) => col.name === 'content')) {
      this.db.exec('ALTER TABLE todos ADD COLUMN content TEXT');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS repo_sync_state (
        repo_full_name TEXT PRIMARY KEY,
        repo_last_updated_at TEXT,
        etag TEXT
      )
    `);
    // U5: append-only comments (bidirectional merge, R10) + structural-field
    // conflicts (R11, detected by U5, resolved by U6). Additive, idempotent.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS todo_comments (
        id TEXT PRIMARY KEY,
        todo_id TEXT NOT NULL,
        origin TEXT NOT NULL,
        remote_id INTEGER,
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        pushed INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS todo_conflicts (
        todo_id TEXT NOT NULL,
        field TEXT NOT NULL,
        local_value TEXT NOT NULL,
        remote_value TEXT NOT NULL,
        baseline_value TEXT,
        detected_at TEXT NOT NULL,
        PRIMARY KEY (todo_id, field)
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
    // Scheduled tasks (U2, KTD-2): task definitions + per-fire run records.
    // Deletion is a soft delete (deleted_at); list and scheduler queries read
    // only non-deleted rows, while run history stays traceable through the
    // retained task definition.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        instruction TEXT NOT NULL,
        schedule_type TEXT NOT NULL,
        schedule_time TEXT,
        cron_expr TEXT,
        notify_desktop INTEGER NOT NULL DEFAULT 1,
        notify_in_app INTEGER NOT NULL DEFAULT 1,
        notify_wecom INTEGER NOT NULL DEFAULT 0,
        wecom_recipient TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        deleted_at TEXT,
        confirmed_snapshot TEXT,
        next_fire_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    // Confirmation-gate removal: tasks created as drafts before the gate was
    // removed are activated (their creation intent is honored).
    this.db.exec(`UPDATE scheduled_tasks SET status = 'active' WHERE status = 'draft'`);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_workspace
        ON scheduled_tasks (workspace_id, deleted_at)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_fire
        ON scheduled_tasks (status, next_fire_at)
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL,
        fire_at TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        reason TEXT,
        instruction_snapshot TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_task_runs_task_created
        ON task_runs (task_id, created_at DESC)
    `);
    // Loopback capability tokens (U12, KTD-28): per-session Bearer tokens for
    // the sandbox-reachable API surface. Only the SHA-256 hash of the token is
    // stored — a database dump never leaks a usable credential. Tokens are
    // boot-invalidated by the session-capability service, so rows here are
    // per-boot runtime artifacts, not durable state.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_capability_tokens (
        token_hash TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        bot_id TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_capability_tokens_session
        ON session_capability_tokens (session_id, revoked_at)
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
    this.migrateBrowserAuditSchema();
    this.migrateTodosGlobalSchema();
    this.migrateTodoContentColumn();
    this.migrateTodoExecutionSchema();
    this.migrateBotEscalationLedgerSchema();
    this.migrateBrowserOperationLedgerSchema();
    this.backfillLastTurnStartedAt();
  }

  private migrateTodoExecutionSchema(): void {
    const columns = this.db.prepare('PRAGMA table_info(todos)').all() as Array<{ name: string }>;
    const add = (name: string, sql: string): void => {
      if (!columns.some((column) => column.name === name)) this.db.exec(sql);
    };
    add('execution_type', "ALTER TABLE todos ADD COLUMN execution_type TEXT NOT NULL DEFAULT 'manual'");
    add('instruction', 'ALTER TABLE todos ADD COLUMN instruction TEXT');
    add('schedule_time', 'ALTER TABLE todos ADD COLUMN schedule_time TEXT');
    add('cron_expr', 'ALTER TABLE todos ADD COLUMN cron_expr TEXT');
    add('execution_status', "ALTER TABLE todos ADD COLUMN execution_status TEXT NOT NULL DEFAULT 'active'");
    add('next_fire_at', 'ALTER TABLE todos ADD COLUMN next_fire_at TEXT');
    add('notify_desktop', 'ALTER TABLE todos ADD COLUMN notify_desktop INTEGER NOT NULL DEFAULT 1');
    add('notify_in_app', 'ALTER TABLE todos ADD COLUMN notify_in_app INTEGER NOT NULL DEFAULT 1');
    add('notify_wecom', 'ALTER TABLE todos ADD COLUMN notify_wecom INTEGER NOT NULL DEFAULT 0');
    add('wecom_recipient', 'ALTER TABLE todos ADD COLUMN wecom_recipient TEXT');
    add('confirmed_snapshot', 'ALTER TABLE todos ADD COLUMN confirmed_snapshot TEXT');
    add('deleted_at', 'ALTER TABLE todos ADD COLUMN deleted_at TEXT');
    add('legacy_scheduled_task_id', 'ALTER TABLE todos ADD COLUMN legacy_scheduled_task_id TEXT');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_legacy_scheduled_task ON todos (legacy_scheduled_task_id) WHERE legacy_scheduled_task_id IS NOT NULL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS todo_runs (
      id TEXT PRIMARY KEY, todo_id TEXT NOT NULL, session_id TEXT, status TEXT NOT NULL,
      fire_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, reason TEXT,
      instruction_snapshot TEXT NOT NULL, created_at TEXT NOT NULL,
      legacy_source_key TEXT UNIQUE
    )`);
    const runColumns = this.db.prepare('PRAGMA table_info(todo_runs)').all() as Array<{ name: string }>;
    if (!runColumns.some((column) => column.name === 'legacy_source_key')) {
      this.db.exec('ALTER TABLE todo_runs ADD COLUMN legacy_source_key TEXT');
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_todo_runs_legacy_source ON todo_runs (legacy_source_key) WHERE legacy_source_key IS NOT NULL');
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_todo_runs_todo_created ON todo_runs (todo_id, created_at DESC)');
    this.db.transaction(() => this.copyLegacyScheduledTasksToTodos())();
    const previous = this.getMigrationState().snapshot;
    this.setMigrationState(Math.max(this.getMigrationVersion() ?? 0, 9), new Date().toISOString(), {
      ...previous,
      todo_execution_schema: true,
    });
  }

  /**
   * Copy-only compatibility migration. `scheduled_tasks` and `task_runs` stay
   * intact so a pre-unification database can always be inspected or recovered.
   * The source-key columns make a repeated app start a no-op.
   */
  private copyLegacyScheduledTasksToTodos(): void {
    this.db.prepare("UPDATE todos SET status = 'pending' WHERE status = 'did-but-need-verify'").run();
    const scheduledRows = this.db.prepare('SELECT * FROM scheduled_tasks').all() as RawScheduledTaskRow[];
    const findTodo = this.db.prepare('SELECT id FROM todos WHERE legacy_scheduled_task_id = ?');
    const idExists = this.db.prepare('SELECT 1 FROM todos WHERE id = ?');
    const insertTodo = this.db.prepare(`
      INSERT INTO todos (
        id, workspace_id, text, content, status, session_id, created_at, updated_at,
        origin, due_date, repo_full_name, issue_number, remote_snapshot_json,
        remote_updated_at, last_synced_at, assignee, labels_json, origin_deleted,
        execution_type, instruction, schedule_time, cron_expr, execution_status,
        next_fire_at, notify_desktop, notify_in_app, notify_wecom, wecom_recipient,
        confirmed_snapshot, deleted_at, legacy_scheduled_task_id
      ) VALUES (?, ?, ?, NULL, ?, NULL, ?, ?, 'local', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '[]', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const task of scheduledRows) {
      if (findTodo.get(task.id)) continue;
      // Preserve source IDs whenever possible. In the practically impossible
      // collision case, retain the legacy ID in `legacy_scheduled_task_id` and
      // use a fresh Todo ID rather than overwriting an unrelated Todo.
      const todoId = idExists.get(task.id) ? uuidv4() : task.id;
      insertTodo.run(
        todoId, task.workspace_id, task.name,
        task.deleted_at ? 'discard' : 'pending', task.created_at, task.updated_at,
        task.schedule_type, task.instruction, task.schedule_time, task.cron_expr,
        task.status, task.next_fire_at, task.notify_desktop, task.notify_in_app,
        task.notify_wecom, task.wecom_recipient, task.confirmed_snapshot,
        task.deleted_at, task.id,
      );
    }

    const taskTodoId = this.db.prepare('SELECT id FROM todos WHERE legacy_scheduled_task_id = ?');
    const legacyRuns = this.db.prepare('SELECT * FROM task_runs').all() as RawTaskRunRow[];
    const existingRun = this.db.prepare('SELECT 1 FROM todo_runs WHERE legacy_source_key = ?');
    const runIdExists = this.db.prepare('SELECT 1 FROM todo_runs WHERE id = ?');
    const insertRun = this.db.prepare(`
      INSERT INTO todo_runs (
        id, todo_id, session_id, status, fire_at, started_at, ended_at, reason,
        instruction_snapshot, created_at, legacy_source_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const run of legacyRuns) {
      const sourceKey = `scheduled-run:${run.id}`;
      if (existingRun.get(sourceKey)) continue;
      const parent = taskTodoId.get(run.task_id) as { id: string } | undefined;
      if (!parent) throw new Error(`Cannot migrate task run ${run.id}: scheduled task ${run.task_id} has no mapped Todo`);
      insertRun.run(
        runIdExists.get(run.id) ? uuidv4() : run.id, parent.id, run.session_id, run.status,
        run.fire_at, run.started_at, run.ended_at, run.reason, run.instruction_snapshot,
        run.created_at, sourceKey,
      );
    }

    const legacyTodoSessions = this.db.prepare('SELECT * FROM todos WHERE session_id IS NOT NULL').all() as RawTodoRow[];
    for (const todo of legacyTodoSessions) {
      const sourceKey = `todo-session:${todo.id}:${todo.session_id}`;
      if (existingRun.get(sourceKey)) continue;
      insertRun.run(
        uuidv4(), todo.id, todo.session_id, 'succeeded', todo.updated_at,
        todo.created_at, todo.updated_at, null,
        todo.instruction ?? todo.content ?? todo.text, todo.updated_at, sourceKey,
      );
    }

    const copiedTaskCount = (this.db.prepare('SELECT COUNT(*) AS count FROM todos WHERE legacy_scheduled_task_id IS NOT NULL').get() as { count: number }).count;
    if (copiedTaskCount !== scheduledRows.length) {
      throw new Error(`Scheduled task migration validation failed: expected ${scheduledRows.length} Todos, found ${copiedTaskCount}`);
    }
    const copiedRunCount = (this.db.prepare("SELECT COUNT(*) AS count FROM todo_runs WHERE legacy_source_key LIKE 'scheduled-run:%'").get() as { count: number }).count;
    if (copiedRunCount !== legacyRuns.length) {
      throw new Error(`Task run migration validation failed: expected ${legacyRuns.length} Runs, found ${copiedRunCount}`);
    }
  }

  /**
   * Schema version 6 (U8): the browser_audit table. The CREATE TABLE above is
   * idempotent and covers both fresh and existing databases; this step only
   * records the version bump so the schema lineage is inspectable. The prior
   * migration's diagnostic snapshot is preserved (merged, not replaced).
   */
  private migrateBrowserAuditSchema(): void {
    const version = this.getMigrationVersion();
    if (version !== null && version >= 6) {
      return;
    }
    const previous = this.getMigrationState().snapshot;
    this.setMigrationState(6, new Date().toISOString(), {
      ...previous,
      browser_audit_schema: true,
    });
  }

  /**
   * Schema version 7 (U1): make todos global. `workspace_id` becomes nullable
   * (a soft link), and sync/due-date/origin columns are added. Mirrors the safe
   * `migrateToUnifiedSchema` shape (file backup, explicit transaction, version
   * bump inside the txn, count verification, re-throw) — NOT the bare-exec
   * `migrateTodoDetailColumn`. The gate keys on table shape (not row count) so
   * fresh/empty DBs created with the new base CREATE skip the rebuild.
   */
  private migrateTodosGlobalSchema(): void {
    const version = this.getMigrationVersion();
    if (version !== null && version >= 7) {
      return;
    }

    const cols = this.db.prepare('PRAGMA table_info(todos)').all() as Array<{ name: string; notnull: number }>;
    const hasOrigin = cols.some((c) => c.name === 'origin');
    const workspaceIdCol = cols.find((c) => c.name === 'workspace_id');
    const alreadyNewShape = hasOrigin && workspaceIdCol != null && workspaceIdCol.notnull === 0;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS repo_sync_state (
        repo_full_name TEXT PRIMARY KEY,
        repo_last_updated_at TEXT,
        etag TEXT
      )
    `);

    if (alreadyNewShape) {
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_repo_issue
          ON todos (repo_full_name, issue_number)
          WHERE repo_full_name IS NOT NULL AND issue_number IS NOT NULL
      `);
      const prev = this.getMigrationState().snapshot;
      this.setMigrationState(7, new Date().toISOString(), { ...prev, todos_global_schema: 'already_new_shape' });
      return;
    }

    if (!this.inMemory) {
      const backupDir = join(STORAGE_DIR, 'backup');
      ensureDirSync(backupDir);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = join(backupDir, `pre-todos-global-${timestamp}.db`);
      try {
        copyFileSync(DB_FILE, backupPath);
        console.log(`[SqliteStore] Created pre-migration backup: ${backupPath}`);
      } catch (err) {
        console.error('[SqliteStore] Failed to create pre-migration backup:', err);
      }
    }

    // Snapshot existing indexes (by sql) to re-create on the rebuilt table.
    const oldIndexes = this.db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'todos' AND sql IS NOT NULL")
      .all() as Array<{ name: string; sql: string }>;

    const nowIso = new Date().toISOString();

    const migrate = this.db.transaction(() => {
      this.db.exec('ALTER TABLE todos RENAME TO todos_old;');
      this.db.exec(`
        CREATE TABLE todos (
          id TEXT PRIMARY KEY,
          workspace_id TEXT,
          text TEXT NOT NULL,
          content TEXT,
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
        );
      `);
      const oldCount = (this.db.prepare('SELECT COUNT(*) AS c FROM todos_old').get() as { c: number }).c;
      this.db.exec(`
        INSERT INTO todos (
          id, workspace_id, text, status, session_id, created_at, updated_at,
          origin, due_date, repo_full_name, issue_number, remote_snapshot_json,
          remote_updated_at, last_synced_at, assignee, labels_json, origin_deleted
        )
        SELECT
          id, workspace_id, text, status, session_id, created_at, updated_at,
          'local', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '[]', 0
        FROM todos_old;
      `);
      const newCount = (this.db.prepare('SELECT COUNT(*) AS c FROM todos').get() as { c: number }).c;
      if (oldCount !== newCount) {
        throw new Error(`todos global migration count mismatch: ${oldCount} -> ${newCount}`);
      }
      this.db.exec('DROP TABLE todos_old;');
      for (const idx of oldIndexes) {
        try {
          this.db.exec(idx.sql);
        } catch {
          /* index name collision on the rebuilt table; ignore */
        }
      }
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_repo_issue
          ON todos (repo_full_name, issue_number)
          WHERE repo_full_name IS NOT NULL AND issue_number IS NOT NULL
      `);

      const prev = this.getMigrationState().snapshot;
      this.setMigrationState(7, nowIso, { ...prev, todos_global_schema: 'rebuilt', todosCount: newCount });
    });

    try {
      migrate();
      console.log('[SqliteStore] Todos global schema migration completed');
    } catch (err) {
      console.error('[SqliteStore] Todos global schema migration failed:', err);
      throw err;
    }
  }

  /**
   * Schema version 8 (U8): add a nullable content column to todos for long-form
   * detail text. Existing rows keep a NULL content.
   */
  private migrateTodoContentColumn(): void {
    const version = this.getMigrationVersion();
    if (version !== null && version >= 8) {
      return;
    }

    const cols = this.db.prepare('PRAGMA table_info(todos)').all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === 'content')) {
      const prev = this.getMigrationState().snapshot;
      this.setMigrationState(8, new Date().toISOString(), { ...prev, todo_content_column: 'already_present' });
      return;
    }

    try {
      this.db.exec(`ALTER TABLE todos ADD COLUMN content TEXT`);
      const prev = this.getMigrationState().snapshot;
      this.setMigrationState(8, new Date().toISOString(), { ...prev, todo_content_column: 'added' });
      console.log('[SqliteStore] Added todos.content column');
    } catch (err) {
      console.error('[SqliteStore] Failed to add todos.content column:', err);
      throw err;
    }
  }

  /**
   * Schema version 10 (U8 phase-2, KTD-16): the bot_escalation_ledger table.
   * The CREATE TABLE above is idempotent and covers both fresh and existing
   * databases; this step only records the version bump so the schema lineage
   * is inspectable (mirrors migrateBrowserAuditSchema).
   */
  private migrateBotEscalationLedgerSchema(): void {
    const version = this.getMigrationVersion();
    if (version !== null && version >= 10) {
      return;
    }
    const previous = this.getMigrationState().snapshot;
    this.setMigrationState(10, new Date().toISOString(), {
      ...previous,
      bot_escalation_ledger_schema: true,
    });
  }

  private migrateBrowserOperationLedgerSchema(): void {
    const version = this.getMigrationVersion();
    if (version !== null && version >= 11) return;
    const previous = this.getMigrationState().snapshot;
    this.setMigrationState(11, new Date().toISOString(), {
      ...previous,
      browser_operation_ledger_schema: true,
    });
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

  close(): void {
    this.db.close();
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
          content TEXT,
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

  /**
   * Activity sort stability (U1, KTD1): every successful construction must
   * converge to zero NULL ordering keys, so this pass is unconditional and
   * NULL-guarded — it heals pre-upgrade rows, interrupted first runs, rows
   * written by a downgraded binary, and any insert path that forgets the
   * column (including the legacy-JSON migrations, which deliberately stay
   * key-less and are covered by this pass's placement at the end of the
   * constructor chain). Both UPDATEs run in one transaction.
   *
   * Expressions are epoch ms, matching the last_modified scale: unixepoch()
   * returns seconds, so the `* 1000` is load-bearing, and the terminal 0
   * guarantees convergence on NULL, empty, or malformed legacy timestamps.
   * The sessions COALESCE priority mirrors the pre-upgrade client comparator
   * (lastModified ?? Date.parse(updatedAt)). Workspaces compute from the RAW
   * session columns (never the sessions' backfilled output), so each pass is
   * independently correct and re-runnable in any order.
   */
  private backfillLastTurnStartedAt(): void {
    try {
      const backfill = this.db.transaction(() => {
        const sessionsResult = this.db.prepare(`
          UPDATE sessions
          SET last_turn_started_at = COALESCE(
            last_modified,
            unixepoch(updated_at) * 1000,
            unixepoch(created_at) * 1000,
            0
          )
          WHERE last_turn_started_at IS NULL
        `).run();
        const workspacesResult = this.db.prepare(`
          UPDATE workspaces
          SET last_turn_started_at = COALESCE(
            (
              SELECT MAX(COALESCE(
                s.last_modified,
                unixepoch(s.updated_at) * 1000,
                unixepoch(s.created_at) * 1000,
                0
              ))
              FROM sessions s
              WHERE s.workspace_id = workspaces.id
            ),
            unixepoch(workspaces.createdAt) * 1000,
            0
          )
          WHERE last_turn_started_at IS NULL
        `).run();
        if (sessionsResult.changes > 0 || workspacesResult.changes > 0) {
          console.log(
            `[SqliteStore] Backfilled last_turn_started_at for ${sessionsResult.changes} sessions and ${workspacesResult.changes} workspaces`,
          );
        }
      });
      backfill();
    } catch (err) {
      console.error('[SqliteStore] Failed to backfill last_turn_started_at:', err);
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
        const policy = sanitizeBotRolePolicy(
          safeJsonParse(bot.role_policy_json, createDefaultBotRolePolicy('normal')),
        );
        const rolePersonas = safeJsonParse(bot.role_personas_json ?? '{}', {} as Partial<Record<BotRoleKey, BotPersona>>);
        for (const roleKey of ['owner', 'admin', 'normal'] as BotRoleKey[]) {
          const roleId = uuidv4();
          const permissions: BotRolePolicy = roleKey === 'normal'
            ? policy
            : createDefaultBotRolePolicy(roleKey);
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
            const permissions: BotRolePolicy = createDefaultBotRolePolicy(roleKey);
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
    return rows.map((row) => this.migrateLegacyWorkspaceSiteAuth(parseRow(row)));
  }

  async get(id: string): Promise<Workspace | null> {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as RawWorkspaceRow | undefined;
    return row ? this.migrateLegacyWorkspaceSiteAuth(parseRow(row)) : null;
  }

  private migrateLegacyWorkspaceSiteAuth(workspace: Workspace): Workspace {
    let current = workspace;
    for (const [key, stored] of Object.entries(workspace.settings.browserSiteAuth ?? {})) {
      if (isEncryptedSiteAuthEntry(stored)) continue;
      const decoded = decodeSiteAuthEntry(stored);
      current = this.setWorkspaceSiteAuthEntry(workspace.id, key, decoded.entry, decoded.generation) ?? current;
    }
    return current;
  }

  private encryptWorkspaceSiteAuth(settings: WorkspaceSettings): WorkspaceSettings {
    if (!settings.browserSiteAuth) return settings;
    const encrypted: Record<string, BrowserSiteAuthStoredEntry> = {};
    for (const [key, stored] of Object.entries(settings.browserSiteAuth)) {
      encrypted[key] = isEncryptedSiteAuthEntry(stored)
        ? stored
        : encodeSiteAuthEntry(stored as BrowserSiteAuthEntry);
    }
    return { ...settings, browserSiteAuth: encrypted };
  }

  async create(input: CreateWorkspaceInput): Promise<Workspace> {
    const now = new Date().toISOString();
    // KTD4/R6: true creation initializes the ordering key to now so the new
    // workspace inserts at the top of the list once.
    const nowMs = Date.now();
    const workspace: Workspace = {
      id: uuidv4(),
      name: input.name,
      description: input.description || '',
      folderPath: input.folderPath,
      settings: this.encryptWorkspaceSiteAuth(input.settings || {}),
      skills: input.skills || [],
      mcpServers: input.mcpServers || [],
      hooks: input.hooks || [],
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: null,
      lastTurnStartedAt: nowMs,
    };
    this.db.prepare(`
      INSERT INTO workspaces (id, name, description, folderPath, settings, skills, mcpServers, hooks, createdAt, updatedAt, lastOpenedAt, last_turn_started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      workspace.lastOpenedAt,
      nowMs
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
      ...(input.settings !== undefined && { settings: this.encryptWorkspaceSiteAuth(input.settings) }),
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

  // -------------------------------------------------------------------------
  // browserSiteAuth field-level mutators (U8, KTD-8). better-sqlite3 is
  // synchronous, so each method's read-modify-write is a single critical
  // section — a remember-site write can never interleave with another
  // site-auth write, and the PUT route's field-level merge covers the
  // whole-bag settings replace (settings page save) racing these writers.
  // -------------------------------------------------------------------------

  /**
   * Set (insert or replace) one remembered-site entry. Returns the updated
   * workspace, or null when the workspace does not exist.
   */
  setWorkspaceSiteAuthEntry(
    id: string,
    key: string,
    entry: BrowserSiteAuthEntry,
    generation?: string,
  ): Workspace | null {
    return this.mutateWorkspaceSiteAuth(id, (siteAuth) => {
      siteAuth[key] = encodeSiteAuthEntry(entry, generation);
      return siteAuth;
    });
  }

  /** Synchronous server-only credential lookup used by opaque auth bindings. */
  getWorkspaceSiteAuthEntry(
    id: string,
    key: string,
  ): { entry: BrowserSiteAuthEntry; generation: string } | undefined {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as
      | RawWorkspaceRow
      | undefined;
    if (!row) return undefined;
    const workspace = this.migrateLegacyWorkspaceSiteAuth(parseRow(row));
    const stored = workspace.settings.browserSiteAuth?.[key];
    if (!stored) return undefined;
    const decoded = decodeSiteAuthEntry(stored);
    return { entry: decoded.entry, generation: decoded.generation };
  }

  /**
   * Delete one remembered-site entry. Returns false when the workspace or the
   * key does not exist (so the revoke route can answer 404 honestly).
   */
  deleteWorkspaceSiteAuthEntry(id: string, key: string): boolean {
    let existed = false;
    this.mutateWorkspaceSiteAuth(id, (siteAuth) => {
      if (key in siteAuth) {
        existed = true;
        delete siteAuth[key];
      }
      return siteAuth;
    });
    return existed;
  }

  /**
   * Synchronous RMW of JUST the browserSiteAuth field: the stored settings
   * bag is read, the field replaced by `mutate`'s return, and the row
   * rewritten — all inside one synchronous critical section. Other settings
   * fields pass through untouched (a concurrent whole-bag PUT is handled by
   * the route-level merge, which preserves this field from storage).
   */
  private mutateWorkspaceSiteAuth(
    id: string,
    mutate: (siteAuth: Record<string, BrowserSiteAuthStoredEntry>) => Record<string, BrowserSiteAuthStoredEntry>,
  ): Workspace | null {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as
      | RawWorkspaceRow
      | undefined;
    if (!row) return null;
    const workspace = parseRow(row);
    const settings = { ...workspace.settings };
    const current = (settings.browserSiteAuth ?? {}) as Record<string, BrowserSiteAuthStoredEntry>;
    settings.browserSiteAuth = mutate({ ...current });
    const updatedAt = new Date().toISOString();
    this.db.prepare('UPDATE workspaces SET settings = ?, updatedAt = ? WHERE id = ?').run(
      JSON.stringify(settings),
      updatedAt,
      id,
    );
    return { ...workspace, settings, updatedAt };
  }

  async delete(id: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
    if (result.changes > 0) {
      this.db.prepare(`
        DELETE FROM user_sessions WHERE session_id IN (SELECT id FROM sessions WHERE workspace_id = ?)
      `).run(id);
      this.db.prepare('DELETE FROM session_metadata WHERE session_id IN (SELECT id FROM sessions WHERE workspace_id = ?)').run(id);
      this.db.prepare('DELETE FROM sessions WHERE workspace_id = ?').run(id);
      // R15: deleting a workspace nulls the soft link on global todos; it never destroys them.
      this.db.prepare('UPDATE todos SET workspace_id = NULL WHERE workspace_id = ?').run(id);
      this.db.prepare('DELETE FROM wecom_proactive_messages WHERE workspace_id = ?').run(id);
      this.db.prepare('DELETE FROM wecom_media_cache WHERE workspace_id = ?').run(id);
      this.db.prepare('DELETE FROM task_runs WHERE task_id IN (SELECT id FROM scheduled_tasks WHERE workspace_id = ?)').run(id);
      this.db.prepare('DELETE FROM scheduled_tasks WHERE workspace_id = ?').run(id);
      this.db.prepare('DELETE FROM workspace_prompt_history WHERE workspace_id = ?').run(id);
      this.deleteBrowserOperationsForWorkspace(id);
      this.deleteBrowserAuditForWorkspace(id);
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

  updateSessionBackend(id: string, backend: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE sessions SET backend = ?, updated_at = ? WHERE id = ?')
      .run(backend, now, id);
  }

  updateSessionBackendSessionId(id: string, backendSessionId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE sessions SET backend_session_id = ?, updated_at = ? WHERE id = ?')
      .run(backendSessionId, now, id);
  }

  createLocalSession(
    workspaceId: string,
    name: string,
    approvalMode?: string,
    providerId?: string,
    source?: 'gui' | 'wecom' | 'feishu' | 'scheduled',
    customTitle?: string,
    botId?: string,
    backend?: string,
    fastMode = false,
  ): ChatSession {
    const now = new Date().toISOString();
    // KTD4/R6: true creation initializes the ordering key to now so the new
    // session inserts at the top of its workspace's list once.
    const nowMs = Date.now();
    const mode = approvalMode ?? 'manual';
    const session: ChatSession = {
      id: uuidv4(),
      workspaceId,
      name,
      isDraft: true,
      source,
      approvalMode: mode as ChatSession['approvalMode'],
      providerId,
      backend,
      fastMode,
      botId,
      createdAt: now,
      updatedAt: now,
      customTitle,
      lastTurnStartedAt: nowMs,
    };
    this.db.prepare(`
      INSERT INTO sessions (id, workspace_id, name, is_draft, is_wip, is_archived, source, approval_mode, fast_mode, provider_id, bot_id, created_at, updated_at, custom_title, backend, last_turn_started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(session.id, session.workspaceId, session.name, 1, 0, 0, source ?? null, mode, fastMode ? 1 : 0, providerId ?? null, botId ?? null, session.createdAt, session.updatedAt, customTitle ?? null, backend ?? null, nowMs);
    return session;
  }

  updateLocalSession(id: string, input: { name?: string; isWip?: boolean; isArchived?: boolean; approvalMode?: string; providerId?: string | null; fastMode?: boolean; customTitle?: string | null }): ChatSession | null {
    const existing = this.getLocalSession(id);
    if (!existing) return null;
    const sets: string[] = [];
    const values: unknown[] = [];
    if (input.name !== undefined) {
      sets.push('name = ?');
      values.push(input.name);
    }
    if (input.customTitle !== undefined) {
      sets.push('custom_title = ?');
      values.push(input.customTitle ?? null);
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
    if (input.fastMode !== undefined) {
      sets.push('fast_mode = ?');
      values.push(input.fastMode ? 1 : 0);
    }
    if (sets.length === 0) return existing;
    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getLocalSession(id);
  }

  deleteLocalSession(id: string): boolean {
    return this.db.transaction(() => {
      const session = this.db.prepare('SELECT workspace_id FROM sessions WHERE id = ?').get(id) as
        { workspace_id: string } | undefined;
      if (session) this.purgeBrowserTasksForSession(session.workspace_id, id);
      this.db.prepare('DELETE FROM user_sessions WHERE session_id = ?').run(id);
      const result = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      return result.changes > 0;
    })();
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

  /**
   * U2 (KTD1/R2): advance the turn-start ordering keys of a session and its
   * workspace to `atMs` (defaults to now). One UPDATE per table inside a single
   * transaction; `updated_at` is deliberately untouched so the stamp only moves
   * the ordering key. The MAX guard keeps each key monotonically non-decreasing
   * even under wall-clock regression, so a late writer can never move an item
   * backwards; COALESCE heals NULL keys left by a downgraded binary. Missing
   * rows are no-ops. Returns the timestamp that was applied.
   */
  stampTurnStarted(sessionId: string, workspaceId: string, atMs: number = Date.now()): number {
    const stamp = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE sessions SET last_turn_started_at = MAX(COALESCE(last_turn_started_at, 0), ?) WHERE id = ?
      `).run(atMs, sessionId);
      this.db.prepare(`
        UPDATE workspaces SET last_turn_started_at = MAX(COALESCE(last_turn_started_at, 0), ?) WHERE id = ?
      `).run(atMs, workspaceId);
    });
    stamp();
    return atMs;
  }

  /**
   * Key-only readers for the status-poll hot path (U3): `getSessionsStatus`
   * runs every few seconds per polled workspace, so it reads the ordering
   * column directly rather than paying full-row parses per session. NULL keys
   * are omitted; a missing workspace row yields `undefined`.
   */
  getSessionTurnStartedKeys(workspaceId: string): Record<string, number> {
    const rows = this.db.prepare(`
      SELECT id, last_turn_started_at FROM sessions WHERE workspace_id = ?
    `).all(workspaceId) as Array<{ id: string; last_turn_started_at: number | null }>;
    const keys: Record<string, number> = {};
    for (const row of rows) {
      if (row.last_turn_started_at !== null) {
        keys[row.id] = row.last_turn_started_at;
      }
    }
    return keys;
  }

  getWorkspaceTurnStartedKey(workspaceId: string): number | undefined {
    const row = this.db.prepare(`
      SELECT last_turn_started_at FROM workspaces WHERE id = ?
    `).get(workspaceId) as { last_turn_started_at: number | null } | undefined;
    return row?.last_turn_started_at ?? undefined;
  }

  syncSdkSession(session: ChatSession): void {
    // KTD4: transcript discovery initializes the ordering key from the
    // pre-upgrade client comparator expression (lastModified ?? Date.parse(createdAt)),
    // computed TS-side — created_at is ISO TEXT, so a raw SQL COALESCE would mix
    // TEXT into the INTEGER-affinity key and corrupt ordering. The
    // conflict-upsert branch deliberately leaves the key untouched. A non-finite
    // result (malformed createdAt) binds NULL and heals at the next launch's
    // backfill.
    const discoveredKey = session.lastModified ?? Date.parse(session.createdAt);
    const initialKey = Number.isFinite(discoveredKey) ? discoveredKey : null;
    this.db.prepare(`
      INSERT INTO sessions (id, workspace_id, name, is_draft, is_wip, is_archived, source, provider_id, bot_id, created_at, updated_at, summary, last_modified, first_prompt, git_branch, custom_title, fast_mode, last_turn_started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        custom_title = excluded.custom_title,
        fast_mode = COALESCE(sessions.fast_mode, excluded.fast_mode, 0)
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
      session.customTitle ?? null,
      session.fastMode ? 1 : 0,
      initialKey
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
      supportsFastMode: providerSupportsFastMode(input.model),
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
      supportsFastMode: providerSupportsFastMode(
        (input.model !== undefined ? input.model : existing.model) ?? undefined,
      ),
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

  createTodo(workspaceId: string | null, input: CreateTodoInput): Todo {
    const nowIso = new Date().toISOString();
    const todo: Todo = {
      id: uuidv4(),
      workspaceId: workspaceId ?? null,
      text: input.text.trim(),
      content: input.content ?? null,
      status: 'pending',
      executionType: input.executionType ?? 'manual',
      instruction: input.instruction ?? null,
      scheduleTime: input.scheduleTime ?? null,
      cronExpr: input.cronExpr ?? null,
      executionStatus: input.executionStatus ?? 'active',
      nextFireAt: input.nextFireAt ?? null,
      notifyDesktop: input.notifyDesktop ?? true,
      notifyInApp: input.notifyInApp ?? true,
      notifyWecom: input.notifyWecom ?? false,
      wecomRecipient: input.wecomRecipient ?? null,
      confirmedSnapshot: input.confirmedSnapshot ?? null,
      deletedAt: null,
      sessionId: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      origin: 'local',
      dueDate: input.dueDate ?? null,
      repoFullName: null,
      issueNumber: null,
      remoteSnapshot: null,
      remoteUpdatedAt: null,
      lastSyncedAt: null,
      assignee: null,
      labels: [],
      originDeleted: false,
    };
    this.db
      .prepare(
        `INSERT INTO todos (
          id, workspace_id, text, content, status, session_id, created_at, updated_at,
          origin, due_date, repo_full_name, issue_number, remote_snapshot_json,
          remote_updated_at, last_synced_at, assignee, labels_json, origin_deleted,
          execution_type, instruction, schedule_time, cron_expr, execution_status, next_fire_at,
          notify_desktop, notify_in_app, notify_wecom, wecom_recipient, confirmed_snapshot, deleted_at
        ) VALUES (
          @id, @workspace_id, @text, @content, @status, @session_id, @created_at, @updated_at,
          @origin, @due_date, @repo_full_name, @issue_number, @remote_snapshot_json,
          @remote_updated_at, @last_synced_at, @assignee, @labels_json, @origin_deleted,
          @execution_type, @instruction, @schedule_time, @cron_expr, @execution_status, @next_fire_at,
          @notify_desktop, @notify_in_app, @notify_wecom, @wecom_recipient, @confirmed_snapshot, @deleted_at
        )`,
      )
      .run({
        id: todo.id,
        workspace_id: todo.workspaceId,
        text: todo.text,
        content: todo.content,
        status: todo.status,
        session_id: todo.sessionId,
        created_at: todo.createdAt,
        updated_at: todo.updatedAt,
        origin: todo.origin,
        due_date: todo.dueDate,
        repo_full_name: todo.repoFullName,
        issue_number: todo.issueNumber,
        remote_snapshot_json: todo.remoteSnapshot,
        remote_updated_at: todo.remoteUpdatedAt,
        last_synced_at: todo.lastSyncedAt,
        assignee: todo.assignee,
        labels_json: JSON.stringify(todo.labels),
        origin_deleted: todo.originDeleted ? 1 : 0,
        execution_type: todo.executionType,
        instruction: todo.instruction,
        schedule_time: todo.scheduleTime,
        cron_expr: todo.cronExpr,
        execution_status: todo.executionStatus,
        next_fire_at: todo.nextFireAt,
        notify_desktop: todo.notifyDesktop ? 1 : 0,
        notify_in_app: todo.notifyInApp ? 1 : 0,
        notify_wecom: todo.notifyWecom ? 1 : 0,
        wecom_recipient: todo.wecomRecipient,
        confirmed_snapshot: todo.confirmedSnapshot === null ? null : JSON.stringify(todo.confirmedSnapshot),
        deleted_at: todo.deletedAt,
      });
    return todo;
  }

  getTodosByWorkspace(workspaceId: string): Todo[] {
    const rows = this.db
      .prepare('SELECT * FROM todos WHERE workspace_id = ? ORDER BY created_at DESC')
      .all(workspaceId) as RawTodoRow[];
    return rows.map(parseTodoRow);
  }

  /** Global todo list (U1/R2). Optional workspace filter preserves the legacy view. */
  getAllTodos(filter?: { workspaceId?: string }): Todo[] {
    if (filter?.workspaceId) {
      const rows = this.db
        .prepare('SELECT * FROM todos WHERE workspace_id = ? ORDER BY created_at DESC')
        .all(filter.workspaceId) as RawTodoRow[];
      return rows.map(parseTodoRow);
    }
    const rows = this.db.prepare('SELECT * FROM todos ORDER BY created_at DESC').all() as RawTodoRow[];
    return rows.map(parseTodoRow);
  }

  getTodoById(id: string): Todo | null {
    const row = this.db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as RawTodoRow | undefined;
    return row ? parseTodoRow(row) : null;
  }

  // -------------------------------------------------------------------------
  // U5 sync storage: per-repo cursor, repo lookups, comments, conflicts.
  // -------------------------------------------------------------------------

  getRepoSyncState(repo: string): { repoLastUpdatedAt: string | null; etag: string | null } | null {
    const row = this.db
      .prepare('SELECT repo_last_updated_at, etag FROM repo_sync_state WHERE repo_full_name = ?')
      .get(repo) as { repo_last_updated_at: string | null; etag: string | null } | undefined;
    return row ? { repoLastUpdatedAt: row.repo_last_updated_at, etag: row.etag } : null;
  }

  setRepoSyncState(repo: string, state: { repoLastUpdatedAt: string | null; etag: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO repo_sync_state (repo_full_name, repo_last_updated_at, etag)
         VALUES (?, ?, ?)
         ON CONFLICT(repo_full_name) DO UPDATE SET
           repo_last_updated_at = excluded.repo_last_updated_at,
           etag = excluded.etag`,
      )
      .run(repo, state.repoLastUpdatedAt, state.etag);
  }

  /** The local todo linked to a repo/issue, or null (pull dedupe — F2). */
  findTodoByRepoIssue(repo: string, issueNumber: number): Todo | null {
    const row = this.db
      .prepare('SELECT * FROM todos WHERE repo_full_name = ? AND issue_number = ?')
      .get(repo, issueNumber) as RawTodoRow | undefined;
    return row ? parseTodoRow(row) : null;
  }

  /** All todos linked to a repo (the reconcile working set for that repo). */
  getTodosByRepo(repo: string): Todo[] {
    const rows = this.db
      .prepare('SELECT * FROM todos WHERE repo_full_name = ? ORDER BY created_at DESC')
      .all(repo) as RawTodoRow[];
    return rows.map(parseTodoRow);
  }

  /** Distinct repo full names that have at least one linked todo (reconcile scoping). */
  getLinkedRepos(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT repo_full_name FROM todos WHERE repo_full_name IS NOT NULL")
      .all() as Array<{ repo_full_name: string }>;
    return rows.map((r) => r.repo_full_name);
  }

  listTodoComments(todoId: string): TodoComment[] {
    const rows = this.db
      .prepare('SELECT * FROM todo_comments WHERE todo_id = ? ORDER BY created_at ASC')
      .all(todoId) as Array<{
      id: string;
      todo_id: string;
      origin: string;
      remote_id: number | null;
      author: string;
      body: string;
      created_at: string;
      pushed: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      todoId: r.todo_id,
      origin: r.origin as 'local' | 'github',
      remoteId: r.remote_id,
      author: r.author,
      body: r.body,
      createdAt: r.created_at,
      pushed: r.pushed === 1,
    }));
  }

  listUnpushedTodoComments(todoId: string): TodoComment[] {
    return this.listTodoComments(todoId).filter((c) => c.origin === 'local' && !c.pushed);
  }

  addLocalTodoComment(todoId: string, body: string, author: string): TodoComment {
    const comment: TodoComment = {
      id: uuidv4(),
      todoId,
      origin: 'local',
      remoteId: null,
      author,
      body,
      createdAt: new Date().toISOString(),
      pushed: false,
    };
    this.db
      .prepare(
        `INSERT INTO todo_comments (id, todo_id, origin, remote_id, author, body, created_at, pushed)
         VALUES (?, ?, 'local', NULL, ?, ?, ?, 0)`,
      )
      .run(comment.id, todoId, author, body, comment.createdAt);
    return comment;
  }

  /** Insert a pulled GitHub comment unless already present (dedupe by remote_id, any origin —
   *  a just-pushed local comment carries that remote_id and must not be mirrored twice). */
  upsertRemoteTodoComment(todoId: string, remoteId: number, author: string, body: string, createdAt: string): void {
    const exists = this.db
      .prepare('SELECT 1 FROM todo_comments WHERE todo_id = ? AND remote_id = ?')
      .get(todoId, remoteId);
    if (exists) return;
    this.db
      .prepare(
        `INSERT INTO todo_comments (id, todo_id, origin, remote_id, author, body, created_at, pushed)
         VALUES (?, ?, 'github', ?, ?, ?, ?, 1)`,
      )
      .run(uuidv4(), todoId, remoteId, author, body, createdAt);
  }

  /** Mark a local comment pushed and record its GitHub-side id so the pull does not re-mirror it. */
  markTodoCommentPushed(commentId: string, remoteId: number | null): void {
    this.db.prepare('UPDATE todo_comments SET pushed = 1, remote_id = ? WHERE id = ?').run(remoteId, commentId);
  }

  getTodoConflicts(todoId: string): TodoConflict[] {
    const rows = this.db.prepare('SELECT * FROM todo_conflicts WHERE todo_id = ?').all(todoId) as Array<{
      todo_id: string;
      field: string;
      local_value: string;
      remote_value: string;
      baseline_value: string | null;
      detected_at: string;
    }>;
    return rows.map((r) => ({
      todoId: r.todo_id,
      field: r.field as 'title' | 'body',
      localValue: r.local_value,
      remoteValue: r.remote_value,
      baselineValue: r.baseline_value,
      detectedAt: r.detected_at,
    }));
  }

  setTodoConflict(
    todoId: string,
    field: 'title' | 'body',
    localValue: string,
    remoteValue: string,
    baselineValue: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO todo_conflicts (todo_id, field, local_value, remote_value, baseline_value, detected_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(todo_id, field) DO UPDATE SET
           local_value = excluded.local_value,
           remote_value = excluded.remote_value,
           baseline_value = excluded.baseline_value,
           detected_at = excluded.detected_at`,
      )
      .run(todoId, field, localValue, remoteValue, baselineValue, new Date().toISOString());
  }

  clearTodoConflict(todoId: string, field?: 'title' | 'body'): void {
    if (field) {
      this.db.prepare('DELETE FROM todo_conflicts WHERE todo_id = ? AND field = ?').run(todoId, field);
    } else {
      this.db.prepare('DELETE FROM todo_conflicts WHERE todo_id = ?').run(todoId);
    }
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
    if (input.content !== undefined) {
      sets.push('content = ?');
      values.push(input.content);
    }
    if (input.status !== undefined) {
      sets.push('status = ?');
      values.push(input.status);
    }
    if (input.sessionId !== undefined) {
      sets.push('session_id = ?');
      values.push(input.sessionId);
    }
    if (input.workspaceId !== undefined) { sets.push('workspace_id = ?'); values.push(input.workspaceId); }
    if (input.dueDate !== undefined) { sets.push('due_date = ?'); values.push(input.dueDate); }
    if (input.executionType !== undefined) { sets.push('execution_type = ?'); values.push(input.executionType); }
    if (input.instruction !== undefined) { sets.push('instruction = ?'); values.push(input.instruction); }
    if (input.scheduleTime !== undefined) { sets.push('schedule_time = ?'); values.push(input.scheduleTime); }
    if (input.cronExpr !== undefined) { sets.push('cron_expr = ?'); values.push(input.cronExpr); }
    if (input.executionStatus !== undefined) { sets.push('execution_status = ?'); values.push(input.executionStatus); }
    if (input.nextFireAt !== undefined) { sets.push('next_fire_at = ?'); values.push(input.nextFireAt); }
    if (input.notifyDesktop !== undefined) { sets.push('notify_desktop = ?'); values.push(input.notifyDesktop ? 1 : 0); }
    if (input.notifyInApp !== undefined) { sets.push('notify_in_app = ?'); values.push(input.notifyInApp ? 1 : 0); }
    if (input.notifyWecom !== undefined) { sets.push('notify_wecom = ?'); values.push(input.notifyWecom ? 1 : 0); }
    if (input.wecomRecipient !== undefined) { sets.push('wecom_recipient = ?'); values.push(input.wecomRecipient); }
    if (input.confirmedSnapshot !== undefined) { sets.push('confirmed_snapshot = ?'); values.push(input.confirmedSnapshot === null ? null : JSON.stringify(input.confirmedSnapshot)); }
    if (input.origin !== undefined) { sets.push('origin = ?'); values.push(input.origin); }
    if (input.repoFullName !== undefined) { sets.push('repo_full_name = ?'); values.push(input.repoFullName); }
    if (input.issueNumber !== undefined) { sets.push('issue_number = ?'); values.push(input.issueNumber); }
    if (input.remoteSnapshot !== undefined) { sets.push('remote_snapshot_json = ?'); values.push(input.remoteSnapshot); }
    if (input.remoteUpdatedAt !== undefined) { sets.push('remote_updated_at = ?'); values.push(input.remoteUpdatedAt); }
    if (input.lastSyncedAt !== undefined) { sets.push('last_synced_at = ?'); values.push(input.lastSyncedAt); }
    if (input.assignee !== undefined) { sets.push('assignee = ?'); values.push(input.assignee); }
    if (input.labels !== undefined) { sets.push('labels_json = ?'); values.push(JSON.stringify(input.labels)); }
    if (input.originDeleted !== undefined) { sets.push('origin_deleted = ?'); values.push(input.originDeleted ? 1 : 0); }
    if (sets.length === 0) return existing;
    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);
    this.db.prepare(`UPDATE todos SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getTodoById(id);
  }

  deleteTodo(id: string): boolean {
    const result = this.db.prepare('DELETE FROM todos WHERE id = ?').run(id);
    if (result.changes > 0) {
      this.db.prepare('DELETE FROM todo_runs WHERE todo_id = ?').run(id);
      this.db.prepare('DELETE FROM todo_comments WHERE todo_id = ?').run(id);
      this.db.prepare('DELETE FROM todo_conflicts WHERE todo_id = ?').run(id);
    }
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

  createScheduledTask(input: CreateScheduledTaskInput): ScheduledTask {
    const now = new Date().toISOString();
    const task: ScheduledTask = {
      id: uuidv4(),
      workspaceId: input.workspaceId,
      name: input.name,
      instruction: input.instruction,
      scheduleType: input.scheduleType,
      scheduleTime: input.scheduleTime ?? null,
      cronExpr: input.cronExpr ?? null,
      notifyDesktop: input.notifyDesktop ?? true,
      notifyInApp: input.notifyInApp ?? true,
      notifyWecom: input.notifyWecom ?? false,
      wecomRecipient: input.wecomRecipient ?? null,
      // Tasks are active at creation (the confirmation gate was removed);
      // the workspace snapshot is captured by the service layer at creation.
      status: 'active',
      deletedAt: null,
      confirmedSnapshot: null,
      nextFireAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO scheduled_tasks (
        id, workspace_id, name, instruction, schedule_type, schedule_time, cron_expr,
        notify_desktop, notify_in_app, notify_wecom, wecom_recipient,
        status, deleted_at, confirmed_snapshot, next_fire_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id,
      task.workspaceId,
      task.name,
      task.instruction,
      task.scheduleType,
      task.scheduleTime,
      task.cronExpr,
      task.notifyDesktop ? 1 : 0,
      task.notifyInApp ? 1 : 0,
      task.notifyWecom ? 1 : 0,
      task.wecomRecipient,
      task.status,
      task.deletedAt,
      null,
      task.nextFireAt,
      task.createdAt,
      task.updatedAt,
    );
    return task;
  }

  getScheduledTask(id: string): ScheduledTask | null {
    const row = this.db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as RawScheduledTaskRow | undefined;
    return row ? parseScheduledTaskRow(row) : null;
  }

  listScheduledTasks(options: ListScheduledTasksOptions = {}): ScheduledTask[] {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (options.workspaceId !== undefined) {
      conditions.push('workspace_id = ?');
      values.push(options.workspaceId);
    }
    if (!options.includeDeleted) {
      conditions.push('deleted_at IS NULL');
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM scheduled_tasks${where} ORDER BY created_at ASC`)
      .all(...values) as RawScheduledTaskRow[];
    return rows.map(parseScheduledTaskRow);
  }

  updateScheduledTask(id: string, input: UpdateScheduledTaskInput): ScheduledTask | null {
    const existing = this.getScheduledTask(id);
    if (!existing) return null;
    const sets: string[] = [];
    const values: unknown[] = [];
    if (input.name !== undefined) {
      sets.push('name = ?');
      values.push(input.name);
    }
    if (input.instruction !== undefined) {
      sets.push('instruction = ?');
      values.push(input.instruction);
    }
    if (input.scheduleType !== undefined) {
      sets.push('schedule_type = ?');
      values.push(input.scheduleType);
    }
    if (input.scheduleTime !== undefined) {
      sets.push('schedule_time = ?');
      values.push(input.scheduleTime);
    }
    if (input.cronExpr !== undefined) {
      sets.push('cron_expr = ?');
      values.push(input.cronExpr);
    }
    if (input.notifyDesktop !== undefined) {
      sets.push('notify_desktop = ?');
      values.push(input.notifyDesktop ? 1 : 0);
    }
    if (input.notifyInApp !== undefined) {
      sets.push('notify_in_app = ?');
      values.push(input.notifyInApp ? 1 : 0);
    }
    if (input.notifyWecom !== undefined) {
      sets.push('notify_wecom = ?');
      values.push(input.notifyWecom ? 1 : 0);
    }
    if (input.wecomRecipient !== undefined) {
      sets.push('wecom_recipient = ?');
      values.push(input.wecomRecipient);
    }
    if (input.status !== undefined) {
      sets.push('status = ?');
      values.push(input.status);
    }
    if (input.confirmedSnapshot !== undefined) {
      sets.push('confirmed_snapshot = ?');
      values.push(input.confirmedSnapshot === null ? null : JSON.stringify(input.confirmedSnapshot));
    }
    if (input.nextFireAt !== undefined) {
      sets.push('next_fire_at = ?');
      values.push(input.nextFireAt);
    }
    if (sets.length === 0) return existing;
    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);
    this.db.prepare(`UPDATE scheduled_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getScheduledTask(id);
  }

  softDeleteScheduledTask(id: string): ScheduledTask | null {
    const existing = this.getScheduledTask(id);
    if (!existing) return null;
    if (existing.deletedAt) return existing;
    const now = new Date().toISOString();
    this.db.prepare('UPDATE scheduled_tasks SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
    return this.getScheduledTask(id);
  }

  createTodoRun(input: CreateTodoRunInput): TodoRun {
    const run: TodoRun = {
      id: uuidv4(),
      todoId: input.todoId,
      sessionId: input.sessionId ?? null,
      status: input.status,
      fireAt: input.fireAt,
      startedAt: input.startedAt ?? null,
      endedAt: input.endedAt ?? null,
      reason: input.reason ?? null,
      instructionSnapshot: input.instructionSnapshot,
      createdAt: new Date().toISOString(),
    };
    this.db.prepare(`
      INSERT INTO todo_runs (
        id, todo_id, session_id, status, fire_at, started_at, ended_at, reason, instruction_snapshot, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id, run.todoId, run.sessionId, run.status, run.fireAt, run.startedAt,
      run.endedAt, run.reason, run.instructionSnapshot, run.createdAt,
    );
    return run;
  }

  getTodoRun(id: string): TodoRun | null {
    const row = this.db.prepare('SELECT * FROM todo_runs WHERE id = ?').get(id) as RawTodoRunRow | undefined;
    return row ? parseTodoRunRow(row) : null;
  }

  updateTodoRun(id: string, input: UpdateTodoRunInput): TodoRun | null {
    const existing = this.getTodoRun(id);
    if (!existing) return null;
    const sets: string[] = [];
    const values: unknown[] = [];
    if (input.sessionId !== undefined) { sets.push('session_id = ?'); values.push(input.sessionId); }
    if (input.status !== undefined) { sets.push('status = ?'); values.push(input.status); }
    if (input.startedAt !== undefined) { sets.push('started_at = ?'); values.push(input.startedAt); }
    if (input.endedAt !== undefined) { sets.push('ended_at = ?'); values.push(input.endedAt); }
    if (input.reason !== undefined) { sets.push('reason = ?'); values.push(input.reason); }
    if (sets.length === 0) return existing;
    values.push(id);
    this.db.prepare(`UPDATE todo_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getTodoRun(id);
  }

  listTodoRuns(todoId: string): TodoRun[] {
    const rows = this.db.prepare(
      'SELECT * FROM todo_runs WHERE todo_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 200',
    ).all(todoId) as RawTodoRunRow[];
    return rows.map(parseTodoRunRow);
  }

  getLatestTodoRun(todoId: string): TodoRun | null {
    const row = this.db.prepare(
      'SELECT * FROM todo_runs WHERE todo_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    ).get(todoId) as RawTodoRunRow | undefined;
    return row ? parseTodoRunRow(row) : null;
  }

  listStaleRunningTodoRuns(cutoffIso: string): TodoRun[] {
    const rows = this.db.prepare(
      "SELECT * FROM todo_runs WHERE status = 'running' AND started_at < ?",
    ).all(cutoffIso) as RawTodoRunRow[];
    return rows.map(parseTodoRunRow);
  }

  latestRunsPerTodo(): TodoRun[] {
    const rows = this.db.prepare(`
      SELECT * FROM todo_runs
      WHERE rowid IN (SELECT MAX(rowid) FROM todo_runs GROUP BY todo_id)
      ORDER BY created_at DESC
    `).all() as RawTodoRunRow[];
    return rows.map(parseTodoRunRow);
  }

  pruneTodoRunsOlderThan(cutoffIso: string): number {
    return this.db.prepare('DELETE FROM todo_runs WHERE created_at < ?').run(cutoffIso).changes;
  }

  createTaskRun(input: CreateTaskRunInput): TaskRun {
    const run: TaskRun = {
      id: uuidv4(),
      taskId: input.taskId,
      sessionId: input.sessionId ?? null,
      status: input.status,
      fireAt: input.fireAt,
      startedAt: input.startedAt ?? null,
      endedAt: input.endedAt ?? null,
      reason: input.reason ?? null,
      instructionSnapshot: input.instructionSnapshot,
      createdAt: new Date().toISOString(),
    };
    this.db.prepare(`
      INSERT INTO task_runs (
        id, task_id, session_id, status, fire_at, started_at, ended_at, reason, instruction_snapshot, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.taskId,
      run.sessionId,
      run.status,
      run.fireAt,
      run.startedAt,
      run.endedAt,
      run.reason,
      run.instructionSnapshot,
      run.createdAt,
    );
    return run;
  }

  getTaskRun(id: string): TaskRun | null {
    const row = this.db.prepare('SELECT * FROM task_runs WHERE id = ?').get(id) as RawTaskRunRow | undefined;
    return row ? parseTaskRunRow(row) : null;
  }

  updateTaskRun(id: string, input: UpdateTaskRunInput): TaskRun | null {
    const existing = this.getTaskRun(id);
    if (!existing) return null;
    const sets: string[] = [];
    const values: unknown[] = [];
    if (input.sessionId !== undefined) {
      sets.push('session_id = ?');
      values.push(input.sessionId);
    }
    if (input.status !== undefined) {
      sets.push('status = ?');
      values.push(input.status);
    }
    if (input.startedAt !== undefined) {
      sets.push('started_at = ?');
      values.push(input.startedAt);
    }
    if (input.endedAt !== undefined) {
      sets.push('ended_at = ?');
      values.push(input.endedAt);
    }
    if (input.reason !== undefined) {
      sets.push('reason = ?');
      values.push(input.reason);
    }
    if (sets.length === 0) return existing;
    values.push(id);
    this.db.prepare(`UPDATE task_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getTaskRun(id);
  }

  listTaskRuns(taskId: string): TaskRun[] {
    // Bounded history: the panel only meaningfully shows recent runs, and an
    // hourly task accumulates ~2k rows inside the retention window. The
    // idx_task_runs_task_created index serves this ordering, so the cap is free.
    const rows = this.db
      .prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 200')
      .all(taskId) as RawTaskRunRow[];
    return rows.map(parseTaskRunRow);
  }

  /** Watchdog support: running runs whose start predates the cutoff (a stalled stream never emits a result). */
  listStaleRunningTaskRuns(cutoffIso: string): TaskRun[] {
    const rows = this.db
      .prepare("SELECT * FROM task_runs WHERE status = 'running' AND started_at < ?")
      .all(cutoffIso) as RawTaskRunRow[];
    return rows.map(parseTaskRunRow);
  }

  /** Newest run for one task, index-served; avoids a full history scan for overlap checks. */
  getLatestTaskRun(taskId: string): TaskRun | null {
    const row = this.db
      .prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(taskId) as RawTaskRunRow | undefined;
    return row ? parseTaskRunRow(row) : null;
  }

  /** Data lifecycle (KTD-11): physically remove runs older than the retention cutoff. */
  pruneTaskRunsOlderThan(cutoffIso: string): number {
    const result = this.db.prepare('DELETE FROM task_runs WHERE created_at < ?').run(cutoffIso);
    return result.changes;
  }

  latestRunsPerTask(): TaskRun[] {
    // rowid order matches insertion order, so MAX(rowid) per task is the
    // newest run even when several runs share a created_at timestamp.
    const rows = this.db.prepare(`
      SELECT * FROM task_runs
      WHERE rowid IN (SELECT MAX(rowid) FROM task_runs GROUP BY task_id)
      ORDER BY created_at DESC
    `).all() as RawTaskRunRow[];
    return rows.map(parseTaskRunRow);
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
      // New bots default to the new permission model (R14): sandboxed normal
      // posture, empty passlist, empty domain list (derivation merges the
      // WeCom/loopback defaults).
      const permissions: BotRolePolicy = createDefaultBotRolePolicy(roleKey);
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

  getBotUserByChannelPlaintext(botId: string, channelId: string, plaintextUserId: string): BotUser | null {
    const row = this.db.prepare(`
      SELECT * FROM bot_users WHERE bot_id = ? AND channel_id = ? AND plaintext_user_id = ?
    `).get(botId, channelId, plaintextUserId) as RawBotUserRow | undefined;
    return row ? parseBotUserRow(row, this.db) : null;
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

  /**
   * Bot-audit retention (U6, KTD-22): physically remove rows older than the
   * retention cutoff (default 90 days). Age-based only — unlike browser_audit
   * there is no row cap: decision-audit volume is bounded by gate activity,
   * not browser automation. Called from server-main's periodic cleanup timer,
   * mirroring the pruneBrowserAudit precedent.
   */
  pruneBotAuditLogs(options: { retentionDays?: number } = {}): number {
    const retentionDays = options.retentionDays ?? 90;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    return this.db.prepare('DELETE FROM bot_audit_logs WHERE created_at < ?').run(cutoff).changes;
  }

  // -------------------------------------------------------------------------
  // session_capability_tokens (U12, KTD-28) — per-session loopback tokens.
  // -------------------------------------------------------------------------

  insertCapabilityToken(row: {
    tokenHash: string;
    sessionId: string;
    workspaceId: string;
    botId: string | null;
    createdAt: string;
    expiresAt: string;
  }): void {
    this.db.prepare(`
      INSERT INTO session_capability_tokens
        (token_hash, session_id, workspace_id, bot_id, created_at, expires_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run(row.tokenHash, row.sessionId, row.workspaceId, row.botId, row.createdAt, row.expiresAt);
  }

  getCapabilityToken(tokenHash: string): {
    tokenHash: string;
    sessionId: string;
    workspaceId: string;
    botId: string | null;
    createdAt: string;
    expiresAt: string;
    revokedAt: string | null;
  } | null {
    const row = this.db.prepare(`
      SELECT token_hash, session_id, workspace_id, bot_id, created_at, expires_at, revoked_at
      FROM session_capability_tokens WHERE token_hash = ?
    `).get(tokenHash) as
      | {
          token_hash: string;
          session_id: string;
          workspace_id: string;
          bot_id: string | null;
          created_at: string;
          expires_at: string;
          revoked_at: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      tokenHash: row.token_hash,
      sessionId: row.session_id,
      workspaceId: row.workspace_id,
      botId: row.bot_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    };
  }

  /** Revoke every live token for a session (rotation and session teardown). */
  revokeCapabilityTokensForSession(sessionId: string, revokedAt: string): number {
    const result = this.db.prepare(`
      UPDATE session_capability_tokens SET revoked_at = ?
      WHERE session_id = ? AND revoked_at IS NULL
    `).run(revokedAt, sessionId);
    return result.changes;
  }

  revokeCapabilityToken(tokenHash: string, revokedAt: string): number {
    return this.db.prepare(`
      UPDATE session_capability_tokens SET revoked_at = ?
      WHERE token_hash = ? AND revoked_at IS NULL
    `).run(revokedAt, tokenHash).changes;
  }

  /** Boot invalidation: every token from a prior process lifetime dies. */
  revokeAllCapabilityTokens(revokedAt: string): number {
    const result = this.db.prepare(`
      UPDATE session_capability_tokens SET revoked_at = ? WHERE revoked_at IS NULL
    `).run(revokedAt);
    return result.changes;
  }

  // -------------------------------------------------------------------------
  // browser_audit (U8, KTD-9) — positive-shape action audit. There is no
  // values/images column BY DESIGN: field values and screenshots never reach
  // this table (structural contract, not redaction-after-the-fact).
  // -------------------------------------------------------------------------

  recordBrowserAudit(input: CreateBrowserAuditInput): BrowserAuditEntry {
    const entry: BrowserAuditEntry = {
      id: uuidv4(),
      workspaceId: input.workspaceId,
      sessionId: input.sessionId ?? null,
      category: input.category,
      action: input.action,
      origin: input.origin ?? null,
      siteKey: input.siteKey ?? null,
      fieldNames: input.fieldNames ?? [],
      outcome: input.outcome,
      potentialSubmit: input.potentialSubmit ?? false,
      detail: input.detail ?? null,
      createdAt: new Date().toISOString(),
    };
    this.db.prepare(`
      INSERT INTO browser_audit
        (id, workspace_id, session_id, category, action, origin, site_key, field_names, outcome, potential_submit, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      entry.workspaceId,
      entry.sessionId,
      entry.category,
      entry.action,
      entry.origin,
      entry.siteKey,
      JSON.stringify(entry.fieldNames),
      entry.outcome,
      entry.potentialSubmit ? 1 : 0,
      entry.detail,
      entry.createdAt,
    );
    return entry;
  }

  listBrowserAudit(
    workspaceId: string,
    options: { sessionId?: string; limit?: number } = {},
  ): BrowserAuditEntry[] {
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
    const rows = (
      options.sessionId
        ? this.db
            .prepare(
              'SELECT * FROM browser_audit WHERE workspace_id = ? AND session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
            )
            .all(workspaceId, options.sessionId, limit)
        : this.db
            .prepare('SELECT * FROM browser_audit WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
            .all(workspaceId, limit)
    ) as RawBrowserAuditRow[];
    return rows.map(parseBrowserAuditRow);
  }

  /** Workspace-delete cascade (KTD-8): audit rows die with the workspace. */
  deleteBrowserAuditForWorkspace(workspaceId: string): number {
    return this.db.prepare('DELETE FROM browser_audit WHERE workspace_id = ?').run(workspaceId).changes;
  }

  /**
   * Bound the audit table's growth (the table is append-only by design):
   * age-based retention plus a global row cap, called from server-main's
   * periodic cleanup timer. Returns the number of rows deleted.
   */
  pruneBrowserAudit(options: { retentionDays?: number; maxRows?: number } = {}): number {
    const retentionDays = options.retentionDays ?? 30;
    const maxRows = options.maxRows ?? 10_000;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    let deleted = this.db.prepare('DELETE FROM browser_audit WHERE created_at < ?').run(cutoff).changes;
    const excess =
      (this.db.prepare('SELECT COUNT(*) AS n FROM browser_audit').get() as { n: number }).n - maxRows;
    if (excess > 0) {
      deleted += this.db
        .prepare(
          'DELETE FROM browser_audit WHERE rowid IN (SELECT rowid FROM browser_audit ORDER BY created_at ASC, rowid ASC LIMIT ?)',
        )
        .run(excess).changes;
    }
    return deleted;
  }

  // -------------------------------------------------------------------------
  // browser_operation_ledger (U8/KTD6-KTD7)
  // -------------------------------------------------------------------------

  private ensureBrowserOperationLedgerPrincipalScope(): void {
    const columns = this.db.prepare('PRAGMA table_info(browser_operation_ledger)').all() as Array<{
      name: string;
      pk: number;
    }>;
    const principalPk = columns.find((column) => column.name === 'principal_id')?.pk;
    const operationPk = columns.find((column) => column.name === 'operation_id')?.pk;
    if (principalPk === 1 && operationPk === 2) return;
    this.db.transaction(() => {
      this.db.exec('ALTER TABLE browser_operation_ledger RENAME TO browser_operation_ledger_legacy');
      this.db.exec(`
        CREATE TABLE browser_operation_ledger (
          operation_id TEXT NOT NULL,
          principal_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          runtime_generation TEXT NOT NULL,
          capability_id TEXT NOT NULL,
          action TEXT NOT NULL,
          parameter_digest TEXT NOT NULL,
          state TEXT NOT NULL,
          receipt_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (principal_id, operation_id)
        )
      `);
      this.db.exec(`
        INSERT INTO browser_operation_ledger
          (operation_id, principal_id, workspace_id, session_id, runtime_generation,
           capability_id, action, parameter_digest, state, receipt_json, created_at, updated_at)
        SELECT operation_id, principal_id, workspace_id, session_id, runtime_generation,
               capability_id, action, parameter_digest, state, receipt_json, created_at, updated_at
        FROM browser_operation_ledger_legacy
      `);
      this.db.exec('DROP TABLE browser_operation_ledger_legacy');
    })();
  }

  deleteBrowserOperationsForWorkspace(workspaceId: string): number {
    return this.db.prepare('DELETE FROM browser_operation_ledger WHERE workspace_id = ?').run(workspaceId).changes;
  }

  proposeBrowserOperation(input: ProposeBrowserOperationInput): BrowserOperationEntry {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO browser_operation_ledger
        (operation_id, principal_id, workspace_id, session_id, runtime_generation,
         capability_id, action, parameter_digest, state, receipt_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', NULL, ?, ?)
    `).run(
      input.operationId, input.principalId, input.workspaceId, input.sessionId,
      input.runtimeGeneration, input.capabilityId, input.action,
      input.parameterDigest, now, now,
    );
    return this.getBrowserOperation(input.principalId, input.operationId)!;
  }

  getBrowserOperation(principalId: string, operationId: string): BrowserOperationEntry | null {
    const row = this.db.prepare(
      'SELECT * FROM browser_operation_ledger WHERE principal_id = ? AND operation_id = ?',
    ).get(principalId, operationId) as RawBrowserOperationRow | undefined;
    return row ? parseBrowserOperationRow(row) : null;
  }

  markBrowserOperationApproved(principalId: string, operationId: string): boolean {
    return this.transitionBrowserOperation(principalId, operationId, ['proposed'], 'approved') > 0;
  }

  markBrowserOperationDispatchIntent(principalId: string, operationId: string): boolean {
    return this.transitionBrowserOperation(principalId, operationId, ['proposed', 'approved'], 'dispatch_intent') > 0;
  }

  completeBrowserOperation(principalId: string, operationId: string, receipt: BrowserOperationStoredReceipt): boolean {
    const result = this.db.prepare(`
      UPDATE browser_operation_ledger
      SET state = 'terminal', receipt_json = ?, updated_at = ?
      WHERE principal_id = ? AND operation_id = ? AND state != 'terminal'
    `).run(JSON.stringify(receipt), new Date().toISOString(), principalId, operationId);
    return result.changes > 0;
  }

  recoverBrowserOperations(): { notDispatched: number; unknown: number } {
    return this.db.transaction(() => {
      const now = new Date().toISOString();
      const orphanedFinalActions = this.db.prepare(`
        SELECT f.task_id, f.operation_id FROM browser_final_actions f
        JOIN browser_tasks t ON t.task_id = f.task_id
        JOIN browser_operation_ledger o ON o.operation_id = f.operation_id
          AND o.principal_id = t.principal_id
        WHERE f.state = 'reviewed' AND o.state = 'dispatch_intent'
      `).all() as Array<{ task_id: string; operation_id: string }>;
      const notDispatched: BrowserOperationStoredReceipt = {
        outcome: 'not_dispatched', dispatchState: 'not_dispatched', verified: false,
        retrySafe: true, reason: 'runtime_replaced', delta: { kind: 'none', changed: false },
      };
      const unknown: BrowserOperationStoredReceipt = {
        outcome: 'outcome_unknown', dispatchState: 'dispatched', verified: false,
        retrySafe: false, reason: 'dispatch_failed', delta: { kind: 'none', changed: false },
      };
      const before = this.db.prepare(`
        UPDATE browser_operation_ledger SET state = 'terminal', receipt_json = ?, updated_at = ?
        WHERE state IN ('proposed', 'approved')
      `).run(JSON.stringify(notDispatched), now).changes;
      const after = this.db.prepare(`
        UPDATE browser_operation_ledger SET state = 'terminal', receipt_json = ?, updated_at = ?
        WHERE state = 'dispatch_intent'
      `).run(JSON.stringify(unknown), now).changes;
      for (const orphan of orphanedFinalActions) {
        this.db.prepare(`UPDATE browser_final_actions SET state = 'outcome_unknown', evidence_status = 'none', updated_at = ?
          WHERE task_id = ? AND operation_id = ? AND state = 'reviewed'`)
          .run(now, orphan.task_id, orphan.operation_id);
        this.db.prepare(`UPDATE browser_tasks SET lifecycle = 'outcome-unknown', version = version + 1, updated_at = ?
          WHERE task_id = ? AND lifecycle != 'complete' AND lifecycle != 'abandoned'`)
          .run(now, orphan.task_id);
        this.db.prepare('DELETE FROM browser_task_bindings WHERE task_id = ?').run(orphan.task_id);
      }
      return { notDispatched: before, unknown: after };
    })();
  }

  listBrowserOperationColumns(): string[] {
    return (this.db.prepare('PRAGMA table_info(browser_operation_ledger)').all() as Array<{ name: string }>)
      .map((column) => column.name);
  }

  // -------------------------------------------------------------------------
  // browser task state — goal-scoped positive-shape persistence
  // -------------------------------------------------------------------------

  private ensureBrowserTaskCausalColumns(): void {
    const existing = new Set((this.db.prepare('PRAGMA table_info(browser_task_slots)').all() as Array<{ name: string }>)
      .map((column) => column.name));
    const additions: Array<[string, string]> = [
      ['baseline_observation_id', 'TEXT'], ['baseline_document_identity', 'TEXT'], ['baseline_structural_checksum', 'TEXT'],
      ['pending_target_binding', 'TEXT'], ['pending_runtime_generation', 'TEXT'],
      ['pending_capability_id', 'TEXT'], ['pending_control_epoch', 'TEXT'],
      ['pending_evidence_class', 'TEXT'],
    ];
    for (const [name, type] of additions) {
      if (!existing.has(name)) this.db.exec(`ALTER TABLE browser_task_slots ADD COLUMN ${name} ${type}`);
    }
  }

  claimBrowserTaskRecovery(taskId: string, taskVersion: number, targetBindingDigest: string, failureClass: string): boolean {
    return this.db.prepare(`
      INSERT OR IGNORE INTO browser_task_recoveries
        (task_id, task_version, target_binding_digest, failure_class, claimed_at)
      SELECT task_id, version, ?, ?, ? FROM browser_tasks
      WHERE task_id = ? AND version = ?
    `).run(targetBindingDigest, failureClass, new Date().toISOString(), taskId, taskVersion).changes === 1;
  }

  hasBrowserTaskRecovery(taskId: string): boolean {
    return this.db.prepare('SELECT 1 FROM browser_task_recoveries WHERE task_id = ? LIMIT 1').get(taskId) !== undefined;
  }

  createBrowserFinalAction(input: BrowserFinalActionCreateInput): BrowserTaskStored {
    return this.db.transaction(() => {
      const task = this.getBrowserTask(input.taskId);
      if (!task || task.version !== input.expectedVersion || task.lifecycle !== 'ready') throw new Error('browser_task_stale');
      if (!task.slots.some((slot) => slot.slotKey === input.slotKey && slot.slotKey.startsWith('final_activation_'))) {
        throw new Error('browser_task_final_slot_missing');
      }
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO browser_final_actions
          (operation_id, task_id, task_version, slot_key, target_binding_digest, control_epoch,
           review_key_version, review_binding_digest, predicate_key_version, predicate_binding_digest,
           state, evidence_status, durable_evidence_id, last_checked_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reviewed', 'none', NULL, NULL, ?, ?)
      `).run(input.operationId, input.taskId, input.expectedVersion, input.slotKey, input.targetBindingDigest,
        input.controlEpoch, input.reviewKeyVersion, input.reviewBindingDigest,
        input.predicateKeyVersion, input.predicateBindingDigest, now, now);
      this.db.prepare('UPDATE browser_tasks SET version = version + 1, updated_at = ? WHERE task_id = ? AND version = ?')
        .run(now, input.taskId, input.expectedVersion);
      return this.getBrowserTask(input.taskId)!;
    })();
  }

  getBrowserFinalAction(taskId: string): BrowserFinalActionEntry | null {
    const row = this.db.prepare('SELECT * FROM browser_final_actions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(taskId) as RawBrowserFinalActionRow | undefined;
    return row ? parseBrowserFinalActionRow(row) : null;
  }

  transitionBrowserFinalAction(input: BrowserFinalActionTransitionInput): BrowserTaskStored {
    return this.db.transaction(() => {
      const task = this.getBrowserTask(input.taskId);
      const action = this.getBrowserFinalAction(input.taskId);
      if (!task || task.version !== input.expectedVersion || !action || action.operationId !== input.operationId) {
        throw new Error('browser_task_final_action_stale');
      }
      const now = new Date().toISOString();
      const changed = this.db.prepare(`
        UPDATE browser_final_actions SET state = ?, evidence_status = ?, durable_evidence_id = ?,
          last_checked_at = ?, updated_at = ? WHERE task_id = ? AND operation_id = ? AND state IN (${input.fromStates.map(() => '?').join(',')})
      `).run(input.state, input.evidenceStatus ?? action.evidenceStatus,
        input.durableEvidenceId ?? action.durableEvidenceId,
        input.checked ? now : action.lastCheckedAt, now, input.taskId, input.operationId, ...input.fromStates).changes;
      if (changed !== 1) throw new Error('browser_task_final_action_stale');
      const slots = input.slots ?? task.slots;
      const updated = this.db.prepare(`
        UPDATE browser_tasks SET lifecycle = ?, version = version + 1, updated_at = ?
        WHERE task_id = ? AND version = ?
      `).run(input.lifecycle, now, input.taskId, input.expectedVersion).changes;
      if (updated !== 1) throw new Error('browser_task_stale');
      if (input.slots) this.replaceBrowserTaskSlots(input.taskId, slots);
      if (input.revokeBindings) this.db.prepare('DELETE FROM browser_task_bindings WHERE task_id = ?').run(input.taskId);
      return this.getBrowserTask(input.taskId)!;
    })();
  }

  createBrowserTask(input: BrowserTaskCreateInput, slots: BrowserTaskStoredSlot[], replaceTaskId?: string): BrowserTaskStored {
    return this.db.transaction(() => {
      const head = this.db.prepare(`
        SELECT task_id FROM browser_task_heads WHERE workspace_id = ? AND session_id = ?
      `).get(input.workspaceId, input.sessionId) as { task_id: string } | undefined;
      if (head && head.task_id !== replaceTaskId) throw new Error('browser_task_active');
      const now = new Date().toISOString();
      if (head) {
        this.db.prepare(`UPDATE browser_tasks SET lifecycle = 'abandoned', version = version + 1, updated_at = ? WHERE task_id = ?`)
          .run(now, head.task_id);
        this.db.prepare('DELETE FROM browser_task_bindings WHERE task_id = ?').run(head.task_id);
      }
      this.db.prepare(`
        INSERT INTO browser_tasks
          (task_id, workspace_id, session_id, principal_id, goal_epoch, runtime_generation,
           capability_id, version, lifecycle, observation_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?)
      `).run(input.taskId, input.workspaceId, input.sessionId, input.principalId, input.goalEpoch,
        input.runtimeGeneration, input.capabilityId, input.lifecycle, now, now);
      this.replaceBrowserTaskSlots(input.taskId, slots);
      this.db.prepare(`
        INSERT INTO browser_task_heads (workspace_id, session_id, task_id, goal_epoch)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(workspace_id, session_id) DO UPDATE SET task_id = excluded.task_id, goal_epoch = excluded.goal_epoch
      `).run(input.workspaceId, input.sessionId, input.taskId, input.goalEpoch);
      return this.getBrowserTask(input.taskId)!;
    })();
  }

  getActiveBrowserTask(workspaceId: string, sessionId: string): BrowserTaskStored | null {
    const row = this.db.prepare(`
      SELECT task_id FROM browser_task_heads WHERE workspace_id = ? AND session_id = ?
    `).get(workspaceId, sessionId) as { task_id: string } | undefined;
    return row ? this.getBrowserTask(row.task_id) : null;
  }

  getBrowserTask(taskId: string): BrowserTaskStored | null {
    const row = this.db.prepare('SELECT * FROM browser_tasks WHERE task_id = ?').get(taskId) as RawBrowserTaskRow | undefined;
    if (!row) return null;
    const slots = this.db.prepare('SELECT * FROM browser_task_slots WHERE task_id = ? ORDER BY slot_key')
      .all(taskId) as RawBrowserTaskSlotRow[];
    return parseBrowserTaskRow(row, slots);
  }

  casBrowserTask(taskId: string, expectedVersion: number, patch: BrowserTaskCasPatch, slots: BrowserTaskStoredSlot[]): BrowserTaskStored {
    return this.db.transaction(() => {
      const current = this.getBrowserTask(taskId);
      if (!current || current.version !== expectedVersion) throw new Error('browser_task_stale');
      if (patch.consumeBinding) {
        const consumed = this.db.prepare(`
          DELETE FROM browser_task_bindings
          WHERE task_id = ? AND purpose = ? AND key_version = ? AND binding_digest = ?
        `).run(taskId, patch.consumeBinding.purpose, patch.consumeBinding.keyVersion, patch.consumeBinding.digest);
        if (consumed.changes !== 1) throw new Error('browser_task_binding_stale');
      }
      const result = this.db.prepare(`
        UPDATE browser_tasks SET runtime_generation = ?, capability_id = ?, lifecycle = ?,
          version = version + 1, updated_at = ? WHERE task_id = ? AND version = ?
      `).run(patch.runtimeGeneration ?? current.runtimeGeneration,
        patch.capabilityId ?? current.capabilityId, patch.lifecycle,
        new Date().toISOString(), taskId, expectedVersion);
      if (result.changes !== 1) throw new Error('browser_task_stale');
      this.replaceBrowserTaskSlots(taskId, slots);
      if (patch.revokeBindings) this.db.prepare('DELETE FROM browser_task_bindings WHERE task_id = ?').run(taskId);
      if (patch.putBinding) {
        this.db.prepare(`
          INSERT INTO browser_task_bindings (task_id, purpose, key_version, binding_digest)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(task_id, purpose) DO UPDATE SET
            key_version = excluded.key_version, binding_digest = excluded.binding_digest
        `).run(taskId, patch.putBinding.purpose, patch.putBinding.keyVersion, patch.putBinding.digest);
      }
      return this.getBrowserTask(taskId)!;
    })();
  }

  getBrowserTaskBinding(taskId: string, purpose: string): { keyVersion: number; digest: string } | null {
    const row = this.db.prepare(`
      SELECT key_version, binding_digest FROM browser_task_bindings WHERE task_id = ? AND purpose = ?
    `).get(taskId, purpose) as { key_version: number; binding_digest: string } | undefined;
    return row ? { keyVersion: row.key_version, digest: row.binding_digest } : null;
  }

  consumeBrowserTaskObservation(workspaceId: string, sessionId: string, taskId: string, max: number): boolean {
    return this.db.prepare(`
      UPDATE browser_tasks SET observation_count = observation_count + 1, updated_at = ?
      WHERE task_id = ? AND workspace_id = ? AND session_id = ? AND observation_count < ?
        AND task_id = (SELECT task_id FROM browser_task_heads WHERE workspace_id = ? AND session_id = ?)
    `).run(new Date().toISOString(), taskId, workspaceId, sessionId, max, workspaceId, sessionId).changes === 1;
  }

  abandonBrowserTask(workspaceId: string, sessionId: string, taskId: string, expectedVersion: number): boolean {
    return this.db.transaction(() => {
      const changed = this.db.prepare(`
        UPDATE browser_tasks SET lifecycle = 'abandoned', version = version + 1, updated_at = ?
        WHERE task_id = ? AND workspace_id = ? AND session_id = ? AND version = ?
      `).run(new Date().toISOString(), taskId, workspaceId, sessionId, expectedVersion).changes;
      if (!changed) return false;
      this.db.prepare('DELETE FROM browser_task_heads WHERE workspace_id = ? AND session_id = ? AND task_id = ?')
        .run(workspaceId, sessionId, taskId);
      this.db.prepare('DELETE FROM browser_task_bindings WHERE task_id = ?').run(taskId);
      return true;
    })();
  }

  purgeBrowserTasksForSession(workspaceId: string, sessionId: string): number {
    return this.db.transaction(() => {
      const ids = this.db.prepare('SELECT task_id FROM browser_tasks WHERE workspace_id = ? AND session_id = ?')
        .all(workspaceId, sessionId) as Array<{ task_id: string }>;
      for (const { task_id } of ids) {
        this.db.prepare('DELETE FROM browser_final_actions WHERE task_id = ?').run(task_id);
        this.db.prepare('DELETE FROM browser_task_recoveries WHERE task_id = ?').run(task_id);
        this.db.prepare('DELETE FROM browser_task_bindings WHERE task_id = ?').run(task_id);
        this.db.prepare('DELETE FROM browser_task_slots WHERE task_id = ?').run(task_id);
      }
      this.db.prepare('DELETE FROM browser_task_heads WHERE workspace_id = ? AND session_id = ?').run(workspaceId, sessionId);
      return this.db.prepare('DELETE FROM browser_tasks WHERE workspace_id = ? AND session_id = ?').run(workspaceId, sessionId).changes;
    })();
  }

  purgeBrowserTasksForWorkspace(workspaceId: string): number {
    const rows = this.db.prepare('SELECT DISTINCT session_id FROM browser_tasks WHERE workspace_id = ?')
      .all(workspaceId) as Array<{ session_id: string }>;
    return rows.reduce((total, row) => total + this.purgeBrowserTasksForSession(workspaceId, row.session_id), 0);
  }

  listBrowserTaskColumns(): Record<string, string[]> {
    const names = ['browser_task_heads', 'browser_tasks', 'browser_task_slots', 'browser_task_bindings', 'browser_task_recoveries', 'browser_final_actions'];
    return Object.fromEntries(names.map((name) => [name,
      (this.db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>).map((column) => column.name),
    ]));
  }

  private replaceBrowserTaskSlots(taskId: string, slots: BrowserTaskStoredSlot[]): void {
    this.db.prepare('DELETE FROM browser_task_slots WHERE task_id = ?').run(taskId);
    const insert = this.db.prepare(`
      INSERT INTO browser_task_slots
        (task_id, slot_key, discovery, required, population, validation, authority,
         population_bucket, evidence_id, observation_epoch, pending_operation_id, baseline_observation_epoch,
         baseline_observation_id, baseline_document_identity, baseline_structural_checksum, pending_target_binding,
         pending_runtime_generation, pending_capability_id, pending_control_epoch, pending_evidence_class)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const slot of slots) insert.run(taskId, slot.slotKey, slot.discovery, slot.required ? 1 : 0,
      slot.population, slot.validation, slot.authority, slot.populationBucket,
      slot.evidenceId, slot.observationEpoch, slot.pendingOperationId, slot.baselineObservationEpoch,
      slot.baselineObservationId, slot.baselineDocumentIdentity, slot.baselineStructuralChecksum, slot.pendingTargetBinding,
      slot.pendingRuntimeGeneration, slot.pendingCapabilityId, slot.pendingControlEpoch, slot.pendingEvidenceClass);
  }

  private transitionBrowserOperation(
    principalId: string,
    operationId: string,
    from: BrowserOperationState[],
    to: BrowserOperationState,
  ): number {
    const placeholders = from.map(() => '?').join(', ');
    return this.db.prepare(`
      UPDATE browser_operation_ledger SET state = ?, updated_at = ?
      WHERE principal_id = ? AND operation_id = ? AND state IN (${placeholders})
    `).run(to, new Date().toISOString(), principalId, operationId, ...from).changes;
  }

  // -------------------------------------------------------------------------
  // bot_escalation_ledger (U8 phase-2, KTD-16): durable approval ledger for
  // out-of-sandbox escalations. Rows are created when the gate registers a
  // pending approval and transition exactly once (pending → approved/denied/
  // expired); transitions are atomic first-writer-wins so a late or duplicate
  // resolution can never flip a settled row.
  // -------------------------------------------------------------------------

  createBotEscalation(input: CreateBotEscalationInput): BotEscalationEntry {
    const entry: BotEscalationEntry = {
      id: input.id,
      botId: input.botId,
      sessionId: input.sessionId,
      audience: input.audience,
      requester: input.requester,
      recipients: input.recipients ?? [],
      rulePayload: input.rulePayload,
      state: 'pending',
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      resolvedAt: null,
      resolution: null,
    };
    this.db.prepare(`
      INSERT INTO bot_escalation_ledger
        (id, bot_id, session_id, audience, requester_channel, requester_channel_user_id,
         requester_role, recipients_json, rule_payload_json, state, created_at, expires_at,
         resolved_at, resolution_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(
      entry.id,
      entry.botId,
      entry.sessionId,
      entry.audience,
      entry.requester.channel,
      entry.requester.channelUserId,
      entry.requester.role,
      JSON.stringify(entry.recipients),
      JSON.stringify(entry.rulePayload),
      entry.state,
      entry.createdAt,
      entry.expiresAt,
    );
    return entry;
  }

  getBotEscalation(id: string): BotEscalationEntry | null {
    const row = this.db
      .prepare('SELECT * FROM bot_escalation_ledger WHERE id = ?')
      .get(id) as RawBotEscalationRow | undefined;
    return row ? parseBotEscalationRow(row) : null;
  }

  /**
   * Atomic pending → terminal-state transition (first writer wins). Returns
   * the settled row, or null when the row was already settled (late/duplicate
   * click, double expiry) or does not exist — callers must treat null as
   * "someone else resolved it" and skip their side effects.
   */
  transitionBotEscalation(
    id: string,
    toState: BotEscalationTerminalState,
    resolution: BotEscalationResolution,
    resolvedAt: string,
  ): BotEscalationEntry | null {
    const result = this.db.prepare(`
      UPDATE bot_escalation_ledger
      SET state = ?, resolved_at = ?, resolution_json = ?
      WHERE id = ? AND state = 'pending'
    `).run(toState, resolvedAt, JSON.stringify(resolution), id);
    if (result.changes === 0) return null;
    return this.getBotEscalation(id);
  }

  listBotEscalations(
    options: { botId?: string; state?: BotEscalationState; limit?: number; since?: string } = {},
  ): BotEscalationEntry[] {
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.botId) {
      clauses.push('bot_id = ?');
      params.push(options.botId);
    }
    if (options.state) {
      clauses.push('state = ?');
      params.push(options.state);
    }
    if (options.since) {
      clauses.push('created_at >= ?');
      params.push(options.since);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM bot_escalation_ledger ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params, limit) as RawBotEscalationRow[];
    return rows.map(parseBotEscalationRow);
  }

  /**
   * Boot recovery (KTD-16): every still-pending row belongs to a promise that
   * died with the previous process — expire them all (fail-closed, never
   * auto-allow) in one transaction and return the settled entries so the
   * caller can queue requester notifications.
   */
  expireAllPendingBotEscalations(
    resolution: BotEscalationResolution,
    resolvedAt: string,
  ): BotEscalationEntry[] {
    const expire = this.db.transaction(() => {
      const rows = this.db
        .prepare("SELECT * FROM bot_escalation_ledger WHERE state = 'pending'")
        .all() as RawBotEscalationRow[];
      this.db.prepare(`
        UPDATE bot_escalation_ledger
        SET state = 'expired', resolved_at = ?, resolution_json = ?
        WHERE state = 'pending'
      `).run(resolvedAt, JSON.stringify(resolution));
      return rows.map(parseBotEscalationRow).map((entry) => ({
        ...entry,
        state: 'expired' as const,
        resolvedAt,
        resolution,
      }));
    });
    return expire();
  }

  /**
   * Age-based retention for settled rows (mirrors bot_audit's 90-day default);
   * pending rows are never pruned (boot recovery owns their lifecycle).
   */
  pruneBotEscalationLedger(options: { retentionDays?: number } = {}): number {
    const retentionDays = options.retentionDays ?? 90;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    return this.db
      .prepare("DELETE FROM bot_escalation_ledger WHERE state != 'pending' AND created_at < ?")
      .run(cutoff).changes;
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

  // -------------------------------------------------------------------------
  // Global GitHub account connection (KTD5). The stored value is
  // credential-crypto ciphertext of the token bundle — these methods move the
  // blob; encryption/decryption is the caller's (github-auth) responsibility.
  // -------------------------------------------------------------------------

  /** Encrypted connection blob, or null when no connection is stored. */
  getGithubConnection(): string | null {
    const row = this.db
      .prepare('SELECT github_connection_json FROM app_settings WHERE id = 1')
      .get() as { github_connection_json: string } | undefined;
    const json = row?.github_connection_json;
    return json && json.length > 0 ? json : null;
  }

  /** Upsert the encrypted connection blob into the singleton row. */
  setGithubConnection(encryptedJson: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO app_settings (id, github_connection_json, updated_at)
        VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          github_connection_json = excluded.github_connection_json,
          updated_at = excluded.updated_at
      `)
      .run(encryptedJson, now);
  }

  /** Remove the stored connection (Disconnect). */
  clearGithubConnection(): void {
    this.db.prepare('DELETE FROM app_settings WHERE id = 1').run();
  }

  // -------------------------------------------------------------------------
  // Global remembered site-auth (cross-workspace). entry_json is a serialized
  // BrowserSiteAuthEntry; server-only — never returned to clients.
  // -------------------------------------------------------------------------

  /** Serialized BrowserSiteAuthEntry JSON for a site, or null when none stored. */
  getGlobalSiteAuth(siteKey: string): string | null {
    const row = this.db
      .prepare('SELECT entry_json FROM global_site_auth WHERE site_key = ?')
      .get(siteKey) as { entry_json: string } | undefined;
    const json = row?.entry_json;
    return json && json.length > 0 ? json : null;
  }

  /** Upsert the serialized site-auth entry JSON for a site. */
  setGlobalSiteAuth(siteKey: string, entryJson: string, generation?: string): void {
    let storedJson: string;
    try {
      const parsed = JSON.parse(entryJson) as BrowserSiteAuthStoredEntry;
      storedJson = JSON.stringify(
        isEncryptedSiteAuthEntry(parsed)
          ? parsed
          : encodeSiteAuthEntry(parsed as BrowserSiteAuthEntry, generation),
      );
    } catch (error) {
      if (error instanceof BrowserSiteAuthReadError) throw error;
      // Never persist an undecodable plaintext credential row.
      throw new Error('Invalid remembered authentication entry');
    }
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO global_site_auth (site_key, entry_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(site_key) DO UPDATE SET
          entry_json = excluded.entry_json,
          updated_at = excluded.updated_at
      `)
      .run(siteKey, storedJson, now);
  }

  /** Remove the stored site-auth entry for a site. */
  clearGlobalSiteAuth(siteKey: string): void {
    this.db.prepare('DELETE FROM global_site_auth WHERE site_key = ?').run(siteKey);
  }

  // -------------------------------------------------------------------------
  // Per-workspace GitHub repository association (KTD5/R8). Repo *names* are a
  // public soft reference on WorkspaceSettings; secrets never live here. The
  // RMW is a synchronous critical section, mirroring mutateWorkspaceSiteAuth.
  // -------------------------------------------------------------------------

  /** Associated repo full names (`owner/repo`), or [] when the workspace has none. */
  getWorkspaceGithubRepos(id: string): string[] {
    const row = this.db.prepare('SELECT settings FROM workspaces WHERE id = ?').get(id) as
      | { settings: string }
      | undefined;
    if (!row) return [];
    const settings = safeJsonParse(row.settings, {}) as WorkspaceSettings;
    return Array.isArray(settings.githubRepoFullNames) ? [...settings.githubRepoFullNames] : [];
  }

  /** Replace the workspace's associated repos; returns the stored list, or null if the workspace is missing. */
  setWorkspaceGithubRepos(id: string, repos: string[]): string[] | null {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as
      | RawWorkspaceRow
      | undefined;
    if (!row) return null;
    const workspace = parseRow(row);
    const deduped = [...new Set(repos.filter((r) => typeof r === 'string' && r.length > 0))];
    const settings: WorkspaceSettings = { ...workspace.settings, githubRepoFullNames: deduped };
    const updatedAt = new Date().toISOString();
    this.db
      .prepare('UPDATE workspaces SET settings = ?, updatedAt = ? WHERE id = ?')
      .run(JSON.stringify(settings), updatedAt, id);
    return settings.githubRepoFullNames ?? null;
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
  last_turn_started_at: number | null;
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
    lastTurnStartedAt: row.last_turn_started_at ?? undefined,
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
  backend: string | null;
  backend_session_id: string | null;
  bot_id: string | null;
  fast_mode: number;
  created_at: string;
  updated_at: string;
  summary: string | null;
  last_modified: number | null;
  first_prompt: string | null;
  git_branch: string | null;
  custom_title: string | null;
  last_turn_started_at: number | null;
}

function parseSessionRow(row: RawSessionRow): ChatSession {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    isDraft: row.is_draft === 1,
    isWip: row.is_wip === 1,
    isArchived: row.is_archived === 1,
    source: (row.source as 'gui' | 'wecom' | 'feishu' | 'scheduled') ?? undefined,
    approvalMode: (row.approval_mode as ApprovalMode) ?? undefined,
    providerId: row.provider_id ?? undefined,
    backend: row.backend ?? undefined,
    backendSessionId: row.backend_session_id ?? undefined,
    fastMode: row.fast_mode === 1,
    botId: row.bot_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    summary: row.summary ?? undefined,
    lastModified: row.last_modified ?? undefined,
    lastTurnStartedAt: row.last_turn_started_at ?? undefined,
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
  // Field-level fail-closed sanitizer on the read path (U2): old-shape blobs
  // get the new fields backfilled to safe defaults; a corrupt blob collapses
  // to the full default. Never returns an unsanitized shape.
  const parsed = safeJsonParse(row.permissions_json, {});
  return {
    id: row.id,
    botId: row.bot_id,
    roleKey: row.role_key as BotRoleKey,
    permissions: sanitizeBotRolePolicy(parsed),
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

// ---------------------------------------------------------------------------
// browser_audit row types (U8). Positive shape only — the table has no
// column capable of holding a field value or an image (KTD-9 contract).
// ---------------------------------------------------------------------------

export type BrowserAuditCategory = 'tool' | 'control' | 'navigation' | 'site_auth' | 'broker';

export type BrowserAuditOutcome = 'ok' | 'denied' | 'error' | 'timeout';

export interface CreateBrowserAuditInput {
  workspaceId: string;
  sessionId?: string | null;
  category: BrowserAuditCategory;
  /** Tool name (`mcp__comate-browser__act`), control verb, or event kind. */
  action: string;
  /** URL origin only (scheme + host + port) — never a full URL with query. */
  origin?: string | null;
  /** PSL site key when the action is site-scoped. */
  siteKey?: string | null;
  /** Field NAMES involved (e.g. submit form fields) — values never. */
  fieldNames?: string[];
  outcome: BrowserAuditOutcome;
  /** RISK-1: a click that cannot be proven harmless was followed by navigation. */
  potentialSubmit?: boolean;
  /** Bounded, pre-sanitized context (no values, no images). */
  detail?: string | null;
}

export interface BrowserAuditEntry {
  id: string;
  workspaceId: string;
  sessionId: string | null;
  category: BrowserAuditCategory;
  action: string;
  origin: string | null;
  siteKey: string | null;
  fieldNames: string[];
  outcome: BrowserAuditOutcome;
  potentialSubmit: boolean;
  detail: string | null;
  createdAt: string;
}

interface RawBrowserAuditRow {
  id: string;
  workspace_id: string;
  session_id: string | null;
  category: string;
  action: string;
  origin: string | null;
  site_key: string | null;
  field_names: string;
  outcome: string;
  potential_submit: number;
  detail: string | null;
  created_at: string;
}

function parseBrowserAuditRow(row: RawBrowserAuditRow): BrowserAuditEntry {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    category: row.category as BrowserAuditCategory,
    action: row.action,
    origin: row.origin,
    siteKey: row.site_key,
    fieldNames: safeJsonParse(row.field_names, []),
    outcome: row.outcome as BrowserAuditOutcome,
    potentialSubmit: row.potential_submit === 1,
    detail: row.detail,
    createdAt: row.created_at,
  };
}

export type BrowserOperationState = 'proposed' | 'approved' | 'dispatch_intent' | 'terminal';

export interface BrowserOperationStoredReceipt {
  outcome: 'not_dispatched' | 'dispatched_verified' | 'outcome_unknown';
  dispatchState: 'not_dispatched' | 'dispatched';
  verified: boolean;
  retrySafe: boolean;
  reason?: string;
  matchesRequested?: boolean;
  normalizedLength?: number;
  delta: { kind: 'none' | 'activation' | 'field'; changed: boolean };
}

export interface ProposeBrowserOperationInput {
  operationId: string;
  principalId: string;
  workspaceId: string;
  sessionId: string;
  runtimeGeneration: string;
  capabilityId: string;
  action: string;
  parameterDigest: string;
}

export interface BrowserOperationEntry extends ProposeBrowserOperationInput {
  state: BrowserOperationState;
  receipt: BrowserOperationStoredReceipt | null;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserTaskStoredSlot {
  slotKey: string;
  discovery: string;
  required: boolean;
  population: string;
  validation: string;
  authority: string;
  populationBucket: string;
  evidenceId: string | null;
  observationEpoch: number | null;
  pendingOperationId: string | null;
  baselineObservationEpoch: number | null;
  baselineObservationId: string | null;
  baselineDocumentIdentity: string | null;
  baselineStructuralChecksum: string | null;
  pendingTargetBinding: string | null;
  pendingRuntimeGeneration: string | null;
  pendingCapabilityId: string | null;
  pendingControlEpoch: string | null;
  pendingEvidenceClass: string | null;
}

export interface BrowserTaskCreateInput {
  taskId: string;
  workspaceId: string;
  sessionId: string;
  principalId: string;
  goalEpoch: string;
  runtimeGeneration: string;
  capabilityId: string;
  lifecycle: string;
}

export interface BrowserTaskCasPatch {
  runtimeGeneration?: string;
  capabilityId?: string;
  lifecycle: string;
  revokeBindings?: boolean;
  putBinding?: { purpose: string; keyVersion: number; digest: string };
  consumeBinding?: { purpose: string; keyVersion: number; digest: string };
}

export interface BrowserTaskStored extends BrowserTaskCreateInput {
  version: number;
  observationCount: number;
  slots: BrowserTaskStoredSlot[];
  createdAt: string;
  updatedAt: string;
}

export interface BrowserFinalActionCreateInput {
  operationId: string;
  taskId: string;
  expectedVersion: number;
  slotKey: string;
  targetBindingDigest: string;
  controlEpoch: string;
  reviewKeyVersion: number;
  reviewBindingDigest: string;
  predicateKeyVersion: number;
  predicateBindingDigest: string;
}

export type BrowserFinalActionState = 'reviewed' | 'cancelled' | 'outcome_unknown' | 'complete' | 'abandoned' | 'duplicate_risk_acknowledged';
export type BrowserFinalEvidenceStatus = 'none' | 'insufficient' | 'conflicting' | 'durable';
export interface BrowserFinalActionEntry {
  operationId: string;
  taskId: string;
  taskVersion: number;
  slotKey: string;
  targetBindingDigest: string;
  controlEpoch: string;
  reviewKeyVersion: number;
  reviewBindingDigest: string;
  predicateKeyVersion: number;
  predicateBindingDigest: string;
  state: BrowserFinalActionState;
  evidenceStatus: BrowserFinalEvidenceStatus;
  durableEvidenceId: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserFinalActionTransitionInput {
  taskId: string;
  expectedVersion: number;
  operationId: string;
  fromStates: BrowserFinalActionState[];
  state: BrowserFinalActionState;
  lifecycle: string;
  evidenceStatus?: BrowserFinalEvidenceStatus;
  durableEvidenceId?: string | null;
  checked?: boolean;
  slots?: BrowserTaskStoredSlot[];
  revokeBindings?: boolean;
}

interface RawBrowserTaskRow {
  task_id: string; workspace_id: string; session_id: string; principal_id: string;
  goal_epoch: string; runtime_generation: string; capability_id: string;
  version: number; lifecycle: string; observation_count: number;
  created_at: string; updated_at: string;
}

interface RawBrowserFinalActionRow {
  operation_id: string; task_id: string; task_version: number; slot_key: string;
  target_binding_digest: string; control_epoch: string;
  review_key_version: number; review_binding_digest: string;
  predicate_key_version: number; predicate_binding_digest: string;
  state: string; evidence_status: string; durable_evidence_id: string | null;
  last_checked_at: string | null; created_at: string; updated_at: string;
}

function parseBrowserFinalActionRow(row: RawBrowserFinalActionRow): BrowserFinalActionEntry {
  return {
    operationId: row.operation_id, taskId: row.task_id, taskVersion: row.task_version,
    slotKey: row.slot_key, targetBindingDigest: row.target_binding_digest, controlEpoch: row.control_epoch,
    reviewKeyVersion: row.review_key_version, reviewBindingDigest: row.review_binding_digest,
    predicateKeyVersion: row.predicate_key_version, predicateBindingDigest: row.predicate_binding_digest,
    state: row.state as BrowserFinalActionState, evidenceStatus: row.evidence_status as BrowserFinalEvidenceStatus,
    durableEvidenceId: row.durable_evidence_id, lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

interface RawBrowserTaskSlotRow {
  slot_key: string; discovery: string; required: number; population: string;
  validation: string; authority: string; population_bucket: string;
  evidence_id: string | null; observation_epoch: number | null;
  pending_operation_id: string | null; baseline_observation_epoch: number | null;
  baseline_observation_id: string | null; baseline_document_identity: string | null; baseline_structural_checksum: string | null;
  pending_target_binding: string | null; pending_runtime_generation: string | null;
  pending_capability_id: string | null; pending_control_epoch: string | null;
  pending_evidence_class: string | null;
}

function parseBrowserTaskRow(row: RawBrowserTaskRow, slots: RawBrowserTaskSlotRow[]): BrowserTaskStored {
  return {
    taskId: row.task_id, workspaceId: row.workspace_id, sessionId: row.session_id,
    principalId: row.principal_id, goalEpoch: row.goal_epoch,
    runtimeGeneration: row.runtime_generation, capabilityId: row.capability_id,
    version: row.version, lifecycle: row.lifecycle, observationCount: row.observation_count,
    createdAt: row.created_at, updatedAt: row.updated_at,
    slots: slots.map((slot) => ({
      slotKey: slot.slot_key, discovery: slot.discovery, required: slot.required === 1,
      population: slot.population, validation: slot.validation, authority: slot.authority,
      populationBucket: slot.population_bucket, evidenceId: slot.evidence_id,
      observationEpoch: slot.observation_epoch, pendingOperationId: slot.pending_operation_id,
      baselineObservationEpoch: slot.baseline_observation_epoch,
      baselineObservationId: slot.baseline_observation_id, baselineDocumentIdentity: slot.baseline_document_identity,
      baselineStructuralChecksum: slot.baseline_structural_checksum,
      pendingTargetBinding: slot.pending_target_binding, pendingRuntimeGeneration: slot.pending_runtime_generation,
      pendingCapabilityId: slot.pending_capability_id, pendingControlEpoch: slot.pending_control_epoch,
      pendingEvidenceClass: slot.pending_evidence_class,
    })),
  };
}

interface RawBrowserOperationRow {
  operation_id: string;
  principal_id: string;
  workspace_id: string;
  session_id: string;
  runtime_generation: string;
  capability_id: string;
  action: string;
  parameter_digest: string;
  state: string;
  receipt_json: string | null;
  created_at: string;
  updated_at: string;
}

const BROWSER_OPERATION_STATES = new Set<BrowserOperationState>([
  'proposed', 'approved', 'dispatch_intent', 'terminal',
]);
const BROWSER_OPERATION_OUTCOMES = new Set<BrowserOperationStoredReceipt['outcome']>([
  'not_dispatched', 'dispatched_verified', 'outcome_unknown',
]);
const BROWSER_OPERATION_REASONS = new Set([
  'target_unavailable', 'target_disabled', 'target_not_visible', 'target_occluded',
  'target_frame_mismatch', 'unsupported_target', 'unsupported_input_command',
  'dispatch_failed', 'verification_mismatch', 'runtime_replaced',
  'control_taken_over', 'cancelled', 'user_denied', 'target_changed',
]);

function unknownBrowserOperationReceipt(): BrowserOperationStoredReceipt {
  return {
    outcome: 'outcome_unknown', dispatchState: 'dispatched', verified: false,
    retrySafe: false, reason: 'dispatch_failed', delta: { kind: 'none', changed: false },
  };
}

function parseBrowserOperationReceipt(json: string | null): BrowserOperationStoredReceipt | null {
  if (json === null) return null;
  let value: unknown;
  try { value = JSON.parse(json); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  const delta = receipt.delta;
  if (!BROWSER_OPERATION_OUTCOMES.has(receipt.outcome as BrowserOperationStoredReceipt['outcome']) ||
      (receipt.dispatchState !== 'not_dispatched' && receipt.dispatchState !== 'dispatched') ||
      typeof receipt.verified !== 'boolean' || typeof receipt.retrySafe !== 'boolean' ||
      !delta || typeof delta !== 'object' || Array.isArray(delta)) return null;
  const parsedDelta = delta as Record<string, unknown>;
  if ((parsedDelta.kind !== 'none' && parsedDelta.kind !== 'activation' && parsedDelta.kind !== 'field') ||
      typeof parsedDelta.changed !== 'boolean') return null;
  if (receipt.reason !== undefined &&
      (typeof receipt.reason !== 'string' || receipt.reason.length > 128 || !BROWSER_OPERATION_REASONS.has(receipt.reason))) return null;
  if (receipt.matchesRequested !== undefined && typeof receipt.matchesRequested !== 'boolean') return null;
  if (receipt.normalizedLength !== undefined &&
      (typeof receipt.normalizedLength !== 'number' || !Number.isSafeInteger(receipt.normalizedLength) || receipt.normalizedLength < 0 ||
       receipt.normalizedLength > 10_000_000)) return null;
  if (receipt.outcome === 'dispatched_verified' &&
      (receipt.dispatchState !== 'dispatched' || receipt.verified !== true || receipt.retrySafe !== false)) return null;
  if (receipt.outcome === 'outcome_unknown' &&
      (receipt.dispatchState !== 'dispatched' || receipt.verified !== false || receipt.retrySafe !== false)) return null;
  if (receipt.outcome === 'not_dispatched' &&
      (receipt.dispatchState !== 'not_dispatched' || receipt.retrySafe !== true)) return null;
  return receipt as unknown as BrowserOperationStoredReceipt;
}

function parseBrowserOperationRow(row: RawBrowserOperationRow): BrowserOperationEntry {
  const validState = BROWSER_OPERATION_STATES.has(row.state as BrowserOperationState);
  const parsedReceipt = parseBrowserOperationReceipt(row.receipt_json);
  const corrupted = !validState ||
    (row.state === 'terminal' && parsedReceipt === null) ||
    (row.state !== 'terminal' && row.receipt_json !== null);
  return {
    operationId: row.operation_id,
    principalId: row.principal_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    runtimeGeneration: row.runtime_generation,
    capabilityId: row.capability_id,
    action: row.action,
    parameterDigest: row.parameter_digest,
    state: corrupted ? 'terminal' : row.state as BrowserOperationState,
    receipt: corrupted ? unknownBrowserOperationReceipt() : parsedReceipt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// bot_escalation_ledger row types (U8 phase-2, KTD-15/KTD-16). Positive-shape
// parser: unknown audience/state values fail safe (audience → 'admins', and
// terminal states round-trip only from the closed set).
// ---------------------------------------------------------------------------

export type BotEscalationAudience = 'self' | 'admins';
export type BotEscalationTerminalState = 'approved' | 'denied' | 'expired';
export type BotEscalationState = 'pending' | BotEscalationTerminalState;
export type BotEscalationDecision = 'allow' | 'deny' | 'expired';

/** A notified recipient of the escalation (U11: one per owner/admin card). */
export interface BotEscalationRecipient {
  userId: string;
  taskId: string;
}

/** The channel user whose tool call triggered the escalation. */
export interface BotEscalationRequester {
  channel: string;
  channelUserId: string;
  role: string | null;
}

/**
 * Who/how the escalation was settled. `approver` is the actor (system for
 * TTL/boot expiries); `source` is the resolution channel (`self-approval`,
 * `desktop`, `timeout`, `boot-recovery`; U11 adds remote-card sources).
 */
export interface BotEscalationResolution {
  approver: { type: string; channelKey?: string; channelUserId?: string };
  decision: BotEscalationDecision;
  source: string;
}

/**
 * The rule payload the approver was shown (and that "always allow" would
 * persist, U11): tool + the exact command/input summary + routing context.
 */
export interface BotEscalationRulePayload {
  toolName: string;
  command?: string;
  decisionReasonType?: string;
  /**
   * U11 (KTD-19): generalized dedupe signature (parameter variants collapse
   * into one pending). Computed at creation; absent on U8 rows.
   */
  dedupeSignature?: string;
  /**
   * U11 (KTD-18): the exact-match rules "always allow" would persist. Empty
   * or absent ⇒ the always-allow button is suppressed on the approval card.
   */
  alwaysAllowRules?: string[];
}

export interface CreateBotEscalationInput {
  /** The approval requestId — also the pending-approval correlation key. */
  id: string;
  botId: string;
  sessionId: string;
  audience: BotEscalationAudience;
  requester: BotEscalationRequester;
  recipients?: BotEscalationRecipient[];
  rulePayload: BotEscalationRulePayload;
  createdAt: string;
  expiresAt: string;
}

export interface BotEscalationEntry {
  id: string;
  botId: string;
  sessionId: string;
  audience: BotEscalationAudience;
  requester: BotEscalationRequester;
  recipients: BotEscalationRecipient[];
  rulePayload: BotEscalationRulePayload;
  state: BotEscalationState;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  resolution: BotEscalationResolution | null;
}

interface RawBotEscalationRow {
  id: string;
  bot_id: string;
  session_id: string;
  audience: string;
  requester_channel: string;
  requester_channel_user_id: string;
  requester_role: string | null;
  recipients_json: string;
  rule_payload_json: string;
  state: string;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
  resolution_json: string | null;
}

function parseBotEscalationRow(row: RawBotEscalationRow): BotEscalationEntry {
  return {
    id: row.id,
    botId: row.bot_id,
    sessionId: row.session_id,
    // Fail-safe (KTD-15): an unreadable audience never becomes 'self'.
    audience: row.audience === 'self' ? 'self' : 'admins',
    requester: {
      channel: row.requester_channel,
      channelUserId: row.requester_channel_user_id,
      role: row.requester_role,
    },
    recipients: safeJsonParse(row.recipients_json, []),
    rulePayload: safeJsonParse(row.rule_payload_json, { toolName: 'unknown' }),
    state: (['pending', 'approved', 'denied', 'expired'].includes(row.state)
      ? row.state
      : 'expired') as BotEscalationState,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    resolution: row.resolution_json ? safeJsonParse(row.resolution_json, null) : null,
  };
}


interface RawTodoRow {
  id: string;
  workspace_id: string | null;
  text: string;
  content: string | null;
  status: string;
  session_id: string | null;
  created_at: string;
  updated_at: string;
  origin: string;
  due_date: string | null;
  repo_full_name: string | null;
  issue_number: number | null;
  remote_snapshot_json: string | null;
  remote_updated_at: string | null;
  last_synced_at: string | null;
  assignee: string | null;
  labels_json: string;
  origin_deleted: number;
  execution_type: string;
  instruction: string | null;
  schedule_time: string | null;
  cron_expr: string | null;
  execution_status: string;
  next_fire_at: string | null;
  notify_desktop: number;
  notify_in_app: number;
  notify_wecom: number;
  wecom_recipient: string | null;
  confirmed_snapshot: string | null;
  deleted_at: string | null;
  legacy_scheduled_task_id: string | null;
}

function parseTodoRow(row: RawTodoRow): Todo {
  return {
    id: row.id,
    workspaceId: row.workspace_id ?? null,
    text: row.text,
    content: row.content ?? null,
    status: row.status as TodoStatus,
    executionType: (row.execution_type as Todo['executionType'] | undefined) ?? 'manual',
    instruction: row.instruction ?? null,
    scheduleTime: row.schedule_time ?? null,
    cronExpr: row.cron_expr ?? null,
    executionStatus: (row.execution_status as TodoExecutionStatus | undefined) ?? 'active',
    nextFireAt: row.next_fire_at ?? null,
    notifyDesktop: row.notify_desktop !== 0,
    notifyInApp: row.notify_in_app !== 0,
    notifyWecom: row.notify_wecom === 1,
    wecomRecipient: row.wecom_recipient ?? null,
    confirmedSnapshot: row.confirmed_snapshot ? JSON.parse(row.confirmed_snapshot) : null,
    deletedAt: row.deleted_at ?? null,
    sessionId: row.session_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    origin: (row.origin as TodoOrigin | undefined) ?? 'local',
    dueDate: row.due_date ?? null,
    repoFullName: row.repo_full_name ?? null,
    issueNumber: row.issue_number ?? null,
    remoteSnapshot: row.remote_snapshot_json ?? null,
    remoteUpdatedAt: row.remote_updated_at ?? null,
    lastSyncedAt: row.last_synced_at ?? null,
    assignee: row.assignee ?? null,
    labels: safeJsonParse(row.labels_json, []) as string[],
    originDeleted: Boolean(row.origin_deleted),
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
    supportsFastMode: providerSupportsFastMode(row.model ?? undefined),
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

interface RawScheduledTaskRow {
  id: string;
  workspace_id: string;
  name: string;
  instruction: string;
  schedule_type: string;
  schedule_time: string | null;
  cron_expr: string | null;
  notify_desktop: number;
  notify_in_app: number;
  notify_wecom: number;
  wecom_recipient: string | null;
  status: string;
  deleted_at: string | null;
  confirmed_snapshot: string | null;
  next_fire_at: string | null;
  created_at: string;
  updated_at: string;
}

function parseScheduledTaskRow(row: RawScheduledTaskRow): ScheduledTask {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    instruction: row.instruction,
    scheduleType: row.schedule_type as ScheduledTask['scheduleType'],
    scheduleTime: row.schedule_time,
    cronExpr: row.cron_expr,
    notifyDesktop: row.notify_desktop === 1,
    notifyInApp: row.notify_in_app === 1,
    notifyWecom: row.notify_wecom === 1,
    wecomRecipient: row.wecom_recipient,
    status: row.status as ScheduledTaskStatus,
    deletedAt: row.deleted_at,
    confirmedSnapshot: row.confirmed_snapshot
      ? safeJsonParse<ConfirmedTaskSnapshot | null>(row.confirmed_snapshot, null)
      : null,
    nextFireAt: row.next_fire_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface RawTaskRunRow {
  id: string;
  task_id: string;
  session_id: string | null;
  status: string;
  fire_at: string;
  started_at: string | null;
  ended_at: string | null;
  reason: string | null;
  instruction_snapshot: string;
  created_at: string;
}

interface RawTodoRunRow {
  id: string;
  todo_id: string;
  session_id: string | null;
  status: string;
  fire_at: string;
  started_at: string | null;
  ended_at: string | null;
  reason: string | null;
  instruction_snapshot: string;
  created_at: string;
}

function parseTodoRunRow(row: RawTodoRunRow): TodoRun {
  return {
    id: row.id,
    todoId: row.todo_id,
    sessionId: row.session_id ?? null,
    status: row.status as TodoRunStatus,
    fireAt: row.fire_at,
    startedAt: row.started_at ?? null,
    endedAt: row.ended_at ?? null,
    reason: row.reason ?? null,
    instructionSnapshot: row.instruction_snapshot,
    createdAt: row.created_at,
  };
}

function parseTaskRunRow(row: RawTaskRunRow): TaskRun {
  return {
    id: row.id,
    taskId: row.task_id,
    sessionId: row.session_id,
    status: row.status as TaskRunStatus,
    fireAt: row.fire_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    reason: row.reason,
    instructionSnapshot: row.instruction_snapshot,
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
