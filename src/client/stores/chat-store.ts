import { create } from 'zustand'
import i18next from 'i18next'

import type { ChatMessage, MessagePart, QuestionPayload, SubagentMessage, SubagentPart, SubagentState, TaskItem, WorkflowState } from '../types/message'
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import { diagLog } from '../utils/diag-logger'
import { getInitialSettings } from '../hooks/use-app-settings'
import { isBotSession } from '../lib/session-filter'
import { useToastStore } from './toast-store'
import { DEFAULT_TIMEOUT, wsClient } from '../lib/websocket-client.js'
import type { WsEventMessage } from '@server/websocket/types'
import { BROWSER_TOOL_PREFIX } from '@server/services/browser-tool-names'

export type { ChatMessage, MessagePart, MessageRole, SubagentMessage, SubagentPart, SubagentState } from '../types/message'

const sessionSubscriptions = new Map<string, { close: () => void; timer?: ReturnType<typeof setTimeout>; workspaceId: string }>()
const lastEventId = new Map<string, string>()
const workspacePollIntervals = new Map<string, ReturnType<typeof setInterval>>()

interface WorkflowPollEntry {
  timer?: ReturnType<typeof setTimeout>
  generation: number
  abortController?: AbortController
}

const workflowPollTimers = new Map<string, WorkflowPollEntry>()

function closeWorkspaceSessionSubscriptions(workspaceId: string): void {
  for (const [sessionId, sub] of sessionSubscriptions) {
    if (sub.workspaceId === workspaceId) {
      sub.close()
      sessionSubscriptions.delete(sessionId)
      stopAllWorkflowPollingForSession(sessionId)
    }
  }
}

function closeSingleSessionSubscription(set: SseSetter, sessionId: string): void {
  const sub = sessionSubscriptions.get(sessionId)
  if (sub) {
    sub.close()
    sessionSubscriptions.delete(sessionId)
    stopAllWorkflowPollingForSession(sessionId)
  }
  set((state) => ({
    serverNonce: { ...state.serverNonce, [sessionId]: '' },
  }))
}

function computeDomCacheUpdate(
  state: ChatState,
  workspaceId: string,
  sessionId: string,
): { nextCache: string[]; evicted: string | null } {
  const currentCache = state.domCache[workspaceId] || []
  const withoutSession = currentCache.filter((id) => id !== sessionId)
  const nextCache = [...withoutSession, sessionId]
  let evicted: string | null = null
  if (nextCache.length > DOM_CACHE_LIMIT) {
    evicted = nextCache.shift() || null
  }
  return { nextCache, evicted }
}

function addBackgroundSession(
  state: ChatState,
  workspaceId: string,
  sessionId: string,
): Partial<ChatState> {
  const list = state.backgroundSessions[workspaceId] || []
  if (list.includes(sessionId)) return {}
  return {
    backgroundSessions: {
      ...state.backgroundSessions,
      [workspaceId]: [...list, sessionId],
    },
  }
}

function removeBackgroundSession(
  state: ChatState,
  workspaceId: string,
  sessionId: string,
): Partial<ChatState> {
  const list = state.backgroundSessions[workspaceId] || []
  if (!list.includes(sessionId)) return {}
  return {
    backgroundSessions: {
      ...state.backgroundSessions,
      [workspaceId]: list.filter((id) => id !== sessionId),
    },
  }
}

function closeBackgroundSessionSubscription(
  set: SseSetter,
  workspaceId: string,
  sessionId: string,
): void {
  set((state) => removeBackgroundSession(state, workspaceId, sessionId))
  closeSingleSessionSubscription(set, sessionId)
}

function stopAllWorkflowPolling(): void {
  for (const [key, entry] of workflowPollTimers) {
    if (entry.timer) {
      clearTimeout(entry.timer)
    }
    if (entry.abortController) {
      try {
        entry.abortController.abort()
      } catch {
        // ignore cleanup errors
      }
    }
    workflowPollTimers.delete(key)
  }
}

/** Test-only helper: tear down every session subscription and clear server nonces. */
export function clearAllSessionSubscriptions(set: SseSetter): void {
  for (const [sessionId, sub] of sessionSubscriptions) {
    try {
      sub.close()
    } catch {
      // ignore cleanup errors
    }
    sessionSubscriptions.delete(sessionId)
  }
  stopAllWorkflowPolling()
  set(() => ({
    serverNonce: {},
    backgroundSessions: {},
    // Keep pendingSend: subscription_ack will drain it after reconnect.
    // Keep lastEventId: it is the replay cursor for reconnect.
  }))
}

function startBackgroundPolling(
  set: SseSetter,
  workspaceId: string,
): void {
  const existing = workspacePollIntervals.get(workspaceId)
  if (existing) {
    clearInterval(existing)
  }

  const interval = setInterval(() => {
    wsClient
      .request('status', { workspaceId }, 5000)
      .then((data) => {
        const result = data as {
          statuses?: Record<string, { pendingCount: number; isProcessing?: boolean }>
        }
        const statuses = result.statuses ?? {}
        set((state) => {
          const next = { ...state.sessionStatus }
          const nextStreaming = { ...state.isStreaming }
          const nextLastActivityAt = { ...state.lastActivityAt }
          const nextProcessing = { ...state.sessionProcessing }
          const nextBackgroundTaskCount = { ...state.sessionBackgroundTaskCount }
          for (const session of state.sessions[workspaceId] ?? []) {
            if (
              !sessionSubscriptions.has(session.id) &&
              !Object.prototype.hasOwnProperty.call(statuses, session.id)
            ) {
              delete next[session.id]
              delete nextProcessing[session.id]
              delete nextBackgroundTaskCount[session.id]
              if (nextStreaming[session.id]) {
                nextStreaming[session.id] = false
              }
            }
          }
          for (const [sid, st] of Object.entries(statuses)) {
            const prevPending = state.sessionStatus[sid]?.pendingCount ?? 0
            if (st.pendingCount === 0 && !st.isProcessing) {
              delete next[sid]
              delete nextProcessing[sid]
              delete nextBackgroundTaskCount[sid]
            } else {
              next[sid] = st
            }
            if (st.pendingCount > 0 && prevPending === 0) {
              nextLastActivityAt[sid] = Date.now()
            }
            if (!sessionSubscriptions.has(sid)) {
              if (st.isProcessing) {
                nextStreaming[sid] = true
              } else if (nextStreaming[sid]) {
                nextStreaming[sid] = false
              }
            }
          }
          return { sessionStatus: next, isStreaming: nextStreaming, lastActivityAt: nextLastActivityAt, sessionProcessing: nextProcessing, sessionBackgroundTaskCount: nextBackgroundTaskCount }
        })
      })
      .catch((err) => {
        console.error('Background poll error:', err)
      })
  }, 5000)

  workspacePollIntervals.set(workspaceId, interval)
}


export type ApprovalMode = 'auto' | 'readonly' | 'manual'

export interface ChatSession {
  id: string
  workspaceId: string
  name: string
  isDraft?: boolean
  isWip?: boolean
  isArchived?: boolean
  source?: 'gui' | 'wecom' | 'feishu'
  approvalMode?: ApprovalMode
  providerId?: string
  fastMode?: boolean
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
  expiresAt?: number
  denialReason?: 'safetyCheck' | 'asyncAgent' | string
}

interface PendingQuestion {
  requestId: string
  questions: QuestionPayload[]
  expiresAt?: number
}

type PendingItem = PendingApproval | PendingQuestion

export interface TurnUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface SessionUsage {
  cumulativeInput: number
  cumulativeOutput: number
  cumulativeCacheRead: number
  cumulativeCacheWrite: number
}

export interface ContextUsageCategory {
  name: string
  tokens: number
  color?: string
}

export interface ContextUsage {
  totalTokens: number
  maxTokens: number
  percentage: number
  categories: ContextUsageCategory[]
}

export interface ResultMeta {
  stopReason?: string | null
  terminalReason?: string
  origin?: string
}

export type { TaskItem }

interface PendingTaskCreate {
  subject: string
  description?: string
  activeForm?: string
}

export interface TurnCompletion {
  endedAt: number
  isError: boolean
  durationMs: number
}

export interface ChatState {
  sessions: Record<string, ChatSession[]>
  messages: Record<string, ChatMessage[]>
  /**
   * In-flight browser tool_use ids per session (F14): ids with a tool_use
   * part but no tool_result part. Maintained incrementally where those parts
   * land (and recomputed on wholesale message replacement) so selectors read
   * it in O(1) instead of rescanning every message part per store update.
   */
  inFlightBrowserTools: Record<string, ReadonlySet<string>>
  promptHistory: Record<string, string[]>
  activeSessionIds: Record<string, string>
  isStreaming: Record<string, boolean>
  isCompacting: Record<string, boolean>
  compactingStartTime: Record<string, number>
  streamStartedAt: Record<string, number>
  isLoadingSessions: Record<string, boolean>
  isLoadingMessages: Record<string, boolean>
  approvalQueue: Record<string, PendingItem[]>
  serverNonce: Record<string, string>
  draftQueue: Record<string, { workspaceId: string; content: string } | undefined>
  pendingSend: Record<string, { workspaceId: string; content: string } | undefined>
  drafts: Record<string, string>
  subagents: Record<string, SubagentState[]>
  sessionStatus: Record<string, { pendingCount: number; isProcessing?: boolean }>
  sessionProcessing: Record<string, boolean>
  sessionBackgroundTaskCount: Record<string, number>
  unreadCompletions: Record<string, boolean>
  lastActivityAt: Record<string, number>
  tasks: Record<string, TaskItem[]>
  pendingTaskCreates: Record<string, Record<string, PendingTaskCreate>>
  autoApprovedTools: Record<string, Record<string, 'auto' | 'readonly'>>
  windowCap: number
  totalMessageCount: Record<string, number>
  isLoadingOlderMessages: Record<string, boolean>
  lastTurnUsage: Record<string, TurnUsage>
  sessionUsage: Record<string, SessionUsage>
  contextUsage: Record<string, ContextUsage>
  resultMeta: Record<string, ResultMeta>
  lastCompletion: Record<string, TurnCompletion>
  domCache: Record<string, string[]>
  backgroundSessions: Record<string, string[]>
  isRestartingRuntime: Record<string, boolean>
  workflows: Record<string, WorkflowState[]>

  fetchSessions: (workspaceId: string) => Promise<{ ok: boolean; error?: string }>
  touchDomCache: (workspaceId: string, sessionId: string) => string | null
  getDomCache: (workspaceId: string) => string[]
  createSession: (workspaceId: string, name: string, approvalMode?: ApprovalMode, providerId?: string) => Promise<void>
  forkSession: (workspaceId: string, sessionId: string) => Promise<{ ok: boolean; error?: string }>
  addSession: (workspaceId: string, session: ChatSession) => void
  renameSession: (workspaceId: string, sessionId: string, name: string) => Promise<void>
  toggleSessionWip: (workspaceId: string, sessionId: string, isWip: boolean) => Promise<void>
  toggleSessionArchive: (workspaceId: string, sessionId: string, isArchived: boolean) => Promise<void>
  setActiveSession: (workspaceId: string, sessionId: string) => void
  loadMessages: (workspaceId: string, sessionId: string) => Promise<void>
  sendMessage: (workspaceId: string, sessionId: string, content: string) => void
  fetchPromptHistory: (workspaceId: string) => Promise<void>
  addPromptHistory: (workspaceId: string, sessionId: string, content: string) => void
  setDraft: (sessionId: string, content: string) => void
  clearMessages: (sessionId: string) => void
  resolveApproval: (
    workspaceId: string,
    sessionId: string,
    requestId: string,
    result: { behavior: 'allow' | 'deny'; updatedPermissions?: PermissionUpdate[]; answers?: Record<string, string>; questions?: QuestionPayload[]; message?: string },
  ) => Promise<void>
  interruptSession: (workspaceId: string, sessionId: string) => Promise<void>
  cleanupWorkspace: (workspaceId: string) => void
  fetchOlderMessages: (
    workspaceId: string,
    sessionId: string,
    offset: number,
    limit: number,
  ) => Promise<void>
  refreshBotMessages: (workspaceId: string, sessionId: string) => Promise<void>
  setWindowCap: (cap: number) => void
  setSessionApprovalMode: (workspaceId: string, sessionId: string, mode: ApprovalMode) => Promise<void>
  setSessionFastMode: (workspaceId: string, sessionId: string, fastMode: boolean) => Promise<void>
  setSessionProvider: (workspaceId: string, sessionId: string, providerId: string | null) => Promise<void>
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

const DEFAULT_WINDOW_CAP = 200
const DOM_CACHE_LIMIT = 5

function sanitizeMessagePart(part: unknown): MessagePart | null {
  if (!part || typeof part !== 'object') return null

  const p = part as Record<string, unknown>
  switch (p.type) {
    case 'text':
      return typeof p.text === 'string' ? { type: 'text', text: p.text } : null
    case 'thinking':
      return typeof p.text === 'string'
        ? {
            type: 'thinking',
            text: p.text,
            state: p.state === 'streaming' ? 'streaming' : 'complete',
          }
        : null
    case 'tool_use':
      return typeof p.toolUseId === 'string' && typeof p.toolName === 'string'
        ? {
            type: 'tool_use',
            toolUseId: p.toolUseId,
            toolName: p.toolName,
            input: p.input,
            ...(typeof p.inputJsonStream === 'string' && {
              inputJsonStream: p.inputJsonStream,
            }),
            state: p.state === 'streaming' ? 'streaming' : 'complete',
          }
        : null
    case 'tool_result':
      return typeof p.toolUseId === 'string'
        ? {
            type: 'tool_result',
            toolUseId: p.toolUseId,
            output: typeof p.output === 'string' ? p.output : '',
            isError: p.isError === true,
            ...(p.toolUseResult !== undefined && {
              toolUseResult: p.toolUseResult,
            }),
          }
        : null
    default:
      return null
  }
}

function sanitizeMessages(messages: unknown): ChatMessage[] {
  if (!Array.isArray(messages)) return []

  const sanitized: ChatMessage[] = []
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue

    const msg = raw as Record<string, unknown>
    const role = msg.role
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue

    const parts = Array.isArray(msg.parts)
      ? msg.parts
          .map((part) => sanitizeMessagePart(part))
          .filter((part): part is MessagePart => part !== null)
      : []
    if (parts.length === 0) continue

    sanitized.push({
      id: typeof msg.id === 'string' ? msg.id : generateId(),
      role,
      parts,
      timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : Date.now(),
      ...(msg.isStreaming === true && { isStreaming: true }),
    })
  }

