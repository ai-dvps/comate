import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import WorkflowDetailPanel from './WorkflowDetailPanel'
import type { WorkflowState, SubagentState } from '../types/message'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { count?: number }) => {
    if (options?.count !== undefined) {
      return `${key}_${options.count === 1 ? 'one' : 'other'}`
    }
    return key
  } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
  I18nextProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

let mockStoreState: { workflows: Record<string, WorkflowState[]>; subagents: Record<string, SubagentState[]>; messages: Record<string, unknown[]> } = {
  workflows: {},
  subagents: {},
  messages: {},
}

vi.mock('../stores/chat-store', () => ({
  useChatStore: vi.fn((selector: (state: typeof mockStoreState) => unknown) =>
    selector(mockStoreState),
  ),
}))

function makeWorkflow(runId: string): WorkflowState {
  return {
    runId,
    sessionId: 'session-1',
    workflowName: 'Deep Research',
    status: 'running',
    startTime: Date.now() - 5000,
    agentCount: 2,
    phases: [{ title: 'Plan' }, { title: 'Execute' }],
    progress: [
      { type: 'workflow_phase', index: 0, title: 'Plan' },
      { type: 'workflow_agent', index: 0, agentId: 'a1', state: 'done' },
      { type: 'workflow_agent', index: 1, agentId: 'a2', state: 'running' },
    ],
    subagents: [
      {
        parentToolUseId: 'workflow:wf-1:a1',
        description: 'Agent one',
        state: 'completed',
        startTime: Date.now() - 4000,
        endTime: Date.now() - 1000,
        toolCount: 3,
        progressHint: '',
        messages: [],
      },
    ],
  }
}

describe('WorkflowDetailPanel', () => {
  beforeEach(() => {
    mockStoreState = { workflows: {}, subagents: {}, messages: {} }
  })

  it('renders workflow name, status, and phases', () => {
    mockStoreState = {
      workflows: { 'session-1': [makeWorkflow('wf-1')] },
      subagents: {},
      messages: {},
    }
    render(
      <WorkflowDetailPanel
        runId="wf-1"
        sessionId="session-1"
        onClose={() => {}}
      />,
    )

    expect(screen.getByText('Deep Research')).toBeInTheDocument()
    expect(screen.getByText('workflowStatus.running')).toBeInTheDocument()
    expect(screen.getByText('Plan')).toBeInTheDocument()
    expect(screen.getByText('Execute')).toBeInTheDocument()
    expect(screen.getByText('workflowDetailSubagents')).toBeInTheDocument()
  })

  it('opens the subagent drawer inside the modal when a subagent is clicked', async () => {
    mockStoreState = {
      workflows: { 'session-1': [makeWorkflow('wf-1')] },
      subagents: {
        'session-1': [
          {
            parentToolUseId: 'workflow:wf-1:a1',
            description: 'Agent one',
            state: 'completed',
            startTime: Date.now(),
            toolCount: 3,
            progressHint: '',
            messages: [],
          },
        ],
      },
      messages: {},
    }
    const { container } = render(
      <WorkflowDetailPanel
        runId="wf-1"
        sessionId="session-1"
        onClose={() => {}}
      />,
    )

    expect(container.querySelector('aside')).toBeNull()
    await userEvent.click(screen.getByTitle('openSubagentPanel'))
    const drawer = container.querySelector('aside')
    expect(drawer).not.toBeNull()
    expect(drawer?.textContent).toContain('Agent one')
  })

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn()
    mockStoreState = {
      workflows: { 'session-1': [makeWorkflow('wf-1')] },
      subagents: {},
      messages: {},
    }
    render(
      <WorkflowDetailPanel
        runId="wf-1"
        sessionId="session-1"
        onClose={onClose}
      />,
    )

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('shows no-data state when workflow is missing', () => {
    render(
      <WorkflowDetailPanel
        runId="wf-missing"
        sessionId="session-1"
        onClose={() => {}}
      />,
    )

    expect(screen.getByText('workflowNoData')).toBeInTheDocument()
  })
})
