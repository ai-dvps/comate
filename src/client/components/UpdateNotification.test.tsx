import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import UpdateNotification from './UpdateNotification';
import i18n from '../i18n';
import { useUpdaterStore } from '../stores/updater-store';
import * as updaterApi from '../lib/updater-api';

vi.mock('../lib/updater-api', async () => {
  const actual = await vi.importActual<typeof import('../lib/updater-api')>('../lib/updater-api');
  return {
    ...actual,
    downloadAndInstallUpdate: vi.fn(),
    dismissUpdate: vi.fn(),
  };
});

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

describe('UpdateNotification', () => {
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

  it('renders nothing when status is idle', () => {
    renderWithI18n(<UpdateNotification />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows checking state', () => {
    useUpdaterStore.setState({ status: 'checking' });
    renderWithI18n(<UpdateNotification />);
    expect(screen.getByText(/Checking for updates/i)).toBeInTheDocument();
  });

  it('shows available state with Download button', () => {
    useUpdaterStore.setState({
      status: 'available',
      update: { currentVersion: '0.0.1', version: '0.0.2' },
    });
    renderWithI18n(<UpdateNotification />);
    expect(screen.getByText('Comate 0.0.2 is available')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download/i })).toBeInTheDocument();
  });

  it('shows downloading state with progress bar', () => {
    useUpdaterStore.setState({ status: 'downloading', downloadProgress: 37 });
    renderWithI18n(<UpdateNotification />);
    expect(screen.getByText(/Downloading update/i)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '37');
  });

  it('calls downloadAndInstallUpdate when Download is clicked', async () => {
    useUpdaterStore.setState({
      status: 'available',
      update: { currentVersion: '0.0.1', version: '0.0.2' },
    });
    renderWithI18n(<UpdateNotification />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Download/i }));
      await Promise.resolve();
    });

    expect(updaterApi.downloadAndInstallUpdate).toHaveBeenCalled();
  });

  it('calls dismissUpdate when close is clicked', async () => {
    useUpdaterStore.setState({
      status: 'available',
      update: { currentVersion: '0.0.1', version: '0.0.2' },
    });
    renderWithI18n(<UpdateNotification />);

    await act(async () => {
      fireEvent.click(screen.getByLabelText(/Close/i));
      await Promise.resolve();
    });

    expect(updaterApi.dismissUpdate).toHaveBeenCalled();
  });
});
