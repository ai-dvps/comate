/**
 * Message-shape types shared between client store, server emitter, and renderers.
 *
 * IMPORTANT: This file is duplicated as-is at:
 *   - src/client/types/message.ts
 *   - src/server/types/message.ts
 * The server `tsconfig.server.json` pins `rootDir: "./src/server"` with
 * `composite: true`, so it cannot import a single source from outside its
 * rootDir. Keep both copies byte-identical; CI verifies via
 * `diff src/client/types/message.ts src/server/types/message.ts`.
 */

import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'

export type MessageRole = 'user' | 'assistant' | 'system'

export type MessagePart =
  | { type: 'text'; text: string }
  | {
      type: 'tool_use'
      toolUseId: string
      toolName: string
      input: unknown
      inputJsonStream?: string
      state: 'streaming' | 'complete'
      meta?: {
        displayName?: string
        iconUrl?: string
      }
    }
  | {
      type: 'tool_result'
      toolUseId: string
      output: string
      isError: boolean
      toolUseResult?: unknown
    }
  | {
      type: 'thinking'
      text: string
      state: 'streaming' | 'complete'
    }

export interface ChatMessage {
  id: string
  role: MessageRole
  parts: MessagePart[]
  timestamp: number
  isStreaming?: boolean
  isCompactBoundary?: boolean
  subType?: string
}

/**
 * AI Elements `<Tool>` lifecycle vocabulary. Distinct from
 * `MessagePart['tool_use'].state`: this 4-state enum is what the renderer
 * derives from co-located tool_use/tool_result parts.
 */
export type ToolState =
  | 'input-streaming'
  | 'input-available'
  | 'output-available'
  | 'output-error'

export type ToolPart = {
  type: string
  state: ToolState
  input?: unknown
  output?: unknown
  errorText?: string
}

export interface QuestionPayload {
  question: string
  header?: string
  options: { label: string; description?: string; preview?: string }[]
  multiSelect: boolean
}

export interface TaskItem {
  id: string
  subject: string
  description?: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'killed' | 'paused'
  activeForm?: string
}

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

export interface WorkflowPhase {
  title: string
  detail?: string
}

export type WorkflowStatus = 'running' | 'completed' | 'error' | 'killed'

export interface WorkflowProgressAgent {
  type: 'workflow_agent'
  index: number
  label?: string
  phaseIndex?: number
  phaseTitle?: string
  agentId: string
  model?: string
  state?: 'running' | 'done'
  startedAt?: number
  queuedAt?: number
  lastProgressAt?: number
  attempt?: number
  tokens?: number
  toolCalls?: number
  durationMs?: number
  lastToolName?: string
  lastToolSummary?: string
  promptPreview?: string
  resultPreview?: string
}

export interface WorkflowProgressPhase {
  type: 'workflow_phase'
  index: number
  title: string
}

export type WorkflowProgressItem = WorkflowProgressAgent | WorkflowProgressPhase

export interface WorkflowState {
  runId: string
  sessionId: string
  toolUseId?: string
  workflowName?: string
  status: WorkflowStatus
  summary?: string
  error?: string
  startTime: number
  durationMs?: number
  totalTokens?: number
  totalToolCalls?: number
  agentCount: number
  phases: WorkflowPhase[]
  progress: WorkflowProgressItem[]
  subagents: SubagentState[]
}

/**
 * Discriminated union of every SSE event emitted by the chat stream route.
 * The server emits these via `event: <type>` + `data: <JSON>` SSE frames.
 * U4 owns the emitter rewrite; U5 owns the consumer.
 */
export type SseEvent =
  | { type: 'system_init'; model: string; tools: string[]; sessionId: string; mcpServers?: { name: string; status: string }[] }
  | { type: 'assistant_start'; messageId: string }
  | { type: 'text_delta'; messageId: string; partIndex: number; text: string }
  | {
      type: 'tool_use_start'
      messageId: string
      partIndex: number
      toolUseId: string
      toolName: string
    }
  | { type: 'tool_use_done'; toolUseId: string; input: unknown }
  | {
      type: 'tool_use_meta'
      toolUseId: string
      meta: {
        displayName?: string
        iconUrl?: string
      }
    }
  | {
      type: 'tool_input_delta'
      messageId: string
      partIndex: number
      toolUseId: string
      partialJson: string
    }
  | { type: 'tool_result'; toolUseId: string; output: string; isError: boolean; toolUseResult?: unknown }
  | { type: 'thinking_start'; messageId: string; partIndex: number }
  | {
      type: 'thinking_delta'
      messageId: string
      partIndex: number
      text: string
    }
  | { type: 'thinking_done'; messageId: string; partIndex: number }
  | { type: 'assistant_done'; messageId: string }
  | {
      type: 'result'
      subtype: string
      isError: boolean
      result?: string
      errors?: unknown
      usage?: unknown
      modelUsage?: unknown
      stopReason?: string | null
      terminalReason?: string
      origin?: string
    }
  | {
      type: 'context_usage'
      totalTokens: number
      maxTokens: number
      percentage: number
      categories: { name: string; tokens: number }[]
    }
  | { type: 'error'; message: string }
  | {
      type: 'rate_limit'
      errorCode?: string
      canUserPurchaseCredits?: boolean
      hasChargeableSavedPaymentMethod?: boolean
      retryAfter?: number
      rateLimitType?: string
    }
  | {
      type: 'model_fallback'
      trigger: string
      direction: string
      originalModel: string
      fallbackModel: string
      category?: string | null
      explanation?: string | null
      retractedMessageIds?: string[]
      text?: string
    }
  | {
      type: 'api_retry'
      attempt: number
      maxRetries: number
      retryDelayMs: number
      errorStatus: number | null
    }
  | { type: 'done' }
  | { type: 'subscription_ack'; serverNonce: string; sessionId: string }
  | {
      type: 'pending_approval'
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
  | { type: 'pending_question'; requestId: string; questions: QuestionPayload[]; expiresAt?: number }
  | { type: 'approval_resolved'; requestId: string }
  | { type: 'approval_timeout'; requestId: string }
  | { type: 'auto_approval'; toolUseId: string; toolName: string; mode: 'auto' | 'readonly' }
  | { type: 'interrupted'; messageId: string | null }
  | { type: 'error_note'; text: string }
  | { type: 'server_restarted'; serverNonce: string }
  | {
      type: 'subagent_start'
      parentToolUseId: string
      description?: string
    }
  | {
      type: 'subagent_delta'
      parentToolUseId: string
      delta:
        | { kind: 'text'; text: string }
        | { kind: 'thinking'; text: string }
        | {
            kind: 'tool_use'
            toolUseId: string
            toolName: string
            input?: unknown
          }
        | {
            kind: 'tool_result'
            toolUseId: string
            output: string
            isError: boolean
          }
    }
  | {
      type: 'subagent_done'
      parentToolUseId: string
      state: 'completed' | 'error'
    }
  | { type: 'task_started'; taskId: string; description: string }
  | {
      type: 'task_updated'
      taskId: string
      patch: { status?: string; description?: string; error?: string }
    }
  | {
      type: 'workflow_start'
      runId: string
      sessionId: string
      toolUseId: string
      workflowName?: string
    }
  | { type: 'workflow_update'; runId: string; sessionId: string }
  | {
      type: 'workflow_done'
      runId: string
      sessionId: string
      status: WorkflowStatus
    }
  | { type: 'compact_boundary' }
  | { type: 'compact_status'; active: boolean }
  | { type: 'heartbeat' }
