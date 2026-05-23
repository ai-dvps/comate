import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

function EnterWorktreeRenderer(input: unknown): ReactNode | null {
  if (!input || typeof input !== 'object') return null

  const { name } = input as Record<string, unknown>

  if (typeof name === 'string' && name.length > 0) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Name</span>
        <span className="text-text-secondary text-sm font-mono">{name}</span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Mode</span>
      <span className="text-text-secondary text-sm">Create new worktree</span>
    </div>
  )
}

registerToolRenderer('EnterWorktree', EnterWorktreeRenderer)
