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
  key: string
  part: Extract<RenderablePart, { type: 'text' }>
  /** Original index of this part in the message — preserves search ranges. */
  partIndex: number
  isFinal: boolean
}

/** A run of consecutive thinking + tool-use parts, collapsed into one ghost. */
export interface ProcessRegion {
  type: 'process'
  key: string
  parts: RenderablePart[]
  /** Original indices of these parts in the message. */
  partIndices: number[]
  /** The most recent part in the run — what the ghost shows as "latest step". */
  latest: RenderablePart
  /** The source message timestamp for each part (aligned 1:1 with parts). */
  timestamps: (number | undefined)[]
}

export type MessageRegion = TextRegion | ProcessRegion

/**
 * Client-only extension that preserves the original message timestamp for each
 * part after consecutive assistant turns are merged. Never sent to the server.
 */
export type TimestampedChatMessage = ChatMessage & {
  sourceTimestamps?: number[]
  sourcePartAnchors?: Array<{ sourceMessageId: string; sourcePartIndex: number }>
}

/**
 * Cache of already-built merged turns, keyed by the turn's first source message
 * (referentially stable for any multi-message turn — the store only hands out a
 * new ref for the message that actually changed, and the first message of a
 * turn is never the one streaming once a second message exists). A merged turn
 * is reused whenever its source messages are referentially unchanged, so every
 * *other* merged turn stays on a stable reference. That stability is what lets
 * `adaptChatMessage`'s WeakMap hit and `ChatMessageRenderer`'s `React.memo`
 * skip — so a streaming delta re-renders only the turn that is actually
 * streaming, not the whole list.
 *
 * `WeakMap` (not `Map`) so entries are reclaimed once their source messages are
 * pruned from the live window / dropped on session switch — no unbounded
 * retention in this long-lived desktop process. The `refs` array inside each
 * entry is what we compare to detect a streaming change to a later message.
 */
const mergedTurnCache = new WeakMap<ChatMessage, { refs: ChatMessage[]; result: TimestampedChatMessage }>()

function sameRefs(a: ChatMessage[], b: ChatMessage[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

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

export function mergeAssistantTurns(messages: ChatMessage[]): TimestampedChatMessage[] {
  const out: TimestampedChatMessage[] = []
  let buffer: ChatMessage[] = []
  const flush = (): void => {
    if (buffer.length === 0) return
    if (buffer.length === 1) {
      out.push(buffer[0])
    } else {
      const ids: string[] = []
      for (const m of buffer) ids.push(m.id)
      const id = ids.join('|')
      const cached = mergedTurnCache.get(buffer[0])
      if (cached && sameRefs(cached.refs, buffer)) {
        out.push(cached.result)
      } else {
        const parts: MessagePart[] = []
        const sourceTimestamps: number[] = []
        const sourcePartAnchors: Array<{ sourceMessageId: string; sourcePartIndex: number }> = []
        for (const m of buffer) {
          parts.push(...m.parts)
          sourceTimestamps.push(...m.parts.map(() => m.timestamp))
          sourcePartAnchors.push(...m.parts.map((_, sourcePartIndex) => ({
            sourceMessageId: m.id,
            sourcePartIndex,
          })))
        }
        const result: TimestampedChatMessage = {
          id,
          role: 'assistant',
          parts,
          timestamp: buffer[0].timestamp,
          sourceTimestamps,
          sourcePartAnchors,
          isStreaming: buffer.some((m) => m.isStreaming),
        }
        mergedTurnCache.set(buffer[0], { refs: buffer.slice(), result })
        out.push(result)
      }
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
  let currentTimestamps: (number | undefined)[] = []

  const flushProcess = (): void => {
    if (current.length > 0) {
      const first = current[0]
      regions.push({
        type: 'process',
        key: `${first.sourceMessageId ?? 'part'}:${first.sourcePartIndex ?? currentIndices[0]}`,
        parts: current,
        latest: current[current.length - 1],
        partIndices: currentIndices,
        timestamps: currentTimestamps,
      })
      current = []
      currentIndices = []
      currentTimestamps = []
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
      currentTimestamps.push(part.timestamp)
    } else {
      flushProcess()
      regions.push({
        type: 'text',
        key: `${part.sourceMessageId ?? 'part'}:${part.sourcePartIndex ?? index}`,
        part,
        partIndex: index,
        isFinal: false,
      })
    }
  })
  flushProcess()

  // The final result is a text part that ends the turn (the last region, if it
  // is text). A turn ending on a process region has no final-result block.
  const last = regions[regions.length - 1]
  if (last && last.type === 'text') last.isFinal = true

  return regions
}
