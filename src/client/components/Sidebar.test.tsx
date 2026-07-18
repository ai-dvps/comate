import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
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

vi.mock('./TodoList', () => ({
  default: () => <div data-testid="todo-list">TodoList</div>,
}));


describe('Sidebar', () => {
  beforeEach(() => {
    cleanup();
  });

  it('renders exactly two tabs: Sessions and Todos', () => {
    renderWithI18n(
      <Sidebar
        width={240}
        onWidthChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Sessions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Todos' })).toBeInTheDocument();
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
          width={48}
          onWidthChange={vi.fn()}
          isCollapsed={true}
        />
      </I18nextProvider>,
    );

    expect(screen.queryByTestId('sidebar-resize-handle')).not.toBeInTheDocument();
  });

  it('renders two icon buttons when collapsed', () => {
    renderWithI18n(
      <Sidebar
        width={48}
        onWidthChange={vi.fn()}
        isCollapsed={true}
      />,
    );

    expect(screen.getByRole('button', { name: 'Show sessions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show todos' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show files' })).not.toBeInTheDocument();

    expect(screen.queryByRole('button', { name: 'Sessions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Todos' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Files' })).not.toBeInTheDocument();
  });

  it('switches between sessions and todos in both expanded and collapsed states', () => {
    const { rerender } = renderWithI18n(
      <Sidebar
        width={240}
        onWidthChange={vi.fn()}
        isCollapsed={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Todos' }));
    expect(screen.getByRole('button', { name: 'Todos' })).toHaveClass('border-b');

    rerender(
      <I18nextProvider i18n={i18n}>
        <Sidebar
          width={48}
          onWidthChange={vi.fn()}
          isCollapsed={true}
        />
      </I18nextProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show sessions' }));

    rerender(
      <I18nextProvider i18n={i18n}>
        <Sidebar
          width={240}
          onWidthChange={vi.fn()}
          isCollapsed={false}
        />
      </I18nextProvider>,
    );

    expect(screen.getByRole('button', { name: 'Sessions' })).toHaveClass('border-b');
    expect(screen.getByRole('button', { name: 'Todos' })).not.toHaveClass('border-b-2');
  });

  it('expands the sidebar when clicking an icon in collapsed state', () => {
    const toggleCollapse = vi.fn();
    renderWithI18n(
      <Sidebar
        width={48}
        onWidthChange={vi.fn()}
        isCollapsed={true}
        onToggleCollapse={toggleCollapse}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show todos' }));
    expect(toggleCollapse).toHaveBeenCalledTimes(1);
  });
});
