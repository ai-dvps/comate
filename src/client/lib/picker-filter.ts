import fuzzysort from 'fuzzysort'
import picomatch from 'picomatch'
import isGlob from 'is-glob'

/**
 * Filter an array of items using either glob (when query contains * or ?)
 * or fuzzy subsequence matching (fuzzysort). Empty query returns all items.
 *
 * Glob mode uses picomatch with nocase + dot. Fuzzy mode uses fuzzysort
 * and returns objects in relevance order.
 */
export function filterItems<T>(
  items: T[],
  query: string,
  key: keyof T,
): T[] {
  const trimmed = query.trim()
  if (trimmed === '') return items

  if (isGlob(trimmed) || trimmed.includes('?')) {
    const isMatch = picomatch(trimmed, { nocase: true, dot: true })
    return items.filter((item) => {
      const value = item[key]
      return typeof value === 'string' && isMatch(value)
    })
  }

  const results = fuzzysort.go(String(trimmed), items, {
    key: String(key),
    limit: 100,
  })
  return results.map((r) => r.obj as T)
}
