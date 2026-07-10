import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import ChatMessageRenderer, {
  type RenderableMessage,
} from './ChatMessageRenderer'
import type { MessageSearchMatch } from '../hooks/useMessageSearch'
import type { WorkflowState } from '../types/message'

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <div>{children}</div>,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => {} },
  I18nextProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

let mockStoreState: { workflows: Record<string, WorkflowState[]>; subagents: Record<string, unknown[]> } = {
  workflows: {},
  subagents: {},
}

vi.mock('../stores/chat-store', () => ({
  useChatStore: vi.fn((selector: (state: typeof mockStoreState) => unknown) =>
    selector(mockStoreState),
  ),
}))

function makeTextMessage(text: string, role: 'user' | 'assistant' | 'system' = 'assistant'): RenderableMessage {
  return {
    id: 'msg-1',
    role,
    parts: [{ type: 'text', text }],
  }
}

const noop = () => {}

const baseProps = {
  resultMap: new Map(),
  onOpenDrawer: noop,
  sessionId: 'session-1',
}

describe('ChatMessageRenderer search highlights', () => {
  beforeEach(() => {
    mockStoreState = { workflows: {}, subagents: {} }
  })
  it('renders inline highlights for user text', () => {
    const message = makeTextMessage('hello world', 'user')
    const matches: MessageSearchMatch[] = [
      { messageId: 'msg-1', partIndex: 0, start: 6, end: 11 },
    ]
    render(<ChatMessageRenderer {...baseProps} message={message} searchMatches={matches} currentMatch={matches[0]} />)

    const active = document.querySelector('[data-search-active="true"]')
    expect(active).toHaveTextContent('world')
  })

  it('renders inline highlights for system text', () => {
    const message: RenderableMessage = {
      id: 'msg-1',
      role: 'system',
      parts: [{ type: 'text', text: 'system warning' }],
    }
    const matches: MessageSearchMatch[] = [
      { messageId: 'msg-1', partIndex: 0, start: 7, end: 14 },
    ]
    render(<ChatMessageRenderer {...baseProps} message={message} searchMatches={matches} currentMatch={matches[0]} />)

    const active = document.querySelector('[data-search-active="true"]')
    expect(active).toHaveTextContent('warning')
  })

  it('auto-expands assistant text when current match is inside', () => {
    const message = makeTextMessage('hello world', 'assistant')
    const matches: MessageSearchMatch[] = [
      { messageId: 'msg-1', partIndex: 0, start: 6, end: 11 },
    ]
    render(<ChatMessageRenderer {...baseProps} message={message} searchMatches={matches} currentMatch={matches[0]} />)

    expect(screen.getByText('hello world')).toBeInTheDocument()
  })

  it('marks tool input/output code blocks when they match', () => {
    const message: RenderableMessage = {
      id: 'msg-1',
      role: 'assistant',
      parts: [
        {
          type: 'tool_use',
          toolUseId: 'tu-1',
          toolName: 'read_file',
          input: { path: '/config.json' },
          isStreaming: false,
        },
      ],
    }
    const matches: MessageSearchMatch[] = [
      { messageId: 'msg-1', partIndex: 0, start: 0, end: 6 },
    ]
    render(<ChatMessageRenderer {...baseProps} message={message} searchMatches={matches} currentMatch={matches[0]} />)

    const container = document.querySelector('[data-language="json"]')
    expect(container).toHaveClass('ring-1')
  })

  it('renders tool_use_meta display name and icon', () => {
    const message: RenderableMessage = {
      id: 'msg-1',
      role: 'assistant',
      parts: [
        {
          type: 'tool_use',
          toolUseId: 'tu-1',
          toolName: 'mcp__server__fetch',
          input: { url: 'https://example.com' },
          isStreaming: false,
          meta: {
            displayName: 'Web Fetch',
            iconUrl: 'https://example.com/icon.png',
          },
        },
      ],
    }
    render(<ChatMessageRenderer {...baseProps} message={message} />)

    expect(screen.getByText('Web Fetch')).toBeInTheDocument()
    const img = document.querySelector('img[src="https://example.com/icon.png"]')
    expect(img).toBeInTheDocument()
  })

  it('renders api_retry system messages as subtle inline text', () => {
    const message: RenderableMessage = {
      id: 'msg-1',
      role: 'system',
      subType: 'api_retry',
      parts: [{ type: 'text', text: 'Retrying API request (1/3) after 1000ms' }],
    }
    render(<ChatMessageRenderer {...baseProps} message={message} />)

    expect(screen.getByText('Retrying API request (1/3) after 1000ms')).toBeInTheDocument()
    const alert = document.querySelector('[data-icon]')
    expect(alert).not.toBeInTheDocument()
  })
})

