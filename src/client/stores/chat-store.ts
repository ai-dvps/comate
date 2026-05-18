import { create } from 'zustand'

import type { ChatMessage, MessagePart, QuestionPayload } from '../types/message'
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'

export type { ChatMessage, MessagePart, MessageRole } from '../types/message'

const sessionSubscriptions = new Map<string, { close: () => void }>()
const lastEventId = new Map<string, string>()

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

interface PendingApproval {
  requestId: string
  toolName: string
  toolUseId: string
  input: unknown
  inputSummary: string
  title?: string
  description?: string
  suggestions?: PermissionUpdate[]
}

interface PendingQuestion {
  requestId: string
  questions: QuestionPayload[]
}

type PendingItem = PendingApproval | PendingQuestion

export type SubagentPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; toolUseId: string; toolName: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; output: string; isError: boolean }

export interface SubagentMessage {
  id: string
  role: 'assistant' | 'user'
  parts: SubagentPart[]
}

export interface SubagentState {
  parentToolUseId: string
  description: string
  state: 'running' | 'completed' | 'error'
  startTime: number
  endTime?: number
  toolCount: number
  progressHint: string
  messages: SubagentMessage[]
}

interface ChatState {
  sessions: Record<string, ChatSession[]>
  messages: Record<string, ChatMessage[]>
  activeSessionIds: Record<string, string>
  isStreaming: Record<string, boolean>
  isLoadingSessions: boolean
  isLoadingMessages: boolean
  approvalQueue: Record<string, PendingItem[]>
  serverNonce: Record<string, string>
  draftQueue: Record<string, { workspaceId: string; content: string } | undefined>
  pendingSend: Record<string, { workspaceId: string; content: string } | undefined>
  drafts: Record<string, string>
  subagents: Record<string, SubagentState[]>

  fetchSessions: (workspaceId: string) => Promise<void>
  createSession: (workspaceId: string, name: string) => Promise<void>
  deleteSession: (sessionId: string, workspaceId: string) => Promise<void>
  setActiveSession: (workspaceId: string, sessionId: string) => void
  loadMessages: (workspaceId: string, sessionId: string) => Promise<void>
  sendMessage: (workspaceId: string, sessionId: string, content: string) => void
  setDraft: (sessionId: string, content: string) => void
  clearMessages: (sessionId: string) => void
  resolveApproval: (
    workspaceId: string,
    sessionId: string,
    requestId: string,
    result: { behavior: 'allow' | 'deny'; updatedPermissions?: PermissionUpdate[]; answers?: Record<string, string>; questions?: QuestionPayload[]; message?: string },
  ) => Promise<void>
  interruptSession: (workspaceId: string, sessionId: string) => Promise<void>
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: unknown; id?: string }> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = 'message'
  let currentData = ''
  let currentId: string | undefined

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        if (currentData) {
          yield { event: currentEvent, data: parseData(currentData), id: currentId }
          currentData = ''
          currentId = undefined
        }
        currentEvent = line.slice(7)
      } else if (line.startsWith('data: ')) {
        currentData = line.slice(6)
      } else if (line.startsWith('id: ')) {
        currentId = line.slice(4)
      } else if (line === '' && currentData) {
        yield { event: currentEvent, data: parseData(currentData), id: currentId }
        currentData = ''
        currentId = undefined
      }
    }
  }

  if (currentData) {
    yield { event: currentEvent, data: parseData(currentData), id: currentId }
  }
}

function parseData(data: string): unknown {
  try {
    return JSON.parse(data)
  } catch {
    return data
  }
}

type SseSetter = (
  updater: (state: ChatState) => ChatState | Partial<ChatState>,
) => void

function updateAssistantPart(
  state: ChatState,
  sessionId: string,
  messageId: string,
  partIndex: number,
  produce: (existing: MessagePart | undefined) => MessagePart,
): Partial<ChatState> {
  const msgs = state.messages[sessionId] || []
  const idx = msgs.findIndex((m) => m.id === messageId)
  if (idx < 0) return {}
  const target = msgs[idx]
  const parts = [...target.parts]
  parts[partIndex] = produce(parts[partIndex])
  const updated: ChatMessage = { ...target, parts }
  const nextMsgs = [...msgs.slice(0, idx), updated, ...msgs.slice(idx + 1)]
  return { messages: { ...state.messages, [sessionId]: nextMsgs } }
}

