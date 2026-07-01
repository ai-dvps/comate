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
});
