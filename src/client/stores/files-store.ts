import { useCallback } from 'react';
import { create } from 'zustand';

export interface FileEntry {
  path: string;
  type: 'file' | 'folder';
}

interface FilesState {
  filesByWorkspace: Record<string, FileEntry[] | undefined>;
  loadingByWorkspace: Record<string, boolean>;
  errorByWorkspace: Record<string, string | undefined>;

  fetchFiles: (workspaceId: string) => Promise<void>;
  refreshFiles: (workspaceId: string) => Promise<void>;
  clearFilesForWorkspace: (workspaceId: string) => void;
}

const inflight = new Map<string, Promise<void>>();

const API_BASE = '/api';

async function doFetch(
  set: (
    updater: (state: FilesState) => FilesState | Partial<FilesState>,
  ) => void,
  workspaceId: string,
): Promise<void> {
  set((state) => ({
    loadingByWorkspace: { ...state.loadingByWorkspace, [workspaceId]: true },
    errorByWorkspace: { ...state.errorByWorkspace, [workspaceId]: undefined },
  }));
  try {
    const res = await fetch(
      `${API_BASE}/workspaces/${workspaceId}/files?recursive=true`,
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    const data = (await res.json()) as { nodes?: FileEntry[] };
    const raw = Array.isArray(data.nodes) ? data.nodes : [];
    // Defensive dedupe: filesystems guarantee unique paths, but this guards
    // against server bugs or duplicate entries in the response.
    const seen = new Set<string>();
    const files = raw.filter((f) => {
      if (seen.has(f.path)) return false;
      seen.add(f.path);
      return true;
    });
    set((state) => ({
      filesByWorkspace: { ...state.filesByWorkspace, [workspaceId]: files },
      loadingByWorkspace: { ...state.loadingByWorkspace, [workspaceId]: false },
    }));
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to fetch files';
    set((state) => ({
      errorByWorkspace: { ...state.errorByWorkspace, [workspaceId]: message },
      loadingByWorkspace: { ...state.loadingByWorkspace, [workspaceId]: false },
    }));
  }
}

export const useFilesStore = create<FilesState>((set, get) => ({
  filesByWorkspace: {},
  loadingByWorkspace: {},
  errorByWorkspace: {},

  fetchFiles: async (workspaceId: string) => {
    if (!workspaceId) return;
    if (get().filesByWorkspace[workspaceId]) return;

    const existing = inflight.get(workspaceId);
    if (existing) return existing;

    const promise = doFetch(set, workspaceId).finally(() => {
      inflight.delete(workspaceId);
    });
    inflight.set(workspaceId, promise);
    return promise;
  },

  refreshFiles: async (workspaceId: string) => {
    if (!workspaceId) return;

    const existing = inflight.get(workspaceId);
    if (existing) return existing;

    set((state) => {
      const next = { ...state.filesByWorkspace };
      delete next[workspaceId];
      return { filesByWorkspace: next };
    });
    const promise = doFetch(set, workspaceId).finally(() => {
      inflight.delete(workspaceId);
    });
    inflight.set(workspaceId, promise);
    return promise;
  },

  clearFilesForWorkspace: (workspaceId: string) => {
    if (!workspaceId) return;
    set((state) => {
      const nextFiles = { ...state.filesByWorkspace };
      const nextLoading = { ...state.loadingByWorkspace };
      const nextError = { ...state.errorByWorkspace };
      delete nextFiles[workspaceId];
      delete nextLoading[workspaceId];
      delete nextError[workspaceId];
      return {
        filesByWorkspace: nextFiles,
        loadingByWorkspace: nextLoading,
        errorByWorkspace: nextError,
      };
    });
  },
}));

export interface UseFilesResult {
  files: FileEntry[];
  loading: boolean;
  error: string | undefined;
  fetch: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useFiles(workspaceId: string): UseFilesResult {
  const cached = useFilesStore((s) => s.filesByWorkspace[workspaceId]);
  const loading = useFilesStore((s) =>
    Boolean(s.loadingByWorkspace[workspaceId]),
  );
  const error = useFilesStore((s) => s.errorByWorkspace[workspaceId]);
  const fetchFiles = useFilesStore((s) => s.fetchFiles);
  const refreshFiles = useFilesStore((s) => s.refreshFiles);

  const fetch = useCallback(
    () => fetchFiles(workspaceId),
    [fetchFiles, workspaceId],
  );
  const refresh = useCallback(
    () => refreshFiles(workspaceId),
    [refreshFiles, workspaceId],
  );

  return {
    files: cached ?? [],
    loading,
    error,
    fetch,
    refresh,
  };
}
