import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { GeneralTab } from './SettingsPanel';
import i18n from '../i18n';
import * as updaterApi from '../lib/updater-api';
import * as desktopApi from '../lib/desktop-api';
import { MISSING_UPDATE_FEED_ERROR } from '../../shared/updater-contract';

vi.mock('../lib/updater-api', async () => {
  const actual = await vi.importActual<typeof import('../lib/updater-api')>('../lib/updater-api');
  return {
    ...actual,
    checkForUpdates: vi.fn(),
    getAppVersion: vi.fn(() => Promise.resolve('0.0.1')),
    downloadAndInstallUpdate: vi.fn(),
    restartToUpdate: vi.fn(),
    dismissUpdate: vi.fn(),
  };
});

vi.mock('../lib/desktop-api', async () => {
  const actual = await vi.importActual<typeof import('../lib/desktop-api')>('../lib/desktop-api');
  return {
    ...actual,
    isDesktop: vi.fn(() => true),
    getLaunchAtLogin: vi.fn(() => Promise.resolve(false)),
    setLaunchAtLogin: vi.fn(() => Promise.resolve(false)),
  };
});

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

async function renderWithAct(ui: React.ReactElement) {
  const result = renderWithI18n(ui);
  await act(async () => {
    await Promise.resolve();
  });
  return result;
}

