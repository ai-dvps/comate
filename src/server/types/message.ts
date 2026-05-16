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
      state: 'streaming' | 'complete'
    }
  | {
      type: 'tool_result'
      toolUseId: string
      output: string
      isError: boolean
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

/**
 * Discriminated union of every SSE event emitted by the chat stream route.
 * The server emits these via `event: <type>` + `data: <JSON>` SSE frames.
 * U4 owns the emitter rewrite; U5 owns the consumer.
 */
export type SseEvent =
  | { type: 'system_init'; model: string; tools: string[]; sessionId: string }
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
  | { type: 'tool_result'; toolUseId: string; output: string; isError: boolean }
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
    }
  | { type: 'error'; message: string }
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
    }
  | { type: 'pending_question'; requestId: string; questions: QuestionPayload[] }
  | { type: 'approval_resolved'; requestId: string }
  | { type: 'interrupted'; messageId: string | null }
  | { type: 'error_note'; text: string }
  | { type: 'server_restarted'; serverNonce: string }
