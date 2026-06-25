import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

export default function WebSearchRenderer(input: unknown): ReactNode | null {
  if (!input || typeof input !== 'object') return null

  const { query, allowed_domains, blocked_domains } = input as Record<string, unknown>

  if (!query || typeof query !== 'string') return null

  const allowedDomains = Array.isArray(allowed_domains) ? allowed_domains.filter((d): d is string => typeof d === 'string') : null
  const blockedDomains = Array.isArray(blocked_domains) ? blocked_domains.filter((d): d is string => typeof d === 'string') : null

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Query</span>
        <span className="text-text-secondary text-sm whitespace-pre-wrap break-words">&ldquo;{query}&rdquo;</span>
      </div>
      {allowedDomains && allowedDomains.length > 0 && (
        <div className="flex items-start gap-2 flex-wrap">
          <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Allow</span>
          <span className="text-text-secondary text-sm">{allowedDomains.join(', ')}</span>
        </div>
      )}
      {blockedDomains && blockedDomains.length > 0 && (
        <div className="flex items-start gap-2 flex-wrap">
          <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Block</span>
          <span className="text-text-secondary text-sm">{blockedDomains.join(', ')}</span>
        </div>
      )}
    </div>
  )
}

registerToolRenderer('WebSearch', WebSearchRenderer)
