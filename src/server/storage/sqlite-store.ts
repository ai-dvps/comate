import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { Workspace, CreateWorkspaceInput, UpdateWorkspaceInput } from '../models/workspace.js';
import type { ChatSession, ApprovalMode } from '../models/session.js';
import type { Todo, CreateTodoInput, UpdateTodoInput, TodoStatus } from '../models/todo.js';
import { getStorageDir } from './data-dir.js';
import { getNativeBindingPath } from './native-binding.js';

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

  constructor() {
    ensureDirSync();
    const options = getDatabaseOptions();
    this.db = new Database(DB_FILE, options);
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
        updatedAt TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wecom_user_sessions (
        workspaceId TEXT NOT NULL,
        wecomUserId TEXT NOT NULL,
        sessionId TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (workspaceId, wecomUserId)
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
      CREATE TABLE IF NOT EXISTS session_metadata (
        session_id TEXT PRIMARY KEY,
        is_wip INTEGER NOT NULL DEFAULT 0
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        is_draft INTEGER NOT NULL DEFAULT 1,
        is_wip INTEGER NOT NULL DEFAULT 0,
        source TEXT,
        approval_mode TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        summary TEXT,
        last_modified INTEGER,
        first_prompt TEXT,
        git_branch TEXT,
        custom_title TEXT
      )
    `);

    // Migration: add approval_mode column to existing sessions table
    const sessionColumns = this.db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    if (!sessionColumns.some(col => col.name === 'approval_mode')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN approval_mode TEXT');
    }

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

    this.migrateTodoDetailColumn();
    this.migrateMappingTable();
    this.migrateFromLegacy();
    this.migrateDraftSessions();
    this.migrateSessionMetadataToSessions();
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
      INSERT INTO workspaces (id, name, description, folderPath, settings, skills, mcpServers, hooks, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          ws.updatedAt
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
    };

    this.db.prepare(`
      INSERT INTO workspaces (id, name, description, folderPath, settings, skills, mcpServers, hooks, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      workspace.updatedAt
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

  async delete(id: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
    if (result.changes > 0) {
      this.db.prepare('DELETE FROM wecom_user_sessions WHERE workspaceId = ?').run(id);
      this.db.prepare('DELETE FROM wecom_workspace_users WHERE workspaceId = ?').run(id);
      this.db.prepare('DELETE FROM todos WHERE workspace_id = ?').run(id);
    }
    return result.changes > 0;
  }

  // WeCom user session mapping

  getWecomSession(workspaceId: string, wecomUserId: string): string | null {
    const row = this.db
      .prepare('SELECT sessionId FROM wecom_user_sessions WHERE workspaceId = ? AND wecomUserId = ?')
      .get(workspaceId, wecomUserId) as { sessionId: string } | undefined;
    return row?.sessionId ?? null;
  }

  setWecomSession(workspaceId: string, wecomUserId: string, sessionId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO wecom_user_sessions (workspaceId, wecomUserId, sessionId, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(workspaceId, wecomUserId) DO UPDATE SET
          sessionId = excluded.sessionId,
          updatedAt = excluded.updatedAt
      `)
      .run(workspaceId, wecomUserId, sessionId, now, now);
  }

  listWecomSessions(workspaceId: string): Array<{ wecomUserId: string; sessionId: string }> {
    const rows = this.db
      .prepare('SELECT wecomUserId, sessionId FROM wecom_user_sessions WHERE workspaceId = ?')
      .all(workspaceId) as Array<{ wecomUserId: string; sessionId: string }>;
    return rows;
  }

  getWecomUserIdBySession(workspaceId: string, sessionId: string): string | null {
    const row = this.db
      .prepare('SELECT wecomUserId FROM wecom_user_sessions WHERE workspaceId = ? AND sessionId = ?')
      .get(workspaceId, sessionId) as { wecomUserId: string } | undefined;
    return row?.wecomUserId ?? null;
  }

  // WeCom user ID mapping (encrypted -> plaintext), global across workspaces

  getWecomUserMapping(encryptedUserId: string): string | null {
    const row = this.db
      .prepare('SELECT plaintextUserId FROM wecom_user_id_mappings WHERE encryptedUserId = ?')
      .get(encryptedUserId) as { plaintextUserId: string } | undefined;
    return row?.plaintextUserId ?? null;
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

  createLocalSession(workspaceId: string, name: string, approvalMode?: string): ChatSession {
    const now = new Date().toISOString();
    const mode = approvalMode ?? 'manual';
    const session: ChatSession = {
      id: uuidv4(),
      workspaceId,
      name,
      isDraft: true,
      approvalMode: mode as ChatSession['approvalMode'],
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO sessions (id, workspace_id, name, is_draft, is_wip, approval_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(session.id, session.workspaceId, session.name, 1, 0, mode, session.createdAt, session.updatedAt);
    return session;
  }

  updateLocalSession(id: string, input: { name?: string; isWip?: boolean; approvalMode?: string }): ChatSession | null {
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
    if (input.approvalMode !== undefined) {
      sets.push('approval_mode = ?');
      values.push(input.approvalMode);
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
      INSERT INTO sessions (id, workspace_id, name, is_draft, is_wip, source, created_at, updated_at, summary, last_modified, first_prompt, git_branch, custom_title)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        is_draft = excluded.is_draft,
        source = excluded.source,
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
      session.source ?? null,
      session.createdAt,
      session.updatedAt,
      session.summary ?? null,
      session.lastModified ?? null,
      session.firstPrompt ?? null,
      session.gitBranch ?? null,
      session.customTitle ?? null
    );
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
  };
}

interface RawSessionRow {
  id: string;
  workspace_id: string;
  name: string;
  is_draft: number;
  is_wip: number;
  source: string | null;
  approval_mode: string | null;
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
    source: (row.source as 'gui' | 'wecom') ?? undefined,
    approvalMode: (row.approval_mode as ApprovalMode) ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    summary: row.summary ?? undefined,
    lastModified: row.last_modified ?? undefined,
    firstPrompt: row.first_prompt ?? undefined,
    gitBranch: row.git_branch ?? undefined,
    customTitle: row.custom_title ?? undefined,
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

function safeJsonParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function ensureDirSync(): void {
  if (!existsSync(STORAGE_DIR)) {
    mkdirSync(STORAGE_DIR, { recursive: true });
  }
}

export const store = new SqliteStore();