describe('ChatMessageRenderer timestamps', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders todays timestamp for a user message', () => {
    const now = new Date(2026, 6, 9, 10, 0).getTime()
    vi.useFakeTimers({ now })
    const message = makeTextMessage('hello world', 'user')
    message.timestamp = new Date(2026, 6, 9, 14, 32).getTime()

    render(<ChatMessageRenderer {...baseProps} message={message} />)
    const timestamp = screen.getByText('14:32')
    expect(timestamp).toBeInTheDocument()
    expect(timestamp).toHaveClass('opacity-0')
  })

  it('renders older timestamp for an assistant message', () => {
    const message = makeTextMessage('hello world', 'assistant')
    message.timestamp = new Date(2026, 6, 8, 14, 32).getTime()

    render(<ChatMessageRenderer {...baseProps} message={message} />)
    const timestamp = screen.getByText('2026-07-08 14:32')
    expect(timestamp).toBeInTheDocument()
    expect(timestamp).toHaveClass('opacity-0')
  })

  it('does not render timestamp for api_retry system messages', () => {
    const message: RenderableMessage = {
      id: 'msg-1',
      role: 'system',
      subType: 'api_retry',
      parts: [{ type: 'text', text: 'Retrying API request' }],
      timestamp: new Date(2026, 6, 8, 14, 32).getTime(),
    }

    render(<ChatMessageRenderer {...baseProps} message={message} />)
    expect(screen.queryByText('2026-07-08 14:32')).not.toBeInTheDocument()
  })

  it('does not render timestamp for generic system messages', () => {
    const message: RenderableMessage = {
      id: 'msg-1',
      role: 'system',
      parts: [{ type: 'text', text: 'system warning' }],
      timestamp: new Date(2026, 6, 8, 14, 32).getTime(),
    }

    render(<ChatMessageRenderer {...baseProps} message={message} />)
    expect(screen.queryByText('2026-07-08 14:32')).not.toBeInTheDocument()
  })

  it('does not render timestamp for assistant messages with thinking part', () => {
    const message: RenderableMessage = {
      id: 'msg-1',
      role: 'assistant',
      parts: [{ type: 'thinking', text: 'thinking...', isStreaming: false }],
      timestamp: new Date(2026, 6, 8, 14, 32).getTime(),
    }

    render(<ChatMessageRenderer {...baseProps} message={message} />)
    expect(screen.queryByText('2026-07-08 14:32')).not.toBeInTheDocument()
  })

  it('does not render timestamp for assistant messages with tool_use part', () => {
    const message: RenderableMessage = {
      id: 'msg-1',
      role: 'assistant',
      parts: [
        {
          type: 'tool_use',
          toolUseId: 'tu-1',
          toolName: 'read_file',
          input: { path: '/config.json' },
          isStreaming: false,
        },
      ],
      timestamp: new Date(2026, 6, 8, 14, 32).getTime(),
    }

    render(<ChatMessageRenderer {...baseProps} message={message} />)
    expect(screen.queryByText('2026-07-08 14:32')).not.toBeInTheDocument()
  })

  it('does not render timestamp for assistant messages with subagent part', () => {
    const message: RenderableMessage = {
      id: 'msg-1',
      role: 'assistant',
      parts: [
        {
          type: 'tool_use',
          toolUseId: 'tu-1',
          toolName: 'Agent',
          input: { task: 'research' },
          isStreaming: false,
        },
      ],
      timestamp: new Date(2026, 6, 8, 14, 32).getTime(),
    }

    render(<ChatMessageRenderer {...baseProps} message={message} />)
    expect(screen.queryByText('2026-07-08 14:32')).not.toBeInTheDocument()
  })

  it('renders timestamp for Interrupt system messages', () => {
    const message: RenderableMessage = {
      id: 'msg-1',
      role: 'system',
      subType: 'Interrupt',
      parts: [{ type: 'text', text: 'Interrupted' }],
      timestamp: new Date(2026, 6, 8, 14, 32).getTime(),
    }

    render(<ChatMessageRenderer {...baseProps} message={message} />)
    const timestamp = screen.getByText('2026-07-08 14:32')
    expect(timestamp).toBeInTheDocument()
    expect(timestamp).toHaveClass('opacity-0')
  })
})

