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
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('BotRolePermissions', () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders Normal role editors by default with no inline Save button', () => {
    renderWithI18n(<BotRolePermissions bot={makeBot()} onSave={vi.fn()} />);

    expect(screen.getByText('Role Permissions')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g. my-skill')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g. npm run')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Save$/i })).not.toBeInTheDocument();
  });

  it('shows full-permission description for Owner and hides editors', async () => {
    renderWithI18n(<BotRolePermissions bot={makeBot()} onSave={vi.fn()} />);

    await userEvent.click(screen.getByText('Owner'));

    expect(screen.getByText(/Owners can manage the bot/)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('e.g. my-skill')).not.toBeInTheDocument();
  });

  it('shows full-permission description for Admin and hides editors', async () => {
    renderWithI18n(<BotRolePermissions bot={makeBot()} onSave={vi.fn()} />);

    await userEvent.click(screen.getByText('Admin'));

    expect(screen.getByText(/Admins have full tool/)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('e.g. my-skill')).not.toBeInTheDocument();
  });

  it('populates existing allowlists from bot rolePolicy', () => {
    const bot = makeBot({
      rolePolicy: {
        normalToolPolicy: {
          posture: 'custom',
          categoryDefaults: {
            fileRead: 'allow',
            fileWrite: 'allow',
            shell: 'deny',
            network: 'deny',
            subagents: 'deny',
            reply: 'allow',
          },
        },
        skillAllowlist: ['existing-skill'],
        bashWhitelist: ['git'],
      },
    });

    renderWithI18n(<BotRolePermissions bot={bot} onSave={vi.fn()} />);

    expect(screen.getByDisplayValue('existing-skill')).toBeInTheDocument();
    expect(screen.getByDisplayValue('git')).toBeInTheDocument();
  });

  it('reports dirty state through onDirtyChange and the imperative handle', async () => {
    const onDirtyChange = vi.fn();
    const ref = createRef<BotRolePermissionsHandle>();
    renderWithI18n(
      <BotRolePermissions bot={makeBot()} onSave={vi.fn()} onDirtyChange={onDirtyChange} ref={ref} />,
    );

    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(ref.current?.isDirty()).toBe(false);

    await userEvent.type(screen.getByPlaceholderText('e.g. my-skill'), 'skill-a');

    await waitFor(() => {
      expect(onDirtyChange).toHaveBeenLastCalledWith(true);
      expect(ref.current?.isDirty()).toBe(true);
    });
  });

  it('calls onSave with parsed role policy when save is invoked through the handle', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const ref = createRef<BotRolePermissionsHandle>();
    renderWithI18n(<BotRolePermissions bot={makeBot()} onSave={onSave} ref={ref} />);

    await userEvent.type(screen.getByPlaceholderText('e.g. my-skill'), 'skill-a\nskill-b');
    await userEvent.type(screen.getByPlaceholderText('e.g. npm run'), 'npm run\nnode ');

    await act(async () => {
      await ref.current?.save();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    const submitted = onSave.mock.calls[0][0];
    expect(submitted.skillAllowlist).toEqual(['skill-a', 'skill-b']);
    expect(submitted.bashWhitelist).toEqual(['npm run', 'node']);
    expect(submitted.normalToolPolicy.posture).toBe('safe');
    expect(ref.current?.isDirty()).toBe(false);
  });

  it('reverts edits when discard is invoked through the handle', async () => {
    const ref = createRef<BotRolePermissionsHandle>();
    renderWithI18n(<BotRolePermissions bot={makeBot()} onSave={vi.fn()} ref={ref} />);

    await userEvent.type(screen.getByPlaceholderText('e.g. my-skill'), 'skill-a');
    await waitFor(() => expect(ref.current?.isDirty()).toBe(true));

    act(() => {
      ref.current?.discard();
    });

    await waitFor(() => {
      expect(ref.current?.isDirty()).toBe(false);
      expect(screen.getByPlaceholderText('e.g. my-skill')).toHaveValue('');
    });
  });

  it('surfaces errors and keeps dirty state when onSave rejects', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Save failed'));
    const ref = createRef<BotRolePermissionsHandle>();
    renderWithI18n(<BotRolePermissions bot={makeBot()} onSave={onSave} ref={ref} />);

    await userEvent.type(screen.getByPlaceholderText('e.g. my-skill'), 'skill-a');

    await act(async () => {
      await expect(ref.current?.save()).rejects.toThrow('Save failed');
    });

    expect(screen.getByText('Save failed')).toBeInTheDocument();
    expect(ref.current?.isDirty()).toBe(true);
  });
});
