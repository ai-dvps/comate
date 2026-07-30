import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import userEvent from '@testing-library/user-event';
import TodoDetail from './TodoDetail';
import { useWorkspaceStore } from '../../stores/workspace-store';
import i18n from '../../i18n';
import type { Todo } from '../../stores/todo-store';
import { openSessionDirect } from '../../lib/session-jump';

vi.mock('../CodeMirrorEditor', () => ({
  default: function CodeMirrorEditorMock({
    value,
    onChange,
    onBlur,
  }: {
    value?: string;
    onChange?: (value: string) => void;
    onBlur?: () => void;
  }) {
    return (
      <textarea
        data-testid="code-mirror-editor"
        value={value ?? ''}
        onChange={(e) => onChange?.(e.target.value)}
        onBlur={onBlur}
      />
    );
  },
}));

vi.mock('../MarkdownPreview', () => ({
  default: function MarkdownPreviewMock({ content }: { content: string }) {
    return <div data-testid="markdown-preview">{content}</div>;
  },
}));

vi.mock('../../lib/session-jump', () => ({
  openSessionDirect: vi.fn(),
}));

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

function makeTodo(overrides: Partial<Todo> & { text: string }): Todo {
  return {
    id: overrides.id ?? `todo-${overrides.text}`,
    workspaceId: overrides.workspaceId ?? null,
    text: overrides.text,
    content: overrides.content ?? null,
    status: overrides.status ?? 'pending',
    sessionId: overrides.sessionId ?? null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    origin: overrides.origin ?? 'local',
    dueDate: overrides.dueDate ?? null,
    repoFullName: overrides.repoFullName ?? null,
    issueNumber: null,
    remoteSnapshot: null,
    remoteUpdatedAt: null,
    lastSyncedAt: null,
    assignee: null,
    labels: [],
    originDeleted: false,
  };
}

describe('TodoDetail', () => {
  const onResolved = vi.fn();
  const onClose = vi.fn();
  const onUpdateTodo = vi.fn().mockResolvedValue(null);
  const onChangeStatus = vi.fn().mockResolvedValue(undefined);
  const onWidthChange = vi.fn();

  beforeEach(() => {
    useWorkspaceStore.setState({
      workspaces: [
        { id: 'ws-1', name: 'Alpha Workspace', description: '', folderPath: '/a', settings: {}, skills: [], mcpServers: [], hooks: [], createdAt: '', updatedAt: '' },
        { id: 'ws-2', name: 'Beta Workspace', description: '', folderPath: '/b', settings: {}, skills: [], mcpServers: [], hooks: [], createdAt: '', updatedAt: '' },
      ],
      activeWorkspaceId: null,
      openWorkspaceIds: [],
      isLoading: false,
      error: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders the no-selection placeholder', () => {
    renderWithI18n(
      <TodoDetail
        todo={null}
        width={384}
        onWidthChange={onWidthChange}
        onResolved={onResolved}
        onClose={onClose}
        onUpdateTodo={onUpdateTodo}
        onChangeStatus={onChangeStatus}
      />,
    );
    expect(screen.getByText('Select a todo to see details')).toBeInTheDocument();
  });

  it('renders with the given width and exposes a resize handle', () => {
    renderWithI18n(
      <TodoDetail
        todo={makeTodo({ text: 'Buy milk' })}
        width={384}
        onWidthChange={onWidthChange}
        onResolved={onResolved}
        onClose={onClose}
        onUpdateTodo={onUpdateTodo}
        onChangeStatus={onChangeStatus}
      />,
    );
    const aside = screen.getByRole('complementary');
    expect(aside).toHaveStyle({ width: '384px' });
    expect(aside.querySelector('[class*="cursor-col-resize"]')).toBeInTheDocument();
  });

  it('shows the workspace name instead of the raw id', () => {
    renderWithI18n(
      <TodoDetail
        todo={makeTodo({ text: 'Task', workspaceId: 'ws-1' })}
        width={384}
        onWidthChange={onWidthChange}
        onResolved={onResolved}
        onClose={onClose}
        onUpdateTodo={onUpdateTodo}
        onChangeStatus={onChangeStatus}
      />,
    );
    expect(screen.getByText('Alpha Workspace')).toBeInTheDocument();
  });

  it('calls onUpdateTodo when the workspace is changed', async () => {
    const user = userEvent.setup();
    renderWithI18n(
      <TodoDetail
        todo={makeTodo({ text: 'Task', workspaceId: 'ws-1' })}
        width={384}
        onWidthChange={onWidthChange}
        onResolved={onResolved}
        onClose={onClose}
        onUpdateTodo={onUpdateTodo}
        onChangeStatus={onChangeStatus}
      />,
    );
    await user.click(screen.getByRole('combobox', { name: 'Workspace' }));
    await user.click(screen.getByRole('option', { name: 'Beta Workspace' }));
    await waitFor(() => expect(onUpdateTodo).toHaveBeenCalledWith('todo-Task', { workspaceId: 'ws-2' }));
  });

  it('calls onChangeStatus when the status is changed', async () => {
    const user = userEvent.setup();
    renderWithI18n(
      <TodoDetail
        todo={makeTodo({ text: 'Task', status: 'pending' })}
        width={384}
        onWidthChange={onWidthChange}
        onResolved={onResolved}
        onClose={onClose}
        onUpdateTodo={onUpdateTodo}
        onChangeStatus={onChangeStatus}
      />,
    );
    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(screen.getByRole('option', { name: 'Done' }));
    await waitFor(() => expect(onChangeStatus).toHaveBeenCalledWith('todo-Task', 'done'));
  });

  it('toggles between edit and preview body modes', async () => {
    const user = userEvent.setup();
    renderWithI18n(
      <TodoDetail
        todo={makeTodo({ text: 'Task', content: '# Hello' })}
        width={384}
        onWidthChange={onWidthChange}
        onResolved={onResolved}
        onClose={onClose}
        onUpdateTodo={onUpdateTodo}
        onChangeStatus={onChangeStatus}
      />,
    );
    expect(screen.getByTestId('markdown-preview')).toHaveTextContent('# Hello');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByTestId('code-mirror-editor')).toHaveValue('# Hello');
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByTestId('markdown-preview')).toBeInTheDocument();
  });

  it('updates todo content when the editor blurs', async () => {
    const user = userEvent.setup();
    renderWithI18n(
      <TodoDetail
        todo={makeTodo({ text: 'Task', content: 'Initial' })}
        width={384}
        onWidthChange={onWidthChange}
        onResolved={onResolved}
        onClose={onClose}
        onUpdateTodo={onUpdateTodo}
        onChangeStatus={onChangeStatus}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const editor = screen.getByTestId('code-mirror-editor');
    await user.clear(editor);
    await user.type(editor, 'Updated body');
    fireEvent.blur(editor);
    await waitFor(() => expect(onUpdateTodo).toHaveBeenCalledWith('todo-Task', { content: 'Updated body' }));
  });

  it('jumps to the linked session and closes the panel', async () => {
    const user = userEvent.setup();
    renderWithI18n(
      <TodoDetail
        todo={makeTodo({ text: 'Task', workspaceId: 'ws-1', sessionId: 'session-1' })}
        width={384}
        onWidthChange={onWidthChange}
        onResolved={onResolved}
        onClose={onClose}
        onUpdateTodo={onUpdateTodo}
        onChangeStatus={onChangeStatus}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Linked to a session' }));
    expect(openSessionDirect).toHaveBeenCalledWith('ws-1', 'session-1');
    expect(onClose).toHaveBeenCalled();
  });
});
