import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

export default function TaskGetRenderer(input: unknown): ReactNode | null {
  if (!input || typeof input !== 'object') return null

  const { taskId } = input as Record<string, unknown>

  if (!taskId || typeof taskId !== 'string') return null

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Task ID</span>
      <span className="text-text-secondary text-sm font-mono">{taskId}</span>
    </div>
  )
}

registerToolRenderer('TaskGet', TaskGetRenderer)
