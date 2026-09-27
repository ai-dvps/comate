import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import userEvent from '@testing-library/user-event';
import TodosPanel from './TodosPanel';
import { useTodoStore, type Todo } from '../stores/todo-store';
import { useGithubStore } from '../stores/github-store';
import i18n from '../i18n';
import en from '../i18n/en/todos.json';
import zh from '../i18n/zh-CN/todos.json';

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

function todoList() {
  return screen.getByRole('region', { name: 'Todos' });
}

function makeTodo(overrides: Partial<Todo> & { text: string }): Todo {
  return {
    id: overrides.id ?? `todo-${overrides.text}`,
    workspaceId: null,
    text: overrides.text,
    content: null,
    status: overrides.status ?? 'pending',
    executionType: overrides.executionType ?? 'manual',
    latestRun: overrides.latestRun ?? null,
    sessionId: null,
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
    labels: overrides.labels ?? [],
    originDeleted: false,
  };
}

function stubFetchEmpty(connected = false) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/todos') return { ok: true, json: async () => ({ todos: [] }) } as unknown as Response;
      if (url === '/api/github/connection')
        return { ok: true, json: async () => ({ connection: { connected } }) } as unknown as Response;
      if (url === '/api/todos/sync')
        return { ok: true, json: async () => ({ sync: { errors: [] } }) } as unknown as Response;
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }),
  );
}

function stubFetchWithTodos(todos: Todo[], connected = false) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/todos' && init?.method !== 'POST') {
        return { ok: true, json: async () => ({ todos }) } as unknown as Response;
      }
      if (url === '/api/github/connection')
        return { ok: true, json: async () => ({ connection: { connected } }) } as unknown as Response;
      if (url === '/api/todos/sync')
        return { ok: true, json: async () => ({ sync: { errors: [] } }) } as unknown as Response;
      if (url === '/api/todos' && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        return { ok: true, json: async () => ({ todo: makeTodo({ text: body.text, id: `new-${body.text}` }) }) } as unknown as Response;
      }
      if (url.startsWith('/api/todos/') && init?.method === 'PUT') {
        const id = url.split('/').pop();
        const body = JSON.parse(init.body as string);
        const todo = todos.find((t) => t.id === id);
        return { ok: true, json: async () => ({ todo: todo ? { ...todo, ...body } : null }) } as unknown as Response;
      }
      if (url.startsWith('/api/todos/') && init?.method === 'DELETE') {
        return { ok: true, json: async () => ({}) } as unknown as Response;
      }
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }),
  );
}

function stubFetchError(message = 'Network error') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/todos') throw new Error(message);
      if (url === '/api/github/connection')
        return { ok: true, json: async () => ({ connection: { connected: false } }) } as unknown as Response;
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }),
  );
}

describe('TodosPanel — panel-open sync (AE5 regression)', () => {
  const calls: string[] = [];

  function stubFetch(connected: boolean) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        if (url === '/api/todos' && init?.method !== 'POST') return { ok: true, json: async () => ({ todos: [] }) } as unknown as Response;
        if (url === '/api/github/connection') return { ok: true, json: async () => ({ connection: { connected, tokenType: connected ? 'pat' : null, expiresAt: null, login: null } }) } as unknown as Response;
        if (url === '/api/todos/sync') return { ok: true, json: async () => ({ sync: { upserted: 0, pulled: 0, conflicts: 0, deletedDetected: 0, errors: [] } }) } as unknown as Response;
        return { ok: true, json: async () => ({}) } as unknown as Response;
      }),
    );
  }

  beforeEach(() => {
    calls.length = 0;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useTodoStore.setState({ todos: [], isSyncing: false, error: null, searchQuery: '' });
    useGithubStore.setState({ connection: null });
  });

  it('triggers POST /api/todos/sync on mount when connected (AE5)', async () => {
    stubFetch(true);
    renderWithI18n(<TodosPanel isOpen onClose={vi.fn()} />);
    await waitFor(() => {
      expect(calls).toContain('POST /api/todos/sync');
    });
  });

  it('does not trigger sync on mount when not connected', async () => {
    stubFetch(false);
    renderWithI18n(<TodosPanel isOpen onClose={vi.fn()} />);
    await waitFor(() => expect(calls).toContain('GET /api/todos'));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).not.toContain('POST /api/todos/sync');
    expect(screen.getByRole('button', { name: 'GitHub' })).toBeInTheDocument();
  });
});

