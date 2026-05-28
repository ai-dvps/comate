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

    const primaryKeys = [
      'command', 'file_path', 'path', 'pattern', 'patterns', 'url', 'query',
      'prompt', 'code', 'language', 'old_string', 'new_string',
      'oldString', 'newString', 'model', 'topic', 'message',
    ]

    for (const key of primaryKeys) {
      if (obj[key] !== undefined) {
        const value = String(obj[key])
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
