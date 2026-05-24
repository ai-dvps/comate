import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { ChatSession, CreateSessionInput, UpdateSessionInput } from '../models/session.js';
import { getStorageDir } from './data-dir.js';

const STORAGE_DIR = getStorageDir();
const DRAFTS_FILE = join(STORAGE_DIR, 'draft-sessions.json');

interface DraftsData {
  sessions: ChatSession[];
}

async function ensureStorage(): Promise<void> {
  try {
    await access(STORAGE_DIR);
  } catch {
    await mkdir(STORAGE_DIR, { recursive: true });
  }
}

async function readDrafts(): Promise<DraftsData> {
  try {
    const data = await readFile(DRAFTS_FILE, 'utf-8');
    const parsed = JSON.parse(data) as DraftsData;
    return { sessions: parsed.sessions || [] };
  } catch {
    return { sessions: [] };
  }
}

async function writeDrafts(data: DraftsData): Promise<void> {
  await ensureStorage();
  const tempFile = `${DRAFTS_FILE}.tmp`;
  await writeFile(tempFile, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  await writeFile(DRAFTS_FILE, await readFile(tempFile, 'utf-8'), 'utf-8');
}

export class DraftSessionStore {
  async listDrafts(workspaceId?: string): Promise<ChatSession[]> {
    const data = await readDrafts();
    if (workspaceId) {
      return data.sessions.filter(s => s.workspaceId === workspaceId);
    }
    return data.sessions;
  }

  async getDraft(id: string): Promise<ChatSession | null> {
    const data = await readDrafts();
    return data.sessions.find(s => s.id === id) || null;
  }

  async createDraft(input: CreateSessionInput): Promise<ChatSession> {
    const now = new Date().toISOString();
    const session: ChatSession = {
      id: uuidv4(),
      workspaceId: input.workspaceId,
      name: input.name,
      isDraft: true,
      createdAt: now,
      updatedAt: now,
    };

    const data = await readDrafts();
    data.sessions.push(session);
    await writeDrafts(data);
    return session;
  }

  async updateDraft(id: string, input: UpdateSessionInput): Promise<ChatSession | null> {
    const data = await readDrafts();
    const index = data.sessions.findIndex(s => s.id === id);
    if (index === -1) return null;

    const session = data.sessions[index];
    data.sessions[index] = {
      ...session,
      ...(input.name !== undefined && { name: input.name }),
      updatedAt: new Date().toISOString(),
    };

    await writeDrafts(data);
    return data.sessions[index];
  }

  async clearDraftFlag(id: string): Promise<boolean> {
    const data = await readDrafts();
    const index = data.sessions.findIndex(s => s.id === id);
    if (index === -1) return false;

    data.sessions[index] = {
      ...data.sessions[index],
      isDraft: false,
      updatedAt: new Date().toISOString(),
    };
    await writeDrafts(data);
    return true;
  }
}

// Legacy export name for backward compatibility during transition
export const store = new DraftSessionStore();
