import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'

import DetailDrawer from './DetailDrawer'
import i18n from '../i18n'
import type { DrawerView } from './detail-drawer-view'
import type { ChatMessage } from '../types/message'

const renderWithI18n = (ui: React.ReactElement) =>
  render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)

const appSettingsMock = vi.hoisted(() => ({ chatFontSize: 12 }))

vi.mock('../hooks/use-app-settings', () => ({
  useAppSettings: () => ({ chatFontSize: appSettingsMock.chatFontSize }),
}))

const chatStoreMock = vi.hoisted(() => {
  type Listener = () => void
  const listeners = new Set<Listener>()
  const state = {
    messages: {} as Record<string, ChatMessage[]>,
    subagents: {} as Record<string, unknown[]>,
    workflows: {} as Record<string, unknown[]>,
  }
  function notify() {
    listeners.forEach((l) => l())
  }
  function useChatStore(selector?: (s: typeof state) => unknown) {
    const [, forceRender] = React.useReducer((x: number) => x + 1, 0)
    React.useEffect(() => {
      const unsubscribe = chatStoreMock.subscribe(forceRender)
      return () => {
        unsubscribe()
      }
    }, [])
    return selector ? selector(state) : state
  }
  return {
    getState: () => state,
    subscribe: (listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setMessages: (sessionId: string, messages: ChatMessage[]) => {
      state.messages[sessionId] = messages
      notify()
    },
    useChatStore,
  }
})

vi.mock('../stores/chat-store', () => ({
  useChatStore: chatStoreMock.useChatStore,
}))

vi.mock('streamdown', () => ({
  defaultRehypePlugins: {},
  Streamdown: ({ children }: { children: string }) => <div>{children}</div>,
}))

const defaultProps = {
  sessionId: 's1',
  width: 400,
  onWidthChange: () => {},
  onPop: () => {},
  onClose: () => {},
  onPush: () => {},
}

const sub = (id: string): DrawerView => ({ kind: 'subagent', parentToolUseId: id })
const processView = (messageId: string, regionIndex = 0): DrawerView => ({
  kind: 'process',
  messageId,
  regionIndex,
})

function textPart(text: string): Extract<ChatMessage['parts'][number], { type: 'text' }> {
  return { type: 'text', text }
}

function thinkingPart(text: string): Extract<ChatMessage['parts'][number], { type: 'thinking' }> {
  return { type: 'thinking', text, state: 'complete' }
}

function toolUsePart(
  toolName: string,
  toolUseId: string,
  input: unknown,
  inputJsonStream?: string,
): Extract<ChatMessage['parts'][number], { type: 'tool_use' }> {
  return {
    type: 'tool_use',
    toolUseId,
    toolName,
    input,
    inputJsonStream,
    state: inputJsonStream ? 'streaming' : 'complete',
  }
}

function toolResultPart(
  toolUseId: string,
  output: string,
  isError = false,
): Extract<ChatMessage['parts'][number], { type: 'tool_result' }> {
  return { type: 'tool_result', toolUseId, output, isError }
}

describe('DetailDrawer', () => {
  let originalScrollHeight: PropertyDescriptor | undefined

  beforeEach(() => {
    originalScrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight')
    appSettingsMock.chatFontSize = 12
    chatStoreMock.getState().messages = {}
    chatStoreMock.getState().subagents = {}
    chatStoreMock.getState().workflows = {}
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    if (originalScrollHeight) {
      Object.defineProperty(Element.prototype, 'scrollHeight', originalScrollHeight)
    } else {
      delete (Element.prototype as { scrollHeight?: number }).scrollHeight
    }
  })

  it('renders nothing when the stack is empty', () => {
    const { container } = renderWithI18n(<DetailDrawer stack={[]} {...defaultProps} />)
    expect(container.firstChild).toBeNull()
  })

  it('keeps non-process drawer content on the UI font size', () => {
    appSettingsMock.chatFontSize = 18

    renderWithI18n(<DetailDrawer stack={[sub('missing')]} {...defaultProps} />)

    const drawerBody = screen.getByRole('dialog').querySelector('.overflow-y-auto.p-3')
    expect(drawerBody).not.toHaveAttribute('style')
    expect(drawerBody).not.toHaveAttribute('data-testid')
  })

  it('applies process-region presentation to the subagent message list', () => {
    const sessionId = 's1'
    const parentToolUseId = 'agent-1'
    appSettingsMock.chatFontSize = 18
    chatStoreMock.getState().subagents[sessionId] = [
      {
        parentToolUseId,
        description: 'Inspect implementation',
        state: 'completed',
        startTime: 1,
        endTime: 2,
        toolCount: 1,
        progressHint: '',
        messages: [
          {
            id: 'sub-message-1',
            role: 'assistant',
            parts: [
              { type: 'thinking', text: 'Reviewing the code' },
              { type: 'tool_use', toolUseId: 'sub-tool-1', toolName: 'Bash', input: { command: 'npm test' } },
            ],
          },
        ],
      },
    ]

    renderWithI18n(
      <DetailDrawer stack={[sub(parentToolUseId)]} {...defaultProps} sessionId={sessionId} />,
    )

    expect(screen.getByTestId('subagent-message-list')).toHaveStyle({ fontSize: '18px' })

    const toolToggle = screen.getByRole('button', { name: /Expand tool details/i })
    const toolHeader = toolToggle.parentElement
    expect(toolHeader?.parentElement).toHaveClass('bg-transparent', 'border-0', 'shadow-none')
    expect(toolHeader).toHaveClass('p-0', 'text-text-tertiary')
    fireEvent.click(toolToggle)
    expect(document.querySelector('[data-tool-content]')).toHaveClass('animate-process-item')

    const reasoningToggle = screen.getByRole('button', { name: /Expand thoughts/i })
    fireEvent.click(reasoningToggle)
    expect(document.querySelector('[data-reasoning-content]')).toHaveClass('animate-process-item')
  })

  it('shows no back button at depth 1 (R3)', () => {
    renderWithI18n(<DetailDrawer stack={[sub('a1')]} {...defaultProps} />)
    expect(screen.queryByRole('button', { name: /back/i })).toBeNull()
  })

  it('shows a back button at depth > 1 and calls onPop when clicked (R3, AE1)', () => {
    const onPop = vi.fn()
    renderWithI18n(
      <DetailDrawer stack={[sub('a1'), sub('a2')]} {...defaultProps} onPop={onPop} />,
    )
    const back = screen.getByRole('button', { name: /back/i })
    fireEvent.click(back)
    expect(onPop).toHaveBeenCalledTimes(1)
  })

  it('animates in when opened', () => {
    renderWithI18n(<DetailDrawer stack={[sub('a1')]} {...defaultProps} />)

    expect(screen.getByRole('dialog')).toHaveAttribute('data-state', 'open')
    expect(screen.getByRole('dialog')).toHaveClass('animate-detail-drawer-enter')
  })

  it('animates out before the X button calls onClose (R4, AE4)', () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    renderWithI18n(
      <DetailDrawer stack={[sub('a1')]} {...defaultProps} onClose={onClose} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /close/i }))

    expect(screen.getByRole('dialog', { hidden: true })).toHaveAttribute('data-state', 'closing')
    expect(screen.getByRole('dialog', { hidden: true })).toHaveClass('animate-detail-drawer-exit')
    expect(onClose).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(200))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape animates out before calling onClose (R9, AE4)', () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    renderWithI18n(
      <DetailDrawer stack={[sub('a1')]} {...defaultProps} onClose={onClose} />,
    )
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(onClose).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(200))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes immediately when reduced motion is preferred', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }))
    const onClose = vi.fn()
    renderWithI18n(
      <DetailDrawer stack={[sub('a1')]} {...defaultProps} onClose={onClose} />,
    )

    fireEvent.click(screen.getByRole('button', { name: /close/i }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog')).toHaveAttribute('data-state', 'open')
  })

  it('restores focus and removes keyboard handling while closing', () => {
    vi.useFakeTimers()
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const onClose = vi.fn()
    renderWithI18n(
      <DetailDrawer stack={[sub('a1')]} {...defaultProps} onClose={onClose} />,
    )
    expect(screen.getByRole('dialog')).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(opener).toHaveFocus()

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    act(() => vi.advanceTimersByTime(200))
    expect(onClose).toHaveBeenCalledTimes(1)
    opener.remove()
  })

  it('keeps resize behavior while the animated drawer is open', () => {
    const onWidthChange = vi.fn()
    renderWithI18n(
      <DetailDrawer
        stack={[sub('a1')]}
        {...defaultProps}
        onWidthChange={onWidthChange}
      />,
    )
    const dialog = screen.getByRole('dialog')
    const resizeHandle = dialog.querySelector<HTMLElement>('.cursor-col-resize')
    expect(resizeHandle).not.toBeNull()
    expect(dialog.style.getPropertyValue('--detail-drawer-width')).toBe('400px')

    fireEvent.mouseDown(resizeHandle!, { clientX: 400 })
    fireEvent.mouseMove(document, { clientX: 250 })
    fireEvent.mouseMove(document, { clientX: -600 })
    fireEvent.mouseUp(document)

    expect(onWidthChange).toHaveBeenNthCalledWith(1, 550)
    expect(onWidthChange).toHaveBeenLastCalledWith(800)
  })

  it('renders a dialog with an accessible label', () => {
    renderWithI18n(<DetailDrawer stack={[sub('a1')]} {...defaultProps} />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})

describe('DetailDrawer process region real-time updates', () => {
  let originalScrollHeight: PropertyDescriptor | undefined

  beforeEach(() => {
    originalScrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight')
    appSettingsMock.chatFontSize = 12
    chatStoreMock.getState().messages = {}
    chatStoreMock.getState().subagents = {}
    chatStoreMock.getState().workflows = {}
  })

  afterEach(() => {
    cleanup()
    if (originalScrollHeight) {
      Object.defineProperty(Element.prototype, 'scrollHeight', originalScrollHeight)
    } else {
      delete (Element.prototype as { scrollHeight?: number }).scrollHeight
    }
  })

  it('lets process-region messages fill the drawer body width', () => {
    const sessionId = 's1'
    const messageId = 'm1'
    chatStoreMock.setMessages(sessionId, [
      {
        id: messageId,
        role: 'assistant',
        timestamp: 1,
        parts: [toolUsePart('Bash', 'tu-1', { command: 'npm test' })],
      },
    ])

    renderWithI18n(
      <DetailDrawer stack={[processView(messageId)]} {...defaultProps} sessionId={sessionId} />,
    )

    const drawerBody = screen.getByRole('dialog').querySelector('.overflow-y-auto.p-3')
    const message = drawerBody?.firstElementChild
    expect(message).toHaveClass('w-full', 'max-w-none')
    expect(message).not.toHaveClass('max-w-[95%]')
  })

  it('uses the configured chat font size for process-region content', () => {
    const sessionId = 's1'
    const messageId = 'm1'
    appSettingsMock.chatFontSize = 18
    chatStoreMock.setMessages(sessionId, [
      {
        id: messageId,
        role: 'assistant',
        timestamp: 1,
        parts: [toolUsePart('Bash', 'tu-1', { command: 'npm test' })],
      },
    ])

    renderWithI18n(
      <DetailDrawer stack={[processView(messageId)]} {...defaultProps} sessionId={sessionId} />,
    )

    expect(screen.getByTestId('process-region-content')).toHaveStyle({ fontSize: '18px' })
  })

  it('renders process-region tool headers with the same lightweight style as reasoning', () => {
    const sessionId = 's1'
    const messageId = 'm1'
    chatStoreMock.setMessages(sessionId, [
      {
        id: messageId,
        role: 'assistant',
        timestamp: 1,
        parts: [toolUsePart('Bash', 'tu-1', { command: 'npm test' })],
      },
    ])

    renderWithI18n(
      <DetailDrawer stack={[processView(messageId)]} {...defaultProps} sessionId={sessionId} />,
    )

    const toggle = screen.getByRole('button', { name: /Expand tool details/i })
    const header = toggle.parentElement
    const tool = header?.parentElement
    expect(tool).toHaveClass('border-0', 'bg-transparent', 'shadow-none')
    expect(tool).not.toHaveClass('bg-surface-hover/30')
    expect(header).toHaveClass('gap-2', 'p-0', 'text-text-tertiary')
    expect(header).not.toHaveClass('p-2')
  })

  it('enables expand and collapse animations for process-region tool cards', async () => {
    const sessionId = 's1'
    const messageId = 'm1'
    chatStoreMock.setMessages(sessionId, [
      {
        id: messageId,
        role: 'assistant',
        timestamp: 1,
        parts: [toolUsePart('Bash', 'tu-1', { command: 'npm test' })],
      },
    ])

    renderWithI18n(
      <DetailDrawer stack={[processView(messageId)]} {...defaultProps} sessionId={sessionId} />,
    )

    await userEvent.click(screen.getByRole('button', { name: /Expand tool details/i }))
    expect(document.querySelector('[data-tool-content]')).toHaveClass('animate-process-item')
  })

  it('renders a new tool card when a tool_use part is appended while the drawer is open', async () => {
    const sessionId = 's1'
    const messageId = 'm1'
    const initial: ChatMessage[] = [
      {
        id: messageId,
        role: 'assistant',
        timestamp: 1,
        parts: [thinkingPart('planning'), toolUsePart('Bash', 'tu-1', { command: 'npm test' })],
      },
    ]
    chatStoreMock.setMessages(sessionId, initial)

    renderWithI18n(
      <DetailDrawer stack={[processView(messageId)]} {...defaultProps} sessionId={sessionId} />,
    )

    expect(screen.getByText('Bash')).toBeInTheDocument()
    expect(screen.queryByText('Edit')).not.toBeInTheDocument()

    const updated: ChatMessage[] = [
      {
        id: messageId,
        role: 'assistant',
        timestamp: 1,
        parts: [
          thinkingPart('planning'),
          toolUsePart('Bash', 'tu-1', { command: 'npm test' }),
          toolUsePart('Edit', 'tu-2', { file_path: 'src/App.tsx' }),
        ],
      },
    ]
    chatStoreMock.setMessages(sessionId, updated)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.getByText('Edit')).toBeInTheDocument()
  })

  it('renders a new tool card when the active turn gains another assistant message', async () => {
    const sessionId = 's1'
    const firstMessageId = 'm1'
    const firstToolUseId = 'tu-1'
    const initial: ChatMessage[] = [
      {
        id: firstMessageId,
        role: 'assistant',
        timestamp: 1,
        parts: [toolUsePart('Bash', firstToolUseId, { command: 'npm test' })],
      },
    ]
    chatStoreMock.setMessages(sessionId, initial)

    renderWithI18n(
      <DetailDrawer
        stack={[processView(firstMessageId)]}
        {...defaultProps}
        sessionId={sessionId}
      />,
    )

    expect(screen.getByText('Bash')).toBeInTheDocument()
    expect(screen.queryByText('Edit')).not.toBeInTheDocument()

    await act(async () => {
      chatStoreMock.setMessages(sessionId, [
        ...initial,
        {
          id: 'result-1',
          role: 'user',
          timestamp: 2,
          parts: [toolResultPart(firstToolUseId, 'ok')],
        },
        {
          id: 'm2',
          role: 'assistant',
          timestamp: 3,
          parts: [toolUsePart('Edit', 'tu-2', { file_path: 'src/App.tsx' })],
        },
      ])
    })

    expect(screen.getByText('Edit')).toBeInTheDocument()
  })

  it('updates streaming tool input preview when inputJsonStream changes', async () => {
    const sessionId = 's1'
    const messageId = 'm1'
    const initial: ChatMessage[] = [
      {
        id: messageId,
        role: 'assistant',
        timestamp: 1,
        parts: [toolUsePart('Bash', 'tu-1', {}, '{"command":"npm ')],
      },
    ]
    chatStoreMock.setMessages(sessionId, initial)

    renderWithI18n(
      <DetailDrawer stack={[processView(messageId)]} {...defaultProps} sessionId={sessionId} />,
    )

    // Streaming cards are collapsed by default: expand before the preview is visible.
    expect(
      screen.queryByText((content) => content.includes('command":"npm')),
    ).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Expand tool details/i }))
    expect(screen.getByText((content) => content.includes('command":"npm'))).toBeInTheDocument()

    const updated: ChatMessage[] = [
      {
        id: messageId,
        role: 'assistant',
        timestamp: 1,
        parts: [toolUsePart('Bash', 'tu-1', {}, '{"command":"npm test"}')],
      },
    ]
    chatStoreMock.setMessages(sessionId, updated)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.getByText((content) => content.includes('npm test'))).toBeInTheDocument()
  })

  it('marks a tool card as completed when its tool_result arrives', async () => {
    const sessionId = 's1'
    const messageId = 'm1'
    const toolUseId = 'tu-1'
    const initial: ChatMessage[] = [
      {
        id: messageId,
        role: 'assistant',
        timestamp: 1,
        parts: [toolUsePart('Bash', toolUseId, { command: 'npm test' })],
      },
    ]
    chatStoreMock.setMessages(sessionId, initial)

    renderWithI18n(
      <DetailDrawer stack={[processView(messageId)]} {...defaultProps} sessionId={sessionId} />,
    )

    expect(screen.getByText('Running')).toBeInTheDocument()

    const updated: ChatMessage[] = [
      ...initial,
      {
        id: 'result-1',
        role: 'user',
        timestamp: 2,
        parts: [toolResultPart(toolUseId, 'ok')],
      },
    ]
    chatStoreMock.setMessages(sessionId, updated)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.getByText('Completed')).toBeInTheDocument()
  })

  it('does not render drawer content when the drawer is closed', async () => {
    const sessionId = 's1'
    const messageId = 'm1'
    chatStoreMock.setMessages(sessionId, [
      {
        id: messageId,
        role: 'assistant',
        timestamp: 1,
        parts: [toolUsePart('Bash', 'tu-1', { command: 'npm test' })],
      },
    ])

    const { container } = renderWithI18n(
      <DetailDrawer stack={[]} {...defaultProps} sessionId={sessionId} />,
    )
    expect(container.firstChild).toBeNull()
  })
})

