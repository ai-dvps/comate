import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

export default function ReadMcpResourceRenderer(input: unknown): ReactNode | null {
  if (!input || typeof input !== 'object') return null

  const { uri, server } = input as Record<string, unknown>

  if (!uri || typeof uri !== 'string') return null
  if (!server || typeof server !== 'string') return null

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Server</span>
        <span className="text-text-secondary text-sm font-mono">{server}</span>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">URI</span>
        <span className="text-text-secondary text-sm font-mono whitespace-pre-wrap break-words">{uri}</span>
      </div>
    </div>
  )
}

registerToolRenderer('ReadMcpResourceTool', ReadMcpResourceRenderer)
