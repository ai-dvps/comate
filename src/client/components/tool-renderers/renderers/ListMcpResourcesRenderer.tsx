import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

export default function ListMcpResourcesRenderer(input: unknown): ReactNode | null {
  if (!input || typeof input !== 'object') return null

  const { server } = input as Record<string, unknown>

  if (!server || typeof server !== 'string') return null

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Server</span>
      <span className="text-text-secondary text-sm font-mono">{server}</span>
    </div>
  )
}

registerToolRenderer('ListMcpResourcesTool', ListMcpResourcesRenderer)