describe('DetailDrawer process region default collapse state', () => {
  beforeEach(() => {
    chatStoreMock.getState().messages = {}
    chatStoreMock.getState().subagents = {}
    chatStoreMock.getState().workflows = {}
  })

  afterEach(() => {
    cleanup()
  })

  it('keeps thinking trigger visible but content collapsed by default', async () => {
    const sessionId = 's1'
    const messageId = 'm1'
    chatStoreMock.setMessages(sessionId, [
      {
        id: messageId,
        role: 'assistant',
        timestamp: 1,
        parts: [thinkingPart('hidden reasoning')],
      },
    ])

    renderWithI18n(
      <DetailDrawer stack={[processView(messageId)]} {...defaultProps} sessionId={sessionId} />,
    )

    // The trigger row text is static; only the row-end icon toggles the body.
    expect(screen.getByText(/Thought for a few seconds/i)).toBeInTheDocument()
    expect(screen.queryByText('hidden reasoning')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Expand thoughts/i }))
    expect(screen.getByText('hidden reasoning')).toBeVisible()
  })

  it('shows the tool header with body collapsed by default and expands via the header-end icon', async () => {
    const sessionId = 's1'
    const messageId = 'm1'
    chatStoreMock.setMessages(sessionId, [
      {
        id: messageId,
        role: 'assistant',
        timestamp: 1,
        parts: [toolUsePart('Bash', 'tu-1', { command: 'npm test' })],
      },
    ])

    renderWithI18n(
      <DetailDrawer stack={[processView(messageId)]} {...defaultProps} sessionId={sessionId} />,
    )

    expect(screen.getByText('Bash')).toBeInTheDocument()
    expect(screen.queryByText('Parameters')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Show details/i })).not.toBeInTheDocument()

    const toggle = screen.getByRole('button', { name: /Expand tool details/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await userEvent.click(toggle)
    expect(screen.getByText('Parameters')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Collapse tool details/i }),
    ).toHaveAttribute('aria-expanded', 'true')

    const body = screen.getByText('Parameters').closest('[data-tool-content]')
    expect(body).toHaveClass('max-h-[40vh]')
    expect(body).toHaveClass('overflow-y-auto')
  })

  it('does not collapse text parts when they appear in the drawer', () => {
    const sessionId = 's1'
    const messageId = 'm1'
    chatStoreMock.setMessages(sessionId, [
      {
        id: messageId,
        role: 'assistant',
        timestamp: 1,
        parts: [
          thinkingPart('planning'),
          toolUsePart('Bash', 'tu-1', { command: 'npm test' }),
          textPart('visible answer'),
        ],
      },
    ])

    renderWithI18n(
      <DetailDrawer stack={[processView(messageId)]} {...defaultProps} sessionId={sessionId} />,
    )

    // The drawer opens the process region (thinking + tool), not the final text.
    // Text remains visible as its own region in the main chat; inside the drawer
    // only the process parts are rendered.
    expect(screen.getByText('Bash')).toBeInTheDocument()
    expect(screen.queryByText('visible answer')).not.toBeInTheDocument()
  })
})
