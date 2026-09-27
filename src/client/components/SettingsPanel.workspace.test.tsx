import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';
import { clampFontSize } from '../lib/font-size';
import SettingsPanel from './SettingsPanel';
import type { Workspace } from '../stores/workspace-store';

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

const workspace1: Workspace = {
  id: 'ws-1',
  name: 'Workspace One',
  description: '',
  folderPath: '/tmp/ws1',
  skills: [],
  mcpServers: [],
  hooks: [],
  createdAt: '',
  updatedAt: '',
  settings: {},
};

const workspace2: Workspace = {
  id: 'ws-2',
  name: 'Workspace Two',
  description: '',
  folderPath: '/tmp/ws2',
  skills: [],
  mcpServers: [],
  hooks: [],
  createdAt: '',
  updatedAt: '',
  settings: {},
};

const mockUpdateWorkspace = vi.fn().mockResolvedValue(undefined);

const workspaceState = {
  workspaces: [workspace1, workspace2],
  activeWorkspaceId: workspace1.id,
  updateWorkspace: mockUpdateWorkspace,
  deleteWorkspace: vi.fn(),
  fetchWorkspaces: vi.fn(),
  error: null,
  isLoading: false,
};

const updaterState = {
  status: 'idle' as const,
  update: null,
  downloadProgress: 0,
  error: null,
};

const appSettingsListeners = new Set<() => void>();
let appSettingsVersion = 0;

function emitAppSettingsChange() {
  appSettingsVersion += 1;
  appSettingsListeners.forEach((listener) => listener());
}

const appSettings = {
  language: 'en',
  setLanguage: vi.fn(),
  chatFontSize: 12,
  setChatFontSize: vi.fn((value: number) => {
    appSettings.chatFontSize = clampFontSize(value);
    emitAppSettingsChange();
  }),
  uiFontSize: 14,
  setUiFontSize: vi.fn((value: number) => {
    appSettings.uiFontSize = clampFontSize(value);
    emitAppSettingsChange();
  }),
  displayMode: 'result' as const,
  setDisplayMode: vi.fn(),
  reopenLastWorkspace: false,
  setReopenLastWorkspace: vi.fn(),
  useModifierToSubmit: true,
  setUseModifierToSubmit: vi.fn(),
  autoCheckUpdates: false,
  setAutoCheckUpdates: vi.fn(),
  notificationSoundsEnabled: true,
  setNotificationSoundsEnabled: vi.fn(),
  notificationSoundsVolume: 100,
  setNotificationSoundsVolume: vi.fn(),
  archiveThresholdDays: 14,
  setArchiveThresholdDays: vi.fn(),
  lastUpdateCheckAt: null,
  setLastUpdateCheckAt: vi.fn(),
};

const botState = {
  bots: [],
  membersByBotId: {},
  channelStatusByBotId: {},
  isLoading: false,
  isSaving: false,
  migrationResult: null,
  error: null,
  fetchBots: vi.fn(),
  createBot: vi.fn(),
  updateBot: vi.fn(),
  deleteBot: vi.fn(),
  switchWorkspace: vi.fn(),
  fetchMembers: vi.fn(),
  addMember: vi.fn(),
  setMemberRole: vi.fn(),
  removeMember: vi.fn(),
  fetchStatus: vi.fn(),
  runMigration: vi.fn(),
  clearError: vi.fn(),
};

vi.mock('../stores/workspace-store', async () => {
  return {
    useWorkspaceStore: vi.fn((selector?: (state: typeof workspaceState) => unknown) =>
      selector ? selector(workspaceState) : workspaceState,
    ),
  };
});

vi.mock('../stores/updater-store', async () => {
  return {
    useUpdaterStore: vi.fn((selector?: (state: typeof updaterState) => unknown) =>
      selector ? selector(updaterState) : updaterState,
    ),
  };
});

vi.mock('../hooks/use-app-settings', async () => {
  const React = await import('react');
  return {
    useAppSettings: vi.fn(() => {
      React.useSyncExternalStore(
        (listener) => {
          appSettingsListeners.add(listener);
          return () => appSettingsListeners.delete(listener);
        },
        () => appSettingsVersion,
        () => appSettingsVersion,
      );
      return appSettings;
    }),
  };
});

vi.mock('../stores/bot-store', async () => {
  const actual = await vi.importActual<typeof import('../stores/bot-store')>('../stores/bot-store');
  return {
    ...actual,
    useBotStore: vi.fn((selector?: (state: typeof botState) => unknown) =>
      selector ? selector(botState) : botState,
    ),
  };
});

vi.mock('../lib/updater-api', async () => {
  return {
    checkForUpdates: vi.fn(),
    getAppVersion: vi.fn(() => Promise.resolve('0.0.1')),
    downloadAndInstallUpdate: vi.fn(),
    restartToUpdate: vi.fn(),
    dismissUpdate: vi.fn(),
  };
});

