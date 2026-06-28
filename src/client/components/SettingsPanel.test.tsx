import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { GeneralTab } from './SettingsPanel';
import i18n from '../i18n';
import * as updaterApi from '../lib/updater-api';

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
    windowCap: '100',
    onWindowCapChange: vi.fn(),
    onWindowCapCommit: vi.fn(),
    archiveThresholdDays: '14',
    onArchiveThresholdDaysChange: vi.fn(),
    onArchiveThresholdDaysCommit: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it('renders Check for Updates button when idle', async () => {
    await renderWithAct(
      <I18nextProvider i18n={i18n}>
        <GeneralTab {...defaultProps} />
      </I18nextProvider>,
    );

    expect(screen.getByRole('button', { name: /Check for Updates/i })).toBeInTheDocument();
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
});