function mutateToolUsePart(
  state: ChatState,
  sessionId: string,
  toolUseId: string,
  produce: (part: Extract<MessagePart, { type: 'tool_use' }>) => MessagePart,
): Partial<ChatState> {
  const msgs = state.messages[sessionId] || []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    const partIdx = m.parts.findIndex(
      (p) => p.type === 'tool_use' && p.toolUseId === toolUseId,
    )
    if (partIdx >= 0) {
      const part = m.parts[partIdx] as Extract<MessagePart, { type: 'tool_use' }>
      const parts = [...m.parts]
      parts[partIdx] = produce(part)
      const updated: ChatMessage = { ...m, parts }
      const nextMsgs = [...msgs.slice(0, i), updated, ...msgs.slice(i + 1)]
      return { messages: { ...state.messages, [sessionId]: nextMsgs } }
    }
  }
  return {}
}

function addSystemMessage(
  state: ChatState,
  sessionId: string,
  text: string,
): Partial<ChatState> {
  return {
    messages: {
      ...state.messages,
      [sessionId]: [
        ...(state.messages[sessionId] || []),
        {
          id: generateId(),
          role: 'system',
          parts: [{ type: 'text', text }],
          timestamp: Date.now(),
        },
      ],
    },
  }
}

function findSubagent(
  state: ChatState,
  sessionId: string,
  parentToolUseId: string,
): SubagentState | undefined {
  const list = state.subagents[sessionId] || []
  return list.find((s) => s.parentToolUseId === parentToolUseId)
}

function updateSubagent(
  state: ChatState,
  sessionId: string,
  parentToolUseId: string,
  produce: (subagent: SubagentState) => SubagentState,
): Partial<ChatState> {
  const list = state.subagents[sessionId] || []
  const idx = list.findIndex((s) => s.parentToolUseId === parentToolUseId)
  if (idx < 0) return {}
  const updated = produce(list[idx])
  const nextList = [...list.slice(0, idx), updated, ...list.slice(idx + 1)]
  return { subagents: { ...state.subagents, [sessionId]: nextList } }
}

function appendSubagentPart(
  messages: SubagentMessage[],
  delta: SubagentPart,
): SubagentMessage[] {
  const lastMessage = messages[messages.length - 1]

  if (delta.type === 'text' || delta.type === 'thinking') {
    if (lastMessage && lastMessage.role === 'assistant') {
      const existingIdx = lastMessage.parts.findIndex(
        (p) => p.type === delta.type,
      )
      if (existingIdx >= 0) {
        const existing = lastMessage.parts[existingIdx]
        if (existing.type === 'text' || existing.type === 'thinking') {
          const updatedParts = [...lastMessage.parts]
          updatedParts[existingIdx] = {
            ...existing,
            text: existing.text + delta.text,
          }
          return [
            ...messages.slice(0, -1),
            { ...lastMessage, parts: updatedParts },
          ]
        }
      }
      return [
        ...messages.slice(0, -1),
        { ...lastMessage, parts: [...lastMessage.parts, delta] },
      ]
    }
    return [...messages, { id: generateId(), role: 'assistant', parts: [delta] }]
  }

  if (delta.type === 'tool_use') {
    if (lastMessage && lastMessage.role === 'assistant') {
      return [
        ...messages.slice(0, -1),
        { ...lastMessage, parts: [...lastMessage.parts, delta] },
      ]
    }
    return [...messages, { id: generateId(), role: 'assistant', parts: [delta] }]
  }

  if (delta.type === 'tool_result') {
    return [...messages, { id: generateId(), role: 'user', parts: [delta] }]
  }

  return messages
}

function updateSubagentMessage(
  state: ChatState,
  sessionId: string,
  parentToolUseId: string,
  delta: SubagentPart,
): Partial<ChatState> {
  const subagent = findSubagent(state, sessionId, parentToolUseId)
  if (!subagent) return {}

  const messages = appendSubagentPart([...subagent.messages], delta)

  return updateSubagent(state, sessionId, parentToolUseId, (s) => ({
    ...s,
    messages,
  }))
}

