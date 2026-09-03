import { useCallback } from 'react';
import { create } from 'zustand';
import i18next from 'i18next';
import type { BackendId } from './backend-store';

export interface SlashCommandDto {
  name: string;
  displayName?: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
}

export interface CachedCommandList {
  commands: SlashCommandDto[];
  partial: boolean;
  partialReason?: string;
  /** Output styles the CLI reports for this workspace (CLI 2.1.237+). */
  outputStyles?: string[];
}

interface CommandsState {
  commandsByWorkspace: Record<string, CachedCommandList | undefined>;
  loadingByWorkspace: Record<string, boolean>;
  errorByWorkspace: Record<string, string | undefined>;

  fetchCommands: (workspaceId: string, scope?: CommandScope) => Promise<void>;
  refreshCommands: (workspaceId: string, scope?: CommandScope) => Promise<void>;
  clearCommandsForWorkspace: (workspaceId: string) => void;
}

// Module-level inflight map survives store re-creates and dedupes
// concurrent fetch calls from independent components mounting on the
// same tick. Mirrors the chat-store pattern.
const inflight = new Map<string, Promise<void>>();
const generations = new Map<string, number>();

const API_BASE = '/api';
const COMMAND_REFRESH_TIMEOUT_MS = 10_000;
const SCOPED_QUERY_PREFIX = '?';

export interface CommandScope {
  sessionId?: string;
  backendId?: BackendId;
}

function commandScopeQuery(scope?: CommandScope): string {
  const params = new URLSearchParams();
  if (scope?.sessionId) params.set('sessionId', scope.sessionId);
  if (scope?.backendId) params.set('backend', scope.backendId);
  const query = params.toString();
  return query ? `${SCOPED_QUERY_PREFIX}${query}` : '';
}

function commandScopeKey(workspaceId: string, scope?: CommandScope): string {
  return `${workspaceId}${commandScopeQuery(scope)}`;
}

async function doFetch(
  set: (
    updater: (state: CommandsState) => CommandsState | Partial<CommandsState>,
  ) => void,
  workspaceId: string,
  scope?: CommandScope,
): Promise<void> {
  const scopeKey = commandScopeKey(workspaceId, scope);
  const generation = generations.get(scopeKey) ?? 0;
  set((state) => ({
    loadingByWorkspace: { ...state.loadingByWorkspace, [scopeKey]: true },
    errorByWorkspace: { ...state.errorByWorkspace, [scopeKey]: undefined },
  }));
  try {
    const res = await fetch(`${API_BASE}/workspaces/${workspaceId}/commands${commandScopeQuery(scope)}`, {
      signal: AbortSignal.timeout(COMMAND_REFRESH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: i18next.t('common:requestFailed', 'Request failed') }));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    const data = (await res.json()) as CachedCommandList;
    if ((generations.get(scopeKey) ?? 0) !== generation) return;
    set((state) => ({
      commandsByWorkspace: {
        ...state.commandsByWorkspace,
        [scopeKey]: {
          commands: Array.isArray(data.commands) ? data.commands : [],
          partial: Boolean(data.partial),
          partialReason: data.partialReason,
          outputStyles: Array.isArray(data.outputStyles)
            ? data.outputStyles.filter((name): name is string => typeof name === 'string')
            : undefined,
        },
      },
      loadingByWorkspace: { ...state.loadingByWorkspace, [scopeKey]: false },
    }));
  } catch (err) {
    if ((generations.get(scopeKey) ?? 0) !== generation) return;
    const message = err instanceof Error ? err.message : i18next.t('common:failedToFetchCommands', 'Failed to fetch commands');
    set((state) => ({
      errorByWorkspace: { ...state.errorByWorkspace, [scopeKey]: message },
      loadingByWorkspace: { ...state.loadingByWorkspace, [scopeKey]: false },
    }));
  }
}

export const useCommandsStore = create<CommandsState>((set, get) => ({
  commandsByWorkspace: {},
  loadingByWorkspace: {},
  errorByWorkspace: {},

  fetchCommands: async (workspaceId: string, scope?: CommandScope) => {
    if (!workspaceId) return;
    const scopeKey = commandScopeKey(workspaceId, scope);
    if (get().commandsByWorkspace[scopeKey]) return;

    const existing = inflight.get(scopeKey);
    if (existing) return existing;

    const promise = doFetch(set, workspaceId, scope).finally(() => {
      if (inflight.get(scopeKey) === promise) inflight.delete(scopeKey);
    });
    inflight.set(scopeKey, promise);
    return promise;
  },

  refreshCommands: async (workspaceId: string, scope?: CommandScope) => {
    if (!workspaceId) return;
    const scopeKey = commandScopeKey(workspaceId, scope);

    const existing = inflight.get(scopeKey);
    if (existing) return existing;

    set((state) => {
      const next = { ...state.commandsByWorkspace };
      delete next[scopeKey];
      return { commandsByWorkspace: next };
    });
    const promise = doFetch(set, workspaceId, scope).finally(() => {
      if (inflight.get(scopeKey) === promise) inflight.delete(scopeKey);
    });
    inflight.set(scopeKey, promise);
    return promise;
  },

  clearCommandsForWorkspace: (workspaceId: string) => {
    if (!workspaceId) return;
    set((state) => {
      const nextCommands = { ...state.commandsByWorkspace };
      const nextLoading = { ...state.loadingByWorkspace };
      const nextError = { ...state.errorByWorkspace };
      const scopedPrefix = `${workspaceId}${SCOPED_QUERY_PREFIX}`;
      for (const key of new Set([
        ...Object.keys(nextCommands),
        ...Object.keys(nextLoading),
        ...Object.keys(nextError),
      ])) {
        if (key !== workspaceId && !key.startsWith(scopedPrefix)) continue;
        generations.set(key, (generations.get(key) ?? 0) + 1);
        inflight.delete(key);
        delete nextCommands[key];
        delete nextLoading[key];
        delete nextError[key];
      }
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
  refresh: () => Promise<{ commands: SlashCommandDto[]; succeeded: boolean }>;
}

export function useCommands(workspaceId: string, scope?: CommandScope): UseCommandsResult {
  const sessionId = scope?.sessionId;
  const backendId = scope?.backendId;
  const scopeKey = commandScopeKey(workspaceId, { sessionId, backendId });
  const cached = useCommandsStore((s) => s.commandsByWorkspace[scopeKey]);
  const loading = useCommandsStore((s) => Boolean(s.loadingByWorkspace[scopeKey]));
  const error = useCommandsStore((s) => s.errorByWorkspace[scopeKey]);
  const fetchCommands = useCommandsStore((s) => s.fetchCommands);
  const refreshCommands = useCommandsStore((s) => s.refreshCommands);

  const fetch = useCallback(
    () => fetchCommands(workspaceId, { sessionId, backendId }),
    [backendId, fetchCommands, sessionId, workspaceId],
  );
  const refresh = useCallback(async () => {
    await refreshCommands(workspaceId, { sessionId, backendId });
    const state = useCommandsStore.getState();
    const succeeded = !state.errorByWorkspace[scopeKey];
    return {
      commands: succeeded
        ? (state.commandsByWorkspace[scopeKey]?.commands ?? [])
        : (cached?.commands ?? []),
      succeeded,
    };
  }, [backendId, cached?.commands, refreshCommands, scopeKey, sessionId, workspaceId]);

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
