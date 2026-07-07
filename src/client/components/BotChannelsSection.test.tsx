import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';
import type { Bot } from '../stores/bot-store';
import BotChannelsSection from './BotChannelsSection';
import { emptyForm } from './bot-form-utils';

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

describe('BotChannelsSection', () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('toggles WeCom and shows credential fields', () => {
    const onUpdate = vi.fn();
    renderWithI18n(
      <BotChannelsSection form={emptyForm()} onUpdate={onUpdate} />,
    );

    expect(screen.queryByPlaceholderText('your-bot-id')).not.toBeInTheDocument();

    const toggle = screen.getAllByRole('button').find((b) => b.className.includes('rounded-full'))!;
    fireEvent.click(toggle);

    expect(onUpdate).toHaveBeenCalledWith({ wecomEnabled: true });
  });

  it('shows WeCom fields when enabled', () => {
    renderWithI18n(
      <BotChannelsSection form={{ ...emptyForm(), wecomEnabled: true }} onUpdate={vi.fn()} />,
    );

    expect(screen.getByPlaceholderText('your-bot-id')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('your-bot-secret')).toBeInTheDocument();
  });

  it('renders secret placeholder for unchanged secret in edit mode', () => {
    const originalBot: Bot = {
      id: 'bot-1',
      name: 'Bot',
      activeWorkspaceId: null,
      channelSettings: { wecom: { enabled: true, botId: 'bid', botSecret: true } },
      rolePolicy: { normalToolPolicy: {}, skillAllowlist: [], bashWhitelist: [] },
      createdAt: '',
      updatedAt: '',
    };

    renderWithI18n(
      <BotChannelsSection
        form={{ ...emptyForm(), wecomEnabled: true }}
        onUpdate={vi.fn()}
        originalBot={originalBot}
      />,
    );

    const secretInput = screen.getByPlaceholderText('••••••••');
    expect(secretInput).toBeInTheDocument();
    expect(secretInput.getAttribute('type')).toBe('password');
  });

  it('renders per-channel status labels and dots', () => {
    renderWithI18n(
      <BotChannelsSection
        form={{ ...emptyForm(), wecomEnabled: true, feishuEnabled: true }}
        onUpdate={vi.fn()}
        channelStatus={{ wecom: 'connected', feishu: 'not_configured' }}
      />,
    );

    expect(screen.getByText('WeCom connected')).toBeInTheDocument();
    expect(screen.getByText('Feishu not configured')).toBeInTheDocument();
  });

  it('renders sanitized error message when a channel is in error state', () => {
    renderWithI18n(
      <BotChannelsSection
        form={{ ...emptyForm(), feishuEnabled: true }}
        onUpdate={vi.fn()}
        channelStatus={{ wecom: 'not_configured', feishu: 'error', errors: { feishu: 'Authentication failed' } }}
      />,
    );

    expect(screen.getByText('Authentication failed')).toBeInTheDocument();
  });

  it('shows Reconnect button when channel is disconnected and credentials are unchanged', () => {
    const originalBot: Bot = {
      id: 'bot-1',
      name: 'Bot',
      activeWorkspaceId: null,
      channelSettings: { wecom: { enabled: true, botId: 'bid', botSecret: true } },
      rolePolicy: { normalToolPolicy: {}, skillAllowlist: [], bashWhitelist: [] },
      createdAt: '',
      updatedAt: '',
    };
    const onReconnect = vi.fn();

    renderWithI18n(
      <BotChannelsSection
        form={{ ...emptyForm(), wecomEnabled: true, wecomBotId: 'bid' }}
        onUpdate={vi.fn()}
        originalBot={originalBot}
        channelStatus={{ wecom: 'disconnected', feishu: 'not_configured' }}
        onReconnect={onReconnect}
      />,
    );

    const reconnectButton = screen.getByRole('button', { name: /reconnect/i });
    expect(reconnectButton).toBeInTheDocument();
    fireEvent.click(reconnectButton);
    expect(onReconnect).toHaveBeenCalledWith('wecom');
  });

  it('hides Reconnect button when credentials are dirty', () => {
    const originalBot: Bot = {
      id: 'bot-1',
      name: 'Bot',
      activeWorkspaceId: null,
      channelSettings: { wecom: { enabled: true, botId: 'bid', botSecret: true } },
      rolePolicy: { normalToolPolicy: {}, skillAllowlist: [], bashWhitelist: [] },
      createdAt: '',
      updatedAt: '',
    };

    renderWithI18n(
      <BotChannelsSection
        form={{ ...emptyForm(), wecomEnabled: true, wecomBotId: 'different-id' }}
        onUpdate={vi.fn()}
        originalBot={originalBot}
        channelStatus={{ wecom: 'disconnected', feishu: 'not_configured' }}
        onReconnect={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: /reconnect/i })).not.toBeInTheDocument();
  });

  it('hides Reconnect button when channel is not disconnected', () => {
    const originalBot: Bot = {
      id: 'bot-1',
      name: 'Bot',
      activeWorkspaceId: null,
      channelSettings: { wecom: { enabled: true, botId: 'bid', botSecret: true } },
      rolePolicy: { normalToolPolicy: {}, skillAllowlist: [], bashWhitelist: [] },
      createdAt: '',
      updatedAt: '',
    };

    renderWithI18n(
      <BotChannelsSection
        form={{ ...emptyForm(), wecomEnabled: true }}
        onUpdate={vi.fn()}
        originalBot={originalBot}
        channelStatus={{ wecom: 'connected', feishu: 'not_configured' }}
        onReconnect={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: /reconnect/i })).not.toBeInTheDocument();
  });

  it('requests credential reveal with the correct field key when the eye is clicked', async () => {
    const originalBot: Bot = {
      id: 'bot-1',
      name: 'Bot',
      activeWorkspaceId: null,
      channelSettings: { wecom: { enabled: true, botId: 'bid', botSecret: true } },
      rolePolicy: { normalToolPolicy: {}, skillAllowlist: [], bashWhitelist: [] },
      createdAt: '',
      updatedAt: '',
    };
    const onRevealCredential = vi.fn().mockResolvedValue('plain-secret');

    renderWithI18n(
      <BotChannelsSection
        form={{ ...emptyForm(), wecomEnabled: true }}
        onUpdate={vi.fn()}
        originalBot={originalBot}
        onRevealCredential={onRevealCredential}
      />,
    );

    const buttons = screen.getAllByRole('button');
    // The first eye button belongs to the WeCom Bot Secret input.
    fireEvent.click(buttons[1]);
    expect(onRevealCredential).toHaveBeenCalledWith('wecomBotSecret');
  });

  it('appends disabled descriptor when a channel toggle is off', () => {
    const originalBot: Bot = {
      id: 'bot-1',
      name: 'Bot',
      activeWorkspaceId: null,
      channelSettings: { wecom: { enabled: false } },
      rolePolicy: { normalToolPolicy: {}, skillAllowlist: [], bashWhitelist: [] },
      createdAt: '',
      updatedAt: '',
    };

    renderWithI18n(
      <BotChannelsSection
        form={{ ...emptyForm(), wecomEnabled: false, feishuEnabled: true }}
        onUpdate={vi.fn()}
        originalBot={originalBot}
        channelStatus={{ wecom: 'disconnected', feishu: 'connected' }}
      />,
    );

    expect(screen.getByText(/WeCom disconnected/i)).toBeInTheDocument();
    expect(screen.getByText(/WeCom disconnected.*disabled/i)).toBeInTheDocument();
  });
});
