import type { SessionStatusState } from '../lib/session-status'

export type StatusIndicatorState = Exclude<SessionStatusState, 'idle'>

interface StatusIndicatorProps {
  state: StatusIndicatorState
  count?: number
}

const DOT_CLASS: Record<StatusIndicatorState, string> = {
  'needs-me': 'bg-orange-500',
  'finished-unread': 'bg-blue-500',
  streaming: 'bg-emerald-500 animate-pulse',
}

const TITLE: Record<StatusIndicatorState, string> = {
  'needs-me': 'Needs approval or input',
  'finished-unread': 'Finished — unread',
  streaming: 'Streaming',
}

function formatCount(count: number): string {
  return count >= 10 ? '9+' : String(count)
}

export default function StatusIndicator({ state, count }: StatusIndicatorProps) {
  const dot = (
    <span
      className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${DOT_CLASS[state]}`}
      title={TITLE[state]}
    />
  )

  if (count === undefined) {
    return dot
  }

  return (
    <span className="inline-flex items-center gap-0.5" title={TITLE[state]}>
      {dot}
      <span className="text-[10px] text-text-tertiary leading-none">
        {formatCount(count)}
      </span>
    </span>
  )
}
