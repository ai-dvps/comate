import { create } from 'zustand';
import i18next from 'i18next';

export type BotChannel = 'wecom' | 'feishu';

export type BotRole = 'owner' | 'admin' | 'normal';

export interface WeComChannelConfig {
  enabled?: boolean;
  botId?: string;
  botSecret?: string | true;
  botName?: string;
  corpId?: string;
  corpSecret?: string | true;
}

export interface FeishuChannelConfig {
  enabled?: boolean;
  appId?: string;
  appSecret?: string | true;
  encryptKey?: string | true;
  verificationToken?: string | true;
  botName?: string;
}

export interface BotChannelSettings {
  wecom?: WeComChannelConfig;
  feishu?: FeishuChannelConfig;
}

export interface BotRolePolicy {
  normalToolPolicy: Record<string, unknown>;
  skillAllowlist: string[];
  bashWhitelist: string[];
}

export type BotPersonaMode = 'append' | 'replace';

export interface BotPersona {
  prompt: string;
  mode: BotPersonaMode;
}

export interface Bot {
  id: string;
  name: string;
  activeWorkspaceId: string | null;
  channelSettings: BotChannelSettings;
  rolePolicy: BotRolePolicy;
  persona?: BotPersona;
  rolePersonas?: Partial<Record<BotRole, BotPersona>>;
  createdAt: string;
  updatedAt: string;
}

export interface BotMember {
  botId: string;
  channel: BotChannel;
  channelUserId: string;
  role: BotRole;
  plaintextUserId: string | null;
  displayName: string | null;
  resolutionStatus: 'resolved' | 'pending';
  createdAt: string;
  updatedAt: string;
}

export interface CreateBotInput {
  name: string;
  activeWorkspaceId?: string;
  channelSettings?: BotChannelSettings;
  rolePolicy?: BotRolePolicy;
  persona?: BotPersona;
  rolePersonas?: Partial<Record<BotRole, BotPersona>>;
}

export interface UpdateBotInput {
  name?: string;
  activeWorkspaceId?: string | null;
  channelSettings?: BotChannelSettings;
  rolePolicy?: BotRolePolicy;
  persona?: BotPersona | null;
  rolePersonas?: Partial<Record<BotRole, BotPersona>> | null;
}

export interface BotStatus {
  wecom: string;
  feishu: string;
}

export interface MigrationResult {
  success: boolean;
  dryRun: boolean;
  createdBots: number;
  migratedWorkspaces: number;
  skippedWorkspaces: number;
  errors: string[];
  preview?: Array<{
    workspaceId: string;
    workspaceName: string;
    botName: string;
    channels: BotChannel[];
    members: Array<{ channel: BotChannel; channelUserId: string; role: Exclude<BotRole, 'owner'> }>;
  }>;
}

export interface BotState {
  bots: Bot[];
  membersByBotId: Record<string, BotMember[]>;
  statusByBotId: Record<string, BotStatus>;
  isLoading: boolean;
  isSaving: boolean;
  migrationResult: MigrationResult | null;
  error: string | null;

  fetchBots: () => Promise<void>;
  createBot: (input: CreateBotInput) => Promise<Bot | null>;
  updateBot: (id: string, input: UpdateBotInput) => Promise<Bot | null>;
  deleteBot: (id: string) => Promise<boolean>;
  switchWorkspace: (botId: string, workspaceId: string) => Promise<Bot | null>;
  fetchMembers: (botId: string) => Promise<void>;
  addMember: (botId: string, input: { channel: BotChannel; channelUserId: string; role: BotRole }) => Promise<BotMember | null>;
  setMemberRole: (botId: string, channel: BotChannel, channelUserId: string, role: BotRole) => Promise<boolean>;
  removeMember: (botId: string, channel: BotChannel, channelUserId: string) => Promise<boolean>;
  fetchStatus: (botId: string) => Promise<void>;
  runMigration: (dryRun?: boolean) => Promise<MigrationResult | null>;
  clearError: () => void;
}

const API_BASE = '/api';

async function handleError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    return data.error || i18next.t('common:requestFailed', 'Request failed');
  } catch {
    return i18next.t('common:requestFailed', 'Request failed');
  }
}

