import type { RenderablePart } from './chat-message-adapter'

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
  isFinal: boolean
}

/** A run of consecutive thinking + tool-use parts, collapsed into one ghost. */
export interface ProcessRegion {
  type: 'process'
  parts: RenderablePart[]
  /** The most recent part in the run — what the ghost shows as "latest step". */
  latest: RenderablePart
}

export type MessageRegion = TextRegion | ProcessRegion

/** A part belongs to a process region unless it is text (text breaks runs). */
function isProcessPart(part: RenderablePart): boolean {
  return part.type !== 'text'
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

  const flushProcess = (): void => {
    if (current.length > 0) {
      regions.push({ type: 'process', parts: current, latest: current[current.length - 1] })
      current = []
    }
  }

  for (const part of parts) {
    if (isProcessPart(part)) {
      current.push(part)
    } else {
      flushProcess()
      regions.push({ type: 'text', part, isFinal: false })
    }
  }
  flushProcess()

  // The final result is a text part that ends the turn (the last region, if it
  // is text). A turn ending on a process region has no final-result block.
  const last = regions[regions.length - 1]
  if (last && last.type === 'text') last.isFinal = true

  return regions
}