describe('TodosPanel — full-screen overlay (U1 regression)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useTodoStore.setState({ todos: [], isSyncing: false, error: null, searchQuery: '' });
    useGithubStore.setState({ connection: null });
  });

  it('renders the fixed overlay below the app header with a dimmed backdrop', () => {
    stubFetchEmpty();
    const { container } = renderWithI18n(<TodosPanel isOpen onClose={vi.fn()} />);
    const overlay = container.querySelector('.fixed.z-50');
    expect(overlay).not.toBeNull();
    expect(overlay).toHaveClass('top-11', 'bottom-0');
    expect(container.querySelector('[class*="bg-overlay"]')).not.toBeNull();
  });

  it('calls onClose when the backdrop is clicked', () => {
    stubFetchEmpty();
    const onClose = vi.fn();
    const { container } = renderWithI18n(<TodosPanel isOpen onClose={onClose} />);
    fireEvent.click(container.querySelector('[class*="bg-overlay"]')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Escape is pressed outside text inputs', () => {
    stubFetchEmpty();
    const onClose = vi.fn();
    renderWithI18n(<TodosPanel isOpen onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close when clicking inside the panel card (paint order)', () => {
    stubFetchEmpty();
    const onClose = vi.fn();
    const { container } = renderWithI18n(<TodosPanel isOpen onClose={onClose} />);
    fireEvent.click(container.querySelector('[class*="shadow-2xl"]')!);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('TodosPanel — header restructure and rail removal (U1)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useTodoStore.setState({ todos: [], isSyncing: false, error: null, searchQuery: '' });
    useGithubStore.setState({ connection: null });
  });

  it('renders four view segments with counts and switching updates the list', async () => {
    const todos = [
      makeTodo({ id: 'a', text: 'Alpha' }),
      makeTodo({ id: 'b', text: 'Beta', dueDate: new Date(Date.now() + 86400000).toISOString() }),
      makeTodo({ id: 'c', text: 'Gamma', dueDate: new Date().toISOString() }),
    ];
    stubFetchWithTodos(todos);
    renderWithI18n(<TodosPanel isOpen onClose={vi.fn()} />);

    await waitFor(() => expect(within(todoList()).getByText('Alpha')).toBeInTheDocument());

    const tabs = within(screen.getByRole('tablist', { name: 'Views' })).getAllByRole('tab');
    expect(tabs).toHaveLength(4);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[0]).toHaveTextContent('Inbox');
    expect(tabs[0]).toHaveTextContent('1');
    expect(tabs[1]).toHaveTextContent('Today');
    expect(tabs[1]).toHaveTextContent('1');
    expect(tabs[2]).toHaveTextContent('Upcoming');
    expect(tabs[2]).toHaveTextContent('1');
    expect(tabs[3]).toHaveTextContent('All');
    expect(tabs[3]).toHaveTextContent('3');

    fireEvent.click(tabs[3]!);
    await waitFor(() => expect(within(todoList()).getAllByText(/Alpha|Beta|Gamma/)).toHaveLength(3));
  });

  it('selects the first Todo in the active view when the panel opens', async () => {
    const todos = [
      makeTodo({ id: 'first', text: 'First Todo' }),
      makeTodo({ id: 'second', text: 'Second Todo' }),
    ];
    stubFetchWithTodos(todos);
    renderWithI18n(<TodosPanel isOpen onClose={vi.fn()} />);

    await waitFor(() => {
      const detail = screen.getByRole('complementary');
      expect(within(detail).getByRole('heading', { name: 'First Todo' })).toBeInTheDocument();
    });
  });

  it('keeps quick add outside the scrolling Todo list', async () => {
    stubFetchWithTodos([makeTodo({ id: 'first', text: 'First Todo' })]);
    renderWithI18n(<TodosPanel isOpen onClose={vi.fn()} />);

    await waitFor(() => expect(within(todoList()).getByText('First Todo')).toBeInTheDocument());
    expect(todoList()).not.toContainElement(screen.getByPlaceholderText('Add a todo…'));
    expect(todoList()).toHaveClass('overflow-y-auto');
  });

  it('shows Today and Upcoming counts of 0 when no todos have due dates (AE2)', async () => {
    const todos = [makeTodo({ id: 'a', text: 'Alpha' })];
    stubFetchWithTodos(todos);
    renderWithI18n(<TodosPanel isOpen onClose={vi.fn()} />);

    await waitFor(() => expect(within(todoList()).getByText('Alpha')).toBeInTheDocument());

    const tabs = within(screen.getByRole('tablist', { name: 'Views' })).getAllByRole('tab');
    expect(tabs[1]).toHaveTextContent('0');
    expect(tabs[2]).toHaveTextContent('0');
    fireEvent.click(tabs[1]!);
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
  });

  it('retains sync, GitHub connect, and close buttons in the header', async () => {
    stubFetchEmpty();
    renderWithI18n(<TodosPanel isOpen onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sync now' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'GitHub' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('switches grouping via the header group-by select', async () => {
    const todos = [
      makeTodo({ id: 'a', text: 'Alpha', origin: 'local' }),
      makeTodo({ id: 'b', text: 'Beta', origin: 'github' }),
    ];
    stubFetchWithTodos(todos);
    renderWithI18n(<TodosPanel isOpen onClose={vi.fn()} />);

    await waitFor(() => expect(within(todoList()).getByText('Alpha')).toBeInTheDocument());

    const groupTrigger = screen.getByLabelText('Group by');
    await userEvent.click(groupTrigger);
    const originOption = await screen.findByRole('option', { name: 'Origin' });
    await userEvent.click(originOption);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Local' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'GitHub' })).toBeInTheDocument();
    });
  });
});

