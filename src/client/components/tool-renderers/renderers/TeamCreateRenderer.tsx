import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

function TeamCreateRenderer(input: unknown): ReactNode | null {
  if (!input || typeof input !== 'object') return null

  const { team_name, description, agent_type } = input as Record<string, unknown>

  if (!team_name || typeof team_name !== 'string') return null

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Team</span>
        <span className="text-text-secondary text-sm font-medium">{team_name}</span>
      </div>
      {typeof description === 'string' && description.length > 0 && (
        <div className="flex items-start gap-2">
          <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Description</span>
          <span className="text-text-secondary text-sm whitespace-pre-wrap break-words">{description}</span>
        </div>
      )}
      {typeof agent_type === 'string' && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Type</span>
          <span className="text-text-secondary text-sm capitalize">{agent_type}</span>
        </div>
      )}
    </div>
  )
}

registerToolRenderer('TeamCreate', TeamCreateRenderer)
