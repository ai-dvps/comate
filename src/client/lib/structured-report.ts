export type StructuredReportKind = 'object' | 'array'

export interface StructuredReportMeta {
  kind: StructuredReportKind
  count: number
  size: number
}

export interface StructuredReport {
  value: unknown
  pretty: string
  meta: StructuredReportMeta
}

/**
 * Detect a text part that is wholly a single JSON object or array.
 * Returns the parsed value, a pretty-printed string, and small header meta,
 * or null when the text is not a strict, whole-part JSON object/array.
 *
 * Detection is intentionally strict (no JSON5/JSONC) and cheap: a first-char
 * guard short-circuits prose before any `JSON.parse`. `meta.size` is the
 * pretty string's length in UTF-16 code units, so astral characters (e.g.
 * emoji) count as 2.
 */
export function detectStructuredReport(text: string): StructuredReport | null {
  if (typeof text !== 'string') return null

  const trimmed = text.trim()
  if (trimmed.length === 0) return null

  const first = trimmed[0]
  if (first !== '{' && first !== '[') return null

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null

  const pretty = JSON.stringify(parsed, null, 2)
  const kind: StructuredReportKind = Array.isArray(parsed) ? 'array' : 'object'
  const count = Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length
  const size = pretty.length

  return { value: parsed, pretty, meta: { kind, count, size } }
}
