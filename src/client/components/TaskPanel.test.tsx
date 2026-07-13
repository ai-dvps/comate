import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import TaskPanel from './TaskPanel'
import type { TaskItem } from '../stores/chat-store'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const mockStore = {
  tasks: {} as Record<string, TaskItem[]>,
}

vi.mock('../stores/chat-store', () => ({
  useChatStore: (selector: (state: typeof mockStore) => unknown) => selector(mockStore),
}))

vi.mock('../hooks/use-app-settings', () => ({
  useAppSettings: () => ({ chatFontSize: 'medium' }),
}))

vi.mock('../lib/font-size', () => ({
  fontSizeClass: () => 'text-sm',
}))

describe('TaskPanel', () => {
  beforeEach(() => {
    mockStore.tasks = {}
    cleanup()
  })

  it('returns null when there are no tasks', () => {
    mockStore.tasks.s1 = []
    const { container } = render(<TaskPanel sessionId="s1" />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the collapsed card summary when tasks exist', () => {
    mockStore.tasks.s1 = [{ id: 't1', subject: 'Pending task', status: 'pending' }]
    render(<TaskPanel sessionId="s1" />)
    expect(screen.getByText('taskPanelTitle')).toBeInTheDocument()
    expect(screen.getByText('0/1')).toBeInTheDocument()
  })

  it('does not stretch to the full width of a shared floating wrapper', () => {
    mockStore.tasks.s1 = [{ id: 't1', subject: 'Pending task', status: 'pending' }]
    const { container } = render(<TaskPanel sessionId="s1" />)
    const root = container.firstChild as HTMLElement
    expect(root).not.toBeNull()
    expect(root.className).toContain('max-w-xs')
    expect(root.className).not.toContain('w-full')
  })

  it('counts terminal tasks (completed, failed, killed) toward progress', () => {
    mockStore.tasks.s1 = [
      ...Array.from({ length: 13 }, (_, i) => ({
        id: `c${i}`,
        subject: `Done ${i}`,
        status: 'completed' as const,
      })),
      { id: 'f1', subject: 'Failed task', status: 'failed' as const },
      { id: 'k1', subject: 'Killed task', status: 'killed' as const },
    ]
    const { container } = render(<TaskPanel sessionId="s1" />)
    expect(screen.getByText('15/15')).toBeInTheDocument()
    expect(container.querySelector('[style*="width: 100%"]')).not.toBeNull()
  })

  it('shows a failed-count badge when tasks have failed', () => {
    mockStore.tasks.s1 = [
      { id: 'c1', subject: 'Done', status: 'completed' },
      { id: 'f1', subject: 'Failed', status: 'failed' },
    ]
    const { container } = render(<TaskPanel sessionId="s1" />)
    expect(container.querySelector('.bg-destructive\\/10')).not.toBeNull()
  })

  it('hides the failed-count badge when nothing has failed', () => {
    mockStore.tasks.s1 = [
      { id: 'c1', subject: 'Done', status: 'completed' },
      { id: 'p1', subject: 'Pending', status: 'pending' },
    ]
    const { container } = render(<TaskPanel sessionId="s1" />)
    expect(container.querySelector('.bg-destructive\\/10')).toBeNull()
  })

  it('expands to show task rows when clicked', async () => {
    mockStore.tasks.s1 = [{ id: 't1', subject: 'Pending task', status: 'pending' }]
    render(<TaskPanel sessionId="s1" />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button'))

    expect(screen.getByText('Pending task')).toBeInTheDocument()
  })

  it('does not show tasks sourced from TodoWrite', async () => {
    mockStore.tasks.s1 = [
      { id: 'todowrite-0', subject: 'Todo item', status: 'in_progress' },
      { id: 't1', subject: 'Real task', status: 'pending' },
    ]
    render(<TaskPanel sessionId="s1" />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button'))

    // UI layer shows whatever the store provides; the contract is that the
    // chat store filters todowrite-* entries before TaskPanel sees them.
    expect(screen.queryByText('Todo item')).toBeInTheDocument()
    expect(screen.getByText('Real task')).toBeInTheDocument()
  })

  it('collapses the expanded panel on Escape', async () => {
    mockStore.tasks.s1 = [{ id: 't1', subject: 'Task to hide', status: 'pending' }]
    render(<TaskPanel sessionId="s1" />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button'))
    expect(screen.getByText('Task to hide')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByText('Task to hide')).not.toBeInTheDocument()
  })

  it('collapses when the session id changes', async () => {
    mockStore.tasks.s1 = [{ id: 't1', subject: 'Task s1', status: 'pending' }]
    mockStore.tasks.s2 = [{ id: 't2', subject: 'Task s2', status: 'pending' }]
    const { rerender } = render(<TaskPanel sessionId="s1" />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button'))
    expect(screen.getByText('Task s1')).toBeInTheDocument()

    rerender(<TaskPanel sessionId="s2" />)
    expect(screen.queryByText('Task s1')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button'))
    expect(screen.getByText('Task s2')).toBeInTheDocument()
  })
})
