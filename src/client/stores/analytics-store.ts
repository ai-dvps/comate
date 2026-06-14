/**
 * Analytics Zustand store (see plan 2026-06-13-007, U3).
 *
 * Wraps the two analytics endpoints (`/api/analytics/global` and
 * `/api/analytics/workspaces/:id`) with loading/error state. The store is
 * deliberately minimal — summaries are recomputed server-side from the
 * transcript cache on every fetch, so the client never holds stale-derived
 * state. Per-workspace summaries are cached in a map keyed by workspace id so
 * switching the selector back to a previously-loaded workspace doesn't
 * re-trigger a load spinner unless the user explicitly refreshes.
 */

import { create } from 'zustand';
import i18next from 'i18next';

import type {
  GlobalStatsSummary,
  WorkspaceStatsSummary,
} from '@server/services/analytics-aggregation.js';

const API_BASE = '/api';

interface AnalyticsState {
  globalSummary: GlobalStatsSummary | null;
  /** Per-workspace summaries, keyed by workspace id. */
  workspaceSummaries: Record<string, WorkspaceStatsSummary>;
  /** Currently-selected workspace on the Workspace tab. */
  activeWorkspaceId: string | null;
  isLoadingGlobal: boolean;
  isLoadingWorkspace: boolean;
  globalError: string | null;
  workspaceError: string | null;
  /** Marker bumped on every successful global fetch so views can show "last refreshed". */
  globalFetchedAt: number | null;

  fetchGlobalSummary: () => Promise<void>;
  fetchWorkspaceSummary: (workspaceId: string) => Promise<void>;
  setActiveWorkspace: (workspaceId: string | null) => void;
  clearWorkspace: (workspaceId: string) => void;
  clearAll: () => void;
}

export const useAnalyticsStore = create<AnalyticsState>((set, get) => ({
  globalSummary: null,
  workspaceSummaries: {},
  activeWorkspaceId: null,
  isLoadingGlobal: false,
  isLoadingWorkspace: false,
  globalError: null,
  workspaceError: null,
  globalFetchedAt: null,

  fetchGlobalSummary: async () => {
    set({ isLoadingGlobal: true, globalError: null });
    try {
      const res = await fetch(`${API_BASE}/analytics/global`);
      if (!res.ok) {
        throw new Error(
          i18next.t('analytics:fetchFailedGlobal', 'Failed to load global analytics'),
        );
      }
      const data = (await res.json()) as { summary: GlobalStatsSummary };
      set({
        globalSummary: data.summary,
        isLoadingGlobal: false,
        globalFetchedAt: Date.now(),
      });
    } catch (err) {
      set({
        globalError:
          err instanceof Error
            ? err.message
            : i18next.t('common:unknownError', 'Unknown error'),
        isLoadingGlobal: false,
      });
    }
  },

  fetchWorkspaceSummary: async (workspaceId) => {
    set({ isLoadingWorkspace: true, workspaceError: null });
    try {
      const res = await fetch(`${API_BASE}/analytics/workspaces/${encodeURIComponent(workspaceId)}`);
      if (res.status === 404) {
        // Unknown workspace id — surface as an error rather than crashing.
        throw new Error(
          i18next.t('analytics:workspaceNotFound', 'Workspace not found'),
        );
      }
      if (!res.ok) {
        throw new Error(
          i18next.t('analytics:fetchFailedWorkspace', 'Failed to load workspace analytics'),
        );
      }
      const data = (await res.json()) as { summary: WorkspaceStatsSummary };
      set((state) => ({
        workspaceSummaries: {
          ...state.workspaceSummaries,
          [workspaceId]: data.summary,
        },
        isLoadingWorkspace: false,
      }));
    } catch (err) {
      set({
        workspaceError:
          err instanceof Error
            ? err.message
            : i18next.t('common:unknownError', 'Unknown error'),
        isLoadingWorkspace: false,
      });
    }
  },

  setActiveWorkspace: (workspaceId) => {
    set({ activeWorkspaceId: workspaceId, workspaceError: null });
    // Lazy-load: if we don't have a cached summary for this workspace, fetch.
    if (workspaceId && !get().workspaceSummaries[workspaceId]) {
      void get().fetchWorkspaceSummary(workspaceId);
    }
  },

  clearWorkspace: (workspaceId) => {
    set((state) => {
      const next = { ...state.workspaceSummaries };
      delete next[workspaceId];
      return {
        workspaceSummaries: next,
        activeWorkspaceId:
          state.activeWorkspaceId === workspaceId ? null : state.activeWorkspaceId,
      };
    });
  },

  clearAll: () => {
    set({
      globalSummary: null,
      workspaceSummaries: {},
      activeWorkspaceId: null,
      globalError: null,
      workspaceError: null,
      globalFetchedAt: null,
    });
  },
}));
