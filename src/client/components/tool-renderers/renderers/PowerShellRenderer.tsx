import { Terminal } from 'lucide-react'
import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

function PowerShellRenderer(input: unknown): ReactNode | null {
  if (!input || typeof input !== 'object') return null

  const { command } = input as Record<string, unknown>

  if (!command || typeof command !== 'string') return null

  return (
    <div className="space-y-2 overflow-hidden">
      <div className="flex items-center gap-2">
        <Terminal className="size-3.5 text-text-tertiary" />
        <h4 className="font-medium text-text-tertiary text-xs uppercase tracking-wide">
          PowerShell
        </h4>
      </div>
      <div className="rounded-md bg-surface-hover/50 overflow-hidden">
        <pre className="text-xs text-text-secondary p-2 whitespace-pre-wrap break-words font-mono">
          {command}
        </pre>
      </div>
    </div>
  )
}

registerToolRenderer('PowerShell', PowerShellRenderer)