describe('ChatMessageRenderer Workflow card', () => {
  function makeWorkflowMessage(toolUseId: string): RenderableMessage {
    return {
      id: 'msg-wf',
      role: 'assistant',
      parts: [
        {
          type: 'tool_use',
          toolUseId,
          toolName: 'Workflow',
          input: { name: 'Deep Research' },
          isStreaming: false,
        },
      ],
    }
  }

  function makeResultMap(toolUseId: string, runId: string) {
    return new Map([
      [
        toolUseId,
        {
          type: 'tool_result' as const,
          toolUseId,
          output: JSON.stringify({ status: 'async_launched', runId }),
          isError: false,
          toolUseResult: {
            status: 'async_launched',
            runId,
            taskId: 'task-1',
            workflowName: 'Deep Research',
          },
        },
      ],
    ])
  }

  beforeEach(() => {
    mockStoreState = { workflows: {}, subagents: {} }
  })

  it('renders Workflow card with status badge and progress hint', () => {
    mockStoreState = {
      workflows: {
        'session-1': [
          {
            runId: 'wf-1',
            sessionId: 'session-1',
            toolUseId: 'tu-wf-1',
            workflowName: 'Deep Research',
            status: 'running',
            startTime: Date.now(),
            agentCount: 3,
            phases: [{ title: 'Research phase' }],
            progress: [
              { type: 'workflow_phase', index: 0, title: 'Research phase' },
              { type: 'workflow_agent', index: 0, agentId: 'a1', state: 'done' },
              { type: 'workflow_agent', index: 1, agentId: 'a2', state: 'running' },
              { type: 'workflow_agent', index: 2, agentId: 'a3' },
            ],
            subagents: [],
          },
        ],
      },
      subagents: {},
    }

    const message = makeWorkflowMessage('tu-wf-1')
    const resultMap = makeResultMap('tu-wf-1', 'wf-1')
    render(<ChatMessageRenderer {...baseProps} message={message} resultMap={resultMap} />)

    expect(screen.getByText('Deep Research')).toBeInTheDocument()
    expect(screen.getByText('workflowStatus.running')).toBeInTheDocument()
    expect(screen.getByText('Research phase')).toBeInTheDocument()
    expect(screen.getByText('workflowSubagentCountWithRunning')).toBeInTheDocument()
  })

  it('calls onOpenWorkflow with runId when card is clicked', async () => {
    const onOpenWorkflow = vi.fn()
    mockStoreState = {
      workflows: {
        'session-1': [
          {
            runId: 'wf-2',
            sessionId: 'session-1',
            status: 'running',
            startTime: Date.now(),
            agentCount: 0,
            phases: [],
            progress: [],
            subagents: [],
          },
        ],
      },
      subagents: {},
    }

    const message = makeWorkflowMessage('tu-wf-2')
    const resultMap = makeResultMap('tu-wf-2', 'wf-2')
    render(
      <ChatMessageRenderer
        {...baseProps}
        message={message}
        resultMap={resultMap}
        onOpenWorkflow={onOpenWorkflow}
      />,
    )

    await userEvent.click(screen.getByRole('button'))
    expect(onOpenWorkflow).toHaveBeenCalledWith('wf-2')
  })

  it('falls back to generic tool card when Workflow result has no runId', () => {
    const message: RenderableMessage = {
      id: 'msg-wf',
      role: 'assistant',
      parts: [
        {
          type: 'tool_use',
          toolUseId: 'tu-wf-3',
          toolName: 'Workflow',
          input: { name: 'Deep Research' },
          isStreaming: false,
        },
      ],
    }
    const resultMap = new Map([
      [
        'tu-wf-3',
        {
          type: 'tool_result' as const,
          toolUseId: 'tu-wf-3',
          output: 'launched',
          isError: false,
        },
      ],
    ])

    render(<ChatMessageRenderer {...baseProps} message={message} resultMap={resultMap} />)

    expect(screen.getByText('Workflow')).toBeInTheDocument()
    expect(screen.getByText('name: Deep Research')).toBeInTheDocument()
  })

  it('continues to render non-Workflow tools as before', () => {
    const message: RenderableMessage = {
      id: 'msg-tool',
      role: 'assistant',
      parts: [
        {
          type: 'tool_use',
          toolUseId: 'tu-read',
          toolName: 'read_file',
          input: { path: '/config.json' },
          isStreaming: false,
        },
      ],
    }

    render(<ChatMessageRenderer {...baseProps} message={message} />)

    expect(screen.getByText('read_file')).toBeInTheDocument()
    expect(screen.getByText('/config.json')).toBeInTheDocument()
  })
})