describe('TodosPanel — search behavior and lifecycle (U2)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useTodoStore.setState({ todos: [], isSyncing: false, error: null, searchQuery: '' });
    useGithubStore.setState({ connection: null });
  });

  it('filters the list by title within the active view', async () => {
    const todos = [makeTodo({ id: 'a', text: 'Fix bug' }), makeTodo({ id: 'b', text: 'Write docs' })];
    stubFetchWithTodos(todos);
    renderWithI18n(<TodosPanel isOpen onClose={vi.fn()} />);

    await waitFor(() => expect(within(todoList()).getByText('Fix bug')).toBeInTheDocument());

    const searchInput = screen.getByPlaceholderText('Search todos…');
    await userEvent.type(searchInput, 'bug');

    await waitFor(() => {
      expect(within(todoList()).getByText('Fix bug')).toBeInTheDocument();
      expect(within(todoList()).queryByText('Write docs')).not.toBeInTheDocument();
    });
  });

  it('clears search on Escape first, blurs on second Escape (AE4)', async () => {
    stubFetchWithTodos([makeTodo({ id: 'a', text: 'Fix bug' })]);
    renderWithI18n(<TodosPanel isOpen onClose={vi.fn()} />);

    await waitFor(() => expect(within(todoList()).getByText('Fix bug')).toBeInTheDocument());

    const searchInput = screen.getByPlaceholderText('Search todos…');
    await userEvent.type(searchInput, 'bug');
    await waitFor(() => expect(searchInput).toHaveValue('bug'));

    fireEvent.keyDown(searchInput, { key: 'Escape' });
    expect(searchInput).toHaveValue('');
    expect(document.activeElement).toBe(searchInput);

    fireEvent.keyDown(searchInput, { key: 'Escape' });
    expect(document.activeElement).not.toBe(searchInput);
  });

  it('does not close the panel when Escape is pressed inside the search input', async () => {
    stubFetchWithTodos([makeTodo({ id: 'a', text: 'Fix bug' })]);
    const onClose = vi.fn();
    renderWithI18n(<TodosPanel isOpen onClose={onClose} />);

    await waitFor(() => expect(within(todoList()).getByText('Fix bug')).toBeInTheDocument());

    const searchInput = screen.getByPlaceholderText('Search todos…');
    await userEvent.type(searchInput, 'bug');
    fireEvent.keyDown(searchInput, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('resets the search query on panel open and persists across view switches (AE5)', async () => {
    useTodoStore.setState({ searchQuery: 'saved' });
    stubFetchWithTodos([makeTodo({ id: 'a', text: 'Fix bug' }), makeTodo({ id: 'b', text: 'Write docs' })]);
    renderWithI18n(<TodosPanel isOpen onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByPlaceholderText('Search todos…')).toHaveValue(''));

    const searchInput = screen.getByPlaceholderText('Search todos…');
    await userEvent.type(searchInput, 'bug');

    const allTab = screen.getByRole('tab', { name: /All/ });
    fireEvent.click(allTab);

    await waitFor(() => expect(searchInput).toHaveValue('bug'));
  });

  it('clears search when quick-add creates a todo that would be hidden (AE6)', async () => {
    stubFetchWithTodos([makeTodo({ id: 'a', text: 'Fix bug' })]);
    renderWithI18n(<TodosPanel isOpen onClose={vi.fn()} />);

    await waitFor(() => expect(within(todoList()).getByText('Fix bug')).toBeInTheDocument());

    const searchInput = screen.getByPlaceholderText('Search todos…');
    await userEvent.type(searchInput, 'xyz');
    await waitFor(() => expect(within(todoList()).queryByText('Fix bug')).not.toBeInTheDocument());

    const quickAdd = screen.getByPlaceholderText('Add a todo…');
    await userEvent.type(quickAdd, 'New task');
    const addButton = screen.getByRole('button', { name: 'Add' });
    await userEvent.click(addButton);

    await waitFor(() => {
      expect(searchInput).toHaveValue('');
      expect(within(todoList()).getByText('New task')).toBeInTheDocument();
    });
  });
});

