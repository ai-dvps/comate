import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import userEvent from '@testing-library/user-event';
import i18n from '../i18n';
import BotForm from './BotForm';
import type { Bot, CreateBotInput } from '../stores/bot-store';
import type { Workspace } from '../stores/workspace-store';

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

function makeWorkspace(overrides?: Partial<Workspace>): Workspace {
  return {
    id: 'ws-1',
    name: 'Workspace One',
    description: '',
    folderPath: '/tmp/ws1',
    skills: [],
    mcpServers: [],
    hooks: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    settings: {},
    ...overrides,
  };
}

const workspaces = [makeWorkspace(), makeWorkspace({ id: 'ws-2', name: 'Workspace Two' })];

describe('BotForm', () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders create mode with empty fields', () => {
    renderWithI18n(<BotForm workspaces={workspaces} onSubmit={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByPlaceholderText('My Bot')).toBeInTheDocument();
    expect(screen.getByText('Create bot')).toBeInTheDocument();
  });

  it('renders edit mode with bot values', () => {
    const bot: Bot = {
      id: 'bot-1',
      name: 'Existing Bot',
      activeWorkspaceId: 'ws-1',
      providerSettings: {
        wecom: { enabled: true, botId: 'w-bid', botName: 'WeCom Name' },
        feishu: { enabled: true, appId: 'cli_xxx', botName: 'Feishu Name' },
      },
      rolePolicy: { normalToolPolicy: {}, skillAllowlist: [], bashWhitelist: [] },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    renderWithI18n(<BotForm bot={bot} workspaces={workspaces} onSubmit={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByDisplayValue('Existing Bot')).toBeInTheDocument();
    expect(screen.getByDisplayValue('w-bid')).toBeInTheDocument();
    expect(screen.getByDisplayValue('cli_xxx')).toBeInTheDocument();
  });

  it('calls onSubmit with provider settings when creating a bot', async () => {
    const onSubmit = vi.fn();
    renderWithI18n(<BotForm workspaces={workspaces} onSubmit={onSubmit} onCancel={vi.fn()} />);

    const nameInput = screen.getByPlaceholderText('My Bot');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'New Bot');

    // enable WeCom
    const wecomToggle = screen.getAllByRole('button').find((b) => b.className.includes('rounded-full'))!;
    fireEvent.click(wecomToggle);

    const botIdInput = screen.getByPlaceholderText('your-bot-id');
    await userEvent.type(botIdInput, 'bid-1');

    const botSecretInput = screen.getByPlaceholderText('your-bot-secret');
    await userEvent.type(botSecretInput, 'secret-1');

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    const submitted = onSubmit.mock.calls[0][0] as CreateBotInput;
    expect(submitted.name).toBe('New Bot');
    expect(submitted.providerSettings?.wecom).toMatchObject({
      enabled: true,
      botId: 'bid-1',
      botSecret: 'secret-1',
    });
  });

  it('uses true sentinel for unchanged secrets in edit mode', async () => {
    const onSubmit = vi.fn();
    const bot: Bot = {
      id: 'bot-1',
      name: 'Existing Bot',
      activeWorkspaceId: null,
      providerSettings: {
        wecom: { enabled: true, botId: 'w-bid', botSecret: true },
      },
      rolePolicy: { normalToolPolicy: {}, skillAllowlist: [], bashWhitelist: [] },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    renderWithI18n(<BotForm bot={bot} workspaces={workspaces} onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    const submitted = onSubmit.mock.calls[0][0] as CreateBotInput;
    expect(submitted.providerSettings?.wecom?.botSecret).toBe(true);
  });

  it('shows validation error when name is missing', async () => {
    const onSubmit = vi.fn();
    renderWithI18n(<BotForm workspaces={workspaces} onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(screen.getByText('Bot name is required.')).toBeInTheDocument();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('calls onCancel when cancel is clicked', () => {
    const onCancel = vi.fn();
    renderWithI18n(<BotForm workspaces={workspaces} onSubmit={vi.fn()} onCancel={onCancel} />);

    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
