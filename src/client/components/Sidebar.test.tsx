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

  it('renders the session list when expanded and a workspace is active', () => {
    renderWithI18n(
      <Sidebar
        width={240}
        onWidthChange={vi.fn()}
        isCollapsed={false}
      />,
    );

    expect(screen.getByTestId('session-list')).toBeInTheDocument();
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

    expect(screen.queryByTestId('session-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-resize-handle')).not.toBeInTheDocument();
  });
});