  return sanitized
}

function sanitizeSubagentPart(part: unknown): SubagentPart | null {
  if (!part || typeof part !== 'object') return null

  const p = part as Record<string, unknown>
  switch (p.type) {
    case 'text':
      return typeof p.text === 'string' ? { type: 'text', text: p.text } : null
    case 'thinking':
      return typeof p.text === 'string' ? { type: 'thinking', text: p.text } : null
    case 'tool_use':
      return typeof p.toolUseId === 'string' && typeof p.toolName === 'string'
        ? { type: 'tool_use', toolUseId: p.toolUseId, toolName: p.toolName, input: p.input }
        : null
    case 'tool_result':
      return typeof p.toolUseId === 'string'
        ? {
            type: 'tool_result',
            toolUseId: p.toolUseId,
            output: typeof p.output === 'string' ? p.output : '',
            isError: p.isError === true,
          }
        : null
    default:
      return null
  }
}

function sanitizeSubagentMessage(msg: unknown): SubagentMessage | null {
  if (!msg || typeof msg !== 'object') return null
  const m = msg as Record<string, unknown>
  if (m.role !== 'assistant' && m.role !== 'user') return null
  const parts = Array.isArray(m.parts)
    ? m.parts
        .map((part) => sanitizeSubagentPart(part))
        .filter((part): part is SubagentPart => part !== null)
    : []
  if (parts.length === 0) return null
  return {
    id: typeof m.id === 'string' ? m.id : generateId(),
    role: m.role,
    parts,
  }
}

export function sanitizeSubagents(raw: unknown): SubagentState[] {
  if (!Array.isArray(raw)) return []

  const sanitized: SubagentState[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const s = entry as Record<string, unknown>
    if (typeof s.parentToolUseId !== 'string') continue
    if (s.state !== 'running' && s.state !== 'completed' && s.state !== 'error') continue
    if (typeof s.startTime !== 'number') continue
    if (typeof s.toolCount !== 'number') continue
    if (typeof s.progressHint !== 'string') continue
    if (typeof s.description !== 'string') continue

    const messages = Array.isArray(s.messages)
      ? s.messages
          .map((msg) => sanitizeSubagentMessage(msg))
          .filter((msg): msg is SubagentMessage => msg !== null)
      : []
    if (messages.length === 0) continue

    const endTime = typeof s.endTime === 'number' ? s.endTime : undefined
    sanitized.push({
      parentToolUseId: s.parentToolUseId,
      description: s.description,
      state: s.state,
      startTime: s.startTime,
      endTime,
      toolCount: s.toolCount,
      progressHint: s.progressHint,
      messages,
    })
  }
  return sanitized
}

const WORKFLOW_POLL_INTERVAL_MS = 2000
const WORKFLOW_FETCH_TIMEOUT_MS = 10000

function getWorkflowPollKey(sessionId: string, runId: string): string {
  return `${sessionId}:${runId}`
}

function isWorkflowTerminal(status: WorkflowState['status']): boolean {
  return status === 'completed' || status === 'error' || status === 'killed'
}

function stopWorkflowPolling(sessionId: string, runId: string): void {
  const key = getWorkflowPollKey(sessionId, runId)
  const entry = workflowPollTimers.get(key)
  if (!entry) return
  if (entry.timer) {
    clearTimeout(entry.timer)
  }
  if (entry.abortController) {
    try {
      entry.abortController.abort()
    } catch {
      // ignore cleanup errors
    }
  }
  workflowPollTimers.delete(key)
}

function stopAllWorkflowPollingForSession(sessionId: string): void {
  for (const key of workflowPollTimers.keys()) {
    if (key.startsWith(`${sessionId}:`)) {
      const entry = workflowPollTimers.get(key)
      if (entry?.timer) {
        clearTimeout(entry.timer)
      }
      if (entry?.abortController) {
        try {
          entry.abortController.abort()
        } catch {
          // ignore cleanup errors
        }
      }
      workflowPollTimers.delete(key)
    }
  }
}

function mergeWorkflowState(
  set: SseSetter,
  sessionId: string,
  workflow: WorkflowState,
): void {
  set((state) => {
    const list = state.workflows[sessionId] || []
    const idx = list.findIndex((w) => w.runId === workflow.runId)
    const nextList = idx >= 0 ? [...list.slice(0, idx), workflow, ...list.slice(idx + 1)] : [...list, workflow]
    const updates: Partial<ChatState> = {
      workflows: { ...state.workflows, [sessionId]: nextList },
    }

    if (workflow.subagents.length > 0) {
      const existingSubagents = state.subagents[sessionId] || []
      const subagentMap = new Map(existingSubagents.map((s) => [s.parentToolUseId, s]))
      for (const s of workflow.subagents) {
        subagentMap.set(s.parentToolUseId, s)
      }
      updates.subagents = { ...state.subagents, [sessionId]: Array.from(subagentMap.values()) }
    }

    return updates
  })
}

async function fetchWorkflowOnce(
  workspaceId: string,
  sessionId: string,
  runId: string,
  set: SseSetter,
  signal?: AbortSignal,
): Promise<WorkflowState | undefined> {
  try {
    const res = await fetch(`/api/workspaces/${workspaceId}/sessions/${sessionId}/workflows/${runId}`, {
      signal,
    })
    if (!res.ok) return undefined
    const data = (await res.json()) as { workflow?: WorkflowState }
    if (!data.workflow) return undefined
    mergeWorkflowState(set, sessionId, data.workflow)
    return data.workflow
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return undefined
    console.error('Failed to fetch workflow:', err)
    return undefined
  }
}

async function fetchWorkflow(
  workspaceId: string,
  sessionId: string,
  runId: string,
  set: SseSetter,
  generation: number,
): Promise<WorkflowState | undefined> {
  const key = getWorkflowPollKey(sessionId, runId)
  const entry = workflowPollTimers.get(key)
  if (!entry || entry.generation !== generation) return undefined

  const abortController = new AbortController()
  entry.abortController = abortController
  const timeoutId = setTimeout(() => abortController.abort(), WORKFLOW_FETCH_TIMEOUT_MS)

  try {
    const workflow = await fetchWorkflowOnce(workspaceId, sessionId, runId, set, abortController.signal)
    clearTimeout(timeoutId)
    const current = workflowPollTimers.get(key)
    if (!current || current.generation !== generation) return undefined
    return workflow
  } catch (err) {
    clearTimeout(timeoutId)
    if (err instanceof Error && err.name === 'AbortError') return undefined
    console.error('Failed to fetch workflow:', err)
    return undefined
  }
}

async function runWorkflowPollLoop(
  workspaceId: string,
  sessionId: string,
  runId: string,
  set: SseSetter,
  generation: number,
): Promise<void> {
  const key = getWorkflowPollKey(sessionId, runId)
  const workflow = await fetchWorkflow(workspaceId, sessionId, runId, set, generation)
  const entry = workflowPollTimers.get(key)
  if (!entry || entry.generation !== generation) return

  if (workflow && isWorkflowTerminal(workflow.status)) {
    stopWorkflowPolling(sessionId, runId)
    return
  }

  entry.timer = setTimeout(() => {
    entry.timer = undefined
    void runWorkflowPollLoop(workspaceId, sessionId, runId, set, generation)
  }, WORKFLOW_POLL_INTERVAL_MS)
}

function startWorkflowPolling(
  workspaceId: string,
  sessionId: string,
  runId: string,
  set: SseSetter,
): void {
  const key = getWorkflowPollKey(sessionId, runId)
  const existing = workflowPollTimers.get(key)
  if (existing) {
    // Abort any in-flight request and bump the generation so stale responses
    // from the previous loop are discarded.
    if (existing.abortController) {
      try {
        existing.abortController.abort()
      } catch {
        // ignore cleanup errors
      }
    }
    if (existing.timer) {
      clearTimeout(existing.timer)
      existing.timer = undefined
    }
    existing.generation += 1
    void runWorkflowPollLoop(workspaceId, sessionId, runId, set, existing.generation)
    return
  }

  const entry: WorkflowPollEntry = { generation: 0 }
  workflowPollTimers.set(key, entry)
  void runWorkflowPollLoop(workspaceId, sessionId, runId, set, entry.generation)
}

/**
 * Prune the oldest messages to keep the window at or below the cap.
 * Never splits a tool_use / tool_result pair: if a pair straddles the
 * prune boundary, pruning stops before the pair so both halves are kept.
 */
function pruneWindow(messages: ChatMessage[], cap: number): ChatMessage[] {
  if (messages.length <= cap) return messages

  // Map toolUseId -> message index for tool_use and tool_result
  const toolUsePositions = new Map<string, number>()
  const toolResultPositions = new Map<string, number>()
  for (let i = 0; i < messages.length; i++) {
    for (const p of messages[i].parts) {
      if (p?.type === 'tool_use') toolUsePositions.set(p.toolUseId, i)
      if (p?.type === 'tool_result') toolResultPositions.set(p.toolUseId, i)
    }
  }

  // Find intervals [usePos, resultPos] for complete pairs
  const pairIntervals: [number, number][] = []
  for (const [id, usePos] of toolUsePositions) {
    const resultPos = toolResultPositions.get(id)
    if (resultPos !== undefined) {
      pairIntervals.push([usePos, resultPos])
    }
  }

  const excess = messages.length - cap
  let pruneCount = excess

  // Move pruneCount backward to avoid splitting any pair
  for (const [usePos, resultPos] of pairIntervals) {
    if (usePos < pruneCount && pruneCount <= resultPos) {
      pruneCount = usePos
    }
  }

  return messages.slice(pruneCount)
}


export type SseSetter = (
  updater: (state: ChatState) => ChatState | Partial<ChatState>,
) => void

type SseGetter = () => ChatState

// ---------------------------------------------------------------------------
// In-flight browser tool ids (F14) — incremental mirror of "browser tool_use
// without its tool_result" over messages[sessionId]. Hot paths add/remove
// single ids; wholesale message replacements recompute with the same
// full-scan rule the selector used to apply (behavior-identical).
// ---------------------------------------------------------------------------

/** Full-scan derivation — the exact rule the old O(messages×parts) selector applied. */
export function deriveInFlightBrowserToolIds(messages: ChatMessage[]): Set<string> {
  const results = new Set<string>()
  const browserUses: string[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'tool_result') {
        results.add(part.toolUseId)
      } else if (part.type === 'tool_use' && part.toolName.startsWith(BROWSER_TOOL_PREFIX)) {
        browserUses.push(part.toolUseId)
      }
    }
  }
  return new Set(browserUses.filter((id) => !results.has(id)))
}

