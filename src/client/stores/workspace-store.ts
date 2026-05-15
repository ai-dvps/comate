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
  openWorkspaceIds: string[];
  isLoading: boolean;
  error: string | null;

  fetchWorkspaces: () => Promise<void>;
  createWorkspace: (input: { name: string; folderPath: string; description?: string }) => Promise<Workspace | null>;
  setActiveWorkspace: (id: string | null) => void;
  openWorkspace: (id: string) => void;
  closeWorkspace: (id: string) => void;
  updateWorkspace: (id: string, input: Partial<Omit<Workspace, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<void>;
  clearError: () => void;
}

const API_BASE = '/api';

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  openWorkspaceIds: [],
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

  openWorkspace: (id) => {
    const { openWorkspaceIds, activeWorkspaceId } = get();
    if (openWorkspaceIds.includes(id)) {
      // Already open, just focus it
      if (activeWorkspaceId !== id) {
        set({ activeWorkspaceId: id });
      }
      return;
    }
    set({
      openWorkspaceIds: [...openWorkspaceIds, id],
      activeWorkspaceId: id,
    });
  },

  closeWorkspace: (id) => {
    const { openWorkspaceIds, activeWorkspaceId } = get();
    const newOpenIds = openWorkspaceIds.filter(wsId => wsId !== id);

    let newActiveId = activeWorkspaceId;
    if (activeWorkspaceId === id) {
      // If closing the active workspace, focus another open one
      newActiveId = newOpenIds.length > 0 ? newOpenIds[newOpenIds.length - 1] : null;
    }

    set({
      openWorkspaceIds: newOpenIds,
      activeWorkspaceId: newActiveId,
    });
  },

  updateWorkspace: async (id, input) => {
    set({ isLoading: true, error: null });
    try {
      const res = await fetch(`${API_BASE}/workspaces/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to update workspace');
      }
      const data = await res.json();
      const updated = data.workspace as Workspace;
      set({
        workspaces: get().workspaces.map((w) => (w.id === id ? updated : w)),
        isLoading: false,
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Unknown error', isLoading: false });
    }
  },

  clearError: () => {
    set({ error: null });
  },
}));
