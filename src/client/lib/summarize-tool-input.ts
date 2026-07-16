/**
 * Keys {@link summarizeToolInput} treats as a meaningful parameter, in priority
 * order. Hoisted to module scope so the meaningful-vs-fallback decision can
 * reuse the same single source of truth instead of being re-derived elsewhere.
 */
const SUMMARY_PRIMARY_KEYS = [
  'command', 'file_path', 'path', 'pattern', 'patterns', 'url', 'query',
  'prompt', 'code', 'language', 'old_string', 'new_string',
  'oldString', 'newString', 'model', 'topic', 'message',
] as const

/**
 * Whether `input` would produce a *meaningful* summary from
 * {@link summarizeToolInput} — i.e. one of its recognized branches matches —
 * rather than the generic `firstKey: value` / JSON fallback. Mirrors the exact
 * type, length, and array guards of the recognized branches so consumers can
 * decide "show a value vs. show nothing" without re-deriving (and drifting
 * from) the helper's logic.
 */
export function hasMeaningfulSummary(input: unknown): boolean {
  if (input === null || typeof input !== 'object') return false
  const obj = input as Record<string, unknown>

  if (typeof obj.description === 'string') return true

  if (Array.isArray(obj.questions) && obj.questions.length > 0) {
    const first = obj.questions[0]
    if (first !== null && typeof first === 'object') {
      const q = first as Record<string, unknown>
      if (typeof q.question === 'string' || typeof q.header === 'string') return true
    }
  }

  if (SUMMARY_PRIMARY_KEYS.some((key) => obj[key] !== undefined)) return true

  if (typeof obj.content === 'string' && obj.content.length <= 120) return true

  return false
}

export function summarizeToolInput(input: unknown): string | undefined {
  if (input === null || input === undefined) return undefined

  if (typeof input === 'object' && input !== null) {
    const obj = input as Record<string, unknown>

    // Prefer description as the summary when available — it's the human-readable intent
    if (typeof obj.description === 'string') {
      const value = obj.description
      return value.length > 120 ? value.slice(0, 120) + '…' : value
    }

    // Handle AskUserQuestion and similar array-of-questions shapes
    if (Array.isArray(obj.questions) && obj.questions.length > 0) {
      const first = obj.questions[0]
      if (typeof first === 'object' && first !== null) {
        const q = first as Record<string, unknown>
        const text =
          typeof q.question === 'string'
            ? q.question
            : typeof q.header === 'string'
              ? q.header
              : undefined
        if (text !== undefined) {
          return text.length > 120 ? text.slice(0, 120) + '…' : text
        }
      }
    }

    for (const key of SUMMARY_PRIMARY_KEYS) {
      if (obj[key] !== undefined) {
        const value = String(obj[key])

        // For file paths, return the full path and let the UI left-truncate
        // so the filename at the end stays visible
        if (key === 'file_path' || key === 'path') {
          return value
        }

        const truncated = value.length > 120 ? value.slice(0, 120) + '…' : value

        // Try to append a short secondary field for extra context
        const secondaryKeys = ['language', 'model', 'path', 'file_path']
        for (const secKey of secondaryKeys) {
          if (secKey !== key && obj[secKey] !== undefined) {
            const secValue = String(obj[secKey])
            if (secValue.length <= 40) {
              return `${truncated} → ${secValue}`
            }
          }
        }

        return truncated
      }
    }

    // Handle short string content key separately
    if (typeof obj.content === 'string' && obj.content.length <= 120) {
      const content = obj.content
      for (const secKey of ['language', 'model', 'path', 'file_path']) {
        if (obj[secKey] !== undefined) {
          const secValue = String(obj[secKey])
          if (secValue.length <= 40) {
            return `${content} → ${secValue}`
          }
        }
      }
      return content
    }

    // Fallback: first key-value pair
    const firstKey = Object.keys(obj)[0]
    if (firstKey !== undefined) {
      const value = String(obj[firstKey])
      const truncated = value.length > 120 ? value.slice(0, 120) + '…' : value
      return `${firstKey}: ${truncated}`
    }

    const str = JSON.stringify(input)
    return str.length > 120 ? str.slice(0, 120) + '…' : str
  }

  const str = String(input)
  return str.length > 120 ? str.slice(0, 120) + '…' : str
}
