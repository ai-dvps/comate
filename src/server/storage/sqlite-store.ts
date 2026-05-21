import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { Workspace, CreateWorkspaceInput, UpdateWorkspaceInput } from '../models/workspace.js';
import type { ChatSession } from '../models/session.js';
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

    this.migrateFromLegacy();
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
