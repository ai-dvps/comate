import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';
import BotMemberList from './BotMemberList';
import type { BotMember } from '../stores/bot-store';

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

describe('BotMemberList', () => {
  beforeEach(() => {
    cleanup();
    baseProps.onAddMember.mockClear();
    baseProps.onSetRole.mockClear();
    baseProps.onRemoveMember.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const baseProps = {
    botId: 'bot-1',
    members: [],
    onAddMember: vi.fn().mockResolvedValue(undefined),
    onSetRole: vi.fn().mockResolvedValue(undefined),
    onRemoveMember: vi.fn().mockResolvedValue(undefined),
  };

  it('renders empty state when no members', () => {
    renderWithI18n(<BotMemberList {...baseProps} />);
    expect(screen.getByText('No members yet.')).toBeInTheDocument();
  });

  it('lists members sorted by role', () => {
    const members: BotMember[] = [
      { botId: 'bot-1', provider: 'wecom', providerUserId: 'u-normal', role: 'normal', createdAt: '', updatedAt: '' },
      { botId: 'bot-1', provider: 'wecom', providerUserId: 'u-owner', role: 'owner', createdAt: '', updatedAt: '' },
      { botId: 'bot-1', provider: 'feishu', providerUserId: 'u-admin', role: 'admin', createdAt: '', updatedAt: '' },
    ];

    renderWithI18n(<BotMemberList {...baseProps} members={members} />);

    const ids = screen.getAllByText(/u-/).map((el) => el.textContent);
    expect(ids).toEqual(['u-owner', 'u-admin', 'u-normal']);
  });

  it('adds a member when form is filled and submitted', async () => {
    renderWithI18n(<BotMemberList {...baseProps} />);

    const input = screen.getByPlaceholderText('User ID');
    fireEvent.change(input, { target: { value: 'new-user' } });
    fireEvent.click(screen.getByText('Add member'));

    await waitFor(() => {
      expect(baseProps.onAddMember).toHaveBeenCalledWith({
        provider: 'wecom',
        providerUserId: 'new-user',
        role: 'normal',
      });
    });
  });

  it('shows validation error when user id is empty', async () => {
    renderWithI18n(<BotMemberList {...baseProps} />);

    fireEvent.click(screen.getByText('Add member'));

    await waitFor(() => {
      expect(screen.getByText('Provider user ID is required.')).toBeInTheDocument();
    });
    expect(baseProps.onAddMember).not.toHaveBeenCalled();
  });

  it('updates role when select changes', async () => {
    const members: BotMember[] = [
      { botId: 'bot-1', provider: 'wecom', providerUserId: 'u-1', role: 'normal', createdAt: '', updatedAt: '' },
    ];
    renderWithI18n(<BotMemberList {...baseProps} members={members} />);

    const triggers = screen.getAllByRole('combobox');
    const memberRoleTrigger = triggers[triggers.length - 1];
    await userEvent.click(memberRoleTrigger);
    await userEvent.click(screen.getByRole('option', { name: 'Admin' }));

    await waitFor(() => {
      expect(baseProps.onSetRole).toHaveBeenCalledWith('wecom', 'u-1', 'admin');
    });
  });
});
