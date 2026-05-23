import { useCallback } from 'react';
import { create } from 'zustand';
import i18next from 'i18next';

export interface SlashCommandDto {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
}

export interface CachedCommandList {
  commands: SlashCommandDto[];
  partial: boolean;
  partialReason?: string;
}

interface CommandsState {
  commandsByWorkspace: Record<string, CachedCommandList | undefined>;
  loadingByWorkspace: Record<string, boolean>;
  errorByWorkspace: Record<string, string | undefined>;

  fetchCommands: (workspaceId: string) => Promise<void>;
  refreshCommands: (workspaceId: string) => Promise<void>;
  clearCommandsForWorkspace: (workspaceId: string) => void;
}

// Module-level inflight map survives store re-creates and dedupes
// concurrent fetch calls from independent components mounting on the
// same tick. Mirrors the chat-store pattern.
const inflight = new Map<string, Promise<void>>();

const API_BASE = '/api';

async function doFetch(
  set: (
    updater: (state: CommandsState) => CommandsState | Partial<CommandsState>,
  ) => void,
  workspaceId: string,
): Promise<void> {
  set((state) => ({
    loadingByWorkspace: { ...state.loadingByWorkspace, [workspaceId]: true },
    errorByWorkspace: { ...state.errorByWorkspace, [workspaceId]: undefined },
  }));
  try {
    const res = await fetch(`${API_BASE}/workspaces/${workspaceId}/commands`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: i18next.t('common:requestFailed', 'Request failed') }));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    const data = (await res.json()) as CachedCommandList;
    set((state) => ({
      commandsByWorkspace: {
        ...state.commandsByWorkspace,
        [workspaceId]: {
          commands: Array.isArray(data.commands) ? data.commands : [],
          partial: Boolean(data.partial),
          partialReason: data.partialReason,
        },
      },
      loadingByWorkspace: { ...state.loadingByWorkspace, [workspaceId]: false },
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : i18next.t('common:failedToFetchCommands', 'Failed to fetch commands');
    set((state) => ({
      errorByWorkspace: { ...state.errorByWorkspace, [workspaceId]: message },
      loadingByWorkspace: { ...state.loadingByWorkspace, [workspaceId]: false },
    }));
  }
}

export const useCommandsStore = create<CommandsState>((set, get) => ({
  commandsByWorkspace: {},
  loadingByWorkspace: {},
  errorByWorkspace: {},

  fetchCommands: async (workspaceId: string) => {
    if (!workspaceId) return;
    if (get().commandsByWorkspace[workspaceId]) return;

    const existing = inflight.get(workspaceId);
    if (existing) return existing;

    const promise = doFetch(set, workspaceId).finally(() => {
      inflight.delete(workspaceId);
    });
    inflight.set(workspaceId, promise);
    return promise;
  },

  refreshCommands: async (workspaceId: string) => {
    if (!workspaceId) return;

    const existing = inflight.get(workspaceId);
    if (existing) return existing;

    set((state) => {
      const next = { ...state.commandsByWorkspace };
      delete next[workspaceId];
      return { commandsByWorkspace: next };
    });
    const promise = doFetch(set, workspaceId).finally(() => {
      inflight.delete(workspaceId);
    });
    inflight.set(workspaceId, promise);
    return promise;
  },

  clearCommandsForWorkspace: (workspaceId: string) => {
    if (!workspaceId) return;
    set((state) => {
      const nextCommands = { ...state.commandsByWorkspace };
      const nextLoading = { ...state.loadingByWorkspace };
      const nextError = { ...state.errorByWorkspace };
      delete nextCommands[workspaceId];
      delete nextLoading[workspaceId];
      delete nextError[workspaceId];
      return {
        commandsByWorkspace: nextCommands,
        loadingByWorkspace: nextLoading,
        errorByWorkspace: nextError,
      };
    });
  },
}));

export interface UseCommandsResult {
  commands: SlashCommandDto[];
  loading: boolean;
  error: string | undefined;
  partial: boolean;
  partialReason: string | undefined;
  fetch: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useCommands(workspaceId: string): UseCommandsResult {
  const cached = useCommandsStore((s) => s.commandsByWorkspace[workspaceId]);
  const loading = useCommandsStore((s) => Boolean(s.loadingByWorkspace[workspaceId]));
  const error = useCommandsStore((s) => s.errorByWorkspace[workspaceId]);
  const fetchCommands = useCommandsStore((s) => s.fetchCommands);
  const refreshCommands = useCommandsStore((s) => s.refreshCommands);

  const fetch = useCallback(
    () => fetchCommands(workspaceId),
    [fetchCommands, workspaceId],
  );
  const refresh = useCallback(
    () => refreshCommands(workspaceId),
    [refreshCommands, workspaceId],
  );

  return {
    commands: cached?.commands ?? [],
    loading,
    error,
    partial: Boolean(cached?.partial),
    partialReason: cached?.partialReason,
    fetch,
    refresh,
  };
}
