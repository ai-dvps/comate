import { create } from 'zustand';
import i18next from 'i18next';
import { useChatStore } from './chat-store';
import { useFilesStore } from './files-store';
import { useAnalyticsStore } from './analytics-store';
import { useCommandsStore } from './commands-store';
import { useWeComQueueStore } from './wecom-queue-store';

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
  deleteWorkspace: (id: string) => Promise<void>;
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
      if (!res.ok) throw new Error(i18next.t('common:failedToFetchWorkspaces', 'Failed to fetch workspaces'));
      const data = await res.json();
      set({ workspaces: data.workspaces || [], isLoading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error'), isLoading: false });
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
        throw new Error(data.error || i18next.t('common:failedToCreateWorkspace', 'Failed to create workspace'));
      }
      const data = await res.json();
      const workspace = data.workspace as Workspace;
      set({ workspaces: [...get().workspaces, workspace], isLoading: false });
      return workspace;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error'), isLoading: false });
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
        throw new Error(data.error || i18next.t('common:failedToUpdateWorkspace', 'Failed to update workspace'));
      }
      const data = await res.json();
      const updated = data.workspace as Workspace;
      set({
        workspaces: get().workspaces.map((w) => (w.id === id ? updated : w)),
        isLoading: false,
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error'), isLoading: false });
    }
  },

  deleteWorkspace: async (id) => {
    set({ isLoading: true, error: null });
    try {
      const res = await fetch(`${API_BASE}/workspaces/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: i18next.t('common:requestFailed', 'Request failed') }));
        throw new Error(data.error || i18next.t('common:failedToDeleteWorkspace', 'Failed to delete workspace'));
      }

      // Mirror closeWorkspace focus fallback after the workspace is gone.
      const { openWorkspaceIds, activeWorkspaceId } = get();
      const newOpenIds = openWorkspaceIds.filter((wsId) => wsId !== id);
      let newActiveId = activeWorkspaceId;
      if (activeWorkspaceId === id) {
        newActiveId = newOpenIds.length > 0 ? newOpenIds[newOpenIds.length - 1] : null;
      }

      // Clean up workspace-scoped state in related stores.
      useChatStore.getState().cleanupWorkspace(id);
      useFilesStore.getState().clearFilesForWorkspace(id);
      useAnalyticsStore.getState().clearWorkspace(id);
      useCommandsStore.getState().clearCommandsForWorkspace(id);
      useWeComQueueStore.getState().clearWorkspace(id);

      set({
        workspaces: get().workspaces.filter((w) => w.id !== id),
        openWorkspaceIds: newOpenIds,
        activeWorkspaceId: newActiveId,
        isLoading: false,
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error'), isLoading: false });
    }
  },

  clearError: () => {
    set({ error: null });
  },
}));