function removeInFlightBrowserTool(
  state: ChatState,
  sessionId: string,
  toolUseId: string,
): Partial<ChatState> {
  const current = state.inFlightBrowserTools[sessionId]
  if (!current?.has(toolUseId)) return {}
  const next = new Set(current)
  next.delete(toolUseId)
  return { inFlightBrowserTools: { ...state.inFlightBrowserTools, [sessionId]: next } }
}

function recomputeInFlightBrowserTools(
  state: ChatState,
  sessionId: string,
  messages: ChatMessage[],
): Partial<ChatState> {
  return {
    inFlightBrowserTools: {
      ...state.inFlightBrowserTools,
      [sessionId]: deriveInFlightBrowserToolIds(messages),
    },
  }
}

function browserToolUseIdOf(part: MessagePart | undefined): string | undefined {
  return part?.type === 'tool_use' && part.toolName.startsWith(BROWSER_TOOL_PREFIX)
    ? part.toolUseId
    : undefined
}

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
  while (parts.length < partIndex) {
    parts.push({ type: 'text', text: '' })
  }
  const before = parts[partIndex]
  parts[partIndex] = produce(before)
  const after = parts[partIndex]
  const updated: ChatMessage = { ...target, parts }
  const nextMsgs = [...msgs.slice(0, idx), updated, ...msgs.slice(idx + 1)]
  const updates: Partial<ChatState> = { messages: { ...state.messages, [sessionId]: nextMsgs } }
  // F14: keep the in-flight browser id set in step with the swapped part
  // (tool_use_start adds; a part replacing a browser tool_use removes).
  const beforeId = browserToolUseIdOf(before)
  const afterId = browserToolUseIdOf(after)
  if (beforeId !== afterId) {
    const current = state.inFlightBrowserTools[sessionId]
    if ((afterId !== undefined && !current?.has(afterId)) || (beforeId !== undefined && current?.has(beforeId))) {
      const next = new Set(current)
      if (beforeId !== undefined) next.delete(beforeId)
      if (afterId !== undefined) next.add(afterId)
      updates.inFlightBrowserTools = { ...state.inFlightBrowserTools, [sessionId]: next }
    }
  }
  return updates
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
      (p) => p?.type === 'tool_use' && p.toolUseId === toolUseId,
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

function findToolName(
  state: ChatState,
  sessionId: string,
  toolUseId: string,
): string | undefined {
  const msgs = state.messages[sessionId] || []
  for (const m of msgs) {
    const part = m.parts.find(
      (p): p is Extract<MessagePart, { type: 'tool_use' }> =>
        p?.type === 'tool_use' && p.toolUseId === toolUseId,
    )
    if (part) return part.toolName
  }
  return undefined
}

/**
 * Check whether a TaskCreate input should be treated as an internal task.
 * Matches the Claude Code convention: tasks created with
 * `metadata: { _internal: true }` are hidden from user-facing task lists.
 */
function isInternalTaskInput(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false
  const metadata = (input as Record<string, unknown>).metadata
  if (!metadata || typeof metadata !== 'object') return false
  return (metadata as Record<string, unknown>)._internal === true
}

