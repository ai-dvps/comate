import { create } from 'zustand';

export interface Workspace {
  id: string;
  name: string;
  description: string;
  folderPath: string;
  settings: Record<string, unknown>;
  skills: { name: string }[];
  mcpServers: { name: string; command: string; args?: string[] }[];
  hooks: { name: string; scriptPath: string }[];
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  isLoading: boolean;
  error: string | null;

  fetchWorkspaces: () => Promise<void>;
  createWorkspace: (input: { name: string; folderPath: string; description?: string }) => Promise<Workspace | null>;
  setActiveWorkspace: (id: string | null) => void;
  clearError: () => void;
}

const API_BASE = '/api';

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  isLoading: false,
  error: null,

  fetchWorkspaces: async () => {
    set({ isLoading: true, error: null });
    try {
      const res = await fetch(`${API_BASE}/workspaces`);
      if (!res.ok) throw new Error('Failed to fetch workspaces');
      const data = await res.json();
      set({ workspaces: data.workspaces || [], isLoading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Unknown error', isLoading: false });
    }
  },

  createWorkspace: async (input) => {
    set({ isLoading: true, error: null });
    try {
      const res = await fetch(`${API_BASE}/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create workspace');
      }
      const data = await res.json();
      const workspace = data.workspace as Workspace;
      set({ workspaces: [...get().workspaces, workspace], isLoading: false });
      return workspace;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Unknown error', isLoading: false });
      return null;
    }
  },

  setActiveWorkspace: (id) => {
    set({ activeWorkspaceId: id });
  },

  clearError: () => {
    set({ error: null });
  },
}));
