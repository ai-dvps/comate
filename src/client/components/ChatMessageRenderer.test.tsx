import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import ChatMessageRenderer, {
  type RenderableMessage,
} from './ChatMessageRenderer'
import type { MessageSearchMatch } from '../hooks/useMessageSearch'
import type { WorkflowState } from '../types/message'

const openUrlMock = vi.fn()

vi.mock('../lib/open-url', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/open-url')>()
  return {
    ...actual,
    openUrlInBrowser: (...args: unknown[]) => openUrlMock(...args),
  }
})

vi.mock('streamdown', () => ({
  Streamdown: ({ children, components }: { children: string; components?: Record<string, unknown> }) => {
    const Anchor = components?.a as React.ComponentType<{ href?: string; children?: React.ReactNode }> | undefined
    if (Anchor && /https?:\/\//.test(children)) {
      return (
        <div>
          <Anchor href="https://example.com">https://example.com</Anchor>
        </div>
      )
    }
    return <div>{children}</div>
  },
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

describe('ChatMessageRenderer width', () => {
  it('keeps the standard chat width constraint by default', () => {
    const { container } = render(
      <ChatMessageRenderer {...baseProps} message={makeTextMessage('hello')} />,
    )

    expect(container.firstElementChild).toHaveClass('w-full', 'max-w-[95%]')
    expect(container.firstElementChild).not.toHaveClass('max-w-none')
  })
})

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

describe('ChatMessageRenderer URL modifier-click', () => {
  beforeEach(() => {
    openUrlMock.mockClear()
  })

  it('opens a URL in a user message on Cmd+click', async () => {
    const user = userEvent.setup()
    const message = makeTextMessage('see https://example.com for details', 'user')
    render(<ChatMessageRenderer {...baseProps} message={message} />)

    await user.keyboard('{Meta>}')
    await user.click(screen.getByText('https://example.com'))
    await user.keyboard('{/Meta}')

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com')
  })

  it('does not open a URL in a user message on plain click', async () => {
    const user = userEvent.setup()
    const message = makeTextMessage('see https://example.com for details', 'user')
    render(<ChatMessageRenderer {...baseProps} message={message} />)

    await user.click(screen.getByText('https://example.com'))

    expect(openUrlMock).not.toHaveBeenCalled()
  })

  it('opens a URL in an assistant message via the components.a override on Cmd+click', async () => {
    const user = userEvent.setup()
    const message = makeTextMessage('see https://example.com for details', 'assistant')
    render(<ChatMessageRenderer {...baseProps} message={message} />)

    const link = screen.getByText('https://example.com')
    expect(link.tagName).toBe('A')
    expect(link).toHaveClass('underline')

    await user.keyboard('{Meta>}')
    await user.click(link)
    await user.keyboard('{/Meta}')

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com')
  })

  it('preserves search highlighting in a user message with a URL', () => {
    const message = makeTextMessage('see https://example.com for details', 'user')
    const matches: MessageSearchMatch[] = [
      { messageId: 'msg-1', partIndex: 0, start: 4, end: 23 },
    ]
    render(<ChatMessageRenderer {...baseProps} message={message} searchMatches={matches} currentMatch={matches[0]} />)

    const active = document.querySelector('[data-search-active="true"]')
    expect(active).toHaveTextContent('https://example.com')
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

describe('ChatMessageRenderer tool expansion', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const toolMessage = (
    parts: RenderableMessage['parts'],
    id = 'msg-tool',
  ): RenderableMessage => ({ id, role: 'assistant', parts })

  it('renders tool cards collapsed by default in linear mode', () => {
    const message = toolMessage([
      {
        type: 'tool_use',
        toolUseId: 'tu-read',
        toolName: 'read_file',
        input: { path: '/config.json' },
        isStreaming: false,
      },
    ])

    render(<ChatMessageRenderer {...baseProps} message={message} />)

    expect(screen.getByText('read_file')).toBeInTheDocument()
    expect(screen.queryByText('Parameters')).not.toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: 'expandToolDetails' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: /showDetails/i })).not.toBeInTheDocument()
  })

  it('toggles a card via the header icon; multiple cards expand independently', async () => {
    const user = userEvent.setup()
    const message = toolMessage([
      {
        type: 'tool_use',
        toolUseId: 'tu-1',
        toolName: 'read_file',
        input: { path: '/a.json' },
        isStreaming: false,
      },
      {
        type: 'tool_use',
        toolUseId: 'tu-2',
        toolName: 'read_file',
        input: { path: '/b.json' },
        isStreaming: false,
      },
    ])
    const resultMap = new Map([
      ['tu-1', { type: 'tool_result' as const, toolUseId: 'tu-1', output: 'alpha-result-body', isError: false }],
      ['tu-2', { type: 'tool_result' as const, toolUseId: 'tu-2', output: 'beta-result-body', isError: false }],
    ])

    render(<ChatMessageRenderer {...baseProps} message={message} resultMap={resultMap} />)

    expect(screen.queryByText('alpha-result-body')).not.toBeInTheDocument()
    expect(screen.queryByText('beta-result-body')).not.toBeInTheDocument()

    const toggles = screen.getAllByRole('button', { name: 'expandToolDetails' })
    expect(toggles).toHaveLength(2)

    await user.click(toggles[0])
    expect(screen.getByText('alpha-result-body')).toBeInTheDocument()
    expect(screen.queryByText('beta-result-body')).not.toBeInTheDocument()
    expect(toggles[0]).toHaveAttribute('aria-expanded', 'true')
    expect(toggles[1]).toHaveAttribute('aria-expanded', 'false')

    await user.click(toggles[0])
    expect(screen.queryByText('alpha-result-body')).not.toBeInTheDocument()
    expect(toggles[0]).toHaveAttribute('aria-expanded', 'false')
  })

  it('caps the expanded body at 40vh with internal scroll and no show more/less', async () => {
    const user = userEvent.setup()
    const message = toolMessage([
      {
        type: 'tool_use',
        toolUseId: 'tu-read',
        toolName: 'read_file',
        input: { path: '/config.json' },
        isStreaming: false,
      },
    ])

    render(<ChatMessageRenderer {...baseProps} message={message} />)

    await user.click(screen.getByRole('button', { name: 'expandToolDetails' }))

    const body = screen.getByText('Parameters').closest('[data-tool-content]')
    expect(body).toHaveClass('max-h-[40vh]')
    expect(body).toHaveClass('overflow-y-auto')
    expect(screen.queryByRole('button', { name: /show details/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /hide details/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /show more/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /show less/i })).not.toBeInTheDocument()
  })

  it('keeps a streaming tool card collapsed, then follows the stream in the outer scroll container once expanded', async () => {
    const user = userEvent.setup()
    const message = toolMessage(
      [
        {
          type: 'tool_use',
          toolUseId: 'tu-stream',
          toolName: 'Bash',
          input: {},
          isStreaming: true,
          inputJsonStream: '{"command":"npm ',
        },
      ],
      'msg-stream',
    )

    const { rerender } = render(<ChatMessageRenderer {...baseProps} message={message} />)

    // Collapsed while streaming: the header badge is the only progress indicator.
    expect(screen.getByText('Bash')).toBeInTheDocument()
    expect(screen.getByText('Pending')).toBeInTheDocument()
    expect(
      screen.queryByText((content) => content.includes('command":"npm')),
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'expandToolDetails' }))
    const preview = screen.getByText((content) => content.includes('command":"npm'))
    expect(preview).toBeInTheDocument()
    // The preview itself carries no nested expand toggle.
    expect(screen.queryByRole('button', { name: /show more/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /show less/i })).not.toBeInTheDocument()

    // Pin-to-bottom follow retargets the outer 40vh scroll container.
    const scrollContainer = preview.closest('[data-tool-content]') as HTMLElement
    expect(scrollContainer).not.toBeNull()
    let mockScrollTop = 0
    let followWrite = -1
    Object.defineProperty(scrollContainer, 'scrollHeight', {
      configurable: true,
      value: 500,
    })
    Object.defineProperty(scrollContainer, 'scrollTop', {
      configurable: true,
      get: () => mockScrollTop,
      set: (value: number) => {
        followWrite = value
      },
    })

    const streamed = (json: string): RenderableMessage =>
      toolMessage(
        [
          {
            type: 'tool_use',
            toolUseId: 'tu-stream',
            toolName: 'Bash',
            input: {},
            isStreaming: true,
            inputJsonStream: json,
          },
        ],
        'msg-stream',
      )

    rerender(<ChatMessageRenderer {...baseProps} message={streamed('{"command":"npm test"')} />)
    expect(followWrite).toBe(500)

    // User scrolls away from the bottom: forced follow pauses.
    followWrite = -1
    fireEvent.scroll(scrollContainer)
    rerender(<ChatMessageRenderer {...baseProps} message={streamed('{"command":"npm test -- --watch"')} />)
    expect(followWrite).toBe(-1)

    // Back near the bottom: follow resumes.
    mockScrollTop = 480
    fireEvent.scroll(scrollContainer)
    rerender(<ChatMessageRenderer {...baseProps} message={streamed('{"command":"npm test -- --watch --ci"')} />)
    expect(followWrite).toBe(500)
  })

  it('force-expands a card containing the current search match and stays expanded when the match moves away', () => {
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView')
    const message = toolMessage(
      [
        {
          type: 'tool_use',
          toolUseId: 'tu-1',
          toolName: 'read_file',
          input: { path: '/config.json' },
          isStreaming: false,
        },
      ],
      'msg-1',
    )
    const matches: MessageSearchMatch[] = [
      { messageId: 'msg-1', partIndex: 0, start: 0, end: 6 },
    ]

    const { rerender } = render(
      <ChatMessageRenderer
        {...baseProps}
        message={message}
        searchMatches={matches}
        currentMatch={matches[0]}
      />,
    )

    // Expanded without a click, ring preserved, hit scrolled into view.
    expect(screen.getByText('Parameters')).toBeInTheDocument()
    const cardRoot = screen.getByText('read_file').closest('[data-state]') as HTMLElement
    expect(cardRoot).toHaveClass('ring-1')
    expect(cardRoot).toHaveClass('ring-accent')
    expect(cardRoot).toHaveClass('bg-accent/5')
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' })

    // One-way semantics: losing the current match must not collapse the card.
    rerender(
      <ChatMessageRenderer
        {...baseProps}
        message={message}
        searchMatches={matches}
        currentMatch={null}
      />,
    )
    expect(screen.getByText('Parameters')).toBeInTheDocument()
  })

  it('keeps a collapsed card ringed at the root for a non-current search match', () => {
    const message = toolMessage(
      [
        {
          type: 'tool_use',
          toolUseId: 'tu-1',
          toolName: 'read_file',
          input: { path: '/config.json' },
          isStreaming: false,
        },
      ],
      'msg-1',
    )
    const matches: MessageSearchMatch[] = [
      { messageId: 'msg-1', partIndex: 0, start: 0, end: 6 },
    ]

    render(
      <ChatMessageRenderer
        {...baseProps}
        message={message}
        searchMatches={matches}
        currentMatch={null}
      />,
    )

    const cardRoot = screen.getByText('read_file').closest('[data-state]') as HTMLElement
    expect(cardRoot).toHaveAttribute('data-state', 'closed')
    expect(cardRoot).toHaveClass('ring-1')
    expect(cardRoot).toHaveClass('ring-accent/30')
    expect(cardRoot).not.toHaveClass('ring-accent')
    expect(screen.queryByText('Parameters')).not.toBeInTheDocument()
  })

  it('shows only Parameters for a completed call without a result once expanded', async () => {
    const user = userEvent.setup()
    const message = toolMessage([
      {
        type: 'tool_use',
        toolUseId: 'tu-1',
        toolName: 'read_file',
        input: { path: '/config.json' },
        isStreaming: false,
      },
    ])

    render(<ChatMessageRenderer {...baseProps} message={message} />)

    await user.click(screen.getByRole('button', { name: 'expandToolDetails' }))
    expect(screen.getByText('Parameters')).toBeInTheDocument()
    expect(screen.queryByText('Result')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Error' })).not.toBeInTheDocument()
  })

  it('renders the Error section for an error result once expanded', async () => {
    const user = userEvent.setup()
    const message = toolMessage([
      {
        type: 'tool_use',
        toolUseId: 'tu-1',
        toolName: 'read_file',
        input: { path: '/config.json' },
        isStreaming: false,
      },
    ])
    const resultMap = new Map([
      ['tu-1', { type: 'tool_result' as const, toolUseId: 'tu-1', output: 'boom happened', isError: true }],
    ])

    render(<ChatMessageRenderer {...baseProps} message={message} resultMap={resultMap} />)

    await user.click(screen.getByRole('button', { name: 'expandToolDetails' }))
    expect(screen.getByRole('heading', { name: 'Error' })).toBeInTheDocument()
    expect(screen.getByText('boom happened')).toBeInTheDocument()
  })
})