describe('TodosPanel — enriched todo rows (U3)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useTodoStore.setState({ todos: [], isSyncing: false, error: null, searchQuery: '' });
    useGithubStore.setState({ connection: null });
  });

  it('renders due date, labels, and origin badges for a GitHub todo (AE1)', async () => {
    const todo = makeTodo({
      id: 'gh',
      text: 'Issue title',
      origin: 'github',
      dueDate: '2026-07-31T00:00:00Z',
      labels: ['bug', 'urgent'],
    });
    stubFetchWithTodos([todo]);
    renderWithI18n(<TodosPanel isOpen onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole('tab', { name: /All/ })).toBeInTheDocument());
    const allTab = screen.getByRole('tab', { name: /All/ });
    fireEvent.click(allTab);

    await waitFor(() => expect(within(todoList()).getByText('Issue title')).toBeInTheDocument());

    const row = within(todoList()).getByText('Issue title').closest('li') as HTMLElement;
    const rowScope = within(row);
    expect(rowScope.getByText('2026-07-31')).toBeInTheDocument();
    expect(rowScope.getByText('bug')).toBeInTheDocument();
    expect(rowScope.getByText('urgent')).toBeInTheDocument();
    expect(rowScope.getByText('GitHub')).toBeInTheDocument();
  });

  it('renders no badges for a bare local todo (AE1 edge)', async () => {
    stubFetchWithTodos([makeTodo({ id: 'local', text: 'Simple task' })]);
    renderWithI18n(<TodosPanel isOpen onClose={vi.fn()} />);

    await waitFor(() => expect(within(todoList()).getByText('Simple task')).toBeInTheDocument());

    const row = within(todoList()).getByText('Simple task').closest('li') as HTMLElement;
    const rowScope = within(row);
    expect(rowScope.queryByText(/\d{4}-/)).not.toBeInTheDocument();
    expect(rowScope.queryByText('GitHub')).not.toBeInTheDocument();
    expect(rowScope.queryByLabelText('Manual')).not.toBeInTheDocument();
  });

  it('shows the execution type and latest execution status (AE1)', async () => {
    const todo = makeTodo({
      id: 'recurring-failed',
      text: 'Refresh reports',
      executionType: 'recurring',
      latestRun: { status: 'failed', fireAt: '2026-08-01T01:30:00.000Z' },
    });
    stubFetchWithTodos([todo]);
    renderWithI18n(<TodosPanel isOpen onClose={vi.fn()} />);

    await waitFor(() => expect(within(todoList()).getByText('Refresh reports')).toBeInTheDocument());

    const row = within(todoList()).getByText('Refresh reports').closest('li') as HTMLElement;
    const rowScope = within(row);
    expect(rowScope.getByLabelText('Recurring')).toBeInTheDocument();
    expect(rowScope.getByText('Failed')).toBeInTheDocument();
    expect(rowScope.getByTitle(/^Latest run: Failed at /)).toBeInTheDocument();
  });

  it('caps labels at two chips and shows +n overflow', async () => {
    const todo = makeTodo({ id: 'labels', text: 'Labelled', labels: ['a', 'b', 'c', 'd'] });
    stubFetchWithTodos([todo]);
    renderWithI18n(<TodosPanel isOpen onClose={vi.fn()} />);

    await waitFor(() => expect(within(todoList()).getByText('Labelled')).toBeInTheDocument());

    expect(within(todoList()).getByText('+2')).toBeInTheDocument();
  });

  it('strikes through done titles and toggles status', async () => {
    const todo = makeTodo({ id: 'toggle', text: 'Toggle me' });
    stubFetchWithTodos([todo]);
    renderWithI18n(<TodosPanel isOpen onClose={vi.fn()} />);

    await waitFor(() => expect(within(todoList()).getByText('Toggle me')).toBeInTheDocument());

    const toggleButton = screen.getByRole('button', { name: 'Toggle complete' });
    expect(toggleButton).toHaveClass('rounded-full');

    await userEvent.click(toggleButton);
    await waitFor(() => expect(useTodoStore.getState().todos[0]?.status).toBe('done'));
  });
});

