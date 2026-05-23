import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

function ExitWorktreeRenderer(input: unknown): ReactNode | null {
  if (!input || typeof input !== 'object') return null

  const { action, discard_changes } = input as Record<string, unknown>

  if (!action || typeof action !== 'string') return null

  const willDiscard = discard_changes === true

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Action</span>
        <span className="text-text-secondary text-sm capitalize">{action}</span>
      </div>
      {willDiscard && (
        <span className="text-xs text-destructive">Discarding changes</span>
      )}
    </div>
  )
}

registerToolRenderer('ExitWorktree', ExitWorktreeRenderer)
