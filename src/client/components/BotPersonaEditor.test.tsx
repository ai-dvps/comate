import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';
import BotPersonaEditor from './BotPersonaEditor';
import type { Bot } from '../stores/bot-store';

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

function makeBot(overrides?: Partial<Bot>): Bot {
  return {
    id: 'bot-1',
    name: 'Test Bot',
    activeWorkspaceId: null,
    providerSettings: {},
    rolePolicy: {
      normalToolPolicy: { posture: 'safe', categoryDefaults: {} },
      skillAllowlist: [],
      bashWhitelist: [],
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('BotPersonaEditor', () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the persona editor with default append mode', () => {
    renderWithI18n(<BotPersonaEditor bot={makeBot()} onSave={vi.fn()} />);

    expect(screen.getByText('Bot Persona')).toBeInTheDocument();
    expect(screen.getByText('Append to Claude Code default')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g. You are a helpful DevOps assistant...')).toBeInTheDocument();

    const saveButton = screen.getByRole('button', { name: 'Saved' });
    expect(saveButton).toBeDisabled();
  });

  it('populates existing persona values', () => {
    const bot = makeBot({
      persona: { prompt: 'Existing prompt', mode: 'replace' },
    });
    renderWithI18n(<BotPersonaEditor bot={bot} onSave={vi.fn()} />);

    expect(screen.getByDisplayValue('Existing prompt')).toBeInTheDocument();
    expect(screen.getByText('Replace Claude Code default')).toHaveClass('bg-surface-active');

    const saveButton = screen.getByRole('button', { name: 'Saved' });
    expect(saveButton).toBeDisabled();
  });

  it('switches mode when buttons are clicked', async () => {
    renderWithI18n(<BotPersonaEditor bot={makeBot()} onSave={vi.fn()} />);

    await userEvent.click(screen.getByText('Replace Claude Code default'));

    expect(screen.getByText('Replace Claude Code default')).toHaveClass('bg-surface-active');
    expect(screen.getByText('Append to Claude Code default')).not.toHaveClass('bg-surface-active');

    const saveButton = screen.getByRole('button', { name: 'Save changes' });
    expect(saveButton).toBeEnabled();
  });

  it('calls onSave with persona when form is submitted', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderWithI18n(<BotPersonaEditor bot={makeBot()} onSave={onSave} />);

    await userEvent.type(
      screen.getByPlaceholderText('e.g. You are a helpful DevOps assistant...'),
      'You are a test persona.',
    );

    const saveButton = screen.getByRole('button', { name: 'Save changes' });
    expect(saveButton).toBeEnabled();
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });

    expect(onSave).toHaveBeenCalledWith({
      prompt: 'You are a test persona.',
      mode: 'append',
    });
  });

  it('calls onSave with null when prompt is cleared', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const bot = makeBot({ persona: { prompt: 'To be cleared', mode: 'append' } });
    renderWithI18n(<BotPersonaEditor bot={bot} onSave={onSave} />);

    const textarea = screen.getByDisplayValue('To be cleared');
    await userEvent.clear(textarea);

    const saveButton = screen.getByRole('button', { name: 'Save changes' });
    expect(saveButton).toBeEnabled();
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });

    expect(onSave).toHaveBeenCalledWith(null);
  });

  it('shows a length warning when the prompt exceeds the budget', async () => {
    renderWithI18n(<BotPersonaEditor bot={makeBot()} onSave={vi.fn()} />);

    const longPrompt = 'a'.repeat(2001);
    await userEvent.type(
      screen.getByPlaceholderText('e.g. You are a helpful DevOps assistant...'),
      longPrompt,
    );

    expect(screen.getByText(/Long prompts increase token usage/)).toBeInTheDocument();
  });

  it('reflects saved state after a successful save', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderWithI18n(<BotPersonaEditor bot={makeBot()} onSave={onSave} />);

    await userEvent.type(
      screen.getByPlaceholderText('e.g. You are a helpful DevOps assistant...'),
      'You are a test persona.',
    );

    const saveButton = screen.getByRole('button', { name: 'Save changes' });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByRole('button', { name: 'Saved' })).toBeDisabled();
  });
});
