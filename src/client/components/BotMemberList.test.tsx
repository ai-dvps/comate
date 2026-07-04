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
    baseProps.onSetRole.mockClear();
    baseProps.onRemoveMember.mockClear();
    baseProps.onSetPlaintext.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const baseProps = {
    botId: 'bot-1',
    members: [],
    onSetRole: vi.fn().mockResolvedValue(undefined),
    onRemoveMember: vi.fn().mockResolvedValue(undefined),
    onRefreshMembers: vi.fn().mockResolvedValue(undefined),
    onResolvePending: vi.fn().mockResolvedValue(undefined),
    onSetPlaintext: vi.fn().mockResolvedValue(undefined),
  };

  it('renders empty state when no members', () => {
    renderWithI18n(<BotMemberList {...baseProps} />);
    expect(screen.getByText('No members yet.')).toBeInTheDocument();
  });

  it('groups members by channel and sorts each group by role', () => {
    const members: BotMember[] = [
      { botId: 'bot-1', channel: 'wecom', channelUserId: 'u-normal', role: 'normal', createdAt: '', updatedAt: '', plaintextUserId: null, displayName: null, resolutionStatus: 'pending' },
      { botId: 'bot-1', channel: 'wecom', channelUserId: 'u-owner', role: 'owner', createdAt: '', updatedAt: '', plaintextUserId: null, displayName: null, resolutionStatus: 'pending' },
      { botId: 'bot-1', channel: 'feishu', channelUserId: 'u-admin', role: 'admin', createdAt: '', updatedAt: '', plaintextUserId: null, displayName: null, resolutionStatus: 'pending' },
    ];

    renderWithI18n(<BotMemberList {...baseProps} members={members} />);

    const ids = screen.getAllByText(/u-/).map((el) => el.textContent);
    expect(ids).toEqual(['u-owner', 'u-normal', 'u-admin']);
  });

  it('updates role when select changes', async () => {
    const members: BotMember[] = [
      { botId: 'bot-1', channel: 'wecom', channelUserId: 'u-1', role: 'normal', createdAt: '', updatedAt: '', plaintextUserId: null, displayName: null, resolutionStatus: 'pending' },
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

  it('renders owner badge and no role select for owner rows', () => {
    const members: BotMember[] = [
      { botId: 'bot-1', channel: 'wecom', channelUserId: 'u-owner', role: 'owner', createdAt: '', updatedAt: '', plaintextUserId: null, displayName: null, resolutionStatus: 'pending' },
      { botId: 'bot-1', channel: 'wecom', channelUserId: 'u-normal', role: 'normal', createdAt: '', updatedAt: '', plaintextUserId: null, displayName: null, resolutionStatus: 'pending' },
    ];
    renderWithI18n(<BotMemberList {...baseProps} members={members} />);

    expect(screen.getAllByText('Owner').length).toBeGreaterThanOrEqual(1);
    // One role selector for the normal member only; owners do not get a role selector.
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
  });

  it('shows owner assigned status when channel has an owner', () => {
    const members: BotMember[] = [
      { botId: 'bot-1', channel: 'wecom', channelUserId: 'u-owner', role: 'owner', createdAt: '', updatedAt: '', plaintextUserId: null, displayName: null, resolutionStatus: 'pending' },
    ];
    renderWithI18n(<BotMemberList {...baseProps} members={members} />);

    expect(screen.getByText('Owner assigned')).toBeInTheDocument();
  });

  it('shows owner-less warning for channels without an owner', () => {
    const members: BotMember[] = [
      { botId: 'bot-1', channel: 'wecom', channelUserId: 'u-normal', role: 'normal', createdAt: '', updatedAt: '', plaintextUserId: null, displayName: null, resolutionStatus: 'pending' },
    ];
    renderWithI18n(<BotMemberList {...baseProps} members={members} />);

    expect(screen.getByText('Owner-less channel')).toBeInTheDocument();
  });

  it('shows inline confirmation before removing the last owner', async () => {
    const members: BotMember[] = [
      { botId: 'bot-1', channel: 'wecom', channelUserId: 'u-owner', role: 'owner', createdAt: '', updatedAt: '', plaintextUserId: null, displayName: null, resolutionStatus: 'pending' },
    ];
    renderWithI18n(<BotMemberList {...baseProps} members={members} />);

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() => {
      expect(screen.getByText('Removing the last owner will leave this channel unmanageable. Are you sure?')).toBeInTheDocument();
    });
    expect(baseProps.onRemoveMember).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Confirm'));

    await waitFor(() => {
      expect(baseProps.onRemoveMember).toHaveBeenCalledWith('wecom', 'u-owner');
    });
  });

  it('shows no-members-in-channel placeholder for empty channels', () => {
    const members: BotMember[] = [
      { botId: 'bot-1', channel: 'wecom', channelUserId: 'u-normal', role: 'normal', createdAt: '', updatedAt: '', plaintextUserId: null, displayName: null, resolutionStatus: 'pending' },
    ];
    renderWithI18n(<BotMemberList {...baseProps} members={members} />);

    expect(screen.getByText('No members in this channel yet.')).toBeInTheDocument();
  });

  it('calls refresh and resolve-pending handlers', async () => {
    renderWithI18n(<BotMemberList {...baseProps} />);

    fireEvent.click(screen.getByText('Resolve pending'));
    await waitFor(() => {
      expect(baseProps.onResolvePending).toHaveBeenCalled();
    });

    const refreshButton = screen.getByTitle('Refresh members');
    fireEvent.click(refreshButton);
    await waitFor(() => {
      expect(baseProps.onRefreshMembers).toHaveBeenCalled();
    });
  });

  it('does not show a plaintext input by default', () => {
    const members: BotMember[] = [
      { botId: 'bot-1', channel: 'wecom', channelUserId: 'u-1', role: 'normal', plaintextUserId: null, displayName: null, resolutionStatus: 'pending', createdAt: '', updatedAt: '' },
    ];
    renderWithI18n(<BotMemberList {...baseProps} members={members} />);

    expect(screen.queryByPlaceholderText('Plaintext user ID')).not.toBeInTheDocument();
    expect(screen.getByText('Plaintext user ID')).toBeInTheDocument();
  });

  it('opens inline plaintext editor on placeholder click and saves on Enter', async () => {
    const members: BotMember[] = [
      { botId: 'bot-1', channel: 'wecom', channelUserId: 'u-1', role: 'normal', plaintextUserId: null, displayName: null, resolutionStatus: 'pending', createdAt: '', updatedAt: '' },
    ];
    renderWithI18n(<BotMemberList {...baseProps} members={members} />);

    await userEvent.click(screen.getByText('Plaintext user ID'));
    const input = screen.getByPlaceholderText('Plaintext user ID');
    await userEvent.clear(input);
    await userEvent.type(input, 'new-id');
    await userEvent.keyboard('{Enter}');

    await waitFor(() => {
      expect(baseProps.onSetPlaintext).toHaveBeenCalledWith('wecom', 'u-1', 'new-id');
    });
  });

  it('opens inline editor on resolved plaintext click and saves on blur', async () => {
    const members: BotMember[] = [
      { botId: 'bot-1', channel: 'feishu', channelUserId: 'ou-1', role: 'normal', plaintextUserId: 'user-1', displayName: 'Alice', resolutionStatus: 'resolved', createdAt: '', updatedAt: '' },
    ];
    renderWithI18n(<BotMemberList {...baseProps} members={members} />);

    await userEvent.click(screen.getByText('user-1'));
    const input = screen.getByDisplayValue('user-1');
    await userEvent.clear(input);
    await userEvent.type(input, 'user-2');
    fireEvent.blur(input);

    await waitFor(() => {
      expect(baseProps.onSetPlaintext).toHaveBeenCalledWith('feishu', 'ou-1', 'user-2');
    });
  });

  it('cancels plaintext editing on Escape', async () => {
    const members: BotMember[] = [
      { botId: 'bot-1', channel: 'wecom', channelUserId: 'u-1', role: 'normal', plaintextUserId: null, displayName: null, resolutionStatus: 'pending', createdAt: '', updatedAt: '' },
    ];
    renderWithI18n(<BotMemberList {...baseProps} members={members} />);

    await userEvent.click(screen.getByText('Plaintext user ID'));
    const input = screen.getByPlaceholderText('Plaintext user ID');
    await userEvent.type(input, 'new-id');
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByPlaceholderText('Plaintext user ID')).not.toBeInTheDocument();
    expect(baseProps.onSetPlaintext).not.toHaveBeenCalled();
  });

  it('cancels plaintext editing on blur when value is empty', async () => {
    const members: BotMember[] = [
      { botId: 'bot-1', channel: 'wecom', channelUserId: 'u-1', role: 'normal', plaintextUserId: null, displayName: null, resolutionStatus: 'pending', createdAt: '', updatedAt: '' },
    ];
    renderWithI18n(<BotMemberList {...baseProps} members={members} />);

    await userEvent.click(screen.getByText('Plaintext user ID'));
    const input = screen.getByPlaceholderText('Plaintext user ID');
    fireEvent.blur(input);

    await waitFor(() => {
      expect(screen.queryByPlaceholderText('Plaintext user ID')).not.toBeInTheDocument();
    });
    expect(baseProps.onSetPlaintext).not.toHaveBeenCalled();
  });

  it('shows resolved plaintext and display name', () => {
    const members: BotMember[] = [
      { botId: 'bot-1', channel: 'feishu', channelUserId: 'ou-1', role: 'normal', plaintextUserId: 'user-1', displayName: 'Alice', resolutionStatus: 'resolved', createdAt: '', updatedAt: '' },
    ];
    renderWithI18n(<BotMemberList {...baseProps} members={members} />);

    expect(screen.getByText('user-1')).toBeInTheDocument();
    expect(screen.getByText('(Alice)')).toBeInTheDocument();
  });
});