describe('ChatMessageRenderer JSON text parts', () => {
  beforeEach(() => {
    mockStoreState = { workflows: {}, subagents: {} }
  })

  it('renders an assistant JSON text part as StructuredReport (AE1)', () => {
    const message = makeTextMessage('{"a":1}', 'assistant')
    render(<ChatMessageRenderer {...baseProps} message={message} />)

    expect(screen.getByText('structuredReport.label')).toBeInTheDocument()
    expect(document.querySelector('[data-language="json"]')).toBeInTheDocument()
  })

  it('leaves assistant prose on the markdown path (R9)', () => {
    const message = makeTextMessage('hello world', 'assistant')
    render(<ChatMessageRenderer {...baseProps} message={message} />)

    expect(screen.getByText('hello world')).toBeInTheDocument()
    expect(screen.queryByText('structuredReport.label')).not.toBeInTheDocument()
    expect(document.querySelector('[data-language="json"]')).not.toBeInTheDocument()
  })

  it('flips from markdown to StructuredReport once a streaming part becomes valid JSON (AE4)', () => {
    const partial = makeTextMessage('{"status":"com', 'assistant')
    const { rerender } = render(<ChatMessageRenderer {...baseProps} message={partial} />)

    expect(screen.queryByText('structuredReport.label')).not.toBeInTheDocument()

    const complete = makeTextMessage('{"status":"complete"}', 'assistant')
    rerender(<ChatMessageRenderer {...baseProps} message={complete} />)

    expect(screen.getByText('structuredReport.label')).toBeInTheDocument()
  })

  it('renders only the JSON text part as StructuredReport in a mixed message', () => {
    const message: RenderableMessage = {
      id: 'msg-mix',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'intro' },
        { type: 'text', text: '{"a":1}' },
        {
          type: 'tool_use',
          toolUseId: 'tu-read',
          toolName: 'read_file',
          input: { path: '/config.json' },
          isStreaming: false,
        },
      ],
    }
    render(<ChatMessageRenderer {...baseProps} message={message} />)

    expect(screen.getByText('intro')).toBeInTheDocument()
    expect(screen.getByText('read_file')).toBeInTheDocument()
    expect(screen.getAllByText('structuredReport.label')).toHaveLength(1)
  })

  it('keeps a user JSON message as a plain paragraph (AE8)', () => {
    const message = makeTextMessage('{"a":1}', 'user')
    render(<ChatMessageRenderer {...baseProps} message={message} />)

    expect(screen.getByText('{"a":1}')).toBeInTheDocument()
    expect(screen.queryByText('structuredReport.label')).not.toBeInTheDocument()
  })

  it('renders StructuredReport for an assistant JSON reply on the shared render path (AE6)', () => {
    // SubagentConversation renders ChatMessageRenderer for adapted subagent
    // messages, so an assistant-role JSON reply reaches this same branch.
    const message = makeTextMessage('{"ok":true}', 'assistant')
    render(<ChatMessageRenderer {...baseProps} message={message} />)

    expect(screen.getByText('structuredReport.label')).toBeInTheDocument()
  })

  it('passes search props to StructuredReport for a matched JSON part', () => {
    const message = makeTextMessage('{"a":1}', 'assistant')
    const matches: MessageSearchMatch[] = [
      { messageId: 'msg-1', partIndex: 0, start: 0, end: 1 },
    ]
    render(
      <ChatMessageRenderer
        {...baseProps}
        message={message}
        searchMatches={matches}
        currentMatch={matches[0]}
      />,
    )

    const container = document.querySelector('[data-language="json"]')
    expect(container).toHaveClass('ring-1')
    expect(screen.getByTestId('structured-report-body')).toBeVisible()
  })
})
