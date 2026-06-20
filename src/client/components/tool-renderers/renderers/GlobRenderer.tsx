import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'
import FilePath from '../FilePath'

function GlobRenderer(input: unknown): ReactNode | null {
  if (!input || typeof input !== 'object') return null

  const { pattern, path } = input as Record<string, unknown>

  if (!pattern || typeof pattern !== 'string') return null

  const pathStr = typeof path === 'string' ? path : null

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Pattern</span>
        <span className="text-text-secondary text-sm font-mono whitespace-pre-wrap break-words">{pattern}</span>
      </div>
      {pathStr && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Path</span>
          <FilePath path={pathStr} isDirectory className="whitespace-pre-wrap break-words" />
        </div>
      )}
    </div>
  )
}

registerToolRenderer('Glob', GlobRenderer)
