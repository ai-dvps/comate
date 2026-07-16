import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'

import DetailDrawer from './DetailDrawer'
import i18n from '../i18n'
import type { DrawerView } from './detail-drawer-view'
import type { ChatMessage } from '../types/message'

const renderWithI18n = (ui: React.ReactElement) =>
  render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)

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

  it('renders nothing when the stack is empty', () => {
    const { container } = renderWithI18n(<DetailDrawer stack={[]} {...defaultProps} />)
    expect(container.firstChild).toBeNull()
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

  it('X button calls onClose (R4, AE4)', () => {
    const onClose = vi.fn()
    renderWithI18n(
      <DetailDrawer stack={[sub('a1')]} {...defaultProps} onClose={onClose} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape calls onClose (R9, AE4)', () => {
    const onClose = vi.fn()
    renderWithI18n(
      <DetailDrawer stack={[sub('a1')]} {...defaultProps} onClose={onClose} />,
    )
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(onClose).toHaveBeenCalledTimes(1)
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
  let originalScrollHeight: PropertyDescriptor | undefined

  beforeEach(() => {
    originalScrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight')
    Object.defineProperty(Element.prototype, 'scrollHeight', {
      configurable: true,
      value: 300,
    })
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

    const trigger = screen.getByRole('button', { name: /Thought for a few seconds/i })
    expect(trigger).toBeInTheDocument()
    expect(screen.queryByText('hidden reasoning')).not.toBeInTheDocument()

    await userEvent.click(trigger)
    expect(screen.getByText('hidden reasoning')).toBeVisible()
  })

  it('shows tool header and hides tool input/output behind a toggle by default', async () => {
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
    const toggle = screen.getByRole('button', { name: /Show details/i })
    expect(toggle).toBeInTheDocument()

    await userEvent.click(toggle)
    expect(screen.getByRole('button', { name: /Hide details/i })).toBeInTheDocument()
    expect(screen.getByText('Parameters')).toBeInTheDocument()
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
