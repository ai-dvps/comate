import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { v4 as uuidv4 } from 'uuid';
import type { Workspace, CreateWorkspaceInput, UpdateWorkspaceInput } from '../models/workspace.js';

const STORAGE_DIR = join(homedir(), '.claude-code-gui');
const STORAGE_FILE = join(STORAGE_DIR, 'workspaces.json');

interface StorageData {
  workspaces: Workspace[];
}

async function ensureStorage(): Promise<void> {
  try {
    await access(STORAGE_DIR);
  } catch {
    await mkdir(STORAGE_DIR, { recursive: true });
  }
}

async function readStorage(): Promise<StorageData> {
  try {
    const data = await readFile(STORAGE_FILE, 'utf-8');
    return JSON.parse(data) as StorageData;
  } catch {
    return { workspaces: [] };
  }
}

async function writeStorage(data: StorageData): Promise<void> {
  await ensureStorage();
  const tempFile = `${STORAGE_FILE}.tmp`;
  await writeFile(tempFile, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  await writeFile(STORAGE_FILE, await readFile(tempFile, 'utf-8'), 'utf-8');
}

export class JsonStore {
  async list(): Promise<Workspace[]> {
    const data = await readStorage();
    return data.workspaces;
  }

  async get(id: string): Promise<Workspace | null> {
    const data = await readStorage();
    return data.workspaces.find(w => w.id === id) || null;
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

    const data = await readStorage();
    data.workspaces.push(workspace);
    await writeStorage(data);
    return workspace;
  }

  async update(id: string, input: UpdateWorkspaceInput): Promise<Workspace | null> {
    const data = await readStorage();
    const index = data.workspaces.findIndex(w => w.id === id);
    if (index === -1) return null;

    const workspace = data.workspaces[index];
    data.workspaces[index] = {
      ...workspace,
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.folderPath !== undefined && { folderPath: input.folderPath }),
      ...(input.settings !== undefined && { settings: input.settings }),
      ...(input.skills !== undefined && { skills: input.skills }),
      ...(input.mcpServers !== undefined && { mcpServers: input.mcpServers }),
      ...(input.hooks !== undefined && { hooks: input.hooks }),
      updatedAt: new Date().toISOString(),
    };

    await writeStorage(data);
    return data.workspaces[index];
  }

  async delete(id: string): Promise<boolean> {
    const data = await readStorage();
    const index = data.workspaces.findIndex(w => w.id === id);
    if (index === -1) return false;

    data.workspaces.splice(index, 1);
    await writeStorage(data);
    return true;
  }
}

export const store = new JsonStore();
