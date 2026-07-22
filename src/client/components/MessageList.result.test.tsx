import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { act, render, cleanup } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'

import MessageList from './MessageList'
import i18n from '../i18n'
import type { ChatMessage } from '../types/message'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

vi.mock('react-virtuoso', async () => {
  const ReactModule = await import('react')
  const Virtuoso = ReactModule.forwardRef(function MockVirtuoso(
    props: { data?: unknown[]; itemContent?: (index: number, item: unknown) => React.ReactNode },
    ref: React.ForwardedRef<unknown>,
  ) {
    ReactModule.useImperativeHandle(ref, () => ({ scrollToIndex: vi.fn(), autoscrollToBottom: vi.fn() }))
    return <div data-testid="conversation-list-scroll">{(props.data ?? []).map((item, index) => props.itemContent?.(index, item))}</div>
  })
  return { Virtuoso }
})

const renderCounter = new Map<string, number>()
vi.mock('./ChatMessageRenderer', () => {
  const MockedChatMessageRenderer = React.memo(function MockedChatMessageRenderer({
    message,
  }: {
    message: { id: string }
  }) {
    renderCounter.set(message.id, (renderCounter.get(message.id) || 0) + 1)
    return <div data-testid={`message-${message.id}`}>{message.id}</div>
  })
  return {
    default: MockedChatMessageRenderer,
    CompactBoundary: () => <div data-testid="compact-boundary" />,
  }
})

const chatStoreMock = vi.hoisted(() => {
  type Listener = () => void
  const listeners = new Set<Listener>()
  const state = {
    messages: {} as Record<string, ChatMessage[]>,
    autoApprovedTools: {} as Record<string, Record<string, 'auto' | 'readonly'>>,
    isCompacting: {} as Record<string, boolean>,
    compactingStartTime: {} as Record<string, number>,
    totalMessageCount: {} as Record<string, number>,
    isLoadingOlderMessages: {} as Record<string, boolean>,
    fetchOlderMessages: vi.fn(() => Promise.resolve()),
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

vi.mock('../hooks/use-app-settings', () => ({
  useAppSettings: () => ({ chatFontSize: 'base', displayMode: 'result' as const }),
}))

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <div>{children}</div>,
}))

function textPart(text: string): Extract<ChatMessage['parts'][number], { type: 'text' }> {
  return { type: 'text', text }
}

describe('MessageList result mode render stability', () => {
  beforeEach(() => {
    cleanup()
    chatStoreMock.getState().messages = {}
    chatStoreMock.getState().autoApprovedTools = {}
    chatStoreMock.getState().isCompacting = {}
    chatStoreMock.getState().compactingStartTime = {}
    chatStoreMock.getState().totalMessageCount = {}
    chatStoreMock.getState().isLoadingOlderMessages = {}
    renderCounter.clear()
  })

  it('keeps one virtual shell when a result-mode session crosses the legacy threshold', async () => {
    const sessionId = 's1'
    const workspaceId = 'ws1'

    const initialMessages: ChatMessage[] = Array.from({ length: 49 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      parts: [textPart(String(index))],
      timestamp: index,
    }))

    chatStoreMock.setMessages(sessionId, initialMessages)

    const rendered = renderWithI18n(
      <MessageList
        sessionId={sessionId}
        workspaceId={workspaceId}
        onOpenDrawer={() => {}}
        isVisible={true}
      />,
    )

    const shell = rendered.getByTestId('conversation-list-scroll')

    const nextMessages: ChatMessage[] = [
      ...initialMessages,
      { id: 'message-49', role: 'assistant', parts: [textPart('49')], timestamp: 49 },
      { id: 'message-50', role: 'user', parts: [textPart('50')], timestamp: 50 },
    ]

    await act(async () => {
      chatStoreMock.setMessages(sessionId, nextMessages)
    })

    expect(rendered.getByTestId('conversation-list-scroll')).toBe(shell)
  })

  it('does not render stable rows when one result region changes', async () => {
    const prompt: ChatMessage = { id: 'u1', role: 'user', parts: [textPart('first')], timestamp: 1 }
    const stable: ChatMessage = { id: 'a1', role: 'assistant', parts: [textPart('stable')], timestamp: 2 }
    const separator: ChatMessage = { id: 'u2', role: 'user', parts: [textPart('second')], timestamp: 3 }
    const active: ChatMessage = {
      id: 'a2',
      role: 'assistant',
      parts: [{ type: 'tool_use', toolUseId: 'tool-1', toolName: 'Bash', input: {}, state: 'complete' }],
      timestamp: 4,
    }
    chatStoreMock.setMessages('s1', [prompt, stable, separator, active])

    renderWithI18n(<MessageList sessionId="s1" workspaceId="ws1" onOpenDrawer={() => {}} />)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(renderCounter.get('a1')).toBe(1)
    expect(renderCounter.get('a2')).toBe(1)

    await act(async () => {
      chatStoreMock.setMessages('s1', [
        prompt,
        stable,
        separator,
        active,
        {
          id: 'r1',
          role: 'user',
          parts: [{ type: 'tool_result', toolUseId: 'tool-1', output: 'done', isError: false }],
          timestamp: 5,
        },
      ])
    })

    expect(renderCounter.get('a1')).toBe(1)
    expect(renderCounter.get('a2')).toBe(2)
  })
})
