import { create } from 'zustand'

import type { ChatMessage } from '../types/message'

export type { ChatMessage, MessagePart, MessageRole } from '../types/message'

export interface ChatSession {
  id: string
  workspaceId: string
  name: string
  isDraft?: boolean
  createdAt: string
  updatedAt: string
  summary?: string
  lastModified?: number
  firstPrompt?: string
  gitBranch?: string
  customTitle?: string
}

interface ChatState {
  sessions: Record<string, ChatSession[]>
  messages: Record<string, ChatMessage[]>
  activeSessionIds: Record<string, string>
  isStreaming: Record<string, boolean>
  isLoadingSessions: boolean
  isLoadingMessages: boolean

  fetchSessions: (workspaceId: string) => Promise<void>
  createSession: (workspaceId: string, name: string) => Promise<void>
  deleteSession: (sessionId: string, workspaceId: string) => Promise<void>
  setActiveSession: (workspaceId: string, sessionId: string) => void
  loadMessages: (workspaceId: string, sessionId: string) => Promise<void>
  sendMessage: (workspaceId: string, sessionId: string, content: string) => void
  clearMessages: (sessionId: string) => void
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

async function* parseSSEStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: unknown }> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = 'message'
  let currentData = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        if (currentData) {
          yield { event: currentEvent, data: parseData(currentData) }
          currentData = ''
        }
        currentEvent = line.slice(7)
      } else if (line.startsWith('data: ')) {
        currentData = line.slice(6)
      } else if (line === '' && currentData) {
        yield { event: currentEvent, data: parseData(currentData) }
        currentData = ''
      }
    }
  }

  if (currentData) {
    yield { event: currentEvent, data: parseData(currentData) }
  }
}

function parseData(data: string): unknown {
  try {
    return JSON.parse(data)
  } catch {
    return data
  }
}

