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

  it('adds a member when form is filled and submitted', async () => {
    renderWithI18n(<BotMemberList {...baseProps} />);

    const input = screen.getByPlaceholderText('User ID');
    fireEvent.change(input, { target: { value: 'new-user' } });
    fireEvent.click(screen.getByText('Add member'));

    await waitFor(() => {
      expect(baseProps.onAddMember).toHaveBeenCalledWith({
        channel: 'wecom',
        channelUserId: 'new-user',
        role: 'normal',
      });
    });
  });

  it('shows validation error when user id is empty', async () => {
    renderWithI18n(<BotMemberList {...baseProps} />);

    fireEvent.click(screen.getByText('Add member'));

    await waitFor(() => {
      expect(screen.getByText('Channel user ID is required.')).toBeInTheDocument();
    });
    expect(baseProps.onAddMember).not.toHaveBeenCalled();
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
    // One channel selector, one add-form role selector, and one role selector for the normal member.
    expect(screen.getAllByRole('combobox')).toHaveLength(3);
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

  it('disables owner option in add form when channel already has an owner', async () => {
    const members: BotMember[] = [
      { botId: 'bot-1', channel: 'wecom', channelUserId: 'u-owner', role: 'owner', createdAt: '', updatedAt: '', plaintextUserId: null, displayName: null, resolutionStatus: 'pending' },
    ];
    renderWithI18n(<BotMemberList {...baseProps} members={members} />);

    const triggers = screen.getAllByRole('combobox');
    const addRoleTrigger = triggers[triggers.length - 1];
    await userEvent.click(addRoleTrigger);

    const ownerOption = screen.getByRole('option', { name: 'Owner' });
    expect(ownerOption).toHaveAttribute('aria-disabled', 'true');
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

  it('shows a plaintext input for pending members and saves the fallback', async () => {
    const members: BotMember[] = [
      { botId: 'bot-1', channel: 'wecom', channelUserId: 'u-pending', role: 'normal', plaintextUserId: null, displayName: null, resolutionStatus: 'pending', createdAt: '', updatedAt: '' },
    ];
    renderWithI18n(<BotMemberList {...baseProps} members={members} />);

    const input = screen.getByPlaceholderText('Plaintext user ID');
    fireEvent.change(input, { target: { value: 'fallback-id' } });
    fireEvent.click(screen.getAllByText('Save')[0]);

    await waitFor(() => {
      expect(baseProps.onSetPlaintext).toHaveBeenCalledWith('wecom', 'u-pending', 'fallback-id');
    });
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