describe('GeneralTab updater flow', () => {
  const defaultProps = {
    reopenLastWorkspace: false,
    onReopenLastWorkspaceChange: vi.fn(),
    useModifierToSubmit: false,
    onUseModifierToSubmitChange: vi.fn(),
    approvalMode: 'auto' as const,
    onApprovalModeChange: vi.fn(),
    autoCheckUpdates: false,
    onAutoCheckUpdatesChange: vi.fn(),
    notificationSounds: false,
    onNotificationSoundsChange: vi.fn(),
    notificationSoundsVolume: 100,
    onNotificationSoundsVolumeChange: vi.fn(),
    lastUpdateCheckAt: null as string | null,
    updateStatus: 'idle' as const,
    updateError: null as string | null,
    updateInfo: null as import('../stores/updater-store').UpdateInfo | null,
    downloadProgress: 0,
    onRecordUpdateCheck: vi.fn(),
    archiveThresholdDays: '14',
    onArchiveThresholdDaysChange: vi.fn(),
    onArchiveThresholdDaysCommit: vi.fn(),
    isDirty: false,
    onSave: vi.fn(),
    onCancel: vi.fn(),
    isSaving: false,
    error: null as string | null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(desktopApi.isDesktop).mockReturnValue(true);
    vi.mocked(desktopApi.getLaunchAtLogin).mockResolvedValue(false);
    vi.mocked(desktopApi.setLaunchAtLogin).mockImplementation((enabled) => Promise.resolve(enabled));
    cleanup();
  });

  it('loads and updates the operating system launch-at-login setting', async () => {
    vi.mocked(desktopApi.getLaunchAtLogin).mockResolvedValueOnce(true);
    const user = userEvent.setup();
    await renderWithAct(<GeneralTab {...defaultProps} />);

    const toggle = await screen.findByRole('switch', { name: /Launch Comate at login/i });
    expect(toggle).toBeChecked();

    await user.click(toggle);

    expect(desktopApi.setLaunchAtLogin).toHaveBeenCalledWith(false);
    expect(toggle).not.toBeChecked();
  });

  it('restores the launch-at-login toggle and shows an error when the OS update fails', async () => {
    vi.mocked(desktopApi.setLaunchAtLogin).mockRejectedValueOnce(new Error('permission denied'));
    const user = userEvent.setup();
    await renderWithAct(<GeneralTab {...defaultProps} />);

    const toggle = await screen.findByRole('switch', { name: /Launch Comate at login/i });
    await user.click(toggle);

    expect(toggle).not.toBeChecked();
    expect(await screen.findByText(/Could not update the launch-at-login setting/i)).toBeInTheDocument();
  });

  it('renders Check for Updates button when idle', async () => {
    await renderWithAct(
      <I18nextProvider i18n={i18n}>
        <GeneralTab {...defaultProps} />
      </I18nextProvider>,
    );

    expect(screen.getByRole('button', { name: /Check for Updates/i })).toBeInTheDocument();
  });

  it('changes the global permission mode used by new sessions', async () => {
    const onApprovalModeChange = vi.fn();
    const user = userEvent.setup();
    await renderWithAct(
      <GeneralTab {...defaultProps} onApprovalModeChange={onApprovalModeChange} />,
    );

    await user.click(screen.getByRole('combobox', { name: /Default permission mode/i }));
    await user.click(screen.getByRole('option', { name: /Read only/i }));

    expect(onApprovalModeChange).toHaveBeenCalledWith('readonly');
  });

  it('records the check time only when the update check succeeds', async () => {
    const onRecordUpdateCheck = vi.fn();
    vi.mocked(updaterApi.checkForUpdates).mockResolvedValueOnce(false);
    await renderWithAct(
      <GeneralTab {...defaultProps} onRecordUpdateCheck={onRecordUpdateCheck} />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Check for Updates/i }));
    });
    expect(onRecordUpdateCheck).not.toHaveBeenCalled();

    vi.mocked(updaterApi.checkForUpdates).mockResolvedValueOnce(true);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Check for Updates/i }));
    });
    expect(onRecordUpdateCheck).toHaveBeenCalledTimes(1);
  });

  it('localizes the packaged missing-feed error', async () => {
    await renderWithAct(
      <GeneralTab {...defaultProps} updateError={MISSING_UPDATE_FEED_ERROR} />,
    );

    expect(screen.getByText(/This build has no automatic update feed/)).toBeInTheDocument();
  });

  it('renders Download button and version info when an update is available', async () => {
    await renderWithAct(
      <I18nextProvider i18n={i18n}>
        <GeneralTab
          {...defaultProps}
          updateStatus="available"
          updateInfo={{ currentVersion: '0.0.1', version: '0.0.2', body: 'Bug fixes' }}
        />
      </I18nextProvider>,
    );

    expect(screen.getByRole('button', { name: /Download/i })).toBeInTheDocument();
    expect(screen.getByText('Comate 0.0.2 is available')).toBeInTheDocument();
    expect(screen.getByText('Bug fixes')).toBeInTheDocument();
  });

  it('calls downloadAndInstallUpdate when Download is clicked', async () => {
    await renderWithAct(
      <I18nextProvider i18n={i18n}>
        <GeneralTab
          {...defaultProps}
          updateStatus="available"
          updateInfo={{ currentVersion: '0.0.1', version: '0.0.2' }}
        />
      </I18nextProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Download/i }));
      await Promise.resolve();
    });

    expect(updaterApi.downloadAndInstallUpdate).toHaveBeenCalled();
  });

  it('renders progress bar and percentage while downloading', async () => {
    await renderWithAct(
      <I18nextProvider i18n={i18n}>
        <GeneralTab {...defaultProps} updateStatus="downloading" downloadProgress={42} />
      </I18nextProvider>,
    );

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');
    expect(screen.getByText('42%')).toBeInTheDocument();
  });

  it('renders Install & Restart and Later buttons when ready', async () => {
    await renderWithAct(
      <I18nextProvider i18n={i18n}>
        <GeneralTab
          {...defaultProps}
          updateStatus="ready"
          updateInfo={{ currentVersion: '0.0.1', version: '0.0.2' }}
        />
      </I18nextProvider>,
    );

    expect(screen.getByRole('button', { name: /Install & Restart/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Later/i })).toBeInTheDocument();
  });

  it('calls restartToUpdate when Install & Restart is clicked', async () => {
    await renderWithAct(
      <I18nextProvider i18n={i18n}>
        <GeneralTab
          {...defaultProps}
          updateStatus="ready"
          updateInfo={{ currentVersion: '0.0.1', version: '0.0.2' }}
        />
      </I18nextProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Install & Restart/i }));
      await Promise.resolve();
    });

    expect(updaterApi.restartToUpdate).toHaveBeenCalled();
  });

  it('calls dismissUpdate when Later is clicked', async () => {
    await renderWithAct(
      <I18nextProvider i18n={i18n}>
        <GeneralTab
          {...defaultProps}
          updateStatus="ready"
          updateInfo={{ currentVersion: '0.0.1', version: '0.0.2' }}
        />
      </I18nextProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Later/i }));
      await Promise.resolve();
    });

    expect(updaterApi.dismissUpdate).toHaveBeenCalled();
  });

  it('renders the notification sound volume slider and calls the change handler', async () => {
    const onNotificationSoundsVolumeChange = vi.fn();
    await renderWithAct(
      <I18nextProvider i18n={i18n}>
        <GeneralTab
          {...defaultProps}
          notificationSounds={true}
          notificationSoundsVolume={50}
          onNotificationSoundsVolumeChange={onNotificationSoundsVolumeChange}
        />
      </I18nextProvider>,
    );

    const slider = screen.getByRole('slider', { name: /Notification sound volume/i }) as HTMLInputElement;
    expect(slider.value).toBe('50');
    expect(slider.disabled).toBe(false);

    await act(async () => {
      fireEvent.change(slider, { target: { value: '75' } });
    });

    expect(onNotificationSoundsVolumeChange).toHaveBeenCalledWith(75);
  });

  it('disables the volume slider when notification sounds are off', async () => {
    await renderWithAct(
      <I18nextProvider i18n={i18n}>
        <GeneralTab
          {...defaultProps}
          notificationSounds={false}
          notificationSoundsVolume={50}
        />
      </I18nextProvider>,
    );

    const slider = screen.getByRole('slider', { name: /Notification sound volume/i }) as HTMLInputElement;
    expect(slider.disabled).toBe(true);
  });

  it('keeps the insecure certificates toggle at the same width as other toggles', async () => {
    await renderWithAct(
      <I18nextProvider i18n={i18n}>
        <GeneralTab {...defaultProps} />
      </I18nextProvider>,
    );

    const label = screen.getByText('Allow insecure certificates in embedded browser');
    const toggle = label.parentElement?.parentElement?.querySelector('button');

    expect(toggle).toHaveClass('shrink-0');
  });

  it('renders the local footer with disabled actions when not dirty', async () => {
    await renderWithAct(
      <I18nextProvider i18n={i18n}>
        <GeneralTab {...defaultProps} isDirty={false} />
      </I18nextProvider>,
    );
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeDisabled();
  });

  it('renders the local Save/Cancel footer when dirty', async () => {
    await renderWithAct(
      <I18nextProvider i18n={i18n}>
        <GeneralTab {...defaultProps} isDirty />
      </I18nextProvider>,
    );
    expect(screen.getByRole('button', { name: /Save/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument();
  });

  it('calls onSave and onCancel from the local footer', async () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    await renderWithAct(
      <I18nextProvider i18n={i18n}>
        <GeneralTab {...defaultProps} isDirty onSave={onSave} onCancel={onCancel} />
      </I18nextProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save/i }));
      fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
      await Promise.resolve();
    });

    expect(onSave).toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it('disables footer actions and shows a spinner while saving', async () => {
    await renderWithAct(
      <I18nextProvider i18n={i18n}>
        <GeneralTab {...defaultProps} isDirty isSaving />
      </I18nextProvider>,
    );
    expect(screen.getByText('Saving...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Saving\.\.\./i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeDisabled();
  });

  it('renders an error message in the footer when error is provided', async () => {
    await renderWithAct(
      <I18nextProvider i18n={i18n}>
        <GeneralTab {...defaultProps} isDirty error="Something failed" />
      </I18nextProvider>,
    );
    expect(screen.getByText('Something failed')).toBeInTheDocument();
  });
});
