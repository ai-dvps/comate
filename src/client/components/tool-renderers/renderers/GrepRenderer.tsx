import { FileText, Search } from 'lucide-react'
import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'
import FilePath from '../FilePath'

export default function GrepRenderer(input: unknown): ReactNode | null {
  if (typeof input !== 'object' || input === null) {
    return null
  }

  const obj = input as Record<string, unknown>

  if (typeof obj.pattern !== 'string' || typeof obj.path !== 'string') {
    return null
  }

  const { pattern, path } = obj
  const outputMode = typeof obj.output_mode === 'string' ? obj.output_mode : undefined

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <Search className="size-3.5 text-text-tertiary" />
        <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">
          Pattern
        </span>
        <code className="text-xs font-mono text-text-primary bg-surface-hover/50 px-1.5 py-0.5 rounded whitespace-pre-wrap break-words">
          {pattern}
        </code>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <FileText className="size-3.5 text-text-tertiary" />
        <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">
          Path
        </span>
        <FilePath path={path} isDirectory className="whitespace-pre-wrap break-words" />
      </div>
      {outputMode && (
        <div className="flex items-center gap-2">
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-text-tertiary/20 text-text-tertiary">
            {outputMode}
          </span>
        </div>
      )}
    </div>
  )
}

registerToolRenderer('Grep', GrepRenderer)
