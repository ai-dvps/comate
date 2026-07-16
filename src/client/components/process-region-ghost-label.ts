import { hasMeaningfulSummary, summarizeToolInput } from '../lib/summarize-tool-input'
import type { RenderablePart } from './chat-message-adapter'

/**
 * Derives the display label for the latest part of a process region in
 * result-focused mode: a thinking part signals the localized "Thinking" label;
 * a tool part yields its display name plus, when available, a short key
 * parameter (reusing {@link summarizeToolInput}) and a hint for which end to
 * keep when the value is truncated to one line.
 *
 * Pure and side-effect free so it is trivial to unit-test in isolation.
 */
export type GhostLabelTruncate = 'keep-tail' | 'keep-head'

export type GhostLatestLabel =
  | { kind: 'thinking' }
  | { kind: 'tool'; name: string; value: string | undefined; truncate: GhostLabelTruncate }

const URL_SCHEME = /^https?:\/\//i

/** `keep-tail` left-truncates so a path's filename survives; `keep-head` right-truncates. */
function classifyTruncate(value: string): GhostLabelTruncate {
  if (URL_SCHEME.test(value)) return 'keep-head'
  if ((/[\\/]/.test(value) && !/\s/.test(value)) || /^[.~][/\\]/.test(value)) {
    return 'keep-tail'
  }
  return 'keep-head'
}

export function ghostLatestLabel(part: RenderablePart): GhostLatestLabel {
  if (part.type === 'thinking') return { kind: 'thinking' }
  if (part.type !== 'tool_use') {
    // Process regions only contain thinking + tool_use; be defensive anyway.
    return { kind: 'tool', name: part.type, value: undefined, truncate: 'keep-head' }
  }

  const name = part.meta?.displayName ?? part.toolName
  // `hasMeaningfulSummary` mirrors summarizeToolInput's recognized branches, so
  // unrecognized/empty inputs fall back to the tool name only (R2) instead of
  // leaking the helper's `firstKey: value` / `{}` fallback into the ghost.
  if (!hasMeaningfulSummary(part.input)) {
    return { kind: 'tool', name, value: undefined, truncate: 'keep-head' }
  }

  const raw = summarizeToolInput(part.input)
  // An empty/whitespace summary (e.g. command: "") is not worth showing.
  const value = raw === undefined || raw.trim() === '' ? undefined : raw
  return {
    kind: 'tool',
    name,
    value,
    truncate: value === undefined ? 'keep-head' : classifyTruncate(value),
  }
}
