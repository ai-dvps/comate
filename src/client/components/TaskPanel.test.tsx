import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import TaskPanel from './TaskPanel'
import type { TaskItem } from '../stores/chat-store'

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

  it('expands and shows a task with an unknown status without crashing', async () => {
    mockStore.tasks.s1 = [
      { id: 't1', subject: 'Task with unknown status', status: 'running' as TaskItem['status'] },
    ]

    render(<TaskPanel sessionId="s1" />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button'))

    expect(screen.getByText('Task with unknown status')).toBeInTheDocument()
  })

  it('expands and shows a task with a known status', async () => {
    mockStore.tasks.s1 = [
      { id: 't1', subject: 'Pending task', status: 'pending' },
    ]

    render(<TaskPanel sessionId="s1" />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button'))

    expect(screen.getByText('Pending task')).toBeInTheDocument()
  })
})
