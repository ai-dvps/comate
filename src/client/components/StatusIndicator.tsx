import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
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
  'needs-me': 'text-warning',
  'finished-unread': 'text-success',
  streaming: 'text-blue-500 animate-spin',
}

function formatCount(count: number): string {
  return count >= 10 ? '9+' : String(count)
}

function buildTitle(state: StatusIndicatorState, count: number | undefined, t: TFunction): string {
  if (count === undefined || count === 1) return t(`status.${state}.singular`)
  return t(`status.${state}.plural`, { count: formatCount(count) })
}

export default function StatusIndicator({ state, count }: StatusIndicatorProps) {
  const { t } = useTranslation('common')
  const Icon = ICON[state]
  const title = buildTitle(state, count, t)
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
