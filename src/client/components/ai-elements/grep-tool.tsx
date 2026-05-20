import { FileText, Search } from 'lucide-react'

import { ToolInput } from './tool'

interface GrepToolInputProps {
  input: unknown
}

export default function GrepToolInput({ input }: GrepToolInputProps) {
  if (typeof input !== 'object' || input === null) {
    return <ToolInput input={input} />
  }

  const obj = input as Record<string, unknown>

  if (typeof obj.pattern !== 'string' || typeof obj.path !== 'string') {
    return <ToolInput input={input} />
  }

  const { pattern, path } = obj
  const outputMode = typeof obj.output_mode === 'string' ? obj.output_mode : undefined

  return (
    <div className="space-y-2 overflow-hidden">
      <div className="flex items-center gap-2">
        <Search className="size-3.5 text-text-tertiary" />
        <h4 className="font-medium text-text-tertiary text-xs uppercase tracking-wide">
          Pattern
        </h4>
        <code className="text-xs font-mono text-text-primary bg-surface-hover/50 px-1.5 py-0.5 rounded">
          {pattern}
        </code>
      </div>
      <div className="flex items-center gap-2">
        <FileText className="size-3.5 text-text-tertiary" />
        <h4 className="font-medium text-text-tertiary text-xs uppercase tracking-wide">
          Path
        </h4>
        <span className="font-mono text-xs text-text-primary">{path}</span>
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
