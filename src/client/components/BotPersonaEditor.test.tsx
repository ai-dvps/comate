import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';
import BotPersonaEditor, { type BotPersonaEditorHandle } from './BotPersonaEditor';
import type { Bot } from '../stores/bot-store';

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

function makeBot(overrides?: Partial<Bot>): Bot {
  return {
    id: 'bot-1',
    name: 'Test Bot',
    activeWorkspaceId: null,
    channelSettings: {},
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

  it('renders the persona editor with Default tab active', () => {
    renderWithI18n(<BotPersonaEditor bot={makeBot()} onSave={vi.fn()} />);

    expect(screen.getByRole('tab', { name: 'Default' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Owner' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByText('Append to Claude Code default')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g. You are a helpful DevOps assistant...')).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: /^Save$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cancel/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Saved' })).not.toBeInTheDocument();
  });

  it('populates existing default persona values', () => {
    const bot = makeBot({
      persona: { prompt: 'Existing prompt', mode: 'replace' },
    });
    renderWithI18n(<BotPersonaEditor bot={bot} onSave={vi.fn()} />);

    expect(screen.getByDisplayValue('Existing prompt')).toBeInTheDocument();
    expect(screen.getByText('Replace Claude Code default')).toHaveClass('bg-surface-active');
  });

  it('switches mode when buttons are clicked', async () => {
    renderWithI18n(<BotPersonaEditor bot={makeBot()} onSave={vi.fn()} />);

    await userEvent.click(screen.getByText('Replace Claude Code default'));

    expect(screen.getByText('Replace Claude Code default')).toHaveClass('bg-surface-active');
    expect(screen.getByText('Append to Claude Code default')).not.toHaveClass('bg-surface-active');
  });

  it('calls onSave when save is invoked through the handle', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const ref = createRef<BotPersonaEditorHandle>();
    renderWithI18n(<BotPersonaEditor bot={makeBot()} onSave={onSave} ref={ref} />);

    await user.type(
      screen.getByPlaceholderText('e.g. You are a helpful DevOps assistant...'),
      'You are a test persona.',
    );

    await act(async () => {
      await ref.current?.save();
    });

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });

    expect(onSave).toHaveBeenCalledWith({
      persona: { prompt: 'You are a test persona.', mode: 'append' },
      rolePersonas: {},
    });
    expect(ref.current?.isDirty()).toBe(false);
  });

  it('calls onSave with null default and empty role personas when prompt is cleared', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const ref = createRef<BotPersonaEditorHandle>();
    const bot = makeBot({ persona: { prompt: 'To be cleared', mode: 'append' } });
    renderWithI18n(<BotPersonaEditor bot={bot} onSave={onSave} ref={ref} />);

    const textarea = screen.getByDisplayValue('To be cleared');
    await user.clear(textarea);

    await act(async () => {
      await ref.current?.save();
    });

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });

    expect(onSave).toHaveBeenCalledWith({ persona: null, rolePersonas: {} });
  });

  it('shows a length warning when the active prompt exceeds the budget', () => {
    renderWithI18n(<BotPersonaEditor bot={makeBot()} onSave={vi.fn()} />);

    const textarea = screen.getByPlaceholderText('e.g. You are a helpful DevOps assistant...');
    fireEvent.change(textarea, { target: { value: 'a'.repeat(2001) } });

    expect(screen.getByText(/Long prompts increase token usage/)).toBeInTheDocument();
  });

  it('switches between role tabs and preserves independent edits', async () => {
    const user = userEvent.setup();
    renderWithI18n(<BotPersonaEditor bot={makeBot()} onSave={vi.fn()} />);

    await user.type(
      screen.getByPlaceholderText('e.g. You are a helpful DevOps assistant...'),
      'Default prompt',
    );

    await user.click(screen.getByRole('tab', { name: 'Owner' }));
    await user.type(
      screen.getByPlaceholderText('e.g. You are a helpful DevOps assistant...'),
      'Owner prompt',
    );

    await user.click(screen.getByRole('tab', { name: 'Admin' }));
    expect(screen.getByPlaceholderText('e.g. You are a helpful DevOps assistant...')).toHaveValue('');

    await user.click(screen.getByRole('tab', { name: 'Owner' }));
    expect(screen.getByDisplayValue('Owner prompt')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Default' }));
    expect(screen.getByDisplayValue('Default prompt')).toBeInTheDocument();
  });

  it('saves role personas only for roles with non-empty prompts', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const ref = createRef<BotPersonaEditorHandle>();
    renderWithI18n(<BotPersonaEditor bot={makeBot()} onSave={onSave} ref={ref} />);

    await user.click(screen.getByRole('tab', { name: 'Owner' }));
    await user.type(
      screen.getByPlaceholderText('e.g. You are a helpful DevOps assistant...'),
      'Owner only',
    );
    await user.click(screen.getByText('Replace Claude Code default'));

    await user.click(screen.getByRole('tab', { name: 'Normal' }));
    await user.type(
      screen.getByPlaceholderText('e.g. You are a helpful DevOps assistant...'),
      'Normal prompt',
    );

    await act(async () => {
      await ref.current?.save();
    });

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });

    expect(onSave).toHaveBeenCalledWith({
      persona: null,
      rolePersonas: {
        owner: { prompt: 'Owner only', mode: 'replace' },
        normal: { prompt: 'Normal prompt', mode: 'append' },
      },
    });
  });

  it('shows fallback hint on role tabs without a configured persona', async () => {
    const user = userEvent.setup();
    renderWithI18n(<BotPersonaEditor bot={makeBot()} onSave={vi.fn()} />);

    await user.click(screen.getByRole('tab', { name: 'Normal' }));
    expect(screen.getByText(/No persona configured for this role/)).toBeInTheDocument();

    await user.type(
      screen.getByPlaceholderText('e.g. You are a helpful DevOps assistant...'),
      'Normal prompt',
    );
    expect(screen.queryByText(/No persona configured for this role/)).not.toBeInTheDocument();
  });

  it('notifies parent when dirty state changes', async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();
    renderWithI18n(
      <BotPersonaEditor bot={makeBot()} onSave={vi.fn()} onDirtyChange={onDirtyChange} />,
    );

    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    await user.type(
      screen.getByPlaceholderText('e.g. You are a helpful DevOps assistant...'),
      'x',
    );

    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it('reverts unsaved changes when discard is invoked through the handle', async () => {
    const user = userEvent.setup();
    const ref = createRef<BotPersonaEditorHandle>();
    renderWithI18n(<BotPersonaEditor bot={makeBot()} onSave={vi.fn()} ref={ref} />);

    await user.type(
      screen.getByPlaceholderText('e.g. You are a helpful DevOps assistant...'),
      'Draft',
    );

    await waitFor(() => expect(ref.current?.isDirty()).toBe(true));

    act(() => {
      ref.current?.discard();
    });

    await waitFor(() => {
      expect(ref.current?.isDirty()).toBe(false);
      expect(screen.getByPlaceholderText('e.g. You are a helpful DevOps assistant...')).toHaveValue('');
    });
  });
});