function updateSubagentToolUse(
  state: ChatState,
  sessionId: string,
  parentToolUseId: string,
  delta: Extract<SubagentPart, { type: 'tool_use' }>,
  progressHint: string,
): Partial<ChatState> {
  const subagent = findSubagent(state, sessionId, parentToolUseId)
  if (!subagent) return {}

  const messages = appendSubagentPart([...subagent.messages], delta)

  return updateSubagent(state, sessionId, parentToolUseId, (s) => ({
    ...s,
    toolCount: s.toolCount + 1,
    progressHint,
    messages,
  }))
}

function handleSseEvent(
  set: SseSetter,
  sessionId: string,
  event: string,
  raw: unknown,
): void {
  const data =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}

  switch (event) {
    case 'assistant_start': {
      const messageId = typeof data.messageId === 'string' ? data.messageId : ''
      if (!messageId) return
      set((state) => ({
        messages: {
          ...state.messages,
          [sessionId]: [
            ...(state.messages[sessionId] || []),
            {
              id: messageId,
              role: 'assistant',
              parts: [],
              timestamp: Date.now(),
              isStreaming: true,
            },
          ],
        },
      }))
      return
    }
    case 'text_delta': {
      const messageId = typeof data.messageId === 'string' ? data.messageId : ''
      const partIndex = typeof data.partIndex === 'number' ? data.partIndex : -1
      const text = typeof data.text === 'string' ? data.text : ''
      if (!messageId || partIndex < 0 || !text) return
      set((state) =>
        updateAssistantPart(state, sessionId, messageId, partIndex, (existing) => {
          if (existing && existing.type === 'text') {
            return { ...existing, text: existing.text + text }
          }
          return { type: 'text', text }
        }),
      )
      return
    }
    case 'tool_use_start': {
      const messageId = typeof data.messageId === 'string' ? data.messageId : ''
      const partIndex = typeof data.partIndex === 'number' ? data.partIndex : -1
      const toolUseId = typeof data.toolUseId === 'string' ? data.toolUseId : ''
      const toolName = typeof data.toolName === 'string' ? data.toolName : ''
      if (!messageId || partIndex < 0 || !toolUseId) return
      set((state) =>
        updateAssistantPart(state, sessionId, messageId, partIndex, () => ({
          type: 'tool_use',
          toolUseId,
          toolName,
          input: {},
          state: 'streaming',
        })),
      )
      return
    }
    case 'tool_use_done': {
      const toolUseId = typeof data.toolUseId === 'string' ? data.toolUseId : ''
      const input = 'input' in data ? data.input : {}
      if (!toolUseId) return
      set((state) =>
        mutateToolUsePart(state, sessionId, toolUseId, (part) => ({
          ...part,
          input,
          state: 'complete',
        })),
      )
      return
    }
    case 'tool_result': {
      const toolUseId = typeof data.toolUseId === 'string' ? data.toolUseId : ''
      const output = typeof data.output === 'string' ? data.output : ''
      const isError = data.isError === true
      if (!toolUseId) return
      set((state) => ({
        messages: {
          ...state.messages,
          [sessionId]: [
            ...(state.messages[sessionId] || []),
            {
              id: generateId(),
              role: 'user',
              parts: [{ type: 'tool_result', toolUseId, output, isError }],
              timestamp: Date.now(),
            },
          ],
        },
      }))
      return
    }
    case 'thinking_start': {
      const messageId = typeof data.messageId === 'string' ? data.messageId : ''
      const partIndex = typeof data.partIndex === 'number' ? data.partIndex : -1
      if (!messageId || partIndex < 0) return
      set((state) =>
        updateAssistantPart(state, sessionId, messageId, partIndex, () => ({
          type: 'thinking',
          text: '',
          state: 'streaming',
        })),
      )
      return
    }
    case 'thinking_delta': {
      const messageId = typeof data.messageId === 'string' ? data.messageId : ''
      const partIndex = typeof data.partIndex === 'number' ? data.partIndex : -1
      const text = typeof data.text === 'string' ? data.text : ''
      if (!messageId || partIndex < 0 || !text) return
      set((state) =>
        updateAssistantPart(state, sessionId, messageId, partIndex, (existing) => {
          if (existing && existing.type === 'thinking') {
            return { ...existing, text: existing.text + text }
          }
          return { type: 'thinking', text, state: 'streaming' }
        }),
      )
      return
    }
    case 'thinking_done': {
      const messageId = typeof data.messageId === 'string' ? data.messageId : ''
      const partIndex = typeof data.partIndex === 'number' ? data.partIndex : -1
      if (!messageId || partIndex < 0) return
      set((state) =>
        updateAssistantPart(state, sessionId, messageId, partIndex, (existing) => {
          if (existing && existing.type === 'thinking') {
            return { ...existing, state: 'complete' }
          }
          return existing ?? { type: 'thinking', text: '', state: 'complete' }
        }),
      )
      return
    }
    case 'assistant_done': {
      const messageId = typeof data.messageId === 'string' ? data.messageId : ''
      if (!messageId) return
      set((state) => ({
        messages: {
          ...state.messages,
          [sessionId]: (state.messages[sessionId] || []).map((m) =>
            m.id === messageId ? { ...m, isStreaming: false } : m,
          ),
        },
      }))
      return
    }
    case 'error': {
      const message = typeof data.message === 'string' ? data.message : 'Stream error'
      throw new Error(message)
    }
    case 'subscription_ack': {
      const serverNonce = typeof data.serverNonce === 'string' ? data.serverNonce : ''
      set((state) => {
        const prevNonce = state.serverNonce[sessionId] || ''
        const updates: Partial<ChatState> = {
          serverNonce: { ...state.serverNonce, [sessionId]: serverNonce },
        }
        if (prevNonce && prevNonce !== serverNonce) {
          updates.messages = {
            ...state.messages,
            [sessionId]: [
              ...(state.messages[sessionId] || []),
              {
                id: generateId(),
                role: 'system',
                parts: [
                  {
                    type: 'text',
                    text: 'Server was restarted. Background work may have been lost.',
                  },
                ],
                timestamp: Date.now(),
              },
            ],
          }
        }
        const pending = state.pendingSend[sessionId]
        if (pending) {
          const { workspaceId, content } = pending
          updates.pendingSend = { ...state.pendingSend }
          delete updates.pendingSend[sessionId]
          fetch(`/api/workspaces/${workspaceId}/sessions/${sessionId}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: content }),
          }).catch((err) => {
            console.error('Failed to send queued message:', err)
            set((s) =>
              addSystemMessage(
                s,
                sessionId,
                `Failed to send: ${err instanceof Error ? err.message : 'Network error'}`,
              ),
            )
          })
        }
        return updates
      })
      return
    }
    case 'pending_approval': {
      const requestId = typeof data.requestId === 'string' ? data.requestId : ''
      const toolName = typeof data.toolName === 'string' ? data.toolName : ''
      const toolUseId = typeof data.toolUseId === 'string' ? data.toolUseId : ''
      if (!requestId) return
      set((state) => ({
        approvalQueue: {
          ...state.approvalQueue,
          [sessionId]: [
            ...(state.approvalQueue[sessionId] || []),
            {
              requestId,
              toolName,
              toolUseId,
              input: data.input,
              inputSummary: typeof data.inputSummary === 'string' ? data.inputSummary : '',
              title: typeof data.title === 'string' ? data.title : undefined,
              description: typeof data.description === 'string' ? data.description : undefined,
              suggestions: Array.isArray(data.suggestions) ? data.suggestions : undefined,
            },
          ],
        },
      }))
      return
    }
    case 'pending_question': {
      const requestId = typeof data.requestId === 'string' ? data.requestId : ''
      const questions = Array.isArray(data.questions) ? data.questions : []
      if (!requestId) return
      set((state) => ({
        approvalQueue: {
          ...state.approvalQueue,
          [sessionId]: [
            ...(state.approvalQueue[sessionId] || []),
            { requestId, questions },
          ],
        },
      }))
      return
    }
    case 'approval_resolved': {
      const requestId = typeof data.requestId === 'string' ? data.requestId : ''
      if (!requestId) return
      set((state) => {
        const queue = state.approvalQueue[sessionId] || []
        const nextQueue = queue.filter((item) => item.requestId !== requestId)
        const updates: Partial<ChatState> = {
          approvalQueue: { ...state.approvalQueue, [sessionId]: nextQueue },
        }
        // If queue is now empty and there's a draft message, send it
        const draft = state.draftQueue[sessionId]
        if (nextQueue.length === 0 && draft) {
          const { workspaceId, content } = draft
          updates.draftQueue = { ...state.draftQueue }
          delete updates.draftQueue[sessionId]
          // Send the queued message asynchronously
          fetch(`/api/workspaces/${workspaceId}/sessions/${sessionId}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: content }),
          }).catch((err) => {
            console.error('Failed to send queued message:', err)
          })
        }
        return updates
      })
      return
    }
    case 'interrupted': {
      set((state) => ({
        isStreaming: { ...state.isStreaming, [sessionId]: false },
      }))
      return
    }
    case 'error_note': {
      const text = typeof data.text === 'string' ? data.text : 'Error'
      set((state) => addSystemMessage(state, sessionId, text))
      return
    }
    case 'server_restarted': {
      set((state) =>
        addSystemMessage(
          state,
          sessionId,
          'Server was restarted. Background work may have been lost.',
        ),
      )
      return
    }
    case 'result': {
      set((state) => ({
        isStreaming: { ...state.isStreaming, [sessionId]: false },
      }))
      return
    }
    case 'subagent_start': {
      const parentToolUseId =
        typeof data.parentToolUseId === 'string' ? data.parentToolUseId : ''
      const description =
        typeof data.description === 'string' ? data.description : 'Agent'
      if (!parentToolUseId) return
      set((state) => {
        const existing = findSubagent(state, sessionId, parentToolUseId)
        if (existing) return {}
        const list = state.subagents[sessionId] || []
        return {
          subagents: {
            ...state.subagents,
            [sessionId]: [
              ...list,
              {
                parentToolUseId,
                description,
                state: 'running',
                startTime: Date.now(),
                toolCount: 0,
                progressHint: '',
                messages: [],
              },
            ],
          },
        }
      })
      return
    }
    case 'subagent_delta': {
      const parentToolUseId =
        typeof data.parentToolUseId === 'string' ? data.parentToolUseId : ''
      const delta = data.delta as Record<string, unknown> | undefined
      if (!parentToolUseId || !delta) return

      const kind = delta.kind
      const deltaText =
        typeof delta.text === 'string' ? delta.text : undefined
      if (kind === 'text' && deltaText !== undefined) {
        set((state) =>
          updateSubagentMessage(state, sessionId, parentToolUseId, {
            type: 'text',
            text: deltaText,
          }),
        )
      } else if (kind === 'thinking' && deltaText !== undefined) {
        set((state) =>
          updateSubagentMessage(state, sessionId, parentToolUseId, {
            type: 'thinking',
            text: deltaText,
          }),
        )
      } else if (kind === 'tool_use') {
        const toolUseId =
          typeof delta.toolUseId === 'string' ? delta.toolUseId : ''
        const toolName =
          typeof delta.toolName === 'string' ? delta.toolName : ''
        const input = 'input' in delta ? delta.input : {}
        const inputStr = JSON.stringify(input)
        const progressHint =
          inputStr.length > 60
            ? `${toolName}: ${inputStr.slice(0, 60)}…`
            : `${toolName}: ${inputStr}`
        set((state) =>
          updateSubagentToolUse(
            state,
            sessionId,
            parentToolUseId,
            { type: 'tool_use', toolUseId, toolName, input },
            progressHint,
          ),
        )
      } else if (kind === 'tool_result') {
        const toolUseId =
          typeof delta.toolUseId === 'string' ? delta.toolUseId : ''
        const output = typeof delta.output === 'string' ? delta.output : ''
        const isError = delta.isError === true
        set((state) =>
          updateSubagentMessage(state, sessionId, parentToolUseId, {
            type: 'tool_result',
            toolUseId,
            output,
            isError,
          }),
        )
      } else {
        console.warn('Unknown subagent_delta kind:', kind)
      }
      return
    }
    case 'subagent_done': {
      const parentToolUseId =
        typeof data.parentToolUseId === 'string' ? data.parentToolUseId : ''
      const doneState =
        data.state === 'error' ? 'error' : ('completed' as const)
      if (!parentToolUseId) return
      set((state) =>
        updateSubagent(state, sessionId, parentToolUseId, (s) => ({
          ...s,
          state: doneState,
          endTime: Date.now(),
        })),
      )
      return
    }
    case 'system_init':
    case 'done':
    default:
      return
  }
}

