import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

export default function SendMessageRenderer(input: unknown): ReactNode | null {
  if (!input || typeof input !== 'object') return null

  const { to, message } = input as Record<string, unknown>

  const recipient = typeof to === 'string' ? to : null

  if (!message || typeof message !== 'object' || message === null) {
    return recipient ? (
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">To</span>
        <span className="text-text-secondary text-sm">{recipient}</span>
      </div>
    ) : null
  }

  const msg = message as Record<string, unknown>
  const msgType = typeof msg.type === 'string' ? msg.type : null
  const approve = msg.approve === true

  return (
    <div className="space-y-1.5">
      {recipient && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">To</span>
          <span className="text-text-secondary text-sm">{recipient}</span>
        </div>
      )}
      {msgType === 'plan_approval_response' && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Action</span>
          <span className={`text-sm ${approve ? 'text-success' : 'text-destructive'}`}>
            {approve ? 'Approve plan' : 'Reject plan'}
          </span>
        </div>
      )}
      {msgType && msgType !== 'plan_approval_response' && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Type</span>
          <span className="text-text-secondary text-sm capitalize">{msgType.replace(/_/g, ' ')}</span>
        </div>
      )}
    </div>
  )
}

registerToolRenderer('SendMessage', SendMessageRenderer)
