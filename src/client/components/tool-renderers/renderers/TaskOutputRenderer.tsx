import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

function TaskOutputRenderer(input: unknown): ReactNode | null {
  if (!input || typeof input !== 'object') return null

  const { task_id, block, timeout } = input as Record<string, unknown>

  if (!task_id || typeof task_id !== 'string') return null

  const shouldBlock = block !== false
  const timeoutMs = typeof timeout === 'number' ? timeout : null

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Task ID</span>
        <span className="text-text-secondary text-sm font-mono">{task_id}</span>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-text-tertiary">
          {shouldBlock ? 'Blocking' : 'Non-blocking'}
        </span>
        {timeoutMs !== null && (
          <span className="text-xs text-text-tertiary">
            Timeout: {timeoutMs >= 1000 ? `${(timeoutMs / 1000).toFixed(0)}s` : `${timeoutMs}ms`}
          </span>
        )}
      </div>
    </div>
  )
}

registerToolRenderer('TaskOutput', TaskOutputRenderer)
