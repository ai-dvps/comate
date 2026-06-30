import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';
import BotTabShell, { BotEmptyState } from './BotTabShell';
import type { Bot } from '../stores/bot-store';

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

function makeBot(overrides?: Partial<Bot>): Bot {
  return {
    id: 'bot-1',
    name: 'TeamBot',
    activeWorkspaceId: null,
    providerSettings: {},
    rolePolicy: { normalToolPolicy: {}, skillAllowlist: [], bashWhitelist: [] },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const sections = [
  { id: 'general', label: 'General' },
  { id: 'providers', label: 'Providers' },
];

describe('BotTabShell', () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders sidebar, section tabs, content, and footer', () => {
    renderWithI18n(
      <BotTabShell
        bots={[makeBot()]}
        selectedBotId="bot-1"
        onSelectBot={vi.fn()}
        onCreateBot={vi.fn()}
        sections={sections}
        activeSection="general"
        onSelectSection={vi.fn()}
        footer={<span data-testid="footer">Footer</span>}
        emptyState={<div>Empty</div>}
      >
        <div data-testid="content">Content</div>
      </BotTabShell>,
    );

    expect(screen.getByText('TeamBot')).toBeInTheDocument();
    expect(screen.getByText('General')).toBeInTheDocument();
    expect(screen.getByText('Providers')).toBeInTheDocument();
    expect(screen.getByTestId('content')).toBeInTheDocument();
    expect(screen.getByTestId('footer')).toBeInTheDocument();
  });

  it('highlights the selected bot and active section', () => {
    renderWithI18n(
      <BotTabShell
        bots={[makeBot(), makeBot({ id: 'bot-2', name: 'DevOps Bot' })]}
        selectedBotId="bot-2"
        onSelectBot={vi.fn()}
        onCreateBot={vi.fn()}
        sections={sections}
        activeSection="providers"
        onSelectSection={vi.fn()}
        emptyState={<div>Empty</div>}
      >
        <div>Content</div>
      </BotTabShell>,
    );

    const selectedBot = screen.getByText('DevOps Bot').closest('button');
    expect(selectedBot?.className).toContain('bg-accent/10');

    const activeTab = screen.getByText('Providers');
    expect(activeTab.className).toContain('border-b-2');
  });

  it('calls onSelectBot when a bot is clicked', () => {
    const onSelectBot = vi.fn();
    renderWithI18n(
      <BotTabShell
        bots={[makeBot(), makeBot({ id: 'bot-2', name: 'DevOps Bot' })]}
        selectedBotId="bot-1"
        onSelectBot={onSelectBot}
        onCreateBot={vi.fn()}
        sections={sections}
        activeSection="general"
        onSelectSection={vi.fn()}
        emptyState={<div>Empty</div>}
      >
        <div>Content</div>
      </BotTabShell>,
    );

    fireEvent.click(screen.getByText('DevOps Bot'));
    expect(onSelectBot).toHaveBeenCalledWith('bot-2');
  });

  it('calls onCreateBot when create button is clicked', () => {
    const onCreateBot = vi.fn();
    renderWithI18n(
      <BotTabShell
        bots={[makeBot()]}
        selectedBotId="bot-1"
        onSelectBot={vi.fn()}
        onCreateBot={onCreateBot}
        sections={sections}
        activeSection="general"
        onSelectSection={vi.fn()}
        emptyState={<div>Empty</div>}
      >
        <div>Content</div>
      </BotTabShell>,
    );

    fireEvent.click(screen.getByText('Create Bot'));
    expect(onCreateBot).toHaveBeenCalledTimes(1);
  });

  it('shows empty state when no bots are provided', () => {
    renderWithI18n(
      <BotTabShell
        bots={[]}
        selectedBotId={null}
        onSelectBot={vi.fn()}
        onCreateBot={vi.fn()}
        sections={sections}
        activeSection="general"
        onSelectSection={vi.fn()}
        emptyState={<BotEmptyState onCreateBot={vi.fn()} />}
      >
        <div>Content</div>
      </BotTabShell>,
    );

    expect(screen.getByText('No bots yet')).toBeInTheDocument();
    expect(screen.queryByText('General')).not.toBeInTheDocument();
  });
});
