import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';
import SettingsPanel from './SettingsPanel';
import type { Bot } from '../stores/bot-store';
import type { Workspace } from '../stores/workspace-store';

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

const workspace: Workspace = {
  id: 'ws-1',
  name: 'Workspace One',
  description: '',
  folderPath: '/tmp/ws1',
  skills: [],
  mcpServers: [],
  hooks: [],
  createdAt: '',
  updatedAt: '',
  settings: {},
};

const bot: Bot = {
  id: 'bot-1',
  name: 'TeamBot',
  activeWorkspaceId: null,
  channelSettings: {},
  rolePolicy: { normalToolPolicy: {}, skillAllowlist: [], bashWhitelist: [] },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockUpdateBot = vi.fn().mockResolvedValue({ ...bot, name: 'TeamBot v2' });
const mockFetchBots = vi.fn().mockResolvedValue(undefined);

const workspaceState = {
  workspaces: [workspace],
  activeWorkspaceId: workspace.id,
  updateWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  fetchWorkspaces: vi.fn(),
  error: null,
  isLoading: false,
};

const updaterState = {
  status: 'idle' as const,
  update: null,
  downloadProgress: 0,
  error: null,
};

const appSettings = {
  reopenLastWorkspace: false,
  setReopenLastWorkspace: vi.fn(),
  useModifierToSubmit: true,
  setUseModifierToSubmit: vi.fn(),
  autoCheckUpdates: false,
  setAutoCheckUpdates: vi.fn(),
  notificationSoundsEnabled: true,
  setNotificationSoundsEnabled: vi.fn(),
  notificationSoundsVolume: 100,
  setNotificationSoundsVolume: vi.fn(),
  archiveThresholdDays: 14,
  setArchiveThresholdDays: vi.fn(),
  lastUpdateCheckAt: null,
  setLastUpdateCheckAt: vi.fn(),
};

const botState = {
  bots: [bot],
  membersByBotId: {},
  channelStatusByBotId: {},
  isLoading: false,
  isSaving: false,
  migrationResult: null,
  error: null,
  fetchBots: mockFetchBots,
  createBot: vi.fn(),
  updateBot: mockUpdateBot,
  deleteBot: vi.fn(),
  switchWorkspace: vi.fn(),
  fetchMembers: vi.fn(),
  addMember: vi.fn(),
  setMemberRole: vi.fn(),
  removeMember: vi.fn(),
  fetchStatus: vi.fn(),
  runMigration: vi.fn(),
  clearError: vi.fn(),
};

vi.mock('../stores/workspace-store', async () => {
  return {
    useWorkspaceStore: vi.fn((selector?: (state: typeof workspaceState) => unknown) =>
      selector ? selector(workspaceState) : workspaceState,
    ),
  };
});

vi.mock('../stores/updater-store', async () => {
  return {
    useUpdaterStore: vi.fn((selector?: (state: typeof updaterState) => unknown) =>
      selector ? selector(updaterState) : updaterState,
    ),
  };
});

vi.mock('../hooks/use-app-settings', async () => {
  return {
    useAppSettings: vi.fn(() => appSettings),
  };
});

vi.mock('../stores/bot-store', async () => {
  const actual = await vi.importActual<typeof import('../stores/bot-store')>('../stores/bot-store');
  return {
    ...actual,
    useBotStore: vi.fn((selector?: (state: typeof botState) => unknown) =>
      selector ? selector(botState) : botState,
    ),
  };
});

vi.mock('../lib/updater-api', async () => {
  return {
    checkForUpdates: vi.fn(),
    getAppVersion: vi.fn(() => Promise.resolve('0.0.1')),
    downloadAndInstallUpdate: vi.fn(),
    restartToUpdate: vi.fn(),
    dismissUpdate: vi.fn(),
  };
});

describe('SettingsPanel bot dirty guard delegation', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockUpdateBot.mockResolvedValue({ ...bot, name: 'TeamBot v2' });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ resolvedPath: '', customPaths: [], sources: { shell: null, fallback: null } }),
    } as Response);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows unsaved-changes dialog when closing with dirty bot config on the bots tab', async () => {
    const onClose = vi.fn();

    await act(async () => {
      renderWithI18n(<SettingsPanel onClose={onClose} />);
    });

    // Switch to bots tab.
    fireEvent.click(screen.getByRole('button', { name: /Bots/i }));

    await waitFor(() => expect(screen.getByPlaceholderText('My Bot')).toBeInTheDocument());

    // Make the bot config dirty.
    fireEvent.change(screen.getByPlaceholderText('My Bot'), { target: { value: 'TeamBot v2' } });

    // Click the panel close button (first header button with the X icon).
    const closeButton = screen.getAllByRole('button').find((b) => b.className.includes('p-1.5 rounded-md'))!;
    fireEvent.click(closeButton);

    await waitFor(() => {
      expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('delegates save to BotManagementPage and closes the panel from the unsaved dialog', async () => {
    const onClose = vi.fn();

    await act(async () => {
      renderWithI18n(<SettingsPanel onClose={onClose} />);
    });

    fireEvent.click(screen.getByRole('button', { name: /Bots/i }));

    await waitFor(() => expect(screen.getByPlaceholderText('My Bot')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('My Bot'), { target: { value: 'TeamBot v2' } });

    // Close triggers the dirty guard dialog.
    const closeButton = screen.getAllByRole('button').find((b) => b.className.includes('p-1.5 rounded-md'))!;
    fireEvent.click(closeButton);

    await waitFor(() => expect(screen.getByText('Unsaved changes')).toBeInTheDocument());

    // Save from the dialog (last Save button, since footer also has one).
    const saveButtons = screen.getAllByRole('button', { name: /Save/i });
    fireEvent.click(saveButtons[saveButtons.length - 1]);

    await waitFor(() => {
      expect(mockUpdateBot).toHaveBeenCalledWith('bot-1', expect.objectContaining({ name: 'TeamBot v2' }));
    });

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('delegates discard to BotManagementPage and closes the panel', async () => {
    const onClose = vi.fn();

    await act(async () => {
      renderWithI18n(<SettingsPanel onClose={onClose} />);
    });

    fireEvent.click(screen.getByRole('button', { name: /Bots/i }));

    await waitFor(() => expect(screen.getByPlaceholderText('My Bot')).toBeInTheDocument());

    const nameInput = screen.getByPlaceholderText('My Bot') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Draft' } });

    // Close triggers the dirty guard dialog.
    const closeButton = screen.getAllByRole('button').find((b) => b.className.includes('p-1.5 rounded-md'))!;
    fireEvent.click(closeButton);

    await waitFor(() => expect(screen.getByText('Unsaved changes')).toBeInTheDocument());

    const discardButtons = screen.getAllByRole('button', { name: /Discard/i });
    fireEvent.click(discardButtons[discardButtons.length - 1]);

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });

    // The draft should be reverted because the bot page was discarded.
    expect(nameInput.value).toBe('TeamBot');
  });
});
