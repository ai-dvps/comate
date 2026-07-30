import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next'
import Sidebar from './Sidebar';
import i18n from '../i18n';

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

const mockStore = {
  activeWorkspaceId: 'ws-1',
};

vi.mock('../stores/workspace-store', () => ({
  useWorkspaceStore: (selector?: (state: typeof mockStore) => unknown) =>
    selector ? selector(mockStore) : mockStore,
}));

vi.mock('./SessionList', () => ({
  default: () => <div data-testid="session-list">SessionList</div>,
}));

describe('Sidebar', () => {
  beforeEach(() => {
    cleanup();
  });

  // R1: the workspace-sidebar Todos tab was removed — Todos are now a top-level
  // panel. Only the Sessions tab remains in the sidebar.
  it('renders only the Sessions tab (no Todos tab — R1)', () => {
    renderWithI18n(
      <Sidebar
        width={240}
        onWidthChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Sessions' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Todos' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Files' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Queue' })).not.toBeInTheDocument();
  });

  it('shows the resize handle when expanded and hides it when collapsed', () => {
    const { rerender } = renderWithI18n(
      <Sidebar
        width={240}
        onWidthChange={vi.fn()}
        isCollapsed={false}
      />,
    );

    expect(screen.getByTestId('sidebar-resize-handle')).toBeInTheDocument();

    rerender(
      <I18nextProvider i18n={i18n}>
        <Sidebar
          width={0}
          onWidthChange={vi.fn()}
          isCollapsed={true}
        />
      </I18nextProvider>,
    );

    expect(screen.queryByTestId('sidebar-resize-handle')).not.toBeInTheDocument();
  });

  it('hides all sidebar content when collapsed', () => {
    renderWithI18n(
      <Sidebar
        width={0}
        onWidthChange={vi.fn()}
        isCollapsed={true}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Sessions' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('session-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-resize-handle')).not.toBeInTheDocument();
  });

  it('defaults to the Sessions tab active', () => {
    renderWithI18n(
      <Sidebar
        width={240}
        onWidthChange={vi.fn()}
        isCollapsed={false}
      />,
    );

    expect(screen.getByRole('button', { name: 'Sessions' })).toHaveClass('border-b');
  });
});
