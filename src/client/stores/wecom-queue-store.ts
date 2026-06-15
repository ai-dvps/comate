import { create } from 'zustand';
import i18next from 'i18next';
import type { WeComProactiveMessage, ProactiveMessageStatus } from '../../server/models/wecom-proactive-message.js';

export type { ProactiveMessageStatus };

interface WeComQueueState {
  entriesByWorkspace: Record<string, WeComProactiveMessage[]>;
  isLoading: Record<string, boolean>;
  error: Record<string, string | null>;
  statusFilter: string | null;

  fetchEntries: (workspaceId: string) => Promise<void>;
  retryEntry: (workspaceId: string, entryId: string) => Promise<boolean>;
  deleteEntry: (workspaceId: string, entryId: string) => Promise<boolean>;
  clearWorkspace: (workspaceId: string) => void;
  setStatusFilter: (filter: string | null) => void;
  getFilteredEntries: (workspaceId: string) => WeComProactiveMessage[];
}

export const useWeComQueueStore = create<WeComQueueState>((set, get) => ({
  entriesByWorkspace: {},
  isLoading: {},
  error: {},
  statusFilter: null,

  fetchEntries: async (workspaceId: string) => {
    set((state) => ({
      isLoading: { ...state.isLoading, [workspaceId]: true },
      error: { ...state.error, [workspaceId]: null },
    }));
    try {
      const query = get().statusFilter ? `?status=${get().statusFilter}` : '';
      const res = await fetch(`/api/workspaces/${workspaceId}/wecom-queue${query}`);
      if (!res.ok) throw new Error(i18next.t('chat:failedToFetchQueue', { defaultValue: 'Failed to fetch queue entries' }));
      const data = await res.json();
      set((state) => ({
        entriesByWorkspace: { ...state.entriesByWorkspace, [workspaceId]: data.entries || [] },
        isLoading: { ...state.isLoading, [workspaceId]: false },
      }));
    } catch (err) {
      set((state) => ({
        error: { ...state.error, [workspaceId]: err instanceof Error ? err.message : i18next.t('common:unknownError', { defaultValue: 'Unknown error' }) },
        isLoading: { ...state.isLoading, [workspaceId]: false },
      }));
    }
  },

  retryEntry: async (workspaceId: string, entryId: string) => {
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/wecom-queue/${entryId}/retry`, {
        method: 'POST',
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || i18next.t('chat:failedToRetryEntry', { defaultValue: 'Failed to retry entry' }));
      }
      await get().fetchEntries(workspaceId);
      return true;
    } catch (err) {
      console.error('Failed to retry queue entry:', err);
      return false;
    }
  },

  deleteEntry: async (workspaceId: string, entryId: string) => {
    set((state) => ({
      entriesByWorkspace: {
        ...state.entriesByWorkspace,
        [workspaceId]: (state.entriesByWorkspace[workspaceId] || []).filter((e) => e.id !== entryId),
      },
    }));
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/wecom-queue/${entryId}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(i18next.t('chat:failedToDeleteEntry', { defaultValue: 'Failed to delete entry' }));
      return true;
    } catch (err) {
      console.error('Failed to delete queue entry:', err);
      await get().fetchEntries(workspaceId);
      return false;
    }
  },

  clearWorkspace: (workspaceId: string) => {
    if (!workspaceId) return;
    set((state) => {
      const nextEntries = { ...state.entriesByWorkspace };
      const nextLoading = { ...state.isLoading };
      const nextError = { ...state.error };
      delete nextEntries[workspaceId];
      delete nextLoading[workspaceId];
      delete nextError[workspaceId];
      return {
        entriesByWorkspace: nextEntries,
        isLoading: nextLoading,
        error: nextError,
      };
    });
  },

  setStatusFilter: (filter: string | null) => {
    set({ statusFilter: filter });
  },

  getFilteredEntries: (workspaceId: string) => {
    return get().entriesByWorkspace[workspaceId] || [];
  },
}));
