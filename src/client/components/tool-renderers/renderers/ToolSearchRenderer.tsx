import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

export default function ToolSearchRenderer(input: unknown): ReactNode | null {
  if (!input || typeof input !== 'object') return null

  const { query, max_results } = input as Record<string, unknown>

  if (!query || typeof query !== 'string') return null

  const maxResults = typeof max_results === 'number' ? max_results : null

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Query</span>
        <span className="text-text-secondary text-sm whitespace-pre-wrap break-words">{query}</span>
      </div>
      {maxResults !== null && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Max results</span>
          <span className="text-text-secondary text-sm font-mono">{maxResults}</span>
        </div>
      )}
    </div>
  )
}

registerToolRenderer('ToolSearch', ToolSearchRenderer)