export const useBotStore = create<BotState>((set, get) => ({
  bots: [],
  membersByBotId: {},
  statusByBotId: {},
  isLoading: false,
  isSaving: false,
  migrationResult: null,
  error: null,

  fetchBots: async () => {
    set({ isLoading: true, error: null });
    try {
      const res = await fetch(`${API_BASE}/bots`);
      if (!res.ok) throw new Error(await handleError(res));
      const data = (await res.json()) as { bots: Bot[] };
      set({ bots: data.bots || [], isLoading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), isLoading: false });
    }
  },

  createBot: async (input) => {
    set({ isSaving: true, error: null });
    try {
      const res = await fetch(`${API_BASE}/bots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(await handleError(res));
      const data = (await res.json()) as { bot: Bot };
      set({ bots: [...get().bots, data.bot], isSaving: false });
      return data.bot;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), isSaving: false });
      return null;
    }
  },

  updateBot: async (id, input) => {
    set({ isSaving: true, error: null });
    try {
      const res = await fetch(`${API_BASE}/bots/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(await handleError(res));
      const data = (await res.json()) as { bot: Bot };
      set({
        bots: get().bots.map((b) => (b.id === id ? data.bot : b)),
        isSaving: false,
      });
      return data.bot;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), isSaving: false });
      return null;
    }
  },

  deleteBot: async (id) => {
    set({ isSaving: true, error: null });
    try {
      const res = await fetch(`${API_BASE}/bots/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await handleError(res));
      set({
        bots: get().bots.filter((b) => b.id !== id),
        isSaving: false,
      });
      return true;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), isSaving: false });
      return false;
    }
  },

  switchWorkspace: async (botId, workspaceId) => {
    set({ isSaving: true, error: null });
    try {
      const res = await fetch(`${API_BASE}/bots/${botId}/active-workspace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      if (!res.ok) throw new Error(await handleError(res));
      const data = (await res.json()) as { bot: Bot };
      set({
        bots: get().bots.map((b) => (b.id === botId ? data.bot : b)),
        isSaving: false,
      });
      return data.bot;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), isSaving: false });
      return null;
    }
  },

  fetchMembers: async (botId) => {
    try {
      const res = await fetch(`${API_BASE}/bots/${botId}`);
      if (!res.ok) throw new Error(await handleError(res));
      const data = (await res.json()) as { bot: Bot; members: BotMember[] };
      set({
        membersByBotId: { ...get().membersByBotId, [botId]: data.members || [] },
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  addMember: async (botId, input) => {
    set({ isSaving: true, error: null });
    try {
      const res = await fetch(`${API_BASE}/bots/${botId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(await handleError(res));
      const data = (await res.json()) as { member: BotMember };
      const current = get().membersByBotId[botId] || [];
      set({
        membersByBotId: { ...get().membersByBotId, [botId]: [...current, data.member] },
        isSaving: false,
      });
      return data.member;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), isSaving: false });
      return null;
    }
  },

  setMemberRole: async (botId, channel, channelUserId, role) => {
    set({ isSaving: true, error: null });
    try {
      const res = await fetch(
        `${API_BASE}/bots/${botId}/members/${encodeURIComponent(channelUserId)}/role?channel=${channel}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role }),
        },
      );
      if (!res.ok) throw new Error(await handleError(res));
      const current = get().membersByBotId[botId] || [];
      set({
        membersByBotId: {
          ...get().membersByBotId,
          [botId]: current.map((m) =>
            m.channel === channel && m.channelUserId === channelUserId ? { ...m, role } : m,
          ),
        },
        isSaving: false,
      });
      return true;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), isSaving: false });
      return false;
    }
  },

  removeMember: async (botId, channel, channelUserId) => {
    set({ isSaving: true, error: null });
    try {
      const res = await fetch(
        `${API_BASE}/bots/${botId}/members/${encodeURIComponent(channelUserId)}?channel=${channel}`,
        { method: 'DELETE' },
      );
      if (!res.ok) throw new Error(await handleError(res));
      const current = get().membersByBotId[botId] || [];
      set({
        membersByBotId: {
          ...get().membersByBotId,
          [botId]: current.filter(
            (m) => !(m.channel === channel && m.channelUserId === channelUserId),
          ),
        },
        isSaving: false,
      });
      return true;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), isSaving: false });
      return false;
    }
  },

  fetchStatus: async (botId) => {
    try {
      const res = await fetch(`${API_BASE}/bots/${botId}/status`);
      if (!res.ok) return;
      const data = (await res.json()) as { status: BotStatus };
      set({
        statusByBotId: { ...get().statusByBotId, [botId]: data.status },
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  runMigration: async (dryRun = false) => {
    set({ isSaving: true, error: null, migrationResult: null });
    try {
      const res = await fetch(`${API_BASE}/bots/migrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun }),
      });
      if (!res.ok) throw new Error(await handleError(res));
      const data = (await res.json()) as { result: MigrationResult };
      set({ migrationResult: data.result, isSaving: false });
      if (!dryRun) {
        await get().fetchBots();
      }
      return data.result;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), isSaving: false });
      return null;
    }
  },

  clearError: () => set({ error: null }),
}));
