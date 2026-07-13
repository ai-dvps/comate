import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    rolePolicy: {
      normalToolPolicy: {
        posture: 'safe',
        categoryDefaults: {
          fileRead: 'allow',
          fileWrite: 'deny',
          shell: 'deny',
          network: 'deny',
          subagents: 'deny',
          reply: 'allow',
        },
      },
      skillAllowlist: [],
      bashWhitelist: [],
    },
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
  channelStatusByBotId: {},
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
  resolvePendingMembers: vi.fn(),
  setMemberPlaintext: vi.fn(),
  refreshMembers: vi.fn(),
  fetchStatus: vi.fn(),
  reconnectChannel: vi.fn(),
  fetchChannelCredentials: vi.fn(),
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

  it('renders the Save/Cancel footer with disabled actions when clean', async () => {
    await act(async () => {
      renderWithI18n(<BotManagementPage />);
    });

    expect(screen.getByRole('button', { name: /^Save$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeDisabled();
  });

  it('marks basic config dirty and enables Save/Cancel footer when name changes', async () => {
    await act(async () => {
      renderWithI18n(<BotManagementPage />);
    });

    const nameInput = screen.getByPlaceholderText('My Bot');
    fireEvent.change(nameInput, { target: { value: 'TeamBot v2' } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Save$/i })).toBeEnabled();
      expect(screen.getByRole('button', { name: /Cancel/i })).toBeEnabled();
    });
  });

  it('calls updateBot and disables Save/Cancel footer when Save is clicked', async () => {
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

    await waitFor(() => expect(screen.getByRole('button', { name: /^Save$/i })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      expect(updateBot).toHaveBeenCalledWith('bot-1', expect.objectContaining({ name: 'TeamBot v2' }));
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Save$/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /Cancel/i })).toBeDisabled();
    });
  });

  it('reverts edits and disables Save/Cancel footer when Cancel is clicked', async () => {
    await act(async () => {
      renderWithI18n(<BotManagementPage />);
    });

    const nameInput = screen.getByPlaceholderText('My Bot') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Draft Name' } });
    expect(nameInput.value).toBe('Draft Name');

    await waitFor(() => expect(screen.getByRole('button', { name: /^Save$/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));

    await waitFor(() => {
      expect(nameInput.value).toBe('TeamBot');
      expect(screen.getByRole('button', { name: /^Save$/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /Cancel/i })).toBeDisabled();
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

  it('populates saved WeCom credentials when opening the Channels section', async () => {
    const fetchChannelCredentials = vi.fn().mockResolvedValue({ botSecret: 'saved-wecom-secret' });
    (useBotStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      ...mockState,
      bots: [
        makeBot({
          channelSettings: {
            wecom: { enabled: true, botId: 'wecom-bot-id', botSecret: true },
          },
        }),
      ],
      fetchChannelCredentials,
    });

    await act(async () => {
      renderWithI18n(<BotManagementPage />);
    });

    fireEvent.click(screen.getByRole('button', { name: /Channels/i }));

    await waitFor(() => {
      expect(fetchChannelCredentials).toHaveBeenCalledWith('bot-1', 'wecom');
    });

    const secretInput = screen.getByDisplayValue('saved-wecom-secret') as HTMLInputElement;
    expect(secretInput).toBeInTheDocument();
    expect(secretInput.type).toBe('password');
  });

  it('clears the reconnecting hint after save even when the polled status is unchanged', async () => {
    let resolveStatus!: (value: { wecom: string; feishu: string }) => void;
    const fetchStatus = vi.fn().mockImplementation(
      () => new Promise<{ wecom: string; feishu: string }>((resolve) => {
        resolveStatus = resolve;
      }),
    );
    const updateBot = vi.fn().mockResolvedValue(
      makeBot({
        channelSettings: { wecom: { enabled: true, botId: 'bid-2', botSecret: true } },
      }),
    );
    (useBotStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      ...mockState,
      bots: [
        makeBot({
          channelSettings: { wecom: { enabled: true, botId: 'bid', botSecret: true } },
        }),
      ],
      channelStatusByBotId: { 'bot-1': { wecom: 'connected', feishu: 'not_configured' } },
      fetchStatus,
      updateBot,
    });

    await act(async () => {
      renderWithI18n(<BotManagementPage />);
    });

    fireEvent.click(screen.getByRole('button', { name: /Channels/i }));

    const botIdInput = await screen.findByPlaceholderText('your-bot-id');
    fireEvent.change(botIdInput, { target: { value: 'bid-2' } });

    await waitFor(() => expect(screen.getByRole('button', { name: /^Save$/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    // The optimistic hint appears once the save derives a connect action...
    await waitFor(() => expect(screen.getByText('Reconnecting…')).toBeInTheDocument());

    // ...and must clear once a status fetch reports a terminal status, even
    // though the status value is identical to what was already stored.
    await act(async () => {
      resolveStatus({ wecom: 'connected', feishu: 'not_configured' });
    });

    await waitFor(() => expect(screen.queryByText('Reconnecting…')).not.toBeInTheDocument());
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

  it('delegates persona save through the page-level Save footer', async () => {
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

    await waitFor(() => expect(screen.getByRole('button', { name: /^Save$/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      expect(updateBot).toHaveBeenCalledWith(
        'bot-1',
        expect.objectContaining({
          persona: { prompt: 'Friendly', mode: 'append' },
          rolePersonas: {},
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Save$/i })).toBeDisabled();
    });
  });

  it('marks role permissions dirty and saves them through the page-level footer', async () => {
    const updateBot = vi.fn().mockResolvedValue(
      makeBot({ rolePolicy: { normalToolPolicy: { posture: 'safe', categoryDefaults: {} }, skillAllowlist: ['skill-a'], bashWhitelist: [] } }),
    );
    (useBotStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      ...mockState,
      updateBot,
    });

    await act(async () => {
      renderWithI18n(<BotManagementPage />);
    });

    fireEvent.click(screen.getByRole('button', { name: /Roles/i }));
    await waitFor(() => expect(screen.getByText('Role Permissions')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('e.g. my-skill'), { target: { value: 'skill-a' } });

    await waitFor(() => expect(screen.getByRole('button', { name: /^Save$/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      expect(updateBot).toHaveBeenCalledWith(
        'bot-1',
        expect.objectContaining({
          rolePolicy: expect.objectContaining({
            skillAllowlist: ['skill-a'],
          }),
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Save$/i })).toBeDisabled();
    });
  });

  it('shows unsaved-changes dialog when switching bots with dirty role config', async () => {
    (useBotStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      ...mockState,
      bots: [makeBot(), makeBot({ id: 'bot-2', name: 'DevOps Bot' })],
    });

    await act(async () => {
      renderWithI18n(<BotManagementPage />);
    });

    fireEvent.click(screen.getByRole('button', { name: /Roles/i }));
    await waitFor(() => expect(screen.getByText('Role Permissions')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('e.g. my-skill'), { target: { value: 'skill-a' } });

    fireEvent.click(screen.getByText('DevOps Bot'));

    await waitFor(() => {
      expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    });
  });

  it('saves Basic config and Role permissions together without wiping either slice', async () => {
    const updateBot = vi.fn().mockImplementation((_id, input) =>
      Promise.resolve(makeBot({ name: input.name ?? 'TeamBot v2', rolePolicy: input.rolePolicy ?? makeBot().rolePolicy })),
    );
    (useBotStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      ...mockState,
      updateBot,
    });

    await act(async () => {
      renderWithI18n(<BotManagementPage />);
    });

    const nameInput = screen.getByPlaceholderText('My Bot');
    fireEvent.change(nameInput, { target: { value: 'TeamBot v2' } });

    fireEvent.click(screen.getByRole('button', { name: /Roles/i }));
    await waitFor(() => expect(screen.getByText('Role Permissions')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('e.g. my-skill'), { target: { value: 'skill-a' } });

    await waitFor(() => expect(screen.getByRole('button', { name: /^Save$/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      expect(updateBot).toHaveBeenCalledTimes(2);
    });

    expect(updateBot).toHaveBeenNthCalledWith(1, 'bot-1', expect.objectContaining({ name: 'TeamBot v2' }));
    expect(updateBot).toHaveBeenNthCalledWith(
      2,
      'bot-1',
      expect.objectContaining({
        rolePolicy: expect.objectContaining({ skillAllowlist: ['skill-a'] }),
      }),
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Save$/i })).toBeDisabled();
    });
  });

  describe('search filter', () => {
    it('filters the bot list and shows the match count after pressing Enter', async () => {
      const user = userEvent.setup();
      (useBotStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        ...mockState,
        bots: [makeBot(), makeBot({ id: 'bot-2', name: 'DevOps Bot' })],
      });

      await act(async () => {
        renderWithI18n(<BotManagementPage />);
      });

      expect(screen.getByText('TeamBot')).toBeInTheDocument();
      expect(screen.getByText('DevOps Bot')).toBeInTheDocument();

      const input = screen.getByPlaceholderText('Search bots...');
      await user.type(input, 'dev');
      await user.keyboard('{Enter}');

      await waitFor(() => {
        expect(screen.queryByText('TeamBot')).not.toBeInTheDocument();
        expect(screen.getByText('DevOps Bot')).toBeInTheDocument();
        expect(screen.getByText('1 bot')).toBeInTheDocument();
      });
    });

    it('switches selection to the first visible match when the selected bot is filtered out', async () => {
      const user = userEvent.setup();
      (useBotStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        ...mockState,
        bots: [makeBot(), makeBot({ id: 'bot-2', name: 'DevOps Bot' })],
      });

      await act(async () => {
        renderWithI18n(<BotManagementPage />);
      });

      const input = screen.getByPlaceholderText('Search bots...');
      await user.type(input, 'dev');
      await user.keyboard('{Enter}');

      await waitFor(() => {
        expect(screen.getByText('DevOps Bot')).toBeInTheDocument();
      });

      const selectedBot = screen.getByText('DevOps Bot').closest('button');
      expect(selectedBot?.className).toContain('bg-accent/10');
    });

    it('restores the full list and preserves the current selection when clearing the search', async () => {
      const user = userEvent.setup();
      (useBotStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        ...mockState,
        bots: [makeBot(), makeBot({ id: 'bot-2', name: 'DevOps Bot' })],
      });

      await act(async () => {
        renderWithI18n(<BotManagementPage />);
      });

      const input = screen.getByPlaceholderText('Search bots...');
      await user.type(input, 'dev');
      await user.keyboard('{Enter}');
      await waitFor(() => expect(screen.getByText('DevOps Bot')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: 'Clear search' }));

      await waitFor(() => {
        expect(screen.getByText('TeamBot')).toBeInTheDocument();
        expect(screen.getByText('DevOps Bot')).toBeInTheDocument();
      });

      const selectedBot = screen.getByText('DevOps Bot').closest('button');
      expect(selectedBot?.className).toContain('bg-accent/10');
    });

    it('shows no matching bots empty state when the query matches nothing', async () => {
      const user = userEvent.setup();
      (useBotStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        ...mockState,
        bots: [makeBot()],
      });

      await act(async () => {
        renderWithI18n(<BotManagementPage />);
      });

      const input = screen.getByPlaceholderText('Search bots...');
      await user.type(input, 'xyz');
      await user.keyboard('{Enter}');

      await waitFor(() => {
        expect(screen.getByText('No bots found')).toBeInTheDocument();
        expect(screen.getByText('0 bots')).toBeInTheDocument();
      });

      // The right pane should still show the previously selected bot.
      expect(screen.getByDisplayValue('TeamBot')).toBeInTheDocument();
    });

    it('opens a Save/Discard dialog when filtering out a dirty bot', async () => {
      const user = userEvent.setup();
      (useBotStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        ...mockState,
        bots: [makeBot(), makeBot({ id: 'bot-2', name: 'DevOps Bot' })],
      });

      await act(async () => {
        renderWithI18n(<BotManagementPage />);
      });

      const nameInput = screen.getByPlaceholderText('My Bot') as HTMLInputElement;
      fireEvent.change(nameInput, { target: { value: 'TeamBot v2' } });
      await waitFor(() => expect(screen.getByText('Save')).toBeInTheDocument());

      const input = screen.getByPlaceholderText('Search bots...');
      await user.type(input, 'dev');
      await user.keyboard('{Enter}');

      await waitFor(() => {
        expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
      });

      expect(screen.queryByRole('button', { name: 'Keep editing' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
    });

    it('saves changes and switches to the first visible bot when Save is chosen', async () => {
      const user = userEvent.setup();
      const updateBot = vi.fn().mockResolvedValue(makeBot({ name: 'TeamBot v2' }));
      (useBotStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        ...mockState,
        bots: [makeBot(), makeBot({ id: 'bot-2', name: 'DevOps Bot' })],
        updateBot,
      });

      await act(async () => {
        renderWithI18n(<BotManagementPage />);
      });

      const nameInput = screen.getByPlaceholderText('My Bot') as HTMLInputElement;
      fireEvent.change(nameInput, { target: { value: 'TeamBot v2' } });
      await waitFor(() => expect(screen.getByText('Save')).toBeInTheDocument());

      const input = screen.getByPlaceholderText('Search bots...');
      await user.type(input, 'dev');
      await user.keyboard('{Enter}');

      await waitFor(() => expect(screen.getByText('Unsaved changes')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

      await waitFor(() => {
        expect(updateBot).toHaveBeenCalledWith('bot-1', expect.objectContaining({ name: 'TeamBot v2' }));
        expect(screen.getByText('DevOps Bot')).toBeInTheDocument();
      });

      const selectedBot = screen.getByText('DevOps Bot').closest('button');
      expect(selectedBot?.className).toContain('bg-accent/10');
    });

    it('discards changes and switches to the first visible bot when Discard is chosen', async () => {
      const user = userEvent.setup();
      (useBotStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        ...mockState,
        bots: [makeBot(), makeBot({ id: 'bot-2', name: 'DevOps Bot' })],
      });

      await act(async () => {
        renderWithI18n(<BotManagementPage />);
      });

      const nameInput = screen.getByPlaceholderText('My Bot') as HTMLInputElement;
      fireEvent.change(nameInput, { target: { value: 'TeamBot v2' } });
      await waitFor(() => expect(screen.getByText('Save')).toBeInTheDocument());

      const input = screen.getByPlaceholderText('Search bots...');
      await user.type(input, 'dev');
      await user.keyboard('{Enter}');

      await waitFor(() => expect(screen.getByText('Unsaved changes')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

      await waitFor(() => {
        expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
        expect(screen.getByText('DevOps Bot')).toBeInTheDocument();
      });

      const selectedBot = screen.getByText('DevOps Bot').closest('button');
      expect(selectedBot?.className).toContain('bg-accent/10');
    });
  });
});