function subscribeToSession(
  set: SseSetter,
  workspaceId: string,
  sessionId: string,
): void {
  const existing = sessionSubscriptions.get(sessionId)
  if (existing) {
    existing.close()
  }

  const lastId = lastEventId.get(sessionId)
  const headers: Record<string, string> = {}
  if (lastId) {
    headers['Last-Event-ID'] = lastId
  }

  const abortController = new AbortController()
  const thisClose = () => abortController.abort()

  fetch(`/api/workspaces/${workspaceId}/sessions/${sessionId}/stream`, {
    headers,
    signal: abortController.signal,
  })
    .then(async (res) => {
      if (!res.ok) {
        const error = await res.json().catch(() => ({ error: 'Subscription failed' }))
        throw new Error(error.error || 'Subscription failed')
      }
      if (!res.body) throw new Error('No response body')

      try {
        for await (const event of parseSSEStream(res.body)) {
          if (event.id) {
            lastEventId.set(sessionId, event.id)
          }
          try {
            handleSseEvent(set, sessionId, event.event, event.data)
          } catch (err) {
            console.error('SSE event handler error:', err)
            set((state) =>
              addSystemMessage(
                state,
                sessionId,
                `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
              ),
            )
          }
        }
      } finally {
        const current = sessionSubscriptions.get(sessionId)
        if (current?.close === thisClose) {
          sessionSubscriptions.delete(sessionId)
        }
      }
    })
    .catch((err) => {
      const current = sessionSubscriptions.get(sessionId)
      if (current?.close === thisClose) {
        sessionSubscriptions.delete(sessionId)
      }
      if (err.name === 'AbortError') return
      console.error('Subscription error:', err)
      set((state) =>
        addSystemMessage(
          state,
          sessionId,
          `Connection error: ${err instanceof Error ? err.message : 'Unknown error'}`,
        ),
      )
      set((state) => ({
        isStreaming: { ...state.isStreaming, [sessionId]: false },
      }))
    })

  sessionSubscriptions.set(sessionId, {
    close: thisClose,
  })
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: {},
  messages: {},
  activeSessionIds: {},
  isStreaming: {},
  isLoadingSessions: false,
  isLoadingMessages: false,
  approvalQueue: {},
  serverNonce: {},
  draftQueue: {},
  pendingSend: {},
  drafts: {},
  subagents: {},

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
      // Close subscription first
      const sub = sessionSubscriptions.get(sessionId)
      if (sub) {
        sub.close()
      }
      sessionSubscriptions.delete(sessionId)
      lastEventId.delete(sessionId)

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
        const newApprovalQueue = { ...state.approvalQueue }
        delete newApprovalQueue[sessionId]
        const newDraftQueue = { ...state.draftQueue }
        delete newDraftQueue[sessionId]
        const newPendingSend = { ...state.pendingSend }
        delete newPendingSend[sessionId]
        const newDrafts = { ...state.drafts }
        delete newDrafts[sessionId]
        const newIsStreaming = { ...state.isStreaming }
        delete newIsStreaming[sessionId]
        const newSubagents = { ...state.subagents }
        delete newSubagents[sessionId]
        return {
          sessions: { ...state.sessions, [workspaceId]: updated },
          activeSessionIds: { ...state.activeSessionIds, [workspaceId]: newActive },
          messages: newMessages,
          approvalQueue: newApprovalQueue,
          draftQueue: newDraftQueue,
          pendingSend: newPendingSend,
          drafts: newDrafts,
          isStreaming: newIsStreaming,
          subagents: newSubagents,
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
    // Auto-subscribe when switching to a session
    if (sessionId) {
      subscribeToSession(set, workspaceId, sessionId)
    }
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
    // Ensure subscription is open
    if (!sessionSubscriptions.has(sessionId)) {
      subscribeToSession(set, workspaceId, sessionId)
    }

    const userMessageId = generateId()

    // Optimistically add user message and clear the input draft
    set((state) => {
      const nextDrafts = { ...state.drafts }
      delete nextDrafts[sessionId]
      return {
        messages: {
          ...state.messages,
          [sessionId]: [
            ...(state.messages[sessionId] || []),
            {
              id: userMessageId,
              role: 'user',
              parts: [{ type: 'text', text: content }],
              timestamp: Date.now(),
            },
          ],
        },
        drafts: nextDrafts,
        isStreaming: { ...state.isStreaming, [sessionId]: true },
      }
    })

    // If approval is pending, queue the message
    const queue = get().approvalQueue[sessionId] || []
    if (queue.length > 0) {
      set((state) => ({
        draftQueue: { ...state.draftQueue, [sessionId]: { workspaceId, content } },
      }))
      return
    }

    // Gate the POST on subscription_ack — without an ack, the server has not
    // yet wired this client's response into the emitter, so events would emit
    // only into the ring buffer. The ack handler drains pendingSend.
    if (!get().serverNonce[sessionId]) {
      set((state) => ({
        pendingSend: { ...state.pendingSend, [sessionId]: { workspaceId, content } },
      }))
      return
    }

    // POST to server
    fetch(`/api/workspaces/${workspaceId}/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: content }),
    }).catch((err) => {
      console.error('Failed to send message:', err)
      set((state) =>
        addSystemMessage(
          state,
          sessionId,
          `Failed to send: ${err instanceof Error ? err.message : 'Network error'}`,
        ),
      )
    })
  },

  clearMessages: (sessionId: string) => {
    set((state) => {
      const newMessages = { ...state.messages }
      delete newMessages[sessionId]
      const newSubagents = { ...state.subagents }
      delete newSubagents[sessionId]
      return { messages: newMessages, subagents: newSubagents }
    })
  },

  setDraft: (sessionId: string, content: string) => {
    if (!sessionId) return
    set((state) => {
      if (content === '') {
        if (state.drafts[sessionId] === undefined) return {}
        const nextDrafts = { ...state.drafts }
        delete nextDrafts[sessionId]
        return { drafts: nextDrafts }
      }
      if (state.drafts[sessionId] === content) return {}
      return { drafts: { ...state.drafts, [sessionId]: content } }
    })
  },

  resolveApproval: async (
    workspaceId: string,
    sessionId: string,
    requestId: string,
    result: {
      behavior: 'allow' | 'deny'
      updatedPermissions?: PermissionUpdate[]
      answers?: Record<string, string>
      questions?: QuestionPayload[]
      message?: string
    },
  ) => {
    try {
      const body: Record<string, unknown> = { behavior: result.behavior }
      if (result.updatedPermissions) {
        body.updatedPermissions = result.updatedPermissions
      }
      if (result.answers) {
        body.answers = result.answers
        body.questions = result.questions
      }
      if (result.message) {
        body.message = result.message
      }

      const res = await fetch(
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/approvals/${requestId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      if (!res.ok) {
        const error = await res.json().catch(() => ({ error: 'Request failed' }))
        throw new Error(error.error || 'Request failed')
      }
    } catch (err) {
      console.error('Failed to resolve approval:', err)
      set((state) =>
        addSystemMessage(
          state,
          sessionId,
          `Approval error: ${err instanceof Error ? err.message : 'Network error'}`,
        ),
      )
    }
  },

  interruptSession: async (workspaceId: string, sessionId: string) => {
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/interrupt`,
        {
          method: 'POST',
        },
      )
      if (!res.ok) {
        const error = await res.json().catch(() => ({ error: 'Request failed' }))
        throw new Error(error.error || 'Request failed')
      }
    } catch (err) {
      console.error('Failed to interrupt:', err)
      set((state) =>
        addSystemMessage(
          state,
          sessionId,
          `Interrupt error: ${err instanceof Error ? err.message : 'Network error'}`,
        ),
      )
    }
  },
}))
