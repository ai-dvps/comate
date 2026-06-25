import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

export default function ConfigRenderer(input: unknown): ReactNode | null {
  if (!input || typeof input !== 'object') return null

  const { setting, value } = input as Record<string, unknown>

  if (!setting || typeof setting !== 'string') return null

  const hasValue = value !== undefined

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Setting</span>
        <span className="text-text-secondary text-sm font-mono">{setting}</span>
      </div>
      {hasValue && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Value</span>
          <span className="text-text-secondary text-sm font-mono whitespace-pre-wrap break-words">
            {typeof value === 'string' ? value : JSON.stringify(value)}
          </span>
        </div>
      )}
    </div>
  )
}

registerToolRenderer('Config', ConfigRenderer)
