import type { ChatMessage } from '../types/message'
import {
  createResultFocusProjector,
  type ResultFocusProjector,
  type ResultFocusTurn,
} from './result-focus-view'

export type ConversationDisplayMode = 'linear' | 'result'

export interface LinearConversationRow {
  kind: 'linear'
  key: string
  message: ChatMessage
  sourceMessageIds: string[]
}

export interface ResultConversationRow {
  kind: 'result'
  key: string
  turn: ResultFocusTurn
  sourceMessageIds: string[]
}

export type ConversationRow = LinearConversationRow | ResultConversationRow

export interface ConversationProjection {
  rows: ConversationRow[]
  prependedRowCount: number
  tailRevision: number
  sourceMessageToRowKey: Map<string, string>
}

export interface ConversationProjector {
  project(messages: ChatMessage[]): ConversationProjection
}

function isToolResultOnly(message: ChatMessage): boolean {
  return message.role === 'user' && message.parts.length > 0 &&
    message.parts.every((part) => part.type === 'tool_result')
}

function countPrependedRows(previous: ConversationRow[], next: ConversationRow[]): number {
  const firstKey = previous[0]?.key
  if (!firstKey) return 0
  const nextIndex = next.findIndex((row) => row.key === firstKey)
  if (nextIndex <= 0) return 0
  for (let index = 0; index < previous.length && nextIndex + index < next.length; index += 1) {
    if (previous[index].key !== next[nextIndex + index].key) return 0
  }
  return nextIndex
}

function buildSourceIndex(rows: ConversationRow[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const row of rows) {
    for (const sourceMessageId of row.sourceMessageIds) {
      index.set(sourceMessageId, row.key)
    }
  }
  return index
}

export function createConversationProjector(mode: ConversationDisplayMode): ConversationProjector {
  const resultProjector: ResultFocusProjector | null = mode === 'result'
    ? createResultFocusProjector()
    : null
  let previousRows: ConversationRow[] = []
  let tailRevision = 0

  return {
    project(messages) {
      const previousByKey = new Map(previousRows.map((row) => [row.key, row]))
      const seen = new Set<string>()
      const uniqueMessages = messages.filter((message) => {
        if (seen.has(message.id)) return false
        seen.add(message.id)
        return true
      })

      const rows: ConversationRow[] = resultProjector
        ? resultProjector.project(uniqueMessages).turns.map((turn) => {
            const previous = previousByKey.get(turn.key)
            if (previous?.kind === 'result' && previous.turn === turn) return previous
            return {
              kind: 'result',
              key: turn.key,
              turn,
              sourceMessageIds: turn.message.id.split('|'),
            }
          })
        : uniqueMessages.filter((message) => !isToolResultOnly(message)).map((message) => {
            const previous = previousByKey.get(message.id)
            if (previous?.kind === 'linear' && previous.message === message) return previous
            return {
              kind: 'linear',
              key: message.id,
              message,
              sourceMessageIds: [message.id],
            }
          })

      const previousTail = previousRows.at(-1)
      const nextTail = rows.at(-1)
      if (previousTail !== nextTail) tailRevision += 1

      const projection = {
        rows,
        prependedRowCount: countPrependedRows(previousRows, rows),
        tailRevision,
        sourceMessageToRowKey: buildSourceIndex(rows),
      }
      previousRows = rows
      return projection
    },
  }
}
