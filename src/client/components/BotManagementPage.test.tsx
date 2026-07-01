import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';
import BotManagementPage from './BotManagementPage';
import { useBotStore, type BotState } from '../stores/bot-store';
import type { Bot } from '../stores/bot-store';
import type { Workspace } from '../stores/workspace-store';

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

function makeBot(overrides?: Partial<Bot>): Bot {
  return {
    id: 'bot-1',
    name: 'TeamBot',
    activeWorkspaceId: null,
    channelSettings: {},
    rolePolicy: { normalToolPolicy: {}, skillAllowlist: [], bashWhitelist: [] },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
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

const mockState: BotState = {
  bots: [makeBot()],
  membersByBotId: {},
  statusByBotId: {},
  isLoading: false,
  isSaving: false,
  migrationResult: null,
  error: null,
  fetchBots: vi.fn(),
  createBot: vi.fn(),
  updateBot: vi.fn(),
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

vi.mock('../stores/bot-store', async () => {
  const actual = await vi.importActual<typeof import('../stores/bot-store')>('../stores/bot-store');
  return {
    ...actual,
    useBotStore: vi.fn(() => mockState),
  };
});

vi.mock('../stores/workspace-store', async () => {
  return {
    useWorkspaceStore: vi.fn(() => ({
      workspaces: [workspace],
      fetchWorkspaces: vi.fn(),
    })),
  };
});

describe('BotManagementPage', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    Object.assign(mockState, {
      bots: [makeBot()],
      error: null,
      isSaving: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('selects the first bot and shows the General section by default', async () => {
    await act(async () => {
      renderWithI18n(<BotManagementPage />);
    });

    expect(screen.getByText('TeamBot')).toBeInTheDocument();
    const generalTab = screen.getByRole('button', { name: /General/i });
    expect(generalTab.className).toContain('border-b-2');
  });

  it('marks basic config dirty and shows Save/Cancel footer when name changes', async () => {
    await act(async () => {
      renderWithI18n(<BotManagementPage />);
    });

    const nameInput = screen.getByPlaceholderText('My Bot');
    fireEvent.change(nameInput, { target: { value: 'TeamBot v2' } });

    await waitFor(() => {
      expect(screen.getByText('Save')).toBeInTheDocument();
      expect(screen.getByText('Cancel')).toBeInTheDocument();
    });
  });

  it('calls updateBot and clears dirty state when Save is clicked', async () => {
    const updatedBot = makeBot({ name: 'TeamBot v2' });
    const updateBot = vi.fn().mockResolvedValue(updatedBot);
    (useBotStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      ...mockState,
      updateBot,
    });

    await act(async () => {
      renderWithI18n(<BotManagementPage />);
    });

    const nameInput = screen.getByPlaceholderText('My Bot');
    fireEvent.change(nameInput, { target: { value: 'TeamBot v2' } });

    await waitFor(() => expect(screen.getByText('Save')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(updateBot).toHaveBeenCalledWith('bot-1', expect.objectContaining({ name: 'TeamBot v2' }));
    });
  });

  it('reverts edits when Cancel is clicked', async () => {
    await act(async () => {
      renderWithI18n(<BotManagementPage />);
    });

    const nameInput = screen.getByPlaceholderText('My Bot') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Draft Name' } });
    expect(nameInput.value).toBe('Draft Name');

    await waitFor(() => expect(screen.getByText('Cancel')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Cancel'));

    await waitFor(() => {
      expect(nameInput.value).toBe('TeamBot');
    });
  });

  it('stages a new bot and removes it on Cancel', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'temp-uuid' });

    await act(async () => {
      renderWithI18n(<BotManagementPage />);
    });

    fireEvent.click(screen.getByText('Create Bot'));

    await waitFor(() => {
      expect(screen.getByText('New bot')).toBeInTheDocument();
      expect(screen.getByText('Cancel')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Cancel'));

    await waitFor(() => {
      expect(screen.queryByText('New bot')).not.toBeInTheDocument();
      expect(screen.getByText('TeamBot')).toBeInTheDocument();
    });

    vi.unstubAllGlobals();
  });

  it('creates a bot and adds initial channel owners when saving a new bot', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'temp-uuid' });

    const newBot = makeBot({
      id: 'new-bot',
      name: 'New Bot',
      channelSettings: {
        wecom: { enabled: true, botId: 'wecom-bot-id', botSecret: 'wecom-secret' },
      },
    });
    const createBot = vi.fn().mockResolvedValue(newBot);
    const addMember = vi.fn().mockResolvedValue(undefined);
    (useBotStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      ...mockState,
      createBot,
      addMember,
    });

    await act(async () => {
      renderWithI18n(<BotManagementPage />);
    });

    fireEvent.click(screen.getByText('Create Bot'));
    await waitFor(() => expect(screen.getByText('New bot')).toBeInTheDocument());

    // Set the bot name first so validation passes while the General section is visible.
    fireEvent.change(screen.getByPlaceholderText('My Bot'), { target: { value: 'New Bot' } });

    fireEvent.click(screen.getByRole('button', { name: /Channels/i }));
    await waitFor(() => expect(screen.getByText('WeCom')).toBeInTheDocument());

    // Enable WeCom.
    const toggles = screen.getAllByRole('button', { name: /WeCom|Feishu/i });
    fireEvent.click(toggles[0]);

    await waitFor(() => expect(screen.getByPlaceholderText('your-bot-id')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('your-bot-id'), { target: { value: 'wecom-bot-id' } });
    fireEvent.change(screen.getByPlaceholderText('your-bot-secret'), { target: { value: 'wecom-secret' } });
    fireEvent.change(screen.getByPlaceholderText('owner-user-id'), { target: { value: 'owner-1' } });

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(createBot).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'New Bot',
          channelSettings: {
            wecom: expect.objectContaining({ enabled: true, botId: 'wecom-bot-id' }),
          },
        }),
      );
    });

    await waitFor(() => {
      expect(addMember).toHaveBeenCalledWith('new-bot', {
        channel: 'wecom',
        channelUserId: 'owner-1',
        role: 'owner',
      });
    });

    vi.unstubAllGlobals();
  });

  it('shows unsaved-changes dialog when switching bots with dirty persona config', async () => {
    (useBotStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      ...mockState,
      bots: [makeBot(), makeBot({ id: 'bot-2', name: 'DevOps Bot' })],
    });

    await act(async () => {
      renderWithI18n(<BotManagementPage />);
    });

    fireEvent.click(screen.getByRole('button', { name: /Persona/i }));
    await waitFor(() => expect(screen.getByPlaceholderText(/You are a helpful DevOps assistant/i)).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText(/You are a helpful DevOps assistant/i), { target: { value: 'Friendly' } });

    fireEvent.click(screen.getByText('DevOps Bot'));

    await waitFor(() => {
      expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    });
  });

  it('delegates persona save through global save and calls updateBot with rolePersonas', async () => {
    const updateBot = vi.fn().mockResolvedValue(makeBot({ persona: { prompt: 'Friendly', mode: 'append' } }));
    (useBotStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      ...mockState,
      updateBot,
    });

    await act(async () => {
      renderWithI18n(<BotManagementPage />);
    });

    fireEvent.click(screen.getByRole('button', { name: /Persona/i }));
    await waitFor(() => expect(screen.getByPlaceholderText(/You are a helpful DevOps assistant/i)).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText(/You are a helpful DevOps assistant/i), { target: { value: 'Friendly' } });

    // The persona editor's own Save button should appear.
    await waitFor(() => expect(screen.getByText('Save persona')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Save persona'));

    await waitFor(() => {
      expect(updateBot).toHaveBeenCalledWith(
        'bot-1',
        expect.objectContaining({
          persona: { prompt: 'Friendly', mode: 'append' },
          rolePersonas: {},
        }),
      );
    });
  });
});