describe('TodosPanel — todo submission shortcuts', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useTodoStore.setState({ todos: [], isSyncing: false, error: null, searchQuery: '' });
    useGithubStore.setState({ connection: null });
  });

  it.each([
    ['Ctrl', { ctrlKey: true }],
    ['Cmd', { metaKey: true }],
  ])('creates a todo only after %s+Enter', async (_modifier, modifier) => {
    stubFetchWithTodos([]);
    renderWithI18n(<TodosPanel isOpen onClose={vi.fn()} />);

    const quickAdd = screen.getByPlaceholderText('Add a todo…');
    await userEvent.type(quickAdd, 'New task');
    fireEvent.keyDown(quickAdd, { key: 'Enter' });

    expect(useTodoStore.getState().todos).toHaveLength(0);
    expect(quickAdd).toHaveValue('New task');

    fireEvent.keyDown(quickAdd, { key: 'Enter', isComposing: true, ...modifier });

    expect(useTodoStore.getState().todos).toHaveLength(0);
    expect(quickAdd).toHaveValue('New task');

    fireEvent.keyDown(quickAdd, { key: 'Enter', ...modifier });

    await waitFor(() => expect(useTodoStore.getState().todos).toHaveLength(1));
    expect(quickAdd).toHaveValue('');
  });

  it.each([
    ['Ctrl', { ctrlKey: true }],
    ['Cmd', { metaKey: true }],
  ])('saves an edited todo title only after %s+Enter', async (_modifier, modifier) => {
    const todo = makeTodo({ id: 'rename', text: 'Old title' });
    stubFetchWithTodos([todo]);
    renderWithI18n(<TodosPanel isOpen onClose={vi.fn()} />);

    const title = await within(todoList()).findByText('Old title');
    fireEvent.doubleClick(title);
    const editInput = screen.getByRole('textbox', { name: 'Edit title' });
    await userEvent.clear(editInput);
    await userEvent.type(editInput, 'New title');

    fireEvent.keyDown(editInput, { key: 'Enter' });
    expect(editInput).toHaveValue('New title');
    expect(screen.getByRole('textbox', { name: 'Edit title' })).toBeInTheDocument();

    fireEvent.keyDown(editInput, { key: 'Enter', isComposing: true, ...modifier });

    expect(editInput).toHaveValue('New title');
    expect(screen.getByRole('textbox', { name: 'Edit title' })).toBeInTheDocument();

    fireEvent.keyDown(editInput, { key: 'Enter', ...modifier });

    await waitFor(() => expect(within(todoList()).getByText('New title')).toBeInTheDocument());
    expect(screen.queryByRole('textbox', { name: 'Edit title' })).not.toBeInTheDocument();
  });
});

