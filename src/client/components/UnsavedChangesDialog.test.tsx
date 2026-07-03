import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';
import UnsavedChangesDialog from './UnsavedChangesDialog';

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

describe('UnsavedChangesDialog', () => {
  const defaultProps = {
    title: 'Unsaved changes',
    message: 'You have unsaved changes. Save them before closing?',
    onSave: vi.fn(),
    onDiscard: vi.fn(),
    onKeepEditing: vi.fn(),
  };

  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('does not render when closed', () => {
    renderWithI18n(<UnsavedChangesDialog {...defaultProps} isOpen={false} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders title, message, and three actions when open', () => {
    renderWithI18n(<UnsavedChangesDialog {...defaultProps} isOpen />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(screen.getByText('You have unsaved changes. Save them before closing?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Keep editing/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Discard/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save changes/i })).toBeInTheDocument();
  });

  it('calls onSave when Save changes is clicked', async () => {
    renderWithI18n(<UnsavedChangesDialog {...defaultProps} isOpen />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));
      await Promise.resolve();
    });
    expect(defaultProps.onSave).toHaveBeenCalled();
  });

  it('calls onDiscard when Discard is clicked', async () => {
    renderWithI18n(<UnsavedChangesDialog {...defaultProps} isOpen />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Discard/i }));
      await Promise.resolve();
    });
    expect(defaultProps.onDiscard).toHaveBeenCalled();
  });

  it('calls onKeepEditing when Keep editing is clicked', async () => {
    renderWithI18n(<UnsavedChangesDialog {...defaultProps} isOpen />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Keep editing/i }));
      await Promise.resolve();
    });
    expect(defaultProps.onKeepEditing).toHaveBeenCalled();
  });

  it('calls onKeepEditing when Escape is pressed', async () => {
    renderWithI18n(<UnsavedChangesDialog {...defaultProps} isOpen />);
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      await Promise.resolve();
    });
    expect(defaultProps.onKeepEditing).toHaveBeenCalled();
  });

  it('calls onSave when Enter is pressed', async () => {
    renderWithI18n(<UnsavedChangesDialog {...defaultProps} isOpen />);
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });
      await Promise.resolve();
    });
    expect(defaultProps.onSave).toHaveBeenCalled();
  });

  it('disables actions and shows spinner while saving', () => {
    renderWithI18n(<UnsavedChangesDialog {...defaultProps} isOpen isSaving />);
    expect(screen.getByText('Saving...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Saving/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Discard/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Keep editing/i })).toBeDisabled();
  });
});
