import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    channelSettings: {},
    rolePolicy: { normalToolPolicy: {}, skillAllowlist: [], bashWhitelist: [] },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const sections = [
  { id: 'general', label: 'General' },
  { id: 'channels', label: 'Channels' },
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
    expect(screen.getByText('Channels')).toBeInTheDocument();
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
        activeSection="channels"
        onSelectSection={vi.fn()}
        emptyState={<div>Empty</div>}
      >
        <div>Content</div>
      </BotTabShell>,
    );

    const selectedBot = screen.getByText('DevOps Bot').closest('button');
    expect(selectedBot?.className).toContain('bg-accent/10');

    const activeTab = screen.getByText('Channels');
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

  describe('search filter', () => {
    it('renders the search input with placeholder', () => {
      renderWithI18n(
        <BotTabShell
          bots={[makeBot()]}
          selectedBotId="bot-1"
          onSelectBot={vi.fn()}
          onCreateBot={vi.fn()}
          sections={sections}
          activeSection="general"
          onSelectSection={vi.fn()}
          emptyState={<div>Empty</div>}
          searchQuery=""
          onSearchQueryChange={vi.fn()}
        >
          <div>Content</div>
        </BotTabShell>,
      );

      expect(screen.getByPlaceholderText('Search bots...')).toBeInTheDocument();
    });

    it('calls onSearchQueryChange with the query when Enter is pressed', async () => {
      const user = userEvent.setup();
      const onSearchQueryChange = vi.fn();
      renderWithI18n(
        <BotTabShell
          bots={[makeBot()]}
          selectedBotId="bot-1"
          onSelectBot={vi.fn()}
          onCreateBot={vi.fn()}
          sections={sections}
          activeSection="general"
          onSelectSection={vi.fn()}
          emptyState={<div>Empty</div>}
          searchQuery=""
          onSearchQueryChange={onSearchQueryChange}
        >
          <div>Content</div>
        </BotTabShell>,
      );

      const input = screen.getByPlaceholderText('Search bots...');
      await user.type(input, 'dev');
      await user.keyboard('{Enter}');

      expect(onSearchQueryChange).toHaveBeenCalledTimes(1);
      expect(onSearchQueryChange).toHaveBeenCalledWith('dev');
    });

    it('clears the query when Escape is pressed', async () => {
      const user = userEvent.setup();
      const onSearchQueryChange = vi.fn();
      renderWithI18n(
        <BotTabShell
          bots={[makeBot()]}
          selectedBotId="bot-1"
          onSelectBot={vi.fn()}
          onCreateBot={vi.fn()}
          sections={sections}
          activeSection="general"
          onSelectSection={vi.fn()}
          emptyState={<div>Empty</div>}
          searchQuery="dev"
          onSearchQueryChange={onSearchQueryChange}
        >
          <div>Content</div>
        </BotTabShell>,
      );

      const input = screen.getByPlaceholderText('Search bots...') as HTMLInputElement;
      expect(input.value).toBe('dev');

      input.focus();
      await user.keyboard('{Escape}');

      expect(input.value).toBe('');
      expect(onSearchQueryChange).toHaveBeenCalledWith('');
    });

    it('shows the clear button when a query is present and clears on click', async () => {
      const user = userEvent.setup();
      const onSearchQueryChange = vi.fn();
      renderWithI18n(
        <BotTabShell
          bots={[makeBot()]}
          selectedBotId="bot-1"
          onSelectBot={vi.fn()}
          onCreateBot={vi.fn()}
          sections={sections}
          activeSection="general"
          onSelectSection={vi.fn()}
          emptyState={<div>Empty</div>}
          searchQuery="dev"
          onSearchQueryChange={onSearchQueryChange}
        >
          <div>Content</div>
        </BotTabShell>,
      );

      const clearButton = screen.getByRole('button', { name: 'Clear search' });
      expect(clearButton).toBeInTheDocument();

      await user.click(clearButton);

      expect(onSearchQueryChange).toHaveBeenCalledWith('');
      expect((screen.getByPlaceholderText('Search bots...') as HTMLInputElement).value).toBe('');
    });

    it('does not show the clear button when the query is empty', () => {
      renderWithI18n(
        <BotTabShell
          bots={[makeBot()]}
          selectedBotId="bot-1"
          onSelectBot={vi.fn()}
          onCreateBot={vi.fn()}
          sections={sections}
          activeSection="general"
          onSelectSection={vi.fn()}
          emptyState={<div>Empty</div>}
          searchQuery=""
          onSearchQueryChange={vi.fn()}
        >
          <div>Content</div>
        </BotTabShell>,
      );

      expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();
    });

    it('renders the match count when a filter is active', () => {
      renderWithI18n(
        <BotTabShell
          bots={[makeBot()]}
          selectedBotId="bot-1"
          onSelectBot={vi.fn()}
          onCreateBot={vi.fn()}
          sections={sections}
          activeSection="general"
          onSelectSection={vi.fn()}
          emptyState={<div>Empty</div>}
          searchQuery="dev"
          matchCount={1}
        >
          <div>Content</div>
        </BotTabShell>,
      );

      expect(screen.getByText('1 bot')).toBeInTheDocument();
    });

    it('renders no matching bots empty state when filtered list is empty', () => {
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
          searchQuery="xyz"
          matchCount={0}
        >
          <div>Content</div>
        </BotTabShell>,
      );

      expect(screen.getByText('No bots found')).toBeInTheDocument();
      expect(screen.getByText('Create Bot')).toBeInTheDocument();
    });

    it('keeps the right pane visible when the filter hides every bot', () => {
      renderWithI18n(
        <BotTabShell
          bots={[]}
          selectedBotId="bot-1"
          onSelectBot={vi.fn()}
          onCreateBot={vi.fn()}
          sections={sections}
          activeSection="general"
          onSelectSection={vi.fn()}
          emptyState={<BotEmptyState onCreateBot={vi.fn()} />}
          searchQuery="xyz"
          matchCount={0}
        >
          <div data-testid="content">Content</div>
        </BotTabShell>,
      );

      expect(screen.queryByText('No bots yet')).not.toBeInTheDocument();
      expect(screen.getByTestId('content')).toBeInTheDocument();
    });
  });
});
