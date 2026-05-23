import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

function LSPToolRenderer(input: unknown): ReactNode | null {
  if (!input || typeof input !== 'object') return null

  const { operation, filePath, line, character, symbol } = input as Record<string, unknown>

  if (!operation || typeof operation !== 'string') return null
  if (!filePath || typeof filePath !== 'string') return null

  const lineNum = typeof line === 'number' ? line : null
  const charNum = typeof character === 'number' ? character : null
  const symbolName = typeof symbol === 'string' ? symbol : null

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Operation</span>
        <span className="text-text-secondary text-sm capitalize">{operation}</span>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">File</span>
        <span className="text-text-secondary text-sm font-mono truncate" title={filePath}>{filePath}</span>
      </div>
      {lineNum !== null && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Line</span>
          <span className="text-text-secondary text-sm font-mono">{lineNum}</span>
          {charNum !== null && (
            <>
              <span className="text-text-tertiary text-xs">:</span>
              <span className="text-text-secondary text-sm font-mono">{charNum}</span>
            </>
          )}
        </div>
      )}
      {symbolName && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Symbol</span>
          <span className="text-text-secondary text-sm font-mono">{symbolName}</span>
        </div>
      )}
    </div>
  )
}

registerToolRenderer('LSP', LSPToolRenderer)
