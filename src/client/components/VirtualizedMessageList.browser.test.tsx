import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, waitFor, cleanup } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import '../index.css'

import VirtualizedMessageList from './VirtualizedMessageList'
import i18n from '../i18n'
import type { ChatMessage, MessagePart } from '../types/message'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

const chatStoreMock = vi.hoisted(() => {
  type Listener = () => void
  const listeners = new Set<Listener>()
  const state = {
    messages: {} as Record<string, ChatMessage[]>,
    totalMessageCount: {} as Record<string, number>,
    isLoadingOlderMessages: {} as Record<string, boolean>,
    isCompacting: {} as Record<string, boolean>,
    autoApprovedTools: {} as Record<string, Record<string, 'auto' | 'readonly'>>,
    fetchOlderMessages: vi.fn(),
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
  useChatStore.getState = () => state

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
    setTotalMessageCount: (sessionId: string, count: number) => {
      state.totalMessageCount[sessionId] = count
      notify()
    },
    useChatStore,
  }
})

vi.mock('../stores/chat-store', () => ({
  useChatStore: chatStoreMock.useChatStore,
}))

const appSettingsMock = vi.hoisted(() => ({
  displayMode: 'result' as const,
}))

vi.mock('../hooks/use-app-settings', () => ({
  useAppSettings: () => ({
    chatFontSize: 'base',
    displayMode: appSettingsMock.displayMode,
  }),
}))

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <div>{children}</div>,
}))

function textPart(text: string): Extract<MessagePart, { type: 'text' }> {
  return { type: 'text', text }
}

function makeMessages(count: number): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (let i = 0; i < count; i++) {
    if (i % 2 === 0) {
      messages.push({
        id: `user-${i}`,
        role: 'user',
        parts: [textPart(`User message ${i}`)],
        timestamp: i,
      })
    } else {
      messages.push({
        id: `assistant-${i}`,
        role: 'assistant',
        parts: [textPart(`Assistant message ${i}`)],
        timestamp: i,
      })
    }
  }
  return messages
}

describe('VirtualizedMessageList result mode streaming scroll', () => {
  beforeEach(() => {
    cleanup()
    chatStoreMock.getState().messages = {}
    chatStoreMock.getState().totalMessageCount = {}
    chatStoreMock.getState().isLoadingOlderMessages = {}
    chatStoreMock.getState().isCompacting = {}
    chatStoreMock.getState().autoApprovedTools = {}
    appSettingsMock.displayMode = 'result'
  })

  it('keeps the panel scrolled to bottom when streaming grows the last merged turn', async () => {
    const sessionId = 'session-1'
    const workspaceId = 'ws-1'
    const initialMessages = makeMessages(60)
    chatStoreMock.setMessages(sessionId, initialMessages)
    chatStoreMock.setTotalMessageCount(sessionId, 60)

    renderWithI18n(
      <div style={{ height: '400px', width: '600px', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: '1 1 0%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <VirtualizedMessageList
            sessionId={sessionId}
            workspaceId={workspaceId}
            onOpenDrawer={() => {}}
            isVisible={true}
          />
        </div>
      </div>,
    )

    const scrollContainer = document.querySelector('[data-testid="virtualized-message-list-scroll"]') as HTMLDivElement
    expect(scrollContainer).toBeTruthy()
    if (!scrollContainer) return

    // Disable scroll anchoring so the browser does not mask missing auto-scroll logic.
    scrollContainer.style.overflowAnchor = 'none'

    // Wait for the virtualizer to measure and produce a scrollable area.
    await waitFor(() => {
      expect(scrollContainer.scrollHeight).toBeGreaterThan(scrollContainer.clientHeight)
    }, { timeout: 5000 })

    // Start at the bottom as a user would during active streaming.
    scrollContainer.scrollTop = scrollContainer.scrollHeight - scrollContainer.clientHeight
    expect(scrollContainer.scrollTop).toBeGreaterThan(0)
    const initialHeight = scrollContainer.scrollHeight

    // Allow any async scroll settling to complete.
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Simulate a text_delta that grows the last assistant turn without adding a new message.
    const lastAssistant = initialMessages[initialMessages.length - 1]
    const lastText = lastAssistant.parts.find((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')?.text ?? ''
    const grownMessages = [
      ...initialMessages.slice(0, -1),
      {
        ...lastAssistant,
        parts: [textPart(lastText + '\n' + 'Streaming line\n'.repeat(50))],
      },
    ]
    chatStoreMock.setMessages(sessionId, grownMessages)

    // The panel should follow the growing content and stay near the bottom.
    // First wait for the virtualizer to remeasure and the content to grow.
    await waitFor(
      () => {
        expect(scrollContainer.scrollHeight).toBeGreaterThan(initialHeight)
      },
      { timeout: 2000 },
    )

    // Now the scroll should have followed the growth.
    await waitFor(
      () => {
        const distanceFromBottom =
          scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight
        expect(distanceFromBottom).toBeLessThan(5)
      },
      { timeout: 2000 },
    )
  })

  it('keeps the panel scrolled to bottom when a new assistant message merges in result mode', async () => {
    const sessionId = 'session-2'
    const workspaceId = 'ws-1'
    // End with two consecutive assistant messages so result mode merges them.
    const baseMessages = makeMessages(58)
    baseMessages.push({
      id: 'assistant-prev',
      role: 'assistant',
      parts: [textPart('Previous assistant chunk')],
      timestamp: 100,
    })
    chatStoreMock.setMessages(sessionId, baseMessages)
    chatStoreMock.setTotalMessageCount(sessionId, 59)

    renderWithI18n(
      <div style={{ height: '400px', width: '600px', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: '1 1 0%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <VirtualizedMessageList
            sessionId={sessionId}
            workspaceId={workspaceId}
            onOpenDrawer={() => {}}
            isVisible={true}
          />
        </div>
      </div>,
    )

    const scrollContainer = document.querySelector('[data-testid="virtualized-message-list-scroll"]') as HTMLDivElement
    expect(scrollContainer).toBeTruthy()
    if (!scrollContainer) return

    // Disable scroll anchoring so the browser does not mask missing auto-scroll logic.
    scrollContainer.style.overflowAnchor = 'none'

    // Wait for the virtualizer to measure and produce a scrollable area.
    await waitFor(() => {
      expect(scrollContainer.scrollHeight).toBeGreaterThan(scrollContainer.clientHeight)
    }, { timeout: 5000 })

    scrollContainer.scrollTop = scrollContainer.scrollHeight - scrollContainer.clientHeight
    expect(scrollContainer.scrollTop).toBeGreaterThan(0)

    // Allow any async scroll settling to complete.
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Add another consecutive assistant message; in result mode it merges with the previous one.
    const mergedMessages: ChatMessage[] = [
      ...baseMessages,
      {
        id: 'assistant-new',
        role: 'assistant',
        parts: [textPart('\nMerged assistant chunk\n'.repeat(30))],
        timestamp: 101,
      },
    ]
    chatStoreMock.setMessages(sessionId, mergedMessages)
    chatStoreMock.setTotalMessageCount(sessionId, 60)

    await waitFor(
      () => {
        const distanceFromBottom =
          scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight
        expect(distanceFromBottom).toBeLessThan(5)
      },
      { timeout: 2000 },
    )
  })
})
