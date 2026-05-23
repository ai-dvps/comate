import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

function CronCreateRenderer(input: unknown): ReactNode | null {
  if (!input || typeof input !== 'object') return null

  const { cron, prompt, recurring, durable } = input as Record<string, unknown>

  if (!cron || typeof cron !== 'string') return null
  if (!prompt || typeof prompt !== 'string') return null

  const isRecurring = recurring === true
  const isDurable = durable === true

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Schedule</span>
        <span className="text-text-secondary text-sm font-mono">{cron}</span>
      </div>
      <div className="flex items-start gap-2">
        <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Prompt</span>
        <span className="text-text-secondary text-sm whitespace-pre-wrap break-words">{prompt}</span>
      </div>
      <div className="flex items-center gap-3">
        {isRecurring ? (
          <span className="text-xs text-accent">Recurring</span>
        ) : (
          <span className="text-xs text-text-tertiary">One-shot</span>
        )}
        {isDurable && <span className="text-xs text-accent">Durable</span>}
      </div>
    </div>
  )
}

registerToolRenderer('CronCreate', CronCreateRenderer)
