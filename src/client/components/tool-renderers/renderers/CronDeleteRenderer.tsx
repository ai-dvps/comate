import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

export default function CronDeleteRenderer(input: unknown): ReactNode | null {
  if (!input || typeof input !== 'object') return null

  const { id } = input as Record<string, unknown>

  if (!id || typeof id !== 'string') return null

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Job ID</span>
      <span className="text-text-secondary text-sm font-mono">{id}</span>
    </div>
  )
}

registerToolRenderer('CronDelete', CronDeleteRenderer)
