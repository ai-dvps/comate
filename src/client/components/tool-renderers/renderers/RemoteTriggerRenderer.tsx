import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

function RemoteTriggerRenderer(input: unknown): ReactNode | null {
  if (!input || typeof input !== 'object') return null

  const { action, trigger_id } = input as Record<string, unknown>

  const actionStr = typeof action === 'string' ? action : null
  const triggerId = typeof trigger_id === 'string' ? trigger_id : null

  return (
    <div className="space-y-1.5">
      {actionStr && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Action</span>
          <span className="text-text-secondary text-sm capitalize">{actionStr}</span>
        </div>
      )}
      {triggerId && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Trigger</span>
          <span className="text-text-secondary text-sm font-mono">{triggerId}</span>
        </div>
      )}
    </div>
  )
}

registerToolRenderer('RemoteTrigger', RemoteTriggerRenderer)