function scanMessagesForTasks(messages: ChatMessage[]): TaskItem[] {
  const tasks: TaskItem[] = []
  const taskMap = new Map<string, TaskItem>()
  const pendingCreates = new Map<string, PendingTaskCreate>()

  for (const message of messages) {
    for (const part of message.parts) {
      if (!part) continue
      if (part.type === 'tool_use') {
        if (part.toolName === 'TaskCreate') {
          const input = part.input as
            | { subject: string; description?: string; activeForm?: string }
            | undefined
          if (input?.subject && !isInternalTaskInput(input)) {
            pendingCreates.set(part.toolUseId, {
              subject: input.subject,
              description: input.description,
              activeForm: input.activeForm,
            })
          }
        } else if (part.toolName === 'TaskUpdate') {
          const input = part.input as
            | {
                taskId: string
                status?: string
                subject?: string
                description?: string
                activeForm?: string
              }
            | undefined
          if (input?.taskId) {
            const existing = taskMap.get(input.taskId)
            if (existing) {
              if (input.status)
                existing.status = normalizeSdkStatus(input.status)
              if (input.subject) existing.subject = input.subject
              if (input.description !== undefined)
                existing.description = input.description
              if (input.activeForm !== undefined)
                existing.activeForm = input.activeForm
            }
          }
        }
      } else if (part.type === 'tool_result') {
        const pending = pendingCreates.get(part.toolUseId)
        if (pending) {
          let taskCreated = false

          // Prefer structured toolUseResult over parsing text output
          if (
            part.toolUseResult &&
            typeof part.toolUseResult === 'object' &&
            part.toolUseResult !== null
          ) {
            const tr = part.toolUseResult as {
              task?: { id?: unknown; subject?: unknown }
            }
            if (typeof tr.task?.id === 'string') {
              const item: TaskItem = {
                id: tr.task.id,
                subject:
                  typeof tr.task.subject === 'string'
                    ? tr.task.subject
                    : pending.subject,
                description: pending.description,
                status: 'pending',
                activeForm: pending.activeForm,
              }
              taskMap.set(item.id, item)
              tasks.push(item)
              taskCreated = true
            }
          }

          // Fallback: parse JSON from output text
          if (!taskCreated) {
            try {
              const parsed = JSON.parse(part.output) as
                | { task?: { id: string; subject: string } }
                | undefined
              if (parsed?.task?.id) {
                const item: TaskItem = {
                  id: parsed.task.id,
                  subject: parsed.task.subject || pending.subject,
                  description: pending.description,
                  status: 'pending',
                  activeForm: pending.activeForm,
                }
                taskMap.set(item.id, item)
                tasks.push(item)
              }
            } catch {
              // Ignore parse errors
            }
          }

          // Fallback: parse plain text like "Task #1 created successfully: ..."
          if (!taskCreated) {
            const match = part.output.match(/Task #(\d+) created successfully: (.+)/)
            if (match) {
              const item: TaskItem = {
                id: match[1],
                subject: match[2].trim() || pending.subject,
                description: pending.description,
                status: 'pending',
                activeForm: pending.activeForm,
              }
              taskMap.set(item.id, item)
              tasks.push(item)
            }
          }

          pendingCreates.delete(part.toolUseId)
        }
      }
    }
  }

  return tasks
}

function isSessionActive(state: ChatState, sessionId: string): boolean {
  for (const activeId of Object.values(state.activeSessionIds)) {
    if (activeId === sessionId) return true
  }
  return false
}

function addSystemMessage(
  state: ChatState,
  sessionId: string,
  text: string,
  subType?: string,
): Partial<ChatState> {
  return {
    messages: {
      ...state.messages,
      [sessionId]: [
        ...(state.messages[sessionId] || []),
        {
          id: generateId(),
          role: 'system',
          ...(subType !== undefined && { subType }),
          parts: [{ type: 'text', text }],
          timestamp: Date.now(),
        },
      ],
    },
  }
}

function hasPendingItem(state: ChatState, sessionId: string, requestId: string): boolean {
  return (state.approvalQueue[sessionId] || []).some((item) => item.requestId === requestId)
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
        (p) => p?.type === delta.type,
      )
      if (existingIdx >= 0) {
        const existing = lastMessage.parts[existingIdx]
        if (existing?.type === 'text' || existing?.type === 'thinking') {
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

export function handleWsEvent(set: SseSetter, get: SseGetter, msg: WsEventMessage): void {
  if (msg.eventType === 'sse' && msg.sessionId && msg.workspaceId) {
    const workspaceId = msg.workspaceId
    const sessionId = msg.sessionId
    // Remember the highest event id we've processed so a reconnect can request
    // replay from this point. Without this, a WebSocket reconnect during an
    // active turn misses events emitted while the client was disconnected.
    if (msg.eventId) {
      lastEventId.set(sessionId, msg.eventId)
    }
    const data = msg.data as { type?: string }
    if (typeof data.type === 'string') {
      handleSseEvent(set, workspaceId, sessionId, data.type, msg.data)
    }
    // Any event from a subscribed session is worth keeping alive in the
    // background until the server reports it idle. Skip the update when the
    // session is already registered to avoid listener churn on every delta.
    const state = get()
    if (!(state.backgroundSessions[workspaceId] || []).includes(sessionId)) {
      set((state) => addBackgroundSession(state, workspaceId, sessionId))
    }
  } else if (msg.eventType === 'runtime_closed' && msg.sessionId) {
    // The server closed this session's runtime (e.g. idle timeout). Tear down
    // the stale local subscription and clear the server nonce so the next
    // sendMessage re-subscribes to a fresh runtime instead of posting to the
    // void.
    if (msg.workspaceId) {
      closeBackgroundSessionSubscription(set, msg.workspaceId, msg.sessionId)
    } else {
      closeSingleSessionSubscription(set, msg.sessionId)
    }
  }
}

/** Test-only helpers for the reconnect `lastEventId` ring buffer. */
export function getLastEventId(sessionId: string): string | undefined {
  return lastEventId.get(sessionId)
}

export function clearLastEventId(sessionId?: string): void {
  if (sessionId) {
    lastEventId.delete(sessionId)
  } else {
    lastEventId.clear()
  }
}

export function handleSseEvent(
  set: SseSetter,
  workspaceId: string,
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
      set((state) => {
        const existing = state.messages[sessionId] || []
        if (existing.some((m) => m.id === messageId)) {
          // Reconnect replay — message already exists, just ensure isStreaming.
          const existingMsg = existing.find((m) => m.id === messageId)
          const updates: Partial<ChatState> = {
            messages: {
              ...state.messages,
              [sessionId]: existing.map((m) =>
                m.id === messageId ? { ...m, isStreaming: true } : m,
              ),
            },
          }
          // The prompt-send action is not replayed on reconnect, so recover the
          // turn-start timestamp from the existing assistant message when it is
          // missing — this keeps the duration guard working after a reconnect.
          if (!state.streamStartedAt[sessionId]) {
            updates.streamStartedAt = {
              ...state.streamStartedAt,
              [sessionId]: existingMsg?.timestamp || Date.now(),
            }
          }
          return updates
        }
        const startedAt = Date.now()
        const newMessages: ChatMessage[] = [
          ...existing,
          {
            id: messageId,
            role: 'assistant' as const,
            parts: [],
            timestamp: startedAt,
            isStreaming: true,
          },
        ]
        const pruned = pruneWindow(newMessages, state.windowCap)
        const updates: Partial<ChatState> = {
          messages: { ...state.messages, [sessionId]: pruned },
          totalMessageCount: {
            ...state.totalMessageCount,
            [sessionId]: (state.totalMessageCount[sessionId] || 0) + 1,
          },
          ...applyActivityUpdate(state, workspaceId, sessionId),
          // F14: a pruned prefix may have dropped an unpaired browser tool_use.
          ...(pruned.length !== newMessages.length
            ? recomputeInFlightBrowserTools(state, sessionId, pruned)
            : {}),
        }
        // Preserve an earlier prompt-send timestamp when present; otherwise
        // capture the turn start here.
        if (!state.streamStartedAt[sessionId]) {
          updates.streamStartedAt = { ...state.streamStartedAt, [sessionId]: startedAt }
        }
        if (state.isCompacting[sessionId]) {
          updates.isCompacting = { ...state.isCompacting, [sessionId]: false }
          updates.compactingStartTime = { ...state.compactingStartTime, [sessionId]: 0 }
        }
        return updates
      })
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
      set((state) => {
        const updates = mutateToolUsePart(state, sessionId, toolUseId, (part) => ({
          ...part,
          input,
          inputJsonStream: undefined,
          state: 'complete',
        }))
        const toolName = findToolName(state, sessionId, toolUseId)
        if (toolName === 'TaskCreate') {
          const createInput = input as
            | { subject: string; description?: string; activeForm?: string }
            | undefined
          if (createInput?.subject && !isInternalTaskInput(createInput)) {
            const pending = state.pendingTaskCreates[sessionId] || {}
            updates.pendingTaskCreates = {
              ...state.pendingTaskCreates,
              [sessionId]: {
                ...pending,
                [toolUseId]: {
                  subject: createInput.subject,
                  description: createInput.description,
                  activeForm: createInput.activeForm,
                },
              },
            }
          }
        } else if (toolName === 'TaskUpdate') {
          const updateInput = input as
            | {
                taskId: string
                status?: string
                subject?: string
                description?: string
                activeForm?: string
              }
            | undefined
          if (updateInput?.taskId) {
            const existingTasks = state.tasks[sessionId] || []
            const updatedTasks = existingTasks.map((task) => {
              if (task.id !== updateInput.taskId) return task
              return {
                ...task,
                ...(updateInput.status && { status: normalizeSdkStatus(updateInput.status) }),
                ...(updateInput.subject && { subject: updateInput.subject }),
                ...(updateInput.description !== undefined && { description: updateInput.description }),
                ...(updateInput.activeForm !== undefined && { activeForm: updateInput.activeForm }),
              }
            })
            updates.tasks = { ...state.tasks, [sessionId]: updatedTasks }
          }
        }
        return updates
      })
      return
    }
    case 'tool_use_meta': {
      const toolUseId = typeof data.toolUseId === 'string' ? data.toolUseId : ''
      const meta = (data as Record<string, unknown>).meta
      if (!toolUseId || !meta || typeof meta !== 'object') return
      const typedMeta = meta as { displayName?: unknown; iconUrl?: unknown }
      const displayName =
        typeof typedMeta.displayName === 'string' ? typedMeta.displayName : undefined
      const iconUrl = typeof typedMeta.iconUrl === 'string' ? typedMeta.iconUrl : undefined
      if (!displayName && !iconUrl) return
      set((state) =>
        mutateToolUsePart(state, sessionId, toolUseId, (part) => ({
          ...part,
          meta: {
            ...(part.meta ?? {}),
            ...(displayName !== undefined && { displayName }),
            ...(iconUrl !== undefined && { iconUrl }),
          },
        })),
      )
      return
    }
    case 'tool_input_delta': {
      const toolUseId = typeof data.toolUseId === 'string' ? data.toolUseId : ''
      const partialJson =
        typeof data.partialJson === 'string' ? data.partialJson : ''
      if (!toolUseId || !partialJson) return
      set((state) =>
        mutateToolUsePart(state, sessionId, toolUseId, (part) => ({
          ...part,
          inputJsonStream: (part.inputJsonStream ?? '') + partialJson,
        })),
      )
      return
    }
    case 'tool_result': {
      const toolUseId = typeof data.toolUseId === 'string' ? data.toolUseId : ''
      const output = typeof data.output === 'string' ? data.output : ''
      const isError = data.isError === true
      const toolUseResult = (data as Record<string, unknown>).toolUseResult
      if (!toolUseId) return
      set((state) => {
        const existing = state.messages[sessionId] || []
        const existingMessageIndex = existing.findIndex((m) =>
          m.parts.some((p) => p?.type === 'tool_result' && p.toolUseId === toolUseId),
        )
        const existingPartIndex =
          existingMessageIndex >= 0
            ? existing[existingMessageIndex].parts.findIndex(
                (p) => p?.type === 'tool_result' && p.toolUseId === toolUseId,
              )
            : -1
        const existingPart =
          existingMessageIndex >= 0 && existingPartIndex >= 0
            ? (existing[existingMessageIndex].parts[existingPartIndex] as {
                type: 'tool_result'
                toolUseId: string
                output: string
                isError: boolean
                toolUseResult?: unknown
              })
            : undefined

        if (existingPart) {
          const isAsyncPlaceholder =
            existingPart.toolUseResult &&
            typeof existingPart.toolUseResult === 'object' &&
            (existingPart.toolUseResult as Record<string, unknown>).status === 'async_launched'
          if (!isAsyncPlaceholder) {
            // Reconnect replay — tool_result already exists, skip
            return removeInFlightBrowserTool(state, sessionId, toolUseId)
          }
          // Replace the async-placeholder result in-place with the final result.
          const replacedMessages: ChatMessage[] = existing.map((m, mi) => {
            if (mi !== existingMessageIndex) return m
            return {
              ...m,
              parts: m.parts.map((p, pi) => {
                if (pi !== existingPartIndex) return p
                return {
                  type: 'tool_result' as const,
                  toolUseId,
                  output,
                  isError,
                  ...(toolUseResult !== undefined && { toolUseResult }),
                }
              }),
            }
          })
          const pruned = pruneWindow(replacedMessages, state.windowCap)
          return {
            messages: {
              ...state.messages,
              [sessionId]: pruned,
            },
            // F14: a dropped prefix may have carried the matching tool_use.
            ...(pruned.length !== replacedMessages.length
              ? recomputeInFlightBrowserTools(state, sessionId, pruned)
              : removeInFlightBrowserTool(state, sessionId, toolUseId)),
          }
        }
        const newMessages: ChatMessage[] = [
          ...existing,
          {
            id: generateId(),
            role: 'user' as const,
            parts: [
              {
                type: 'tool_result',
                toolUseId,
                output,
                isError,
                ...(toolUseResult !== undefined && { toolUseResult }),
              },
            ],
            timestamp: Date.now(),
          },
        ]
        const pruned = pruneWindow(newMessages, state.windowCap)
        const updates: Partial<ChatState> = {
          messages: { ...state.messages, [sessionId]: pruned },
          totalMessageCount: {
            ...state.totalMessageCount,
            [sessionId]: (state.totalMessageCount[sessionId] || 0) + 1,
          },
          ...(pruned.length !== newMessages.length
            ? recomputeInFlightBrowserTools(state, sessionId, pruned)
            : removeInFlightBrowserTool(state, sessionId, toolUseId)),
        }
        const pendingCreates = state.pendingTaskCreates[sessionId]
        if (pendingCreates && pendingCreates[toolUseId]) {
          const pending = pendingCreates[toolUseId]
          let taskCreated = false

          // Prefer structured toolUseResult over parsing text output
          if (
            toolUseResult &&
            typeof toolUseResult === 'object' &&
            toolUseResult !== null
          ) {
            const tr = toolUseResult as { task?: { id?: unknown; subject?: unknown } }
            if (typeof tr.task?.id === 'string') {
              const newTask: TaskItem = {
                id: tr.task.id,
                subject:
                  typeof tr.task.subject === 'string'
                    ? tr.task.subject
                    : pending.subject,
                description: pending.description,
                status: 'pending',
                activeForm: pending.activeForm,
              }
              const existingTasks = state.tasks[sessionId] || []
              updates.tasks = {
                ...state.tasks,
                [sessionId]: [...existingTasks, newTask],
              }
              taskCreated = true
            }
          }

          // Fallback: parse JSON from output text
          if (!taskCreated) {
            try {
              const parsed = JSON.parse(output) as
                | { task?: { id: string; subject: string } }
                | undefined
              if (parsed?.task?.id) {
                const newTask: TaskItem = {
                  id: parsed.task.id,
                  subject: parsed.task.subject || pending.subject,
                  description: pending.description,
                  status: 'pending',
                  activeForm: pending.activeForm,
                }
                const existingTasks = state.tasks[sessionId] || []
                updates.tasks = {
                  ...state.tasks,
                  [sessionId]: [...existingTasks, newTask],
                }
              }
            } catch {
              // Ignore parse errors
            }
          }

          // Fallback: parse plain text like "Task #1 created successfully: ..."
          if (!taskCreated) {
            const match = output.match(/Task #(\d+) created successfully: (.+)/)
            if (match) {
              const newTask: TaskItem = {
                id: match[1],
                subject: match[2].trim() || pending.subject,
                description: pending.description,
                status: 'pending',
                activeForm: pending.activeForm,
              }
              const existingTasks = state.tasks[sessionId] || []
              updates.tasks = {
                ...state.tasks,
                [sessionId]: [...existingTasks, newTask],
              }
            }
          }

          const newPending = { ...pendingCreates }
          delete newPending[toolUseId]
          updates.pendingTaskCreates = {
            ...state.pendingTaskCreates,
            [sessionId]: newPending,
          }
        }
        return updates
      })
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
    case 'compact_boundary': {
      set((state) => {
        const withMessage = addSystemMessage(state, sessionId, 'Conversation compacted')
        const messages = withMessage.messages?.[sessionId] || state.messages[sessionId] || []
        const lastMessage = messages[messages.length - 1]
        const newLastTurnUsage = { ...state.lastTurnUsage }
        delete newLastTurnUsage[sessionId]
        const newContextUsage = { ...state.contextUsage }
        delete newContextUsage[sessionId]
        const resetSessionUsage = {
          ...state.sessionUsage,
          [sessionId]: {
            cumulativeInput: 0,
            cumulativeOutput: 0,
            cumulativeCacheRead: 0,
            cumulativeCacheWrite: 0,
          },
        }
        if (lastMessage && lastMessage.role === 'system') {
          return {
            ...withMessage,
            messages: {
              ...state.messages,
              [sessionId]: messages.map((m, idx) =>
                idx === messages.length - 1 ? { ...m, isCompactBoundary: true } : m
              ),
            },
            isCompacting: { ...state.isCompacting, [sessionId]: false },
            compactingStartTime: { ...state.compactingStartTime, [sessionId]: 0 },
            lastTurnUsage: newLastTurnUsage,
            sessionUsage: resetSessionUsage,
            contextUsage: newContextUsage,
          }
        }
        return {
          ...withMessage,
          isCompacting: { ...state.isCompacting, [sessionId]: false },
          compactingStartTime: { ...state.compactingStartTime, [sessionId]: 0 },
          lastTurnUsage: newLastTurnUsage,
          sessionUsage: resetSessionUsage,
          contextUsage: newContextUsage,
        }
      })
      return
    }
    case 'context_usage': {
      const usage: ContextUsage = {
        totalTokens: typeof data.totalTokens === 'number' ? data.totalTokens : 0,
        maxTokens: typeof data.maxTokens === 'number' ? data.maxTokens : 0,
        percentage: typeof data.percentage === 'number' ? data.percentage : 0,
        categories: Array.isArray(data.categories)
          ? data.categories.map((c: unknown) => {
              const cx = c as Record<string, unknown>
              return {
                name: typeof cx.name === 'string' ? cx.name : '',
                tokens: typeof cx.tokens === 'number' ? cx.tokens : 0,
              }
            })
          : [],
      }
      set((state) => ({
        contextUsage: { ...state.contextUsage, [sessionId]: usage },
      }))
      return
    }
    case 'compact_status': {
      const active = data.active === true
      set((state) => ({
        isCompacting: { ...state.isCompacting, [sessionId]: active },
        compactingStartTime: active
          ? { ...state.compactingStartTime, [sessionId]: Date.now() }
          : { ...state.compactingStartTime, [sessionId]: 0 },
      }))
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
      const message = typeof data.message === 'string' ? data.message : i18next.t('common:streamError', 'Stream error')
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
                    text: i18next.t('common:serverRestarted', 'Server was restarted. Background work may have been lost.'),
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
          wsClient
            .request('sendMessage', { workspaceId, sessionId, content })
            .catch((err) => {
              console.error('Failed to send queued message:', err)
              set((s) =>
                addSystemMessage(
                  s,
                  sessionId,
                  `${i18next.t('common:failedToSend', 'Failed to send')}: ${err instanceof Error ? err.message : i18next.t('common:networkError', 'Network error')}`,
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
      diagLog(`[Client] pending_approval requestId=${requestId} toolName=${toolName}`)
      if (!requestId) return
      set((state) => {
        if (hasPendingItem(state, sessionId, requestId)) {
          diagLog(`[Client] pending_approval duplicate, ignored`)
          return {}
        }
        const expiresAt = typeof data.expiresAt === 'number' && Number.isFinite(data.expiresAt) ? data.expiresAt : undefined
        const queue = [
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
            expiresAt,
            denialReason: typeof data.denialReason === 'string' ? data.denialReason : undefined,
          },
        ]
        diagLog(`[Client] approvalQueue updated for ${sessionId}: length=${queue.length}`)
        return {
          approvalQueue: {
            ...state.approvalQueue,
            [sessionId]: queue,
          },
          ...applyActivityUpdate(state, workspaceId, sessionId),
        }
      })
      return
    }
    case 'pending_question': {
      const requestId = typeof data.requestId === 'string' ? data.requestId : ''
      const questions = Array.isArray(data.questions) ? data.questions : []
      diagLog(`[Client] pending_question requestId=${requestId} questions=${questions.length}`)
      if (!requestId) return
      set((state) => {
        if (hasPendingItem(state, sessionId, requestId)) {
          diagLog(`[Client] pending_question duplicate, ignored`)
          return {}
        }
        const expiresAt = typeof data.expiresAt === 'number' && Number.isFinite(data.expiresAt) ? data.expiresAt : undefined
        const queue = [
          ...(state.approvalQueue[sessionId] || []),
          { requestId, questions, expiresAt },
        ]
        diagLog(`[Client] approvalQueue updated for ${sessionId}: length=${queue.length}`)
        return {
          approvalQueue: {
            ...state.approvalQueue,
            [sessionId]: queue,
          },
          ...applyActivityUpdate(state, workspaceId, sessionId),
        }
      })
      return
    }
    case 'approval_resolved': {
      const requestId = typeof data.requestId === 'string' ? data.requestId : ''
      diagLog(`[Client] approval_resolved requestId=${requestId}`)
      if (!requestId) return
      set((state) => {
        const queue = state.approvalQueue[sessionId] || []
        const nextQueue = queue.filter((item) => item.requestId !== requestId)
        diagLog(`[Client] approvalQueue resolved for ${sessionId}: ${queue.length} -> ${nextQueue.length}`)
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
          wsClient
            .request('sendMessage', { workspaceId, sessionId, content })
            .catch((err) => {
              console.error('Failed to send queued message:', err)
            })
        }
        return updates
      })
      return
    }
    case 'approval_timeout': {
      // The server timed a pending card out (timeoutDeny): the card itself is
      // removed by the approval_resolved event that follows. Until now this
      // event had no consumer and the card vanished silently — surface a
      // toast so the user understands why (U5; the browser handoff timeout is
      // the first server-fixed timeout to rely on it).
      const requestId = typeof data.requestId === 'string' ? data.requestId : ''
      diagLog(`[Client] approval_timeout requestId=${requestId}`)
      useToastStore.getState().addToast({
        severity: 'warning',
        message: i18next.t('common:approvalTimeout', 'Approval request timed out and was dismissed.'),
      })
      return
    }
    case 'interrupted': {
      set((state) => {
        // The interrupted event clears the in-flight turn but, unlike
        // terminal events (error_note, rate_limit, …), historically added no
        // message — so a stopped turn was invisible, especially in result
        // mode where the partial assistant content collapses into a ghost.
        // Append an Interrupt system message so the stop is always shown.
        const withNotice = addSystemMessage(
          state,
          sessionId,
          i18next.t('common:interrupted', 'Interrupted by user'),
          'Interrupt',
        )
        // Background tasks may still be running (sessionProcessing); keep the
        // active/streaming state in that case, but always show the notice.
        if (state.sessionProcessing[sessionId]) return withNotice
        return {
          ...withNotice,
          isStreaming: { ...state.isStreaming, [sessionId]: false },
        }
      })
      return
    }
    case 'error_note': {
      const text = typeof data.text === 'string' ? data.text : i18next.t('common:error', 'Error')
      set((state) => addSystemMessage(state, sessionId, text))
      return
    }
    case 'api_retry': {
      const attempt = typeof data.attempt === 'number' ? data.attempt : 0
      const maxRetries = typeof data.maxRetries === 'number' ? data.maxRetries : 0
      const retryDelayMs = typeof data.retryDelayMs === 'number' ? data.retryDelayMs : 0
      const text = i18next.t('chat:apiRetry', {
        defaultValue: 'Retrying API request ({{attempt}}/{{maxRetries}}) after {{retryDelayMs}}ms',
        attempt,
        maxRetries,
        retryDelayMs,
      })
      set((state) => ({
        messages: {
          ...state.messages,
          [sessionId]: [
            ...(state.messages[sessionId] || []),
            {
              id: generateId(),
              role: 'system',
              subType: 'api_retry',
              parts: [{ type: 'text', text }],
              timestamp: Date.now(),
            },
          ],
        },
      }))
      return
    }
    case 'rate_limit': {
      const errorCode = typeof data.errorCode === 'string' ? data.errorCode : undefined
      const canUserPurchaseCredits = data.canUserPurchaseCredits === true
      const hasChargeableSavedPaymentMethod = data.hasChargeableSavedPaymentMethod === true
      let text: string
      if (errorCode === 'credits_required') {
        if (hasChargeableSavedPaymentMethod) {
          text = i18next.t(
            'common:rateLimit.creditsRequiredCanPurchase',
            'Credits required. Purchase credits to continue.',
          )
        } else if (canUserPurchaseCredits) {
          text = i18next.t(
            'common:rateLimit.creditsRequiredAddPayment',
            'Credits required. Add a payment method to purchase credits.',
          )
        } else {
          text = i18next.t('common:rateLimit.creditsRequired', 'Credits required to continue.')
        }
      } else {
        text = i18next.t(
          'common:rateLimit.throughput',
          'Rate limit reached. Please wait a moment and try again.',
        )
      }
      set((state) => {
        const updates: Partial<ChatState> = {
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
        if (!state.sessionProcessing[sessionId]) {
          updates.isStreaming = { ...state.isStreaming, [sessionId]: false }
        }
        return updates
      })
      return
    }
    case 'model_fallback': {
      const originalModel = typeof data.originalModel === 'string' ? data.originalModel : ''
      const fallbackModel = typeof data.fallbackModel === 'string' ? data.fallbackModel : ''
      const explanation = typeof data.explanation === 'string' ? data.explanation : undefined
      let text: string
      if (explanation) {
        text = explanation
      } else {
        text = i18next.t('common:modelFallback', {
          defaultValue: 'Model fallback: {{originalModel}} → {{fallbackModel}}',
          originalModel,
          fallbackModel,
        })
      }
      set((state) => {
        const existing = state.messages[sessionId] || []
        const retractedIds = Array.isArray(data.retractedMessageIds)
          ? (data.retractedMessageIds as string[])
          : []
        const filtered =
          retractedIds.length > 0
            ? existing.filter((m) => !retractedIds.includes(m.id))
            : existing
        const nextMessages: ChatMessage[] = [
          ...filtered,
          {
            id: generateId(),
            role: 'system',
            parts: [{ type: 'text', text }],
            timestamp: Date.now(),
          },
        ]
        return {
          messages: {
            ...state.messages,
            [sessionId]: nextMessages,
          },
          // F14: retracted messages may have carried browser tool parts.
          ...(filtered.length !== existing.length
            ? recomputeInFlightBrowserTools(state, sessionId, nextMessages)
            : {}),
        }
      })
      return
    }
    case 'server_restarted': {
      set((state) =>
        addSystemMessage(
          state,
          sessionId,
          i18next.t('common:serverRestarted', 'Server was restarted. Background work may have been lost.'),
        ),
      )
      return
    }
    case 'result': {
      set((state) => {
        const next: Partial<ChatState> = {
          ...applyActivityUpdate(state, workspaceId, sessionId),
        }
        // Keep the generating state while the server reports tracked
        // background tasks still running; the final session_processing
        // { processing: false } edge clears it.
        if (!state.sessionProcessing[sessionId]) {
          next.isStreaming = { ...state.isStreaming, [sessionId]: false }
          // The unread completion marker must land together with the
          // streaming clear: while background tasks still run, the session
          // is not done, and deriveSessionState would otherwise prioritize
          // 'finished-unread' over 'streaming' and hide the spinner. The
          // final session_processing { processing: false } edge sets it.
          if (!isSessionActive(state, sessionId)) {
            next.unreadCompletions = {
              ...state.unreadCompletions,
              [sessionId]: true,
            }
          }
        }

        const usage = data.usage as Record<string, unknown> | undefined
        if (usage && typeof usage === 'object') {
          const inputTokens =
            typeof usage.input_tokens === 'number' ? usage.input_tokens : 0
          const outputTokens =
            typeof usage.output_tokens === 'number' ? usage.output_tokens : 0
          const cacheReadTokens =
            typeof usage.cache_read_input_tokens === 'number'
              ? usage.cache_read_input_tokens
              : 0
          const cacheWriteTokens =
            typeof usage.cache_creation_input_tokens === 'number'
              ? usage.cache_creation_input_tokens
              : 0

          const turnUsage: TurnUsage = {
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
          }

          const prevSession = state.sessionUsage[sessionId]
          const sessionUsage: SessionUsage = {
            cumulativeInput:
              (prevSession?.cumulativeInput || 0) + inputTokens,
            cumulativeOutput:
              (prevSession?.cumulativeOutput || 0) + outputTokens,
            cumulativeCacheRead:
              (prevSession?.cumulativeCacheRead || 0) + cacheReadTokens,
            cumulativeCacheWrite:
              (prevSession?.cumulativeCacheWrite || 0) + cacheWriteTokens,
          }

          next.lastTurnUsage = {
            ...state.lastTurnUsage,
            [sessionId]: turnUsage,
          }
          next.sessionUsage = {
            ...state.sessionUsage,
            [sessionId]: sessionUsage,
          }
        }

        const stopReason =
          data.stopReason === null || typeof data.stopReason === 'string'
            ? data.stopReason
            : undefined
        const terminalReason =
          typeof data.terminalReason === 'string' ? data.terminalReason : undefined
        const origin = typeof data.origin === 'string' ? data.origin : undefined
        if (stopReason !== undefined || terminalReason !== undefined || origin !== undefined) {
          next.resultMeta = {
            ...state.resultMeta,
            [sessionId]: { stopReason, terminalReason, origin },
          }
        }

        // Record a per-session completion so the notification hook can fire the
        // "done" sound: only for turns long enough and without error, deduped by
        // endedAt so reconnect replays do not re-sound.
        const isError = data.isError === true
        const endedAt = Date.now()
        const startedAt = state.streamStartedAt[sessionId]
        const durationMs = startedAt ? endedAt - startedAt : 0
        next.lastCompletion = {
          ...state.lastCompletion,
          [sessionId]: { endedAt, isError, durationMs },
        }
        if (startedAt) {
          next.streamStartedAt = { ...state.streamStartedAt, [sessionId]: 0 }
        }

        return next
      })
      return
    }
    case 'subagent_start': {
      const parentToolUseId =
        typeof data.parentToolUseId === 'string' ? data.parentToolUseId : ''
      const description =
        typeof data.description === 'string' ? data.description : i18next.t('chat:agent', 'Agent')
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
    case 'task_started': {
      const taskId = typeof data.taskId === 'string' ? data.taskId : ''
      const description = typeof data.description === 'string' ? data.description : ''
      if (!taskId) return
      set((state) => {
        const existing = state.tasks[sessionId] || []
        if (existing.find((t) => t.id === taskId)) return {}
        return {
          tasks: {
            ...state.tasks,
            [sessionId]: [...existing, { id: taskId, subject: description, status: 'pending' as const }],
          },
        }
      })
      return
    }
    case 'task_updated': {
      const taskId = typeof data.taskId === 'string' ? data.taskId : ''
      const patch = data.patch as Record<string, unknown> | undefined
      if (!taskId || !patch) return
      set((state) => {
        const existing = state.tasks[sessionId] || []
        const updated = existing.map((task) => {
          if (task.id !== taskId) return task
          const next: TaskItem = { ...task }
          if (typeof patch.status === 'string') {
            next.status = normalizeSdkStatus(patch.status)
          }
          if (typeof patch.description === 'string') {
            next.subject = patch.description
          }
          return next
        })
        return { tasks: { ...state.tasks, [sessionId]: updated } }
      })
      return
    }
    case 'session_processing': {
      // The server's processing verdict is authoritative for subscribed
      // sessions: it hydrates a session subscribed mid background-only task
      // and keeps isStreaming true through a foreground `result` while
      // tracked background tasks still run.
      const processing = data.processing === true
      const backgroundTaskCount =
        typeof data.backgroundTaskCount === 'number' ? data.backgroundTaskCount : 0
      if (!sessionId) return
      set((state) => {
        // A { processing: false } edge after the session was processing is
        // the final settle: streaming clears here (the foreground `result`
        // left it set), so the unread completion marker for an inactive
        // session lands here too, mirroring the pre-change foreground
        // behavior. Requiring the prior verdict to be true keeps an idle
        // (re)subscribe verdict from spuriously marking the session unread.
        const completionPending =
          !processing &&
          state.sessionProcessing[sessionId] === true &&
          !isSessionActive(state, sessionId) &&
          !state.unreadCompletions[sessionId]
        // The server force-emits this verdict on every (re)subscribe, so
        // identical verdicts are common — skip the writes when nothing
        // changed to avoid notifying the three slices' subscribers.
        if (
          state.sessionProcessing[sessionId] === processing &&
          (state.sessionBackgroundTaskCount[sessionId] ?? 0) === backgroundTaskCount &&
          state.isStreaming[sessionId] === processing &&
          !completionPending
        ) {
          return {}
        }
        const next: Partial<ChatState> = {
          sessionProcessing: { ...state.sessionProcessing, [sessionId]: processing },
          sessionBackgroundTaskCount: {
            ...state.sessionBackgroundTaskCount,
            [sessionId]: backgroundTaskCount,
          },
          isStreaming: { ...state.isStreaming, [sessionId]: processing },
        }
        if (completionPending) {
          next.unreadCompletions = {
            ...state.unreadCompletions,
            [sessionId]: true,
          }
        }
        return next
      })
      return
    }
    case 'auto_approval': {
      const toolUseId = typeof data.toolUseId === 'string' ? data.toolUseId : ''
      const mode = data.mode === 'auto' || data.mode === 'readonly' ? data.mode : 'auto'
      if (!toolUseId) return
      set((state) => {
        const sessionTools = state.autoApprovedTools[sessionId] || {}
        return {
          autoApprovedTools: {
            ...state.autoApprovedTools,
            [sessionId]: { ...sessionTools, [toolUseId]: mode },
          },
        }
      })
      return
    }
    case 'workflow_start': {
      const runId = typeof data.runId === 'string' ? data.runId : ''
      const toolUseId = typeof data.toolUseId === 'string' ? data.toolUseId : undefined
      const workflowName = typeof data.workflowName === 'string' ? data.workflowName : undefined
      if (!runId) return
      set((state) => {
        const list = state.workflows[sessionId] || []
        if (list.some((w) => w.runId === runId)) return {}
        const placeholder: WorkflowState = {
          runId,
          sessionId,
          ...(toolUseId && { toolUseId }),
          ...(workflowName && { workflowName }),
          status: 'running',
          startTime: Date.now(),
          agentCount: 0,
          phases: [],
          progress: [],
          subagents: [],
        }
        return { workflows: { ...state.workflows, [sessionId]: [...list, placeholder] } }
      })
      startWorkflowPolling(workspaceId, sessionId, runId, set)
      return
    }
    case 'workflow_update': {
      const runId = typeof data.runId === 'string' ? data.runId : ''
      if (!runId) return
      // Do not restart polling for workflows that have already reached a terminal
      // state; a stale update arriving after workflow_done must not resurrect the
      // poll loop.
      set((state) => {
        const list = state.workflows[sessionId] || []
        const existing = list.find((w) => w.runId === runId)
        if (existing && isWorkflowTerminal(existing.status)) return {}
        startWorkflowPolling(workspaceId, sessionId, runId, set)
        return {}
      })
      return
    }
    case 'workflow_done': {
      const runId = typeof data.runId === 'string' ? data.runId : ''
      const status =
        data.status === 'completed' || data.status === 'error' || data.status === 'killed'
          ? data.status
          : 'completed'
      if (!runId) return
      set((state) => {
        const list = state.workflows[sessionId] || []
        const idx = list.findIndex((w) => w.runId === runId)
        if (idx < 0) return {}
        const updated: WorkflowState = { ...list[idx], status }
        return { workflows: { ...state.workflows, [sessionId]: [...list.slice(0, idx), updated, ...list.slice(idx + 1)] } }
      })
      stopWorkflowPolling(sessionId, runId)
      void fetchWorkflowOnce(workspaceId, sessionId, runId, set)
      return
    }
    case 'heartbeat':
      return
    case 'system_init':
    case 'done':
    default:
      return
  }
}

export function normalizeSdkStatus(status: string): TaskItem['status'] {
  switch (status) {
    case 'pending':
      return 'pending'
    case 'running':
      return 'in_progress'
    case 'in_progress':
      return 'in_progress'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'killed':
      return 'killed'
    case 'paused':
      return 'paused'
    default:
      return 'pending'
  }
}

function subscribeToSession(
  set: SseSetter,
  _get: SseGetter,
  workspaceId: string,
  sessionId: string,
): void {
  const existing = sessionSubscriptions.get(sessionId)
  if (existing) {
    existing.close()
  }

  // Mark this session as having no valid server nonce until subscription_ack
  // arrives. This prevents a stale nonce from letting sendMessage post to a
  // runtime that has no WebSocket handler registered.
  set((state) => ({
    serverNonce: { ...state.serverNonce, [sessionId]: '' },
  }))

  const doSubscribe = async (): Promise<void> => {
    try {
      // Read the latest lastEventId at resubscribe time so reconnect replay
      // starts from the most recently processed event.
      const lastId = lastEventId.get(sessionId)
      await wsClient.request(
        'subscribe',
        { workspaceId, sessionId, lastEventId: lastId },
        DEFAULT_TIMEOUT,
      )
      diagLog(`[WS ${sessionId}] subscribed`)
      set((state) => ({
        isRestartingRuntime: { ...state.isRestartingRuntime, [sessionId]: false },
      }))
      // The subscription is now a background-stream candidate for this workspace.
      set((state) => addBackgroundSession(state, workspaceId, sessionId))
    } catch (err) {
      set((state) => ({
        isRestartingRuntime: { ...state.isRestartingRuntime, [sessionId]: false },
        serverNonce: { ...state.serverNonce, [sessionId]: '' },
      }))
      console.error(`[WS ${sessionId}] subscribe failed`, err)
      set((state) =>
        addSystemMessage(
          state,
          sessionId,
          `${i18next.t('common:connectionError', 'Connection error')}: ${err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error')}`,
        ),
      )
    }
  }

  const thisClose = (): void => {
    void wsClient.request('unsubscribe', { workspaceId, sessionId }, 3000).catch(() => {})
  }

  const reconnectUnsub = wsClient.onReconnect(() => {
    diagLog(`[WS ${sessionId}] resubscribing after reconnect`)
    void doSubscribe()
  })

  sessionSubscriptions.set(sessionId, {
    close: () => {
      reconnectUnsub()
      thisClose()
    },
    workspaceId,
  })

  void doSubscribe()
}

function applyActivityUpdate(
  state: ChatState,
  workspaceId: string,
  sessionId: string,
): Partial<ChatState> {
  const workspaceSessions = state.sessions[workspaceId] || []
  const session = workspaceSessions.find((s) => s.id === sessionId)
  const updates: Partial<ChatState> = {
    lastActivityAt: { ...state.lastActivityAt, [sessionId]: Date.now() },
  }
  if (session?.isArchived) {
    updates.sessions = {
      ...state.sessions,
      [workspaceId]: workspaceSessions.map((s) =>
        s.id === sessionId ? { ...s, isArchived: false } : s,
      ),
    }
    fetch(`/api/workspaces/${workspaceId}/sessions/${sessionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isArchived: false }),
    }).catch((err) => {
      console.warn('Failed to clear archived state on activity:', err)
    })
  }
  return updates
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: {},
  messages: {},
  inFlightBrowserTools: {},
  promptHistory: {},
  activeSessionIds: {},
  isStreaming: {},
  isCompacting: {},
  compactingStartTime: {},
  streamStartedAt: {},
  isLoadingSessions: {},
  isLoadingMessages: {},
  approvalQueue: {},
  serverNonce: {},
  draftQueue: {},
  pendingSend: {},
  drafts: {},
  subagents: {},
  sessionStatus: {},
  sessionProcessing: {},
  sessionBackgroundTaskCount: {},
  unreadCompletions: {},
  lastActivityAt: {},
  tasks: {},
  pendingTaskCreates: {},
  autoApprovedTools: {},
  windowCap: DEFAULT_WINDOW_CAP,
  totalMessageCount: {},
  isLoadingOlderMessages: {},
  lastTurnUsage: {},
  sessionUsage: {},
  contextUsage: {},
  resultMeta: {},
  lastCompletion: {},
  domCache: {},
  backgroundSessions: {},
  isRestartingRuntime: {},
  workflows: {},

  // WebSocket event listener — routes server-pushed events back into the store.
  ...(typeof window !== 'undefined' && typeof WebSocket !== 'undefined'
    ? (() => {
        wsClient.onEvent((msg: WsEventMessage) => {
          handleWsEvent(set, get, msg)
        })
        wsClient.onDisconnect(() => {
          clearAllSessionSubscriptions(set)
        })
        void wsClient.connect().catch(() => {})
        return {}
      })()
    : {}),

  fetchSessions: async (workspaceId: string) => {
    set((state) => ({ isLoadingSessions: { ...state.isLoadingSessions, [workspaceId]: true } }))
    try {
      const settings = getInitialSettings()
      const threshold = settings.archiveThresholdDays
      const url = new URL(`/api/workspaces/${workspaceId}/sessions`, window.location.origin)
      if (typeof threshold === 'number' && threshold > 0) {
        url.searchParams.set('archive_threshold_days', String(threshold))
      }
      const res = await fetch(url.pathname + url.search)
      if (!res.ok) {
        return { ok: false, error: i18next.t('common:failedToFetchSessions', 'Failed to fetch sessions') }
      }
      const data = await res.json()
      const fetchedSessions: ChatSession[] = data.sessions || []
      set((state) => {
        const nextLastActivityAt = { ...state.lastActivityAt }
        for (const session of fetchedSessions) {
          nextLastActivityAt[session.id] =
            session.lastModified ?? (Date.parse(session.updatedAt) || Date.now())
        }
        for (const id of Object.keys(nextLastActivityAt)) {
          if (!fetchedSessions.some((s) => s.id === id)) {
            delete nextLastActivityAt[id]
          }
        }
        return {
          sessions: { ...state.sessions, [workspaceId]: fetchedSessions },
          lastActivityAt: nextLastActivityAt,
        }
      })
      startBackgroundPolling(set, workspaceId)
      // Load workspace-scoped prompt history in parallel with session setup.
      // Errors are logged but do not fail the overall session fetch.
      get().fetchPromptHistory(workspaceId).catch((err) => {
        console.error('Failed to fetch prompt history:', err)
      })
      return { ok: true }
    } catch (err) {
      console.error('Failed to fetch sessions:', err)
      return {
        ok: false,
        error: err instanceof Error ? err.message : i18next.t('common:networkError', 'Network error'),
      }
    } finally {
      set((state) => ({ isLoadingSessions: { ...state.isLoadingSessions, [workspaceId]: false } }))
    }
  },

  createSession: async (workspaceId: string, name: string, approvalMode?: ApprovalMode, providerId?: string) => {
    try {
      const body: Record<string, unknown> = { name }
      if (approvalMode) body.approvalMode = approvalMode
      if (providerId) body.providerId = providerId
      const res = await fetch(`/api/workspaces/${workspaceId}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(i18next.t('common:failedToCreateSession', 'Failed to create session'))
      const session: ChatSession = await res.json()
      const { nextCache, evicted } = computeDomCacheUpdate(get(), workspaceId, session.id)
      set((state) => {
        const nextUnread = { ...state.unreadCompletions }
        delete nextUnread[session.id]
        return {
          sessions: {
            ...state.sessions,
            [workspaceId]: [session, ...(state.sessions[workspaceId] || [])],
          },
          activeSessionIds: { ...state.activeSessionIds, [workspaceId]: session.id },
          unreadCompletions: nextUnread,
          domCache: { ...state.domCache, [workspaceId]: nextCache },
          ...applyActivityUpdate(state, workspaceId, session.id),
        }
      })
      if (evicted) {
        closeBackgroundSessionSubscription(set, workspaceId, evicted)
      }
    } catch (err) {
      console.error('Failed to create session:', err)
    }
  },

  forkSession: async (workspaceId: string, sessionId: string) => {
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/sessions/${sessionId}/fork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      if (!res.ok) throw new Error(i18next.t('common:failedToForkSession', 'Failed to fork session'))
      const data = (await res.json()) as { sessionId?: string }
      const forkedSessionId = data.sessionId
      if (!forkedSessionId) {
        throw new Error(i18next.t('common:failedToForkSession', 'Failed to fork session'))
      }
      const fetchResult = await get().fetchSessions(workspaceId)
      if (fetchResult.ok) {
        set((state) => ({
          activeSessionIds: { ...state.activeSessionIds, [workspaceId]: forkedSessionId },
          ...applyActivityUpdate(state, workspaceId, forkedSessionId),
        }))
      }
      return { ok: true }
    } catch (err) {
      console.error('Failed to fork session:', err)
      return {
        ok: false,
        error: err instanceof Error ? err.message : i18next.t('common:networkError', 'Network error'),
      }
    }
  },

  addSession: (workspaceId: string, session: ChatSession) => {
    const { nextCache, evicted } = computeDomCacheUpdate(get(), workspaceId, session.id)
    set((state) => {
      const nextUnread = { ...state.unreadCompletions }
      delete nextUnread[session.id]
      return {
        sessions: {
          ...state.sessions,
          [workspaceId]: [session, ...(state.sessions[workspaceId] || [])],
        },
        activeSessionIds: { ...state.activeSessionIds, [workspaceId]: session.id },
        unreadCompletions: nextUnread,
        domCache: { ...state.domCache, [workspaceId]: nextCache },
        ...applyActivityUpdate(state, workspaceId, session.id),
      }
    })
    if (evicted) {
      closeBackgroundSessionSubscription(set, workspaceId, evicted)
    }
  },

  renameSession: async (workspaceId: string, sessionId: string, name: string) => {
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/sessions/${sessionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) throw new Error(i18next.t('common:failedToRenameSession', 'Failed to rename session'))
      const updated: ChatSession = await res.json()
      set((state) => {
        const workspaceSessions = state.sessions[workspaceId] || []
        const nextSessions = workspaceSessions.map((s) =>
          s.id === sessionId
            ? { ...s, name: updated.name, customTitle: updated.customTitle, updatedAt: updated.updatedAt }
            : s,
        )
        return {
          sessions: { ...state.sessions, [workspaceId]: nextSessions },
        }
      })
    } catch (err) {
      console.error('Failed to rename session:', err)
    }
  },

  toggleSessionWip: async (workspaceId: string, sessionId: string, isWip: boolean) => {
    try {
      // Optimistic update
      set((state) => {
        const workspaceSessions = state.sessions[workspaceId] || []
        const nextSessions = workspaceSessions.map((s) =>
          s.id === sessionId ? { ...s, isWip } : s,
        )
        return {
          sessions: { ...state.sessions, [workspaceId]: nextSessions },
        }
      })

      const res = await fetch(`/api/workspaces/${workspaceId}/sessions/${sessionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isWip }),
      })
      if (!res.ok) throw new Error(i18next.t('common:failedToUpdateSession', 'Failed to update session'))
      const updated: ChatSession = await res.json()
      // Confirm state with server response
      set((state) => {
        const workspaceSessions = state.sessions[workspaceId] || []
        const nextSessions = workspaceSessions.map((s) =>
          s.id === sessionId ? { ...s, isWip: updated.isWip } : s,
        )
        return {
          sessions: { ...state.sessions, [workspaceId]: nextSessions },
        }
      })
    } catch (err) {
      console.error('Failed to toggle session WIP:', err)
      // Revert optimistic update on error
      set((state) => {
        const workspaceSessions = state.sessions[workspaceId] || []
        const nextSessions = workspaceSessions.map((s) =>
          s.id === sessionId ? { ...s, isWip: !isWip } : s,
        )
        return {
          sessions: { ...state.sessions, [workspaceId]: nextSessions },
        }
      })
    }
  },

  toggleSessionArchive: async (workspaceId: string, sessionId: string, isArchived: boolean) => {
    try {
      // Optimistic update
      set((state) => {
        const workspaceSessions = state.sessions[workspaceId] || []
        const nextSessions = workspaceSessions.map((s) =>
          s.id === sessionId ? { ...s, isArchived } : s,
        )
        return {
          sessions: { ...state.sessions, [workspaceId]: nextSessions },
        }
      })

      const res = await fetch(`/api/workspaces/${workspaceId}/sessions/${sessionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isArchived }),
      })
      if (!res.ok) throw new Error(i18next.t('common:failedToUpdateSession', 'Failed to update session'))
      const updated: ChatSession = await res.json()
      // Confirm state with server response
      set((state) => {
        const workspaceSessions = state.sessions[workspaceId] || []
        const nextSessions = workspaceSessions.map((s) =>
          s.id === sessionId ? { ...s, isArchived: updated.isArchived } : s,
        )
        return {
          sessions: { ...state.sessions, [workspaceId]: nextSessions },
        }
      })
    } catch (err) {
      console.error('Failed to toggle session archive:', err)
      // Revert optimistic update on error
      set((state) => {
        const workspaceSessions = state.sessions[workspaceId] || []
        const nextSessions = workspaceSessions.map((s) =>
          s.id === sessionId ? { ...s, isArchived: !isArchived } : s,
        )
        return {
          sessions: { ...state.sessions, [workspaceId]: nextSessions },
        }
      })
    }
  },

  setActiveSession: (workspaceId: string, sessionId: string) => {
    // Avoid duplicate subscriptions when the App-level effect re-fires with the
    // same active session (e.g. after a state update that preserves the selection).
    // We must also verify the subscription is still alive: switching workspaces
    // tears down the previous session's subscription, so returning here would
    // leave the session unsubscribed when the user switches back.
    if (get().activeSessionIds[workspaceId] === sessionId && sessionSubscriptions.has(sessionId)) return

    const { nextCache, evicted } = computeDomCacheUpdate(get(), workspaceId, sessionId)

    set((state) => {
      const nextUnread = { ...state.unreadCompletions }
      if (sessionId) delete nextUnread[sessionId]
      return {
        activeSessionIds: { ...state.activeSessionIds, [workspaceId]: sessionId },
        unreadCompletions: nextUnread,
        domCache: { ...state.domCache, [workspaceId]: nextCache },
        ...(sessionId ? applyActivityUpdate(state, workspaceId, sessionId) : {}),
      }
    })

    if (evicted) {
      closeBackgroundSessionSubscription(set, workspaceId, evicted)
    }

    // Auto-subscribe when switching to a session (skip for bot sessions and
    // sessions that are already background-subscribed).
    if (sessionId && !sessionSubscriptions.has(sessionId)) {
      const session = get().sessions[workspaceId]?.find((s) => s.id === sessionId)
      if (session && !isBotSession(session.source)) {
        subscribeToSession(set, get, workspaceId, sessionId)
      }
    }
  },

  touchDomCache: (workspaceId: string, sessionId: string) => {
    const { nextCache, evicted } = computeDomCacheUpdate(get(), workspaceId, sessionId)
    set((state) => ({
      domCache: { ...state.domCache, [workspaceId]: nextCache },
    }))
    if (evicted) {
      closeBackgroundSessionSubscription(set, workspaceId, evicted)
    }
    return evicted
  },

  getDomCache: (workspaceId: string) => {
    return get().domCache[workspaceId] || []
  },

  loadMessages: async (workspaceId: string, sessionId: string) => {
    // Skip fetch if messages are already cached for this session
    const existing = get().messages[sessionId] || []
    if (existing.length > 0) {
      set((state) => ({ isLoadingMessages: { ...state.isLoadingMessages, [sessionId]: false } }))
      return
    }

    try {
      set((state) => ({ isLoadingMessages: { ...state.isLoadingMessages, [sessionId]: true } }))
      const data = (await wsClient.request('loadMessages', { workspaceId, sessionId })) as {
        messages?: unknown
        tasks?: TaskItem[]
        subagents?: unknown
        workflows?: unknown
      }
      const mappedMessages = sanitizeMessages(data.messages)
      const serverTasks = data.tasks ?? []
      const serverSubagents = sanitizeSubagents(data.subagents)
      const serverWorkflows = Array.isArray(data.workflows) ? (data.workflows as WorkflowState[]) : []

      set((state) => {
        const existing = state.messages[sessionId] || []
        const hasStreaming = existing.some((m) => m.isStreaming)
        if (hasStreaming) {
          return { isLoadingMessages: { ...state.isLoadingMessages, [sessionId]: false } }
        }
        const pruned = pruneWindow(mappedMessages, state.windowCap)
        const scannedTasks = scanMessagesForTasks(mappedMessages)
        const taskMap = new Map<string, TaskItem>()
        for (const task of serverTasks) {
          if (!task.id.startsWith('todowrite-')) taskMap.set(task.id, task)
        }
        for (const task of scannedTasks) {
          if (!task.id.startsWith('todowrite-')) taskMap.set(task.id, task)
        }

        const existingSubagents = state.subagents[sessionId] || []
        const runningIds = new Set(
          existingSubagents.filter((s) => s.state === 'running').map((s) => s.parentToolUseId),
        )
        const mergedSubagents = new Map<string, SubagentState>()
        for (const s of existingSubagents) {
          mergedSubagents.set(s.parentToolUseId, s)
        }
        for (const s of serverSubagents) {
          if (!runningIds.has(s.parentToolUseId)) {
            mergedSubagents.set(s.parentToolUseId, s)
          }
        }

        return {
          messages: { ...state.messages, [sessionId]: pruned },
          isLoadingMessages: { ...state.isLoadingMessages, [sessionId]: false },
          tasks: { ...state.tasks, [sessionId]: Array.from(taskMap.values()) },
          subagents: { ...state.subagents, [sessionId]: Array.from(mergedSubagents.values()) },
          totalMessageCount: {
            ...state.totalMessageCount,
            [sessionId]: mappedMessages.length,
          },
          // F14: wholesale replacement — recompute with the full-scan rule.
          ...recomputeInFlightBrowserTools(state, sessionId, pruned),
        }
      })

      // Hydrate workflow state from history and start polling for any that are
      // still running. This ensures the floating panel appears for workflows
      // that completed before the session was reopened.
      for (const workflow of serverWorkflows) {
        mergeWorkflowState(set, sessionId, workflow)
        if (!isWorkflowTerminal(workflow.status)) {
          startWorkflowPolling(workspaceId, sessionId, workflow.runId, set)
        }
      }
    } catch (err) {
      console.error('Failed to load messages:', err)
      set((state) => ({ isLoadingMessages: { ...state.isLoadingMessages, [sessionId]: false } }))
    }
  },

  cleanupWorkspace: (workspaceId: string) => {
    closeWorkspaceSessionSubscriptions(workspaceId)
    const poll = workspacePollIntervals.get(workspaceId)
    if (poll) {
      clearInterval(poll)
      workspacePollIntervals.delete(workspaceId)
    }
    set((state) => {
      const nextPromptHistory = { ...state.promptHistory }
      delete nextPromptHistory[workspaceId]
      const nextBackgroundSessions = { ...state.backgroundSessions }
      delete nextBackgroundSessions[workspaceId]
      return { promptHistory: nextPromptHistory, backgroundSessions: nextBackgroundSessions }
    })
  },

  sendMessage: (workspaceId: string, sessionId: string, content: string) => {
    // Defensive guard: do not send messages to bot sessions
    const session = get().sessions[workspaceId]?.find((s) => s.id === sessionId)
    if (session && isBotSession(session.source)) {
      console.warn('[sendMessage] blocked: cannot send messages to bot sessions')
      return
    }

    // Record user-sent prompt in workspace-scoped history.
    get().addPromptHistory(workspaceId, sessionId, content)

    // Ensure subscription is open
    if (!sessionSubscriptions.has(sessionId)) {
      subscribeToSession(set, get, workspaceId, sessionId)
    }

    const userMessageId = generateId()

    // Optimistically add user message and clear the input draft
    set((state) => {
      const nextDrafts = { ...state.drafts }
      delete nextDrafts[sessionId]
      const nextUnread = { ...state.unreadCompletions }
      delete nextUnread[sessionId]
      const newMessages: ChatMessage[] = [
        ...(state.messages[sessionId] || []),
        {
          id: userMessageId,
          role: 'user' as const,
          parts: [{ type: 'text', text: content }],
          timestamp: Date.now(),
        },
      ]
      const pruned = pruneWindow(newMessages, state.windowCap)
      const workspaceSessions = state.sessions[workspaceId] || []
      const nextSessions = workspaceSessions.map((s) =>
        s.id === sessionId ? { ...s, isDraft: false } : s,
      )
      return {
        messages: { ...state.messages, [sessionId]: pruned },
        drafts: nextDrafts,
        sessions: { ...state.sessions, [workspaceId]: nextSessions },
        isStreaming: { ...state.isStreaming, [sessionId]: true },
        streamStartedAt: { ...state.streamStartedAt, [sessionId]: Date.now() },
        unreadCompletions: nextUnread,
        totalMessageCount: {
          ...state.totalMessageCount,
          [sessionId]: (state.totalMessageCount[sessionId] || 0) + 1,
        },
        ...applyActivityUpdate(state, workspaceId, sessionId),
        // F14: a pruned prefix may have dropped an unpaired browser tool_use.
        ...(pruned.length !== newMessages.length
          ? recomputeInFlightBrowserTools(state, sessionId, pruned)
          : {}),
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

    // Gate the send on subscription_ack — without an ack, the server has not
    // yet wired this client's response into the emitter, so events would emit
    // only into the ring buffer. The ack handler drains pendingSend.
    if (!get().serverNonce[sessionId]) {
      set((state) => ({
        pendingSend: { ...state.pendingSend, [sessionId]: { workspaceId, content } },
      }))
      return
    }

    // Send via WebSocket
    wsClient
      .request('sendMessage', { workspaceId, sessionId, content })
      .catch((err) => {
        console.error('Failed to send message:', err)
        set((state) =>
          addSystemMessage(
            state,
            sessionId,
          `${i18next.t('common:failedToSend', 'Failed to send')}: ${err instanceof Error ? err.message : i18next.t('common:networkError', 'Network error')}`,
        ),
      )
    })
  },

  fetchPromptHistory: async (workspaceId: string) => {
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/prompt-history`)
      if (!res.ok) throw new Error(i18next.t('common:failedToFetchPromptHistory', 'Failed to fetch prompt history'))
      const data = (await res.json()) as { prompts?: Array<{ prompt: string } > }
      const prompts = (data.prompts || []).map((p) => p.prompt)
      set((state) => ({
        promptHistory: { ...state.promptHistory, [workspaceId]: prompts },
      }))
    } catch (err) {
      console.error('Failed to fetch prompt history:', err)
    }
  },

  addPromptHistory: (workspaceId: string, sessionId: string, content: string) => {
    const trimmed = content.trim()
    if (!trimmed) return

    set((state) => {
      const existing = state.promptHistory[workspaceId] || []
      return {
        promptHistory: {
          ...state.promptHistory,
          [workspaceId]: [...existing, trimmed],
        },
      }
    })

    fetch(`/api/workspaces/${workspaceId}/prompt-history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, prompt: trimmed }),
    }).catch((err) => {
      console.error('Failed to record prompt history:', err)
    })
  },

  clearMessages: (sessionId: string) => {
    stopAllWorkflowPollingForSession(sessionId)
    set((state) => {
      const newMessages = { ...state.messages }
      delete newMessages[sessionId]
      const newInFlightBrowserTools = { ...state.inFlightBrowserTools }
      delete newInFlightBrowserTools[sessionId]
      const newSubagents = { ...state.subagents }
      delete newSubagents[sessionId]
      const newTasks = { ...state.tasks }
      delete newTasks[sessionId]
      const newPendingTaskCreates = { ...state.pendingTaskCreates }
      delete newPendingTaskCreates[sessionId]
      const newLastTurnUsage = { ...state.lastTurnUsage }
      delete newLastTurnUsage[sessionId]
      const newSessionUsage = { ...state.sessionUsage }
      delete newSessionUsage[sessionId]
      const newContextUsage = { ...state.contextUsage }
      delete newContextUsage[sessionId]
      const newResultMeta = { ...state.resultMeta }
      delete newResultMeta[sessionId]
      const newAutoApprovedTools = { ...state.autoApprovedTools }
      delete newAutoApprovedTools[sessionId]
      const newIsRestartingRuntime = { ...state.isRestartingRuntime }
      delete newIsRestartingRuntime[sessionId]
      const newWorkflows = { ...state.workflows }
      delete newWorkflows[sessionId]
      return {
        messages: newMessages,
        inFlightBrowserTools: newInFlightBrowserTools,
        subagents: newSubagents,
        tasks: newTasks,
        pendingTaskCreates: newPendingTaskCreates,
        lastTurnUsage: newLastTurnUsage,
        sessionUsage: newSessionUsage,
        contextUsage: newContextUsage,
        resultMeta: newResultMeta,
        autoApprovedTools: newAutoApprovedTools,
        isRestartingRuntime: newIsRestartingRuntime,
        workflows: newWorkflows,
      }
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
        const error = await res.json().catch(() => ({ error: i18next.t('common:requestFailed', 'Request failed') }))
        throw new Error(error.error || i18next.t('common:requestFailed', 'Request failed'))
      }

      // Optimistically remove from queue so the panel dismisses immediately
      set((state) => {
        const queue = state.approvalQueue[sessionId] || []
        const nextQueue = queue.filter((item) => item.requestId !== requestId)
        return {
          approvalQueue: { ...state.approvalQueue, [sessionId]: nextQueue },
        }
      })
    } catch (err) {
      console.error('Failed to resolve approval:', err)
      set((state) =>
        addSystemMessage(
          state,
          sessionId,
          `${i18next.t('common:approvalError', 'Approval error')}: ${err instanceof Error ? err.message : i18next.t('common:networkError', 'Network error')}`,
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
        const error = await res.json().catch(() => ({ error: i18next.t('common:requestFailed', 'Request failed') }))
        throw new Error(error.error || i18next.t('common:requestFailed', 'Request failed'))
      }
    } catch (err) {
      console.error('Failed to interrupt:', err)
      set((state) =>
        addSystemMessage(
          state,
          sessionId,
          `${i18next.t('common:interruptError', 'Interrupt error')}: ${err instanceof Error ? err.message : i18next.t('common:networkError', 'Network error')}`,
        ),
      )
    }
  },

  fetchOlderMessages: async (
    workspaceId: string,
    sessionId: string,
    offset: number,
    limit: number,
  ) => {
    try {
      set((state) => ({
        isLoadingOlderMessages: {
          ...state.isLoadingOlderMessages,
          [sessionId]: true,
        },
      }))
      const data = (await wsClient.request('loadMessages', { workspaceId, sessionId, offset, limit })) as {
        messages?: unknown
        tasks?: TaskItem[]
      }
      const olderMessages = sanitizeMessages(data.messages)

      set((state) => {
        const current = state.messages[sessionId] || []
        // Prepend older messages, avoiding duplicates by message id
        const existingIds = new Set(current.map((m) => m.id))
        const newOlder = olderMessages.filter((m) => !existingIds.has(m.id))
        const merged = [...newOlder, ...current]
        return {
          messages: { ...state.messages, [sessionId]: merged },
          isLoadingOlderMessages: {
            ...state.isLoadingOlderMessages,
            [sessionId]: false,
          },
          // F14: prepended history may contain browser tool parts.
          ...(newOlder.length > 0 ? recomputeInFlightBrowserTools(state, sessionId, merged) : {}),
        }
      })
    } catch (err) {
      console.error('Failed to fetch older messages:', err)
      set((state) => ({
        isLoadingOlderMessages: {
          ...state.isLoadingOlderMessages,
          [sessionId]: false,
        },
      }))
    }
  },

  refreshBotMessages: async (workspaceId: string, sessionId: string) => {
    const session = get().sessions[workspaceId]?.find((s) => s.id === sessionId)
    if (!session || !isBotSession(session.source)) {
      console.warn('[refreshBotMessages] blocked: only bot sessions support refresh')
      return
    }

    const currentMessages = get().messages[sessionId] || []
    const lastMessage = currentMessages[currentMessages.length - 1]
    const afterMessageId = lastMessage?.id

    try {
      set((state) => ({
        isLoadingMessages: { ...state.isLoadingMessages, [sessionId]: true },
      }))

      const data = (await wsClient.request('loadMessagesAfter', {
        workspaceId,
        sessionId,
        afterMessageId,
      })) as { messages?: unknown; tasks?: TaskItem[] }
      const newMessages = sanitizeMessages(data.messages)

      set((state) => {
        const current = state.messages[sessionId] || []
        const existingIds = new Set(current.map((m) => m.id))
        const uniqueNew = newMessages.filter((m) => !existingIds.has(m.id))
        const merged = [...current, ...uniqueNew]
        return {
          messages: { ...state.messages, [sessionId]: merged },
          isLoadingMessages: { ...state.isLoadingMessages, [sessionId]: false },
          // F14: appended history may contain browser tool parts.
          ...(uniqueNew.length > 0 ? recomputeInFlightBrowserTools(state, sessionId, merged) : {}),
        }
      })
    } catch (err) {
      console.error('Failed to refresh bot messages:', err)
      set((state) => ({
        isLoadingMessages: { ...state.isLoadingMessages, [sessionId]: false },
      }))
    }
  },

  setWindowCap: (cap: number) => {
    const clamped = Math.max(50, Math.min(1000, cap))
    set({ windowCap: clamped })
  },

  setSessionApprovalMode: async (workspaceId: string, sessionId: string, mode: ApprovalMode) => {
    // Optimistic update
    set((state) => {
      const workspaceSessions = state.sessions[workspaceId] || []
      const nextSessions = workspaceSessions.map((s) =>
        s.id === sessionId ? { ...s, approvalMode: mode } : s,
      )
      return {
        sessions: { ...state.sessions, [workspaceId]: nextSessions },
      }
    })

    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/sessions/${sessionId}/approval-mode`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approvalMode: mode }),
        },
      )
      if (!res.ok) throw new Error(i18next.t('common:failedToUpdateApprovalMode', 'Failed to update approval mode'))
    } catch (err) {
      console.error('Failed to set approval mode:', err)
      // Revert optimistic update on error
      set((state) => {
        const workspaceSessions = state.sessions[workspaceId] || []
        const session = workspaceSessions.find((s) => s.id === sessionId)
        const prevMode = session?.approvalMode === mode
          ? (mode === 'auto' ? 'manual' : mode === 'readonly' ? 'manual' : 'auto')
          : session?.approvalMode
        const nextSessions = workspaceSessions.map((s) =>
          s.id === sessionId ? { ...s, approvalMode: prevMode } : s,
        )
        return {
          sessions: { ...state.sessions, [workspaceId]: nextSessions },
        }
      })
    }
  },

  setSessionFastMode: async (workspaceId: string, sessionId: string, fastMode: boolean) => {
    // Snapshot the previous value before the optimistic update so the revert
    // restores the exact prior state instead of the newly-set value.
    let previousFastMode = false
    set((state) => {
      const workspaceSessions = state.sessions[workspaceId] || []
      const session = workspaceSessions.find((s) => s.id === sessionId)
      previousFastMode = session?.fastMode ?? false
      const nextSessions = workspaceSessions.map((s) =>
        s.id === sessionId ? { ...s, fastMode } : s,
      )
      return {
        sessions: { ...state.sessions, [workspaceId]: nextSessions },
      }
    })

    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/sessions/${sessionId}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fastMode }),
        },
      )
      if (!res.ok) throw new Error(i18next.t('common:failedToUpdateSession', 'Failed to update session'))
    } catch (err) {
      console.error('Failed to set session fast mode:', err)
      // Revert optimistic update on error
      set((state) => {
        const workspaceSessions = state.sessions[workspaceId] || []
        const nextSessions = workspaceSessions.map((s) =>
          s.id === sessionId ? { ...s, fastMode: previousFastMode } : s,
        )
        return {
          sessions: { ...state.sessions, [workspaceId]: nextSessions },
        }
      })
    }
  },

  setSessionProvider: async (workspaceId: string, sessionId: string, providerId: string | null) => {
    // Optimistic update
    set((state) => {
      const workspaceSessions = state.sessions[workspaceId] || []
      const nextSessions = workspaceSessions.map((s) =>
        s.id === sessionId ? { ...s, providerId: providerId ?? undefined } : s,
      )
      return {
        sessions: { ...state.sessions, [workspaceId]: nextSessions },
      }
    })

    try {
      // Snapshot whether the session had a live subscription before the fetch.
      // A runtime_closed event may arrive mid-flight and tear down the
      // subscription; we still want to recreate it after a successful provider
      // change if it was alive when the request started.
      const hadActiveSubscription = sessionSubscriptions.has(sessionId)

      const res = await fetch(
        `/api/workspaces/${workspaceId}/sessions/${sessionId}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerId: providerId ?? undefined }),
        },
      )
      if (!res.ok) throw new Error(i18next.t('common:failedToUpdateSession', 'Failed to update session'))
      // If the session had a live subscription, the server closed its runtime.
      // Recreate the subscription so a fresh runtime with the new provider is
      // created; the resulting subscription_ack clears the loading state.
      if (hadActiveSubscription) {
        set((state) => ({
          isRestartingRuntime: { ...state.isRestartingRuntime, [sessionId]: true },
        }))
        subscribeToSession(set, get, workspaceId, sessionId)
      }
    } catch (err) {
      console.error('Failed to set session provider:', err)
      // Revert optimistic update on error
      set((state) => {
        const workspaceSessions = state.sessions[workspaceId] || []
        const session = workspaceSessions.find((s) => s.id === sessionId)
        const prevProviderId = session?.providerId
        const nextSessions = workspaceSessions.map((s) =>
          s.id === sessionId ? { ...s, providerId: prevProviderId } : s,
        )
        return {
          sessions: { ...state.sessions, [workspaceId]: nextSessions },
        }
      })
    }
  },
}))
