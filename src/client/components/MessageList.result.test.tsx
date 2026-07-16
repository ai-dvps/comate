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
    renderCounter.clear()
  })

  it('only re-renders the affected merged turn when a new assistant message arrives in result mode', async () => {
    const sessionId = 's1'
    const workspaceId = 'ws1'

    const initialMessages: ChatMessage[] = [
      { id: 'user-1', role: 'user', parts: [textPart('Hello')], timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', parts: [textPart('Hi')], timestamp: 2 },
      { id: 'user-2', role: 'user', parts: [textPart('How are you?')], timestamp: 3 },
      { id: 'assistant-2', role: 'assistant', parts: [textPart('I am fine')], timestamp: 4 },
    ]

    chatStoreMock.setMessages(sessionId, initialMessages)

    renderWithI18n(
      <MessageList
        sessionId={sessionId}
        workspaceId={workspaceId}
        onOpenDrawer={() => {}}
        isVisible={true}
      />,
    )

    // Capture initial render counts.
    const initialCounts = new Map(renderCounter)

    // Add a new consecutive assistant message; in result mode it merges with assistant-2.
    const nextMessages: ChatMessage[] = [
      ...initialMessages,
      { id: 'assistant-3', role: 'assistant', parts: [textPart('Thanks for asking')], timestamp: 5 },
    ]

    chatStoreMock.setMessages(sessionId, nextMessages)

    // Wait for React to re-render after store notification.
    await new Promise((resolve) => setTimeout(resolve, 0))

    const finalCounts = new Map(renderCounter)

    // In result mode the merged turn should re-render because its content changed.
    // The mock sees the adapted id, which becomes "assistant-2|assistant-3" after merge.
    const mergedRenderCount =
      (finalCounts.get('assistant-2|assistant-3') ?? 0) +
      (finalCounts.get('assistant-2') ?? 0)
    expect(mergedRenderCount).toBeGreaterThan(
      initialCounts.get('assistant-2') ?? 0,
    )

    // Messages that did not change should not re-render.
    expect(finalCounts.get('user-1')).toBe(initialCounts.get('user-1'))
    expect(finalCounts.get('assistant-1')).toBe(initialCounts.get('assistant-1'))
    expect(finalCounts.get('user-2')).toBe(initialCounts.get('user-2'))
  })
})
