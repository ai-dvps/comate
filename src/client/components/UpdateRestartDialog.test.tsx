import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import UpdateRestartDialog from './UpdateRestartDialog';
import i18n from '../i18n';
import { useUpdaterStore } from '../stores/updater-store';
import * as updaterApi from '../lib/updater-api';

vi.mock('../lib/updater-api', async () => {
  const actual = await vi.importActual<typeof import('../lib/updater-api')>('../lib/updater-api');
  return {
    ...actual,
    restartToUpdate: vi.fn(),
    dismissUpdate: vi.fn(),
  };
});

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

describe('UpdateRestartDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    useUpdaterStore.setState({
      status: 'idle',
      update: null,
      downloadProgress: 0,
      error: null,
    });
  });

  it('renders nothing when status is not ready', () => {
    renderWithI18n(<UpdateRestartDialog />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows ready state with version and release body', () => {
    useUpdaterStore.setState({
      status: 'ready',
      update: { currentVersion: '0.0.1', version: '0.0.2', body: 'Bug fixes' },
    });
    renderWithI18n(<UpdateRestartDialog />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Restart now/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Later/i })).toBeInTheDocument();
    expect(screen.getByText('Bug fixes')).toBeInTheDocument();
  });

  it('calls restartToUpdate when Restart now is clicked', async () => {
    useUpdaterStore.setState({
      status: 'ready',
      update: { currentVersion: '0.0.1', version: '0.0.2' },
    });
    renderWithI18n(<UpdateRestartDialog />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Restart now/i }));
      await Promise.resolve();
    });

    expect(updaterApi.restartToUpdate).toHaveBeenCalled();
  });

  it('calls dismissUpdate when Later is clicked', async () => {
    useUpdaterStore.setState({
      status: 'ready',
      update: { currentVersion: '0.0.1', version: '0.0.2' },
    });
    renderWithI18n(<UpdateRestartDialog />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Later/i }));
      await Promise.resolve();
    });

    expect(updaterApi.dismissUpdate).toHaveBeenCalled();
  });
});
