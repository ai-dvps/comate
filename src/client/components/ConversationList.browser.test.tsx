import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { act, render, waitFor, cleanup } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import '../index.css'

import MessageList from './MessageList'
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
    isCompacting: {} as Record<string, boolean>,
    autoApprovedTools: {} as Record<string, Record<string, 'auto' | 'readonly'>>,
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
  displayMode: 'result' as 'result' | 'linear',
}))

vi.mock('../hooks/use-app-settings', () => ({
  useAppSettings: () => ({
    chatFontSize: 'base',
    displayMode: appSettingsMock.displayMode,
  }),
}))

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <div style={{ whiteSpace: 'pre-wrap' }}>{children}</div>,
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

function makeHeavyMessages(count: number): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (let index = 0; index < count; index += 1) {
    const toolStep = Math.floor(index / 20)
    if (index % 20 === 18) {
      messages.push({
        id: `assistant-tool-${toolStep}`,
        role: 'assistant',
        parts: [{
          type: 'tool_use',
          toolUseId: `tool-${toolStep}`,
          toolName: 'Bash',
          input: { command: `echo ${toolStep}` },
          state: 'complete',
        }],
        timestamp: index,
      })
    } else if (index % 20 === 19) {
      messages.push({
        id: `tool-result-${toolStep}`,
        role: 'user',
        parts: [{ type: 'tool_result', toolUseId: `tool-${toolStep}`, output: 'done', isError: false }],
        timestamp: index,
      })
    } else {
      messages.push({
        id: `message-${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        parts: [textPart(`Message ${index}`)],
        timestamp: index,
      })
    }
  }
  return messages
}

describe('ConversationList result mode streaming scroll', () => {
  beforeEach(() => {
    cleanup()
    chatStoreMock.getState().messages = {}
    chatStoreMock.getState().totalMessageCount = {}
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
          <MessageList
            sessionId={sessionId}
            workspaceId={workspaceId}
            onOpenDrawer={() => {}}
            isVisible={true}
          />
        </div>
      </div>,
    )

    const scrollContainer = document.querySelector('[data-testid="conversation-list-scroll"]') as HTMLDivElement
    expect(scrollContainer).toBeTruthy()
    if (!scrollContainer) return

    // Disable scroll anchoring so the browser does not mask missing auto-scroll logic.
    scrollContainer.style.overflowAnchor = 'none'

    // Wait for the complete list to produce a scrollable area.
    await waitFor(() => {
      expect(scrollContainer.scrollHeight).toBeGreaterThan(scrollContainer.clientHeight)
    }, { timeout: 5000 })

    // Start at the bottom as a user would during active streaming.
    scrollContainer.scrollTop = scrollContainer.scrollHeight - scrollContainer.clientHeight
    expect(scrollContainer.scrollTop).toBeGreaterThan(0)
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
    await act(async () => {
      chatStoreMock.setMessages(sessionId, grownMessages)
    })

    // The stable contract is the final distance from the physical bottom.
    await waitFor(
      () => {
        const distanceFromBottom =
          scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight
        expect(distanceFromBottom).toBeLessThan(5)
      },
      { timeout: 2000 },
    )
  })

  it('does not pull the panel back to bottom when streaming starts as the user scrolls up', async () => {
    const sessionId = 'session-scroll-away'
    const initialMessages = makeMessages(60)
    chatStoreMock.setMessages(sessionId, initialMessages)
    chatStoreMock.setTotalMessageCount(sessionId, 60)

    renderWithI18n(
      <div style={{ height: '400px', width: '600px', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: '1 1 0%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <MessageList
            sessionId={sessionId}
            workspaceId="ws-1"
            onOpenDrawer={() => {}}
            isVisible={true}
          />
        </div>
      </div>,
    )

    const scrollContainer = document.querySelector('[data-testid="conversation-list-scroll"]') as HTMLDivElement
    expect(scrollContainer).toBeTruthy()
    scrollContainer.style.overflowAnchor = 'none'

    await waitFor(() => {
      expect(scrollContainer.scrollHeight).toBeGreaterThan(scrollContainer.clientHeight)
    }, { timeout: 5000 })

    scrollContainer.scrollTop = scrollContainer.scrollHeight - scrollContainer.clientHeight
    await new Promise((resolve) => setTimeout(resolve, 100))

    // A single wheel/trackpad step can be smaller than the bottom proximity
    // threshold, but it still represents explicit user intent to stop following.
    const scrolledAwayTop = Math.max(0, scrollContainer.scrollTop - 20)
    await act(async () => {
      scrollContainer.dispatchEvent(new WheelEvent('wheel', { deltaY: -20 }))
      scrollContainer.scrollTop = scrolledAwayTop
      scrollContainer.dispatchEvent(new Event('scroll'))
    })

    const lastAssistant = initialMessages[initialMessages.length - 1]
    const grownMessages = [
      ...initialMessages.slice(0, -1),
      {
        ...lastAssistant,
        parts: [textPart('Streaming line\n'.repeat(50))],
      },
    ]
    await act(async () => {
      chatStoreMock.setMessages(sessionId, grownMessages)
    })

    await waitFor(() => {
      expect(scrollContainer.scrollHeight).toBeGreaterThan(
        scrollContainer.clientHeight + scrolledAwayTop,
      )
    }, { timeout: 2000 })

    await waitFor(() => {
      const distanceFromBottom =
        scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight
      expect(distanceFromBottom).toBeGreaterThan(200)
    }, { timeout: 2000 })
    expect(document.querySelector('[aria-label="Scroll to bottom"]')).toBeTruthy()

    // Returning to the bottom should opt back into following future growth.
    scrollContainer.scrollTop = scrollContainer.scrollHeight - scrollContainer.clientHeight
    scrollContainer.dispatchEvent(new Event('scroll'))
    await new Promise((resolve) => setTimeout(resolve, 50))

    const heightBeforeFollowingAgain = scrollContainer.scrollHeight
    chatStoreMock.setMessages(sessionId, [
      ...grownMessages.slice(0, -1),
      {
        ...lastAssistant,
        parts: [textPart('Streaming line\n'.repeat(100))],
      },
    ])

    await waitFor(() => {
      expect(scrollContainer.scrollHeight).toBeGreaterThan(heightBeforeFollowingAgain)
    }, { timeout: 2000 })
    await waitFor(() => {
      const distanceFromBottom =
        scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight
      expect(distanceFromBottom).toBeLessThan(5)
    }, { timeout: 2000 })
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
          <MessageList
            sessionId={sessionId}
            workspaceId={workspaceId}
            onOpenDrawer={() => {}}
            isVisible={true}
          />
        </div>
      </div>,
    )

    const scrollContainer = document.querySelector('[data-testid="conversation-list-scroll"]') as HTMLDivElement
    expect(scrollContainer).toBeTruthy()
    if (!scrollContainer) return

    // Disable scroll anchoring so the browser does not mask missing auto-scroll logic.
    scrollContainer.style.overflowAnchor = 'none'

    // Wait for the complete list to produce a scrollable area.
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

  it('opens a 2,000-message transcript at the stable tail without overlap', async () => {
    const sessionId = 'session-heavy'
    const messages = makeHeavyMessages(2_000)
    const longTasks: number[] = []
    const observer = typeof PerformanceObserver !== 'undefined'
      ? new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTasks.push(entry.duration)
        })
      : null
    observer?.observe({ type: 'longtask', buffered: true })
    chatStoreMock.setMessages(sessionId, messages)
    chatStoreMock.setTotalMessageCount(sessionId, messages.length)

    renderWithI18n(
      <div style={{ height: '600px', width: '900px', display: 'flex', flexDirection: 'column' }}>
        <MessageList sessionId={sessionId} workspaceId="ws-1" onOpenDrawer={() => {}} />
      </div>,
    )

    const scrollContainer = document.querySelector('[data-testid="conversation-list-scroll"]') as HTMLDivElement
    await waitFor(() => {
      expect(document.querySelector('[data-item-index="1799"]')).toBeTruthy()
    }, { timeout: 5000 })

    const mountedRows = Array.from(scrollContainer.querySelectorAll<HTMLElement>('[data-item-key]'))
    expect(mountedRows).toHaveLength(1_800)
    const rects = mountedRows.map((row) => row.getBoundingClientRect())
    for (let index = 1; index < rects.length; index += 1) {
      expect(rects[index].top).toBeGreaterThanOrEqual(rects[index - 1].bottom - 1)
    }
    const distanceFromBottom =
      scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight
    expect(distanceFromBottom).toBeLessThan(5)

    observer?.disconnect()
    expect(Math.max(0, ...longTasks)).toBeLessThan(250)
  })

  it('preserves the visible anchor when the streaming tail updates', async () => {
    const sessionId = 'session-tail-update'
    const initialMessages = makeMessages(80)
    chatStoreMock.setMessages(sessionId, initialMessages)
    chatStoreMock.setTotalMessageCount(sessionId, 100)

    renderWithI18n(
      <div style={{ height: '400px', width: '600px', display: 'flex', flexDirection: 'column' }}>
        <MessageList sessionId={sessionId} workspaceId="ws-1" onOpenDrawer={() => {}} />
      </div>,
    )

    const scrollContainer = document.querySelector('[data-testid="conversation-list-scroll"]') as HTMLDivElement
    await waitFor(() => expect(scrollContainer.scrollHeight).toBeGreaterThan(scrollContainer.clientHeight))
    await act(async () => {
      scrollContainer.dispatchEvent(new WheelEvent('wheel', { deltaY: -400 }))
      scrollContainer.scrollTop = Math.floor(scrollContainer.scrollHeight / 2)
      scrollContainer.dispatchEvent(new Event('scroll'))
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    const containerTop = scrollContainer.getBoundingClientRect().top
    const visibleRows = Array.from(scrollContainer.querySelectorAll<HTMLElement>('[data-item-key]'))
      .filter((row) => row.getBoundingClientRect().bottom > containerTop)
    const anchor = visibleRows[0]
    expect(anchor).toBeTruthy()
    const anchorKey = anchor.dataset.itemKey
    const anchorTop = anchor.getBoundingClientRect().top
    const updatedTail = {
      ...initialMessages.at(-1)!,
      parts: [textPart('Concurrent streaming tail update')],
    }

    await act(async () => {
      chatStoreMock.setMessages(sessionId, [...initialMessages.slice(0, -1), updatedTail])
    })

    await waitFor(() => {
      const retained = scrollContainer.querySelector<HTMLElement>(`[data-item-key="${anchorKey}"]`)
      expect(retained).toBeTruthy()
      expect(retained!.getBoundingClientRect().top).toBeCloseTo(anchorTop, 0)
    })
    expect(document.querySelector('[aria-label="Scroll to bottom"]')).toBeTruthy()
  })
})
