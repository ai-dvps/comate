import { Bell } from 'lucide-react'
import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

/**
 * CLI 2.1.237+ ReadNotifications tool: drains queued server-side
 * notifications (webhooks, trigger fires, cross-session messages) into the
 * conversation. The input is empty — a compact affordance line suffices.
 */
export default function ReadNotificationsRenderer(input: unknown): ReactNode | null {
  if (typeof input !== 'object' || input === null) {
    return null
  }

  return (
    <div className="flex items-center gap-2">
      <Bell className="size-3.5 text-text-tertiary" />
      <span className="text-xs text-text-secondary">read queued notifications</span>
    </div>
  )
}

registerToolRenderer('ReadNotifications', ReadNotificationsRenderer)
