import { create } from 'zustand';

/** Connection status returned by GET /api/github/connection — never a token (R18). */
export interface GithubConnectionStatus {
  connected: boolean;
  tokenType: 'pat' | 'device-flow' | null;
  expiresAt: string | null;
  login: string | null;
}

export interface GithubRepo {
  fullName: string;
  private: boolean;
  defaultBranch: string | null;
}

export interface DeviceFlowStart {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresIn: number;
  interval: number;
}

export type DevicePollStatus =
  | 'pending'
  | 'success'
  | 'expired'
  | 'access_denied'
  | 'incorrect_device_code'
  | 'slow_down';

interface GithubState {
  connection: GithubConnectionStatus | null;
  repos: GithubRepo[];
  isLoadingStatus: boolean;
  isBusy: boolean;
  error: string | null;
  /** Per-workspace associated repo full names, keyed by workspaceId. */
  workspaceRepos: Record<string, string[]>;

  fetchStatus: () => Promise<void>;
  startDeviceFlow: () => Promise<DeviceFlowStart>;
  pollDeviceFlow: () => Promise<{ status: DevicePollStatus }>;
  connectPat: (token: string) => Promise<boolean>;
  disconnect: () => Promise<{ deepLink?: string } | null>;
  fetchRepos: () => Promise<void>;
  fetchWorkspaceRepos: (workspaceId: string) => Promise<void>;
  setWorkspaceRepos: (workspaceId: string, repos: string[]) => Promise<boolean>;
  clearError: () => void;
}

export const useGithubStore = create<GithubState>((set) => ({
  connection: null,
  repos: [],
  isLoadingStatus: false,
  isBusy: false,
  error: null,
  workspaceRepos: {},

  fetchStatus: async () => {
    set({ isLoadingStatus: true, error: null });
    try {
      const res = await fetch('/api/github/connection');
      if (!res.ok) throw new Error('Failed to read GitHub connection');
      const data = (await res.json()) as { connection: GithubConnectionStatus };
      set({ connection: data.connection, isLoadingStatus: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to read connection', isLoadingStatus: false });
    }
  },

  startDeviceFlow: async () => {
    set({ isBusy: true, error: null });
    try {
      const res = await fetch('/api/github/device-flow/start', { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'Failed to start device flow');
      }
      const data = (await res.json()) as DeviceFlowStart;
      set({ isBusy: false });
      return data;
    } catch (err) {
      set({ isBusy: false, error: err instanceof Error ? err.message : 'Failed to start device flow' });
      throw err;
    }
  },

  pollDeviceFlow: async () => {
    const res = await fetch('/api/github/device-flow/poll', { method: 'POST' });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? 'Failed to poll device flow');
    }
    const data = (await res.json()) as { status: DevicePollStatus; connection: GithubConnectionStatus };
    if (data.status === 'success' && data.connection) {
      set({ connection: data.connection });
    }
    return { status: data.status };
  },

  connectPat: async (token: string) => {
    set({ isBusy: true, error: null });
    try {
      const res = await fetch('/api/github/connect/pat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'Failed to store token');
      }
      const data = (await res.json()) as { connection: GithubConnectionStatus };
      set({ connection: data.connection, isBusy: false });
      return true;
    } catch (err) {
      set({ isBusy: false, error: err instanceof Error ? err.message : 'Failed to store token' });
      return false;
    }
  },

  disconnect: async () => {
    set({ isBusy: true, error: null });
    try {
      const res = await fetch('/api/github/disconnect', { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'Failed to disconnect');
      }
      const data = (await res.json()) as { ok: boolean; deepLink?: string; connection: GithubConnectionStatus };
      set({ connection: data.connection, repos: [], isBusy: false });
      return data.deepLink ? { deepLink: data.deepLink } : {};
    } catch (err) {
      set({ isBusy: false, error: err instanceof Error ? err.message : 'Failed to disconnect' });
      return null;
    }
  },

  fetchRepos: async () => {
    set({ error: null });
    try {
      const res = await fetch('/api/github/repos');
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'Failed to list repositories');
      }
      const data = (await res.json()) as { repos: GithubRepo[] };
      set({ repos: data.repos });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to list repositories' });
    }
  },

  fetchWorkspaceRepos: async (workspaceId: string) => {
    try {
      const res = await fetch(`/api/github/workspaces/${workspaceId}/repos`);
      if (!res.ok) throw new Error('Failed to read workspace repositories');
      const data = (await res.json()) as { repos: string[] };
      set((state) => ({ workspaceRepos: { ...state.workspaceRepos, [workspaceId]: data.repos } }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to read workspace repositories' });
    }
  },

  setWorkspaceRepos: async (workspaceId: string, repos: string[]) => {
    try {
      const res = await fetch(`/api/github/workspaces/${workspaceId}/repos`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repos }),
      });
      if (!res.ok) throw new Error('Failed to set workspace repositories');
      const data = (await res.json()) as { repos: string[] };
      set((state) => ({ workspaceRepos: { ...state.workspaceRepos, [workspaceId]: data.repos } }));
      return true;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to set workspace repositories' });
      return false;
    }
  },

  clearError: () => set({ error: null }),
}));
