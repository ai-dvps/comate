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

vi.mock('./FileExplorer', () => ({
  default: () => <div data-testid="file-explorer">FileExplorer</div>,
}));

describe('Sidebar', () => {
  beforeEach(() => {
    cleanup();
  });

  it('renders exactly three tabs: Sessions, Todos, and Files', () => {
    renderWithI18n(
      <Sidebar
        width={240}
        onWidthChange={vi.fn()}
        onFileClick={vi.fn()}
        onFileDoubleClick={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Sessions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Todos' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Files' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Queue' })).not.toBeInTheDocument();
  });

  it('shows the resize handle when expanded and hides it when collapsed', () => {
    const { rerender } = renderWithI18n(
      <Sidebar
        width={240}
        onWidthChange={vi.fn()}
        onFileClick={vi.fn()}
        onFileDoubleClick={vi.fn()}
        isCollapsed={false}
      />,
    );

    expect(screen.getByTestId('sidebar-resize-handle')).toBeInTheDocument();

    rerender(
      <I18nextProvider i18n={i18n}>
        <Sidebar
          width={48}
          onWidthChange={vi.fn()}
          onFileClick={vi.fn()}
          onFileDoubleClick={vi.fn()}
          isCollapsed={true}
        />
      </I18nextProvider>,
    );

    expect(screen.queryByTestId('sidebar-resize-handle')).not.toBeInTheDocument();
  });

  it('renders three icon buttons and an expand button when collapsed', () => {
    renderWithI18n(
      <Sidebar
        width={48}
        onWidthChange={vi.fn()}
        onFileClick={vi.fn()}
        onFileDoubleClick={vi.fn()}
        isCollapsed={true}
      />,
    );

    expect(screen.getByRole('button', { name: 'Show sessions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show todos' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show files' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: 'Sessions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Todos' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Files' })).not.toBeInTheDocument();
  });

  it('switches the active tab from a collapsed icon without expanding', () => {
    const onToggleCollapse = vi.fn();
    const { rerender } = renderWithI18n(
      <Sidebar
        width={48}
        onWidthChange={vi.fn()}
        onFileClick={vi.fn()}
        onFileDoubleClick={vi.fn()}
        isCollapsed={true}
        onToggleCollapse={onToggleCollapse}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show files' }));

    expect(onToggleCollapse).not.toHaveBeenCalled();

    rerender(
      <I18nextProvider i18n={i18n}>
        <Sidebar
          width={240}
          onWidthChange={vi.fn()}
          onFileClick={vi.fn()}
          onFileDoubleClick={vi.fn()}
          isCollapsed={false}
          onToggleCollapse={onToggleCollapse}
        />
      </I18nextProvider>,
    );

    expect(screen.getByRole('button', { name: 'Files' })).toHaveClass('border-b-2');
    expect(screen.getByRole('button', { name: 'Sessions' })).not.toHaveClass('border-b-2');
    expect(screen.getByRole('button', { name: 'Todos' })).not.toHaveClass('border-b-2');
  });

  it('calls onToggleCollapse when the expand button is clicked', () => {
    const onToggleCollapse = vi.fn();
    renderWithI18n(
      <Sidebar
        width={48}
        onWidthChange={vi.fn()}
        onFileClick={vi.fn()}
        onFileDoubleClick={vi.fn()}
        isCollapsed={true}
        onToggleCollapse={onToggleCollapse}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));

    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it('calls onToggleCollapse when the collapse button is clicked in expanded state', () => {
    const onToggleCollapse = vi.fn();
    renderWithI18n(
      <Sidebar
        width={240}
        onWidthChange={vi.fn()}
        onFileClick={vi.fn()}
        onFileDoubleClick={vi.fn()}
        isCollapsed={false}
        onToggleCollapse={onToggleCollapse}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));

    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it('switches between sessions, todos, and files in both expanded and collapsed states', () => {
    const { rerender } = renderWithI18n(
      <Sidebar
        width={240}
        onWidthChange={vi.fn()}
        onFileClick={vi.fn()}
        onFileDoubleClick={vi.fn()}
        isCollapsed={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Todos' }));
    expect(screen.getByRole('button', { name: 'Todos' })).toHaveClass('border-b-2');

    rerender(
      <I18nextProvider i18n={i18n}>
        <Sidebar
          width={48}
          onWidthChange={vi.fn()}
          onFileClick={vi.fn()}
          onFileDoubleClick={vi.fn()}
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
          onFileClick={vi.fn()}
          onFileDoubleClick={vi.fn()}
          isCollapsed={false}
        />
      </I18nextProvider>,
    );

    expect(screen.getByRole('button', { name: 'Sessions' })).toHaveClass('border-b-2');
    expect(screen.getByRole('button', { name: 'Todos' })).not.toHaveClass('border-b-2');
    expect(screen.getByRole('button', { name: 'Files' })).not.toHaveClass('border-b-2');
  });
});
