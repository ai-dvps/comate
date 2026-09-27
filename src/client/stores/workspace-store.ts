import { create } from 'zustand';
import i18next from 'i18next';
import { useChatStore } from './chat-store';
import { useFilesStore } from './files-store';
import { useAnalyticsStore } from './analytics-store';
import { useCommandsStore } from './commands-store';
import { useWeComQueueStore } from './wecom-queue-store';
import { useGitRepositoryStore } from './git-repository-store';
import { useContextTabStore } from './context-tab-store';
import { readNavigationState, saveNavigationState } from '../lib/navigation-state';

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
  lastOpenedAt?: string;
  /**
   * Server-persisted MRU ordering key (epoch ms of the last turn start in any
   * session of this workspace, activity sort position stability KTD1).
   * Server-carried values are authoritative (KTD3); ordering writers are
   * rewired to it in U4.
   */
  lastTurnStartedAt?: number;
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
  openWorkspace: (id: string) => Promise<void>;
  closeWorkspace: (id: string) => void;
  updateWorkspace: (id: string, input: Partial<Omit<Workspace, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  clearError: () => void;
}

const API_BASE = '/api';
const savedNavigation = readNavigationState();

function computeFocusFallback(
  openWorkspaceIds: string[],
  activeWorkspaceId: string | null,
  removedId: string,
): { newOpenIds: string[]; newActiveId: string | null } {
  const newOpenIds = openWorkspaceIds.filter((id) => id !== removedId);
  const newActiveId =
    activeWorkspaceId === removedId
      ? newOpenIds.length > 0
        ? newOpenIds[newOpenIds.length - 1]
        : null
      : activeWorkspaceId;
  return { newOpenIds, newActiveId };
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: savedNavigation.activeWorkspaceId,
  openWorkspaceIds: savedNavigation.openWorkspaceIds,
  isLoading: false,
  error: null,

  fetchWorkspaces: async () => {
    set({ isLoading: true, error: null });
    try {
      const res = await fetch(`${API_BASE}/workspaces`);
      if (!res.ok) throw new Error(i18next.t('common:failedToFetchWorkspaces', 'Failed to fetch workspaces'));
      const data = await res.json();
      const workspaces = (data.workspaces || []) as Workspace[];
      // Seed the workspace ordering map from server-carried keys (KTD1/KTD3).
      useChatStore.getState().seedWorkspaceActivityKeys(workspaces);
      set((state) => {
        const validIds = new Set(workspaces.map((workspace) => workspace.id));
        const openWorkspaceIds = state.openWorkspaceIds.filter((id) => validIds.has(id));
        const activeWorkspaceId = state.activeWorkspaceId && validIds.has(state.activeWorkspaceId)
          ? state.activeWorkspaceId
          : state.activeWorkspaceId ? openWorkspaceIds.at(-1) ?? null : null;
        if (activeWorkspaceId && !openWorkspaceIds.includes(activeWorkspaceId)) {
          openWorkspaceIds.push(activeWorkspaceId);
        }
        return { workspaces, openWorkspaceIds, activeWorkspaceId, isLoading: false };
      });
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
      // The creation-initialized key places the new workspace at the top (R6).
      useChatStore.getState().seedWorkspaceActivityKeys([workspace]);
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

  openWorkspace: async (id) => {
    const { openWorkspaceIds, activeWorkspaceId } = get();
    if (openWorkspaceIds.includes(id)) {
      if (activeWorkspaceId !== id) {
        set({ activeWorkspaceId: id });
      }
    } else {
      set({
        openWorkspaceIds: [...openWorkspaceIds, id],
        activeWorkspaceId: id,
      });
    }

    try {
      const res = await fetch(`${API_BASE}/workspaces/${id}/open`, { method: 'POST' });
      if (!res.ok) return;
      const data = await res.json();
      const updated = data.workspace as Workspace;
      set({
        workspaces: get().workspaces.map((w) => (w.id === id ? updated : w)),
      });
    } catch {
      // Best-effort: don't block UI if last-opened recording fails
    }
  },

  closeWorkspace: (id) => {
    const { openWorkspaceIds, activeWorkspaceId } = get();
    const { newOpenIds, newActiveId } = computeFocusFallback(
      openWorkspaceIds,
      activeWorkspaceId,
      id,
    );
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

      const { openWorkspaceIds, activeWorkspaceId } = get();
      const { newOpenIds, newActiveId } = computeFocusFallback(
        openWorkspaceIds,
        activeWorkspaceId,
        id,
      );

      useChatStore.getState().cleanupWorkspace(id);
      useFilesStore.getState().clearFilesForWorkspace(id);
      useAnalyticsStore.getState().clearWorkspace(id);
      useCommandsStore.getState().clearCommandsForWorkspace(id);
      useWeComQueueStore.getState().clearWorkspace(id);
      useGitRepositoryStore.getState().clearWorkspace(id);
      useContextTabStore.getState().clearWorkspace(id);

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

useWorkspaceStore.subscribe((state, previous) => {
  if (state.activeWorkspaceId !== previous.activeWorkspaceId || state.openWorkspaceIds !== previous.openWorkspaceIds) {
    saveNavigationState({ activeWorkspaceId: state.activeWorkspaceId, openWorkspaceIds: state.openWorkspaceIds });
  }
});
