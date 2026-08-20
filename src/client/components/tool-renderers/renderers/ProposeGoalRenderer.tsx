import { Target } from 'lucide-react'
import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

interface ProposeGoalInput {
  condition?: unknown
  ask_user?: unknown
}

/**
 * CLI 2.1.237+ ProposeGoal tool: proposes a verifiable goal completion
 * condition for the session (/goal). Renders the condition text plus whether
 * the user is asked to approve it.
 */
export default function ProposeGoalRenderer(input: unknown): ReactNode | null {
  if (typeof input !== 'object' || input === null) {
    return null
  }

  const obj = input as ProposeGoalInput
  if (typeof obj.condition !== 'string' || obj.condition === '') {
    return null
  }

  const asksUser = obj.ask_user !== false

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Target className="size-3.5 text-text-tertiary" />
        <span className="text-xs uppercase tracking-wide text-text-tertiary">Goal</span>
      </div>
      <div className="rounded-md border border-border/60 bg-surface-hover/40 px-2.5 py-2 text-xs text-text-primary">
        {obj.condition}
      </div>
      {obj.ask_user !== undefined && (
        <div className="text-[11px] text-text-tertiary">
          {asksUser ? 'pending user approval' : 'set directly'}
        </div>
      )}
    </div>
  )
}

registerToolRenderer('ProposeGoal', ProposeGoalRenderer)
