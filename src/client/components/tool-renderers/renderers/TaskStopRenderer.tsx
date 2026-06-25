import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

export default function TaskStopRenderer(input: unknown): ReactNode | null {
  if (!input || typeof input !== 'object') return null

  const { task_id, shell_id } = input as Record<string, unknown>

  const id = typeof task_id === 'string' ? task_id : typeof shell_id === 'string' ? shell_id : null

  if (!id) return null

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Task ID</span>
      <span className="text-text-secondary text-sm font-mono">{id}</span>
    </div>
  )
}

registerToolRenderer('TaskStop', TaskStopRenderer)
