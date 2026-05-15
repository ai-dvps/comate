import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { v4 as uuidv4 } from 'uuid';
import type { ChatSession, CreateSessionInput, UpdateSessionInput } from '../models/session.js';

const STORAGE_DIR = join(homedir(), '.claude-code-gui');
const SESSIONS_FILE = join(STORAGE_DIR, 'sessions.json');

interface SessionsData {
  sessions: ChatSession[];
}

async function ensureStorage(): Promise<void> {
  try {
    await access(STORAGE_DIR);
  } catch {
    await mkdir(STORAGE_DIR, { recursive: true });
  }
}

async function readSessions(): Promise<SessionsData> {
  try {
    const data = await readFile(SESSIONS_FILE, 'utf-8');
    const parsed = JSON.parse(data) as SessionsData;
    return { sessions: parsed.sessions || [] };
  } catch {
    return { sessions: [] };
  }
}

async function writeSessions(data: SessionsData): Promise<void> {
  await ensureStorage();
  const tempFile = `${SESSIONS_FILE}.tmp`;
  await writeFile(tempFile, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  await writeFile(SESSIONS_FILE, await readFile(tempFile, 'utf-8'), 'utf-8');
}

export class JsonStore {
  // Session methods only — workspaces have moved to SQLite

  async listSessions(workspaceId?: string): Promise<ChatSession[]> {
    const data = await readSessions();
    if (workspaceId) {
      return data.sessions.filter(s => s.workspaceId === workspaceId);
    }
    return data.sessions;
  }

  async getSession(id: string): Promise<ChatSession | null> {
    const data = await readSessions();
    return data.sessions.find(s => s.id === id) || null;
  }

  async createSession(input: CreateSessionInput): Promise<ChatSession> {
    const now = new Date().toISOString();
    const session: ChatSession = {
      id: uuidv4(),
      workspaceId: input.workspaceId,
      name: input.name,
      createdAt: now,
      updatedAt: now,
    };

    const data = await readSessions();
    data.sessions.push(session);
    await writeSessions(data);
    return session;
  }

  async updateSession(id: string, input: UpdateSessionInput): Promise<ChatSession | null> {
    const data = await readSessions();
    const index = data.sessions.findIndex(s => s.id === id);
    if (index === -1) return null;

    const session = data.sessions[index];
    data.sessions[index] = {
      ...session,
      ...(input.name !== undefined && { name: input.name }),
      ...(input.sdkSessionId !== undefined && { sdkSessionId: input.sdkSessionId }),
      updatedAt: new Date().toISOString(),
    };

    await writeSessions(data);
    return data.sessions[index];
  }

  async deleteSession(id: string): Promise<boolean> {
    const data = await readSessions();
    const index = data.sessions.findIndex(s => s.id === id);
    if (index === -1) return false;

    data.sessions.splice(index, 1);
    await writeSessions(data);
    return true;
  }
}

export const store = new JsonStore();