export const useChatStore = create<ChatState>((set) => ({
  sessions: {},
  messages: {},
  activeSessionIds: {},
  isStreaming: {},
  isLoadingSessions: false,
  isLoadingMessages: false,

  fetchSessions: async (workspaceId: string) => {
    try {
      set({ isLoadingSessions: true })
      const res = await fetch(`/api/workspaces/${workspaceId}/sessions`)
      if (!res.ok) throw new Error('Failed to fetch sessions')
      const data = await res.json()
      set((state) => ({
        sessions: { ...state.sessions, [workspaceId]: data.sessions || [] },
        isLoadingSessions: false,
      }))
    } catch (err) {
      console.error('Failed to fetch sessions:', err)
      set({ isLoadingSessions: false })
    }
  },

  createSession: async (workspaceId: string, name: string) => {
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) throw new Error('Failed to create session')
      const session: ChatSession = await res.json()
      set((state) => ({
        sessions: {
          ...state.sessions,
          [workspaceId]: [...(state.sessions[workspaceId] || []), session],
        },
        activeSessionIds: { ...state.activeSessionIds, [workspaceId]: session.id },
      }))
    } catch (err) {
      console.error('Failed to create session:', err)
    }
  },

  deleteSession: async (sessionId: string, workspaceId: string) => {
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/sessions/${sessionId}`, {
        method: 'DELETE',
      })
      if (!res.ok && res.status !== 404) throw new Error('Failed to delete session')
      set((state) => {
        const updated = (state.sessions[workspaceId] || []).filter((s) => s.id !== sessionId)
        const newActive =
          state.activeSessionIds[workspaceId] === sessionId
            ? updated[0]?.id || ''
            : state.activeSessionIds[workspaceId]
        const newMessages = { ...state.messages }
        delete newMessages[sessionId]
        return {
          sessions: { ...state.sessions, [workspaceId]: updated },
          activeSessionIds: { ...state.activeSessionIds, [workspaceId]: newActive },
          messages: newMessages,
        }
      })
    } catch (err) {
      console.error('Failed to delete session:', err)
    }
  },

  setActiveSession: (workspaceId: string, sessionId: string) => {
    set((state) => ({
      activeSessionIds: { ...state.activeSessionIds, [workspaceId]: sessionId },
    }))
  },

  loadMessages: async (workspaceId: string, sessionId: string) => {
    try {
      set({ isLoadingMessages: true })
      const res = await fetch(`/api/workspaces/${workspaceId}/sessions/${sessionId}/messages`)
      if (!res.ok) throw new Error('Failed to load messages')
      const data = (await res.json()) as { messages?: ChatMessage[] }
      const mappedMessages = data.messages ?? []

      set((state) => ({
        messages: { ...state.messages, [sessionId]: mappedMessages },
        isLoadingMessages: false,
      }))
    } catch (err) {
      console.error('Failed to load messages:', err)
      set({ isLoadingMessages: false })
    }
  },

  sendMessage: (workspaceId: string, sessionId: string, content: string) => {
    const messageId = generateId()

    set((state) => ({
      messages: {
        ...state.messages,
        [sessionId]: [
          ...(state.messages[sessionId] || []),
          {
            id: messageId,
            role: 'user',
            parts: [{ type: 'text', text: content }],
            timestamp: Date.now(),
          },
        ],
      },
      isStreaming: { ...state.isStreaming, [sessionId]: true },
    }))

    const assistantMessageId = generateId()
    let assistantContent = ''

    fetch(`/api/workspaces/${workspaceId}/sessions/${sessionId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: content }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const error = await res.json().catch(() => ({ error: 'Request failed' }))
          throw new Error(error.error || 'Request failed')
        }
        if (!res.body) throw new Error('No response body')

        for await (const event of parseSSEStream(res.body)) {
          if (event.event === 'text_delta') {
            const data = event.data as { text?: string }
            if (data.text) {
              assistantContent += data.text
              set((state) => {
                const msgs = state.messages[sessionId] || []
                const lastMsg = msgs[msgs.length - 1]
                if (lastMsg?.id === assistantMessageId) {
                  return {
                    messages: {
                      ...state.messages,
                      [sessionId]: [
                        ...msgs.slice(0, -1),
                        {
                          ...lastMsg,
                          parts: [{ type: 'text', text: assistantContent }],
                        },
                      ],
                    },
                  }
                }
                return {
                  messages: {
                    ...state.messages,
                    [sessionId]: [
                      ...msgs,
                      {
                        id: assistantMessageId,
                        role: 'assistant',
                        parts: [{ type: 'text', text: assistantContent }],
                        timestamp: Date.now(),
                      },
                    ],
                  },
                }
              })
            }
          } else if (event.event === 'assistant') {
            const data = event.data as { text?: string; uuid?: string }
            if (data.text) {
              assistantContent = data.text
              set((state) => {
                const msgs = state.messages[sessionId] || []
                const lastMsg = msgs[msgs.length - 1]
                if (lastMsg?.id === assistantMessageId) {
                  return {
                    messages: {
                      ...state.messages,
                      [sessionId]: [
                        ...msgs.slice(0, -1),
                        {
                          ...lastMsg,
                          parts: [{ type: 'text', text: assistantContent }],
                        },
                      ],
                    },
                  }
                }
                return {
                  messages: {
                    ...state.messages,
                    [sessionId]: [
                      ...msgs,
                      {
                        id: assistantMessageId,
                        role: 'assistant',
                        parts: [{ type: 'text', text: assistantContent }],
                        timestamp: Date.now(),
                      },
                    ],
                  },
                }
              })
            }
          } else if (event.event === 'tool_progress') {
            // Bridge-state: tool_progress SSE no longer maps to a synthetic
            // 'tool' chat message — `MessageRole` is now strictly
            // user|assistant|system. U4 replaces this with proper
            // tool_use_start/tool_use_done events writing tool_use MessageParts.
          } else if (event.event === 'error') {
            const data = event.data as { message?: string }
            throw new Error(data.message || 'Stream error')
          }
        }
      })
      .catch((err) => {
        console.error('Chat error:', err)
        set((state) => ({
          messages: {
            ...state.messages,
            [sessionId]: [
              ...(state.messages[sessionId] || []),
              {
                id: generateId(),
                role: 'system',
                parts: [
                  {
                    type: 'text',
                    text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
                  },
                ],
                timestamp: Date.now(),
              },
            ],
          },
        }))
      })
      .finally(() => {
        set((state) => ({
          isStreaming: { ...state.isStreaming, [sessionId]: false },
        }))
      })
  },

  clearMessages: (sessionId: string) => {
    set((state) => {
      const newMessages = { ...state.messages }
      delete newMessages[sessionId]
      return { messages: newMessages }
    })
  },
}))