describe('TodosPanel — states, chrome, and i18n (U4)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useTodoStore.setState({ todos: [], isSyncing: false, error: null, searchQuery: '' });
    useGithubStore.setState({ connection: null });
  });

  it('shows the view-empty state when there are no todos', async () => {
    stubFetchEmpty();
    renderWithI18n(<TodosPanel isOpen onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('No todos here.')).toBeInTheDocument());
  });

  it('shows the no-results state with query echo and a clear action', async () => {
    stubFetchWithTodos([makeTodo({ id: 'a', text: 'Fix bug' })]);
    renderWithI18n(<TodosPanel isOpen onClose={vi.fn()} />);

    await waitFor(() => expect(within(todoList()).getByText('Fix bug')).toBeInTheDocument());

    const searchInput = screen.getByPlaceholderText('Search todos…');
    await userEvent.type(searchInput, 'xyz');

    await waitFor(() => expect(screen.getByText(/No todos match/)).toBeInTheDocument());
    expect(screen.getByText(/xyz/)).toBeInTheDocument();
    expect(screen.getByText('Clear search')).toBeInTheDocument();
  });

  it('shows the load-failure state from the store error field', async () => {
    stubFetchError('Server unreachable');
    renderWithI18n(<TodosPanel isOpen onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('Server unreachable')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('keeps the list rendered while refetching (R16)', async () => {
    const existing = makeTodo({ id: 'a', text: 'Existing' });
    stubFetchWithTodos([existing]);
    renderWithI18n(<TodosPanel isOpen onClose={vi.fn()} />);

    await waitFor(() => expect(within(todoList()).getByText('Existing')).toBeInTheDocument());
    useTodoStore.setState({ isLoading: true });
    await waitFor(() => expect(within(todoList()).getByText('Existing')).toBeInTheDocument());
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('has exact en/zh-CN parity for new i18n keys', () => {
    const newKeys = [
      'searchPlaceholder',
      'searchClear',
      'noResults',
      'clearSearch',
      'loadFailed',
      'retry',
      'viewControl',
      'viewCountLabel_one',
      'viewCountLabel_other',
    ];
    for (const key of newKeys) {
      expect(en[key as keyof typeof en], `missing en.${key}`).toBeDefined();
      expect(zh[key as keyof typeof zh], `missing zh-CN.${key}`).toBeDefined();
    }
  });
});
