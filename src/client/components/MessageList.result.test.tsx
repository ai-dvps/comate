import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, cleanup } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'

import MessageList from './MessageList'
import i18n from '../i18n'
import type { ChatMessage } from '../types/message'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

const renderCounter = new Map<string, number>()
const virtualShellCounter = { renders: 0 }

vi.mock('./VirtualizedMessageList', () => ({
  default: function MockVirtualizedMessageList() {
    virtualShellCounter.renders += 1
    return <div data-testid="result-virtual-shell" />
  },
}))

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
    virtualShellCounter.renders = 0
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

    const shell = rendered.getByTestId('result-virtual-shell')

    const nextMessages: ChatMessage[] = [
      ...initialMessages,
      { id: 'message-49', role: 'assistant', parts: [textPart('49')], timestamp: 49 },
      { id: 'message-50', role: 'user', parts: [textPart('50')], timestamp: 50 },
    ]

    chatStoreMock.setMessages(sessionId, nextMessages)

    // Wait for React to re-render after store notification.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(rendered.getByTestId('result-virtual-shell')).toBe(shell)
    expect(virtualShellCounter.renders).toBeGreaterThan(1)
  })
})