describe('SettingsPanel workspace tab local footer', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockUpdateWorkspace.mockResolvedValue(undefined);
    appSettings.chatFontSize = 12;
    appSettings.uiFontSize = 14;
    emitAppSettingsChange();

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ resolvedPath: '', customPaths: [], sources: { shell: null, fallback: null } }),
    } as Response);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('edits chat and UI font sizes through controlled number inputs', async () => {
    const user = userEvent.setup();
    await act(async () => {
      renderWithI18n(<SettingsPanel isOpen onClose={vi.fn()} />);
    });

    await user.click(screen.getByRole('button', { name: /Appearance/i }));

    const chatFontSize = screen.getByRole('spinbutton', { name: /Chat Font Size/i });
    const uiFontSize = screen.getByRole('spinbutton', { name: /UI Font Size/i });
    expect(chatFontSize).toHaveValue(12);
    expect(uiFontSize).toHaveValue(14);

    await user.clear(chatFontSize);
    expect(chatFontSize).toHaveValue(null);
    await user.click(uiFontSize);
    expect(chatFontSize).toHaveValue(12);
    expect(appSettings.setChatFontSize).not.toHaveBeenCalled();

    await user.click(chatFontSize);
    await user.clear(chatFontSize);
    await user.type(chatFontSize, '18');
    expect(chatFontSize).toHaveValue(18);
    await user.click(uiFontSize);
    expect(appSettings.setChatFontSize).toHaveBeenCalledWith(18);

    await user.clear(uiFontSize);
    await user.type(uiFontSize, '16');
    expect(uiFontSize).toHaveValue(16);
    await user.click(chatFontSize);
    expect(appSettings.setUiFontSize).toHaveBeenCalledWith(16);
    expect(chatFontSize).toHaveValue(18);
    expect(uiFontSize).toHaveValue(16);
  });

  it('renders the workspace footer with disabled actions when clean', async () => {
    const onClose = vi.fn();

    await act(async () => {
      renderWithI18n(<SettingsPanel isOpen onClose={onClose} />);
    });

    fireEvent.click(screen.getByRole('button', { name: /Workspace/i }));

    expect(screen.getByRole('button', { name: /^Save$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeDisabled();
  });

  it('shows the local Save/Cancel footer when workspace fields are dirty', async () => {
    const onClose = vi.fn();

    await act(async () => {
      renderWithI18n(<SettingsPanel isOpen onClose={onClose} />);
    });

    fireEvent.click(screen.getByRole('button', { name: /Workspace/i }));
    const nameInput = screen.getByDisplayValue('Workspace One') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'Workspace One Updated' } });
      await Promise.resolve();
    });

    expect(screen.getByRole('button', { name: /Save/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument();
  });

  it('saves the workspace and disables the footer buttons when Save is clicked', async () => {
    const onClose = vi.fn();

    await act(async () => {
      renderWithI18n(<SettingsPanel isOpen onClose={onClose} />);
    });

    fireEvent.click(screen.getByRole('button', { name: /Workspace/i }));
    const nameInput = screen.getByDisplayValue('Workspace One') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'Workspace One Updated' } });
      await Promise.resolve();
    });

    const saveButton = screen.getByRole('button', { name: /^Save$/i });
    expect(saveButton).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(saveButton);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockUpdateWorkspace).toHaveBeenCalledWith(
        workspace1.id,
        expect.objectContaining({ name: 'Workspace One Updated' }),
      );
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Save$/i })).toBeDisabled();
    });
  });

  it('reverts the workspace and disables the footer buttons when Cancel is clicked', async () => {
    const onClose = vi.fn();

    await act(async () => {
      renderWithI18n(<SettingsPanel isOpen onClose={onClose} />);
    });

    fireEvent.click(screen.getByRole('button', { name: /Workspace/i }));
    const nameInput = screen.getByDisplayValue('Workspace One') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'Workspace One Updated' } });
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
      await Promise.resolve();
    });

    expect(nameInput.value).toBe('Workspace One');
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeDisabled();
    expect(mockUpdateWorkspace).not.toHaveBeenCalled();
  });

  it('prompts to save when switching workspaces with unsaved changes', async () => {
    const onClose = vi.fn();

    await act(async () => {
      renderWithI18n(<SettingsPanel isOpen onClose={onClose} />);
    });

    fireEvent.click(screen.getByRole('button', { name: /Workspace/i }));
    const nameInput = screen.getByDisplayValue('Workspace One') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'Workspace One Updated' } });
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('button', { name: /Workspace Two/i }));

    await waitFor(() => {
      expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    });
  });

  it('saves and switches workspaces when choosing Save in the switch guard', async () => {
    const onClose = vi.fn();

    await act(async () => {
      renderWithI18n(<SettingsPanel isOpen onClose={onClose} />);
    });

    fireEvent.click(screen.getByRole('button', { name: /Workspace/i }));
    const nameInput = screen.getByDisplayValue('Workspace One') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'Workspace One Updated' } });
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('button', { name: /Workspace Two/i }));

    await waitFor(() => {
      expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockUpdateWorkspace).toHaveBeenCalledWith(
        workspace1.id,
        expect.objectContaining({ name: 'Workspace One Updated' }),
      );
    });

    expect(screen.getByDisplayValue('Workspace Two')).toBeInTheDocument();
  });

  it('discards and switches workspaces when choosing Discard in the switch guard', async () => {
    const onClose = vi.fn();

    await act(async () => {
      renderWithI18n(<SettingsPanel isOpen onClose={onClose} />);
    });

    fireEvent.click(screen.getByRole('button', { name: /Workspace/i }));
    const nameInput = screen.getByDisplayValue('Workspace One') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'Workspace One Updated' } });
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('button', { name: /Workspace Two/i }));

    await waitFor(() => {
      expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Discard/i }));
      await Promise.resolve();
    });

    expect(mockUpdateWorkspace).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('Workspace Two')).toBeInTheDocument();
  });

  it('stays on the current workspace when choosing Keep editing in the switch guard', async () => {
    const onClose = vi.fn();

    await act(async () => {
      renderWithI18n(<SettingsPanel isOpen onClose={onClose} />);
    });

    fireEvent.click(screen.getByRole('button', { name: /Workspace/i }));
    const nameInput = screen.getByDisplayValue('Workspace One') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'Workspace One Updated' } });
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('button', { name: /Workspace Two/i }));

    await waitFor(() => {
      expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Keep editing/i }));
      await Promise.resolve();
    });

    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('Workspace One Updated')).toBeInTheDocument();
    expect(mockUpdateWorkspace).not.toHaveBeenCalled();
  });

  describe('settings deep-link seeding', () => {
    it('seeds the workspace selection from initialWorkspaceId and lands on the workspace tab', async () => {
      await act(async () => {
        renderWithI18n(<SettingsPanel isOpen onClose={vi.fn()} initialWorkspaceId={workspace2.id} />);
      });

      // The deep link lands directly on the workspace tab, so the workspace
      // list renders without clicking the tab first.
      const ws2 = screen.getByRole('button', { name: 'Workspace Two' });
      const ws1 = screen.getByRole('button', { name: 'Workspace One' });
      expect(ws2.className).toContain('text-accent');
      expect(ws1.className).not.toContain('text-accent');
    });

    it('falls back to the active workspace when the seeded id no longer exists', async () => {
      await act(async () => {
        renderWithI18n(<SettingsPanel isOpen onClose={vi.fn()} initialWorkspaceId="ws-gone" />);
      });

      const ws1 = screen.getByRole('button', { name: 'Workspace One' });
      const ws2 = screen.getByRole('button', { name: 'Workspace Two' });
      expect(ws1.className).toContain('text-accent');
      expect(ws2.className).not.toContain('text-accent');
    });

    it('defaults to the active workspace and general tab without initialWorkspaceId', async () => {
      await act(async () => {
        renderWithI18n(<SettingsPanel isOpen onClose={vi.fn()} />);
      });

      // Still on the general tab: the workspace list is not rendered yet.
      expect(screen.queryByRole('button', { name: 'Workspace Two' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /Workspace/i }));

      const ws1 = screen.getByRole('button', { name: 'Workspace One' });
      const ws2 = screen.getByRole('button', { name: 'Workspace Two' });
      expect(ws1.className).toContain('text-accent');
      expect(ws2.className).not.toContain('text-accent');
    });

    it('moves the selection when initialWorkspaceId arrives after mount', async () => {
      // Settings already open without a deep link: stays on the general tab
      // with the active workspace selected.
      const view = renderWithI18n(<SettingsPanel isOpen onClose={vi.fn()} />);
      expect(screen.queryByRole('button', { name: 'Workspace Two' })).not.toBeInTheDocument();

      // Deep link arrives while the panel stays mounted.
      await act(async () => {
        view.rerender(
          <I18nextProvider i18n={i18n}>
            <SettingsPanel isOpen onClose={vi.fn()} initialWorkspaceId={workspace2.id} />
          </I18nextProvider>,
        );
      });

      const ws2 = screen.getByRole('button', { name: 'Workspace Two' });
      const ws1 = screen.getByRole('button', { name: 'Workspace One' });
      expect(ws2.className).toContain('text-accent');
      expect(ws1.className).not.toContain('text-accent');
    });

    it('ignores a stale initialWorkspaceId that arrives after mount', async () => {
      const view = renderWithI18n(<SettingsPanel isOpen onClose={vi.fn()} />);

      await act(async () => {
        view.rerender(
          <I18nextProvider i18n={i18n}>
            <SettingsPanel isOpen onClose={vi.fn()} initialWorkspaceId="ws-gone" />
          </I18nextProvider>,
        );
      });

      // Stale target: no workspace tab jump, selection unchanged.
      expect(screen.queryByRole('button', { name: 'Workspace Two' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /Workspace/i }));
      const ws1 = screen.getByRole('button', { name: 'Workspace One' });
      expect(ws1.className).toContain('text-accent');
    });
  });
});
