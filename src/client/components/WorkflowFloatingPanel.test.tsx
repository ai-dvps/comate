import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import WorkflowFloatingPanel from './WorkflowFloatingPanel'
import type { WorkflowState } from '../types/message'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => {} },
  I18nextProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

let mockStoreState: { workflows: Record<string, WorkflowState[]> } = {
  workflows: {},
}

vi.mock('../stores/chat-store', () => ({
  useChatStore: vi.fn((selector: (state: typeof mockStoreState) => unknown) =>
    selector(mockStoreState),
  ),
}))

describe('WorkflowFloatingPanel', () => {
  beforeEach(() => {
    mockStoreState = { workflows: {} }
  })

  function makeWorkflow(runId: string, status: WorkflowState['status']): WorkflowState {
    return {
      runId,
      sessionId: 'session-1',
      workflowName: 'Research',
      status,
      startTime: Date.now(),
      agentCount: 3,
      phases: [{ title: 'Plan' }, { title: 'Execute' }, { title: 'Synthesize' }],
      progress: [
        { type: 'workflow_phase', index: 0, title: 'Plan' },
        { type: 'workflow_agent', index: 0, agentId: 'a1', state: 'done' },
        { type: 'workflow_agent', index: 1, agentId: 'a2', state: 'running' },
        { type: 'workflow_agent', index: 2, agentId: 'a3' },
      ],
      subagents: [],
    }
  }

  it('renders nothing when there are no workflows', () => {
    const { container } = render(
      <WorkflowFloatingPanel sessionId="session-1" onOpenWorkflow={() => {}} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders workflows and their status', () => {
    mockStoreState = {
      workflows: {
        'session-1': [makeWorkflow('wf-1', 'running')],
      },
    }
    render(
      <WorkflowFloatingPanel sessionId="session-1" onOpenWorkflow={() => {}} />,
    )

    expect(screen.getByText('workflowPanelTitle')).toBeInTheDocument()
    expect(screen.getByText('Research')).toBeInTheDocument()
    expect(screen.getByText('workflowStatus.running')).toBeInTheDocument()
    expect(screen.getByText('Synthesize')).toBeInTheDocument()
  })

  it('calls onOpenWorkflow with runId when a workflow item is clicked', async () => {
    const onOpenWorkflow = vi.fn()
    mockStoreState = {
      workflows: {
        'session-1': [makeWorkflow('wf-2', 'running')],
      },
    }
    render(
      <WorkflowFloatingPanel
        sessionId="session-1"
        onOpenWorkflow={onOpenWorkflow}
      />,
    )

    await userEvent.click(screen.getByText('Research'))
    expect(onOpenWorkflow).toHaveBeenCalledWith('wf-2')
  })

  it('renders multiple workflows', () => {
    mockStoreState = {
      workflows: {
        'session-1': [
          makeWorkflow('wf-a', 'running'),
          makeWorkflow('wf-b', 'completed'),
        ],
      },
    }
    render(
      <WorkflowFloatingPanel sessionId="session-1" onOpenWorkflow={() => {}} />,
    )

    expect(screen.getAllByRole('button').length).toBe(2)
  })
})
