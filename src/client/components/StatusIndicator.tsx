import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'
import type { SessionStatusState } from '../lib/session-status'

export type StatusIndicatorState = Exclude<SessionStatusState, 'idle'>

interface StatusIndicatorProps {
  state: StatusIndicatorState
  count?: number
}

const ICON = {
  'needs-me': AlertCircle,
  'finished-unread': CheckCircle2,
  streaming: Loader2,
} as const

const ICON_CLASS: Record<StatusIndicatorState, string> = {
  'needs-me': 'text-orange-500',
  'finished-unread': 'text-emerald-500',
  streaming: 'text-blue-500 animate-spin',
}

const TITLE_SINGULAR: Record<StatusIndicatorState, string> = {
  'needs-me': 'Needs approval or input',
  'finished-unread': 'Finished',
  streaming: 'Streaming',
}

const TITLE_PLURAL: Record<StatusIndicatorState, string> = {
  'needs-me': 'need approval or input',
  'finished-unread': 'finished',
  streaming: 'streaming',
}

function formatCount(count: number): string {
  return count >= 10 ? '9+' : String(count)
}

function buildTitle(state: StatusIndicatorState, count: number | undefined): string {
  if (count === undefined || count === 1) return TITLE_SINGULAR[state]
  return `${formatCount(count)} sessions ${TITLE_PLURAL[state]}`
}

export default function StatusIndicator({ state, count }: StatusIndicatorProps) {
  const Icon = ICON[state]
  const title = buildTitle(state, count)
  const icon = <Icon className={`w-3 h-3 flex-shrink-0 ${ICON_CLASS[state]}`} />

  if (count === undefined) {
    return (
      <span title={title} className="inline-flex flex-shrink-0">
        {icon}
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-0.5" title={title}>
      {icon}
      <span className="text-[10px] text-text-tertiary leading-none">
        {formatCount(count)}
      </span>
    </span>
  )
}
