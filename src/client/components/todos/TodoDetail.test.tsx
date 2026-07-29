import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import TodoDetail from './TodoDetail'
import i18n from '../../i18n'
import type { Todo } from '../../stores/todo-store'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

// vi.mock factories are hoisted, so the fn must be created via vi.hoisted.
const mocks = vi.hoisted(() => ({
  updateTodo: vi.fn(),
}))

vi.mock('../../stores/todo-store', async (importActual) => {
  const actual = await importActual<typeof import('../../stores/todo-store')>()
  return {
    ...actual,
    useTodoStore: (selector?: (s: { updateTodo: typeof mocks.updateTodo }) => unknown) =>
      selector ? selector({ updateTodo: mocks.updateTodo }) : { updateTodo: mocks.updateTodo },
  }
})

vi.mock('../../stores/workspace-store', () => ({
  useWorkspaceStore: (selector?: (s: { workspaces: [] }) => unknown) =>
    selector ? selector({ workspaces: [] }) : { workspaces: [] },
}))

// Stub the editor + preview so toggle behavior is deterministic in jsdom and
// edits surface through the normal onChange path.
vi.mock('../CodeMirrorEditor', () => ({
  default: ({ value, onChange }: { value?: string; onChange?: (v: string) => void }) => (
    <textarea
      data-testid="cm-editor"
      aria-label="content-editor"
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}))

vi.mock('../MarkdownPreview', () => ({
  default: ({ content }: { content: string }) => <div data-testid="md-preview">{content}</div>,
}))

vi.mock('./ConflictReview', () => ({
  default: () => <div data-testid="conflict-review" />,
}))

function makeTodo(overrides: Partial<Todo> = {}): Todo {
  return {
    id: 't1',
    workspaceId: null,
    text: 'Original title',
    content: 'Original **content**',
    status: 'pending',
    sessionId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    origin: 'local',
    dueDate: null,
    repoFullName: null,
    issueNumber: null,
    remoteSnapshot: null,
    remoteUpdatedAt: null,
    lastSyncedAt: null,
    assignee: null,
    labels: [],
    originDeleted: false,
    ...overrides,
  }
}

describe('TodoDetail editing (U2)', () => {
  beforeEach(() => {
    mocks.updateTodo.mockReset()
    mocks.updateTodo.mockResolvedValue({ id: 't1', text: 'saved', content: 'saved' })
  })
  afterEach(() => {
    cleanup()
  })

  // R3/R4/AE1: editing title and content and saving persists both via updateTodo.
  it('saves title and content together on Save', async () => {
    const user = userEvent.setup()
    const todo = makeTodo()
    mocks.updateTodo.mockResolvedValue({ ...todo, text: 'New title', content: 'New body' })
    renderWithI18n(<TodoDetail todo={todo} onResolved={vi.fn()} />)

    const titleInput = screen.getByLabelText('Title')
    await user.clear(titleInput)
    await user.type(titleInput, 'New title')

    const editor = screen.getByTestId('cm-editor')
    await user.clear(editor)
    await user.type(editor, 'New body')

    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mocks.updateTodo).toHaveBeenCalledTimes(1))
    expect(mocks.updateTodo).toHaveBeenCalledWith('t1', {
      text: 'New title',
      content: 'New body',
    })
  })

  // R2: the edit/preview toggle renders formatted markdown in preview mode.
  it('toggles between the editor and the markdown preview', async () => {
    const user = userEvent.setup()
    renderWithI18n(<TodoDetail todo={makeTodo({ content: 'Hello **world**' })} onResolved={vi.fn()} />)

    // Starts in edit mode.
    expect(screen.getByTestId('cm-editor')).toBeInTheDocument()
    expect(screen.queryByTestId('md-preview')).not.toBeInTheDocument()

    // Switch to preview: formatted content is shown, editor hidden.
    await user.click(screen.getByRole('button', { name: 'Preview' }))
    const preview = screen.getByTestId('md-preview')
    expect(preview).toBeInTheDocument()
    expect(preview).toHaveTextContent('Hello **world**')
    expect(screen.queryByTestId('cm-editor')).not.toBeInTheDocument()

    // Switch back to edit.
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByTestId('cm-editor')).toBeInTheDocument()
    expect(screen.queryByTestId('md-preview')).not.toBeInTheDocument()
  })

  // R1: empty/optional content saves as empty without error.
  it('saves empty content without error', async () => {
    const user = userEvent.setup()
    const todo = makeTodo({ content: null })
    mocks.updateTodo.mockResolvedValue(todo)
    renderWithI18n(<TodoDetail todo={todo} onResolved={vi.fn()} />)

    // Dirty the title so Save enables; content stays empty (null normalized to '').
    await user.type(screen.getByLabelText('Title'), '!')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mocks.updateTodo).toHaveBeenCalledTimes(1))
    expect(mocks.updateTodo).toHaveBeenCalledWith('t1', {
      text: 'Original title!',
      content: '',
    })
    expect(screen.queryByText(/Failed to update/i)).not.toBeInTheDocument()
  })

  // KTD2: content over the client cap is blocked before save.
  it('blocks save when content exceeds the cap', async () => {
    const user = userEvent.setup()
    renderWithI18n(<TodoDetail todo={makeTodo()} onResolved={vi.fn()} />)

    // Set a value over the client cap (fireEvent avoids typing 50k keystrokes).
    const editor = screen.getByTestId('cm-editor')
    fireEvent.change(editor, { target: { value: 'x'.repeat(50001) } })

    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(mocks.updateTodo).not.toHaveBeenCalled()
    expect(screen.getByText(/character limit/i)).toBeInTheDocument()
  })

  it('blocks save when the title is empty', async () => {
    const user = userEvent.setup()
    renderWithI18n(<TodoDetail todo={makeTodo()} onResolved={vi.fn()} />)

    const titleInput = screen.getByLabelText('Title')
    await user.clear(titleInput)
    await user.type(titleInput, '   ')

    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(mocks.updateTodo).not.toHaveBeenCalled()
    expect(screen.getByText(/cannot be empty/i)).toBeInTheDocument()
  })

  // Doc-review fix: dirty edits are never silently discarded on todo switch
  // (chosen strategy: auto-save the outgoing todo).
  it('auto-saves dirty edits when switching to another todo', async () => {
    const todoA = makeTodo({ id: 'a', text: 'A title', content: 'A body' })
    const todoB = makeTodo({ id: 'b', text: 'B title', content: 'B body' })

    const { rerender } = renderWithI18n(<TodoDetail todo={todoA} onResolved={vi.fn()} />)

    // Dirty both drafts of A (fireEvent.change is deterministic for controlled
    // inputs; appending via user.type depends on cursor position).
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A title [edited]' } })
    fireEvent.change(screen.getByTestId('cm-editor'), { target: { value: 'A body [edited]' } })

    // Switch to B (simulates selecting another row in the list).
    rerender(
      <I18nextProvider i18n={i18n}>
        <TodoDetail todo={todoB} onResolved={vi.fn()} />
      </I18nextProvider>,
    )

    await waitFor(() => {
      expect(mocks.updateTodo).toHaveBeenCalledWith('a', {
        text: 'A title [edited]',
        content: 'A body [edited]',
      })
    })
    // The newly selected todo's values are loaded.
    expect(screen.getByLabelText('Title')).toHaveValue('B title')
  })

  it('does not auto-save when switching away from a clean (unedited) todo', async () => {
    const todoA = makeTodo({ id: 'a', text: 'A title', content: 'A body' })
    const todoB = makeTodo({ id: 'b', text: 'B title', content: 'B body' })

    const { rerender } = renderWithI18n(<TodoDetail todo={todoA} onResolved={vi.fn()} />)

    rerender(
      <I18nextProvider i18n={i18n}>
        <TodoDetail todo={todoB} onResolved={vi.fn()} />
      </I18nextProvider>,
    )

    // Give the effect a chance; no save should fire for a clean switch.
    await waitFor(() => expect(screen.getByLabelText('Title')).toHaveValue('B title'))
    expect(mocks.updateTodo).not.toHaveBeenCalled()
  })
})
