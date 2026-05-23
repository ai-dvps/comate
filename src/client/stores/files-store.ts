import { useCallback } from 'react';
import { create } from 'zustand';

export interface FileEntry {
  path: string;
}

interface SearchResponse {
  query: string;
  results: FileEntry[];
  source: 'rg' | 'fallback';
  truncated: boolean;
}

interface FilesState {
  resultsByWorkspace: Record<string, FileEntry[] | undefined>;
  loadingByWorkspace: Record<string, boolean>;
  errorByWorkspace: Record<string, string | undefined>;
  truncatedByWorkspace: Record<string, boolean>;

  search: (workspaceId: string, query: string) => void;
  clearFilesForWorkspace: (workspaceId: string) => void;
}

const DEBOUNCE_MS = 120;
const API_BASE = '/api';

interface PerWorkspaceState {
  debounceTimer?: ReturnType<typeof setTimeout>;
  abortController?: AbortController;
  // The query the most recent committed request was issued against — used to
  // drop responses that lost a race when an even-newer request hasn't aborted
  // them yet.
  latestQuery?: string;
}

const perWorkspace = new Map<string, PerWorkspaceState>();

function getWorkspaceState(workspaceId: string): PerWorkspaceState {
  let state = perWorkspace.get(workspaceId);
  if (!state) {
    state = {};
    perWorkspace.set(workspaceId, state);
  }
  return state;
}

async function runSearch(
  set: (
    updater: (state: FilesState) => FilesState | Partial<FilesState>,
  ) => void,
  workspaceId: string,
  query: string,
): Promise<void> {
  const ws = getWorkspaceState(workspaceId);
  ws.abortController?.abort();
  const controller = new AbortController();
  ws.abortController = controller;
  ws.latestQuery = query;

  set((state) => ({
    loadingByWorkspace: { ...state.loadingByWorkspace, [workspaceId]: true },
    errorByWorkspace: { ...state.errorByWorkspace, [workspaceId]: undefined },
  }));

  try {
    const url = `${API_BASE}/workspaces/${workspaceId}/files/search?q=${encodeURIComponent(query)}&limit=200`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    const data = (await res.json()) as SearchResponse;
    if (ws.latestQuery !== query) return;
    const results = Array.isArray(data.results) ? data.results : [];
    set((state) => ({
      resultsByWorkspace: { ...state.resultsByWorkspace, [workspaceId]: results },
      truncatedByWorkspace: { ...state.truncatedByWorkspace, [workspaceId]: Boolean(data.truncated) },
      loadingByWorkspace: { ...state.loadingByWorkspace, [workspaceId]: false },
    }));
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    if (err instanceof Error && err.name === 'AbortError') return;
    if (ws.latestQuery !== query) return;
    const message =
      err instanceof Error ? err.message : 'Failed to search files';
    set((state) => ({
      errorByWorkspace: { ...state.errorByWorkspace, [workspaceId]: message },
      loadingByWorkspace: { ...state.loadingByWorkspace, [workspaceId]: false },
    }));
  }
}

export const useFilesStore = create<FilesState>((set) => ({
  resultsByWorkspace: {},
  loadingByWorkspace: {},
  errorByWorkspace: {},
  truncatedByWorkspace: {},

  search: (workspaceId: string, query: string) => {
    if (!workspaceId) return;

    const ws = getWorkspaceState(workspaceId);
    if (ws.debounceTimer) clearTimeout(ws.debounceTimer);

    ws.debounceTimer = setTimeout(() => {
      ws.debounceTimer = undefined;
      void runSearch(set, workspaceId, query);
    }, DEBOUNCE_MS);
  },

  clearFilesForWorkspace: (workspaceId: string) => {
    if (!workspaceId) return;
    const ws = perWorkspace.get(workspaceId);
    if (ws) {
      if (ws.debounceTimer) clearTimeout(ws.debounceTimer);
      ws.abortController?.abort();
      perWorkspace.delete(workspaceId);
    }
    set((state) => {
      const nextResults = { ...state.resultsByWorkspace };
      const nextLoading = { ...state.loadingByWorkspace };
      const nextError = { ...state.errorByWorkspace };
      const nextTruncated = { ...state.truncatedByWorkspace };
      delete nextResults[workspaceId];
      delete nextLoading[workspaceId];
      delete nextError[workspaceId];
      delete nextTruncated[workspaceId];
      return {
        resultsByWorkspace: nextResults,
        loadingByWorkspace: nextLoading,
        errorByWorkspace: nextError,
        truncatedByWorkspace: nextTruncated,
      };
    });
  },
}));

export interface UseFilesResult {
  results: FileEntry[];
  loading: boolean;
  error: string | undefined;
  truncated: boolean;
  search: (query: string) => void;
  clear: () => void;
}

export function useFiles(workspaceId: string): UseFilesResult {
  const results = useFilesStore((s) => s.resultsByWorkspace[workspaceId]);
  const loading = useFilesStore((s) =>
    Boolean(s.loadingByWorkspace[workspaceId]),
  );
  const error = useFilesStore((s) => s.errorByWorkspace[workspaceId]);
  const truncated = useFilesStore((s) =>
    Boolean(s.truncatedByWorkspace[workspaceId]),
  );
  const searchFiles = useFilesStore((s) => s.search);
  const clearFiles = useFilesStore((s) => s.clearFilesForWorkspace);

  const search = useCallback(
    (query: string) => searchFiles(workspaceId, query),
    [searchFiles, workspaceId],
  );
  const clear = useCallback(
    () => clearFiles(workspaceId),
    [clearFiles, workspaceId],
  );

  return {
    results: results ?? [],
    loading,
    error,
    truncated,
    search,
    clear,
  };
}
