import type { RenderablePart } from './chat-message-adapter'
import type { ChatMessage, MessagePart } from '../types/message'

/**
 * Result-focused display mode: an assistant turn's parts are reinterpreted as
 * ordered "regions" so the renderer can keep text visible while collapsing the
 * thinking + tool-use runs ("process regions") into a compact ghost.
 *
 * This is a pure view transform. It does not mutate the message store or touch
 * tool_results (which live in separate messages and are re-linked by
 * `buildResultMap` at render time).
 */

/** A visible text part. `isFinal` marks the turn's final result. */
export interface TextRegion {
  type: 'text'
  part: Extract<RenderablePart, { type: 'text' }>
  /** Original index of this part in the message — preserves search ranges. */
  partIndex: number
  isFinal: boolean
}

/** A run of consecutive thinking + tool-use parts, collapsed into one ghost. */
export interface ProcessRegion {
  type: 'process'
  parts: RenderablePart[]
  /** Original indices of these parts in the message. */
  partIndices: number[]
  /** The most recent part in the run — what the ghost shows as "latest step". */
  latest: RenderablePart
}

export type MessageRegion = TextRegion | ProcessRegion

/**
 * Result-focused mode: a single user turn can span multiple assistant messages
 * in the SDK transcript (the API stores one assistant message per tool step,
 * with results in separate user messages that are already filtered out). Merge
 * consecutive assistant messages into one so the whole turn's thinking + tool
 * runs collapse into a single ghost instead of one ghost per step.
 *
 * The merged message's id joins the source ids with '|' so the drawer can split
 * it back apart to read each source message. Single assistant messages pass
 * through unchanged (preserving their real id for search/scroll).
 */
export function mergeAssistantTurns(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  let buffer: ChatMessage[] = []
  const flush = (): void => {
    if (buffer.length === 0) return
    if (buffer.length === 1) {
      out.push(buffer[0])
    } else {
      const parts: MessagePart[] = []
      const sourceTimestamps: number[] = []
      const ids: string[] = []
      for (const m of buffer) {
        parts.push(...m.parts)
        sourceTimestamps.push(...m.parts.map(() => m.timestamp))
        ids.push(m.id)
      }
      out.push({
        id: ids.join('|'),
        role: 'assistant',
        parts,
        timestamp: buffer[0].timestamp,
        sourceTimestamps,
        isStreaming: buffer.some((m) => m.isStreaming),
      })
    }
    buffer = []
  }
  for (const m of messages) {
    if (m.role === 'assistant') {
      buffer.push(m)
    } else {
      flush()
      out.push(m)
    }
  }
  flush()
  return out
}

/**
 * Group a turn's parts into ordered regions: consecutive non-text parts form a
 * process region, each text part is its own text region. The final result is a
 * text part that ends the turn — a text part with process trailing it is
 * mid-turn text, not the final result (R7 + R14).
 */
export function groupMessageParts(parts: RenderablePart[]): MessageRegion[] {
  const regions: MessageRegion[] = []
  let current: RenderablePart[] = []
  let currentIndices: number[] = []

  const flushProcess = (): void => {
    if (current.length > 0) {
      regions.push({
        type: 'process',
        parts: current,
        latest: current[current.length - 1],
        partIndices: currentIndices,
      })
      current = []
      currentIndices = []
    }
  }

  parts.forEach((part, index) => {
    // Empty/whitespace text (e.g. block-index padding in the store, where
    // `text_delta` skips empty deltas but later parts still advance the index)
    // must not fragment a single process run into multiple ghosts. Ignore it.
    if (part.type === 'text' && part.text.trim() === '') return
    if (part.type !== 'text') {
      current.push(part)
      currentIndices.push(index)
    } else {
      flushProcess()
      regions.push({ type: 'text', part, partIndex: index, isFinal: false })
    }
  })
  flushProcess()

  // The final result is a text part that ends the turn (the last region, if it
  // is text). A turn ending on a process region has no final-result block.
  const last = regions[regions.length - 1]
  if (last && last.type === 'text') last.isFinal = true

  return regions
}
