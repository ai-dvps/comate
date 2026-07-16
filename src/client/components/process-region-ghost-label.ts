import { summarizeToolInput } from '../lib/summarize-tool-input'
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

/**
 * Keys `summarizeToolInput` treats as a meaningful parameter. When the input
 * has none of these, the helper's output is its generic `firstKey: value` or
 * `{}` fallback — noise in the compact ghost — so the caller shows the tool
 * name only (R2). Kept in sync with the keys `summarizeToolInput` prefers.
 */
const MEANINGFUL_KEYS = [
  'description', 'questions',
  'command', 'file_path', 'path', 'pattern', 'patterns', 'url', 'query',
  'prompt', 'code', 'language', 'old_string', 'new_string', 'oldString',
  'newString', 'model', 'topic', 'message', 'content',
] as const

function hasMeaningfulKey(input: unknown): boolean {
  if (input === null || typeof input !== 'object') return false
  const obj = input as Record<string, unknown>
  if (Object.keys(obj).length === 0) return false
  return MEANINGFUL_KEYS.some((key) => obj[key] !== undefined)
}

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
  if (!hasMeaningfulKey(part.input)) {
    return { kind: 'tool', name, value: undefined, truncate: 'keep-head' }
  }

  const raw = summarizeToolInput(part.input)
  // `{}` is the helper's stringify fallback for an empty object; treat as none.
  const value = raw === undefined || raw === '{}' ? undefined : raw
  return {
    kind: 'tool',
    name,
    value,
    truncate: value === undefined ? 'keep-head' : classifyTruncate(value),
  }
}
