import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import DeleteWorkspaceDialog from './DeleteWorkspaceDialog';
import i18n from '../i18n';

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

const DEFAULT_PROPS = {
  workspaceName: 'Production',
  isOpen: true,
  isLoading: false,
  onCancel: vi.fn(),
  onConfirm: vi.fn(),
};

describe('DeleteWorkspaceDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it('renders workspace name in the warning', () => {
    renderWithI18n(<DeleteWorkspaceDialog {...DEFAULT_PROPS} />);
    expect(screen.getByText(/Production/)).toBeInTheDocument();
  });

  it('enables Delete only when the exact workspace name is typed', () => {
    renderWithI18n(<DeleteWorkspaceDialog {...DEFAULT_PROPS} />);

    const input = screen.getByPlaceholderText(/type the workspace name/i);
    const deleteButton = screen.getByRole('button', { name: /delete$/i });

    expect(deleteButton).toBeDisabled();

    fireEvent.change(input, { target: { value: 'Production' } });
    expect(deleteButton).toBeEnabled();
  });

  it('keeps Delete disabled on case mismatch', () => {
    renderWithI18n(<DeleteWorkspaceDialog {...DEFAULT_PROPS} />);

    const input = screen.getByPlaceholderText(/type the workspace name/i);
    fireEvent.change(input, { target: { value: 'production' } });

    expect(screen.getByRole('button', { name: /delete$/i })).toBeDisabled();
  });

  it('trims whitespace before comparing the typed name', () => {
    renderWithI18n(<DeleteWorkspaceDialog {...DEFAULT_PROPS} />);

    const input = screen.getByPlaceholderText(/type the workspace name/i);
    fireEvent.change(input, { target: { value: '  Production  ' } });

    expect(screen.getByRole('button', { name: /delete$/i })).toBeEnabled();
  });

  it('calls onCancel when Cancel is clicked', () => {
    renderWithI18n(<DeleteWorkspaceDialog {...DEFAULT_PROPS} />);

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(DEFAULT_PROPS.onCancel).toHaveBeenCalledTimes(1);
    expect(DEFAULT_PROPS.onConfirm).not.toHaveBeenCalled();
  });

  it('calls onCancel when Escape is pressed', () => {
    renderWithI18n(<DeleteWorkspaceDialog {...DEFAULT_PROPS} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(DEFAULT_PROPS.onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onConfirm when Enter is pressed with a matching name', () => {
    renderWithI18n(<DeleteWorkspaceDialog {...DEFAULT_PROPS} />);

    const input = screen.getByPlaceholderText(/type the workspace name/i);
    fireEvent.change(input, { target: { value: 'Production' } });
    fireEvent.keyDown(document, { key: 'Enter' });

    expect(DEFAULT_PROPS.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('does not call onConfirm when Enter is pressed with a mismatching name', () => {
    renderWithI18n(<DeleteWorkspaceDialog {...DEFAULT_PROPS} />);

    const input = screen.getByPlaceholderText(/type the workspace name/i);
    fireEvent.change(input, { target: { value: 'wrong' } });
    fireEvent.keyDown(document, { key: 'Enter' });

    expect(DEFAULT_PROPS.onConfirm).not.toHaveBeenCalled();
  });

  it('shows loading state on the Delete button', () => {
    renderWithI18n(<DeleteWorkspaceDialog {...DEFAULT_PROPS} isLoading={true} />);

    const deleteButton = screen.getByRole('button', { name: /deleting/i });
    expect(deleteButton).toBeDisabled();
  });

  it('returns null when closed', () => {
    const { container } = renderWithI18n(<DeleteWorkspaceDialog {...DEFAULT_PROPS} isOpen={false} />);
    expect(container.firstChild).toBeNull();
  });
});
