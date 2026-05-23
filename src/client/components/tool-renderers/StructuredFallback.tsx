import type { ReactNode } from 'react'

function formatValue(value: unknown): ReactNode {
  if (value === null) return <span className="text-text-tertiary">null</span>
  if (value === undefined) return <span className="text-text-tertiary">undefined</span>
  if (typeof value === 'boolean') return <span className="text-accent">{String(value)}</span>
  if (typeof value === 'number') return <span className="text-accent">{value}</span>
  if (typeof value === 'string') {
    if (value.length > 200) {
      return (
        <span className="text-text-secondary whitespace-pre-wrap break-words">
          {value.slice(0, 200)}…
        </span>
      )
    }
    return <span className="text-text-secondary whitespace-pre-wrap break-words">{value}</span>
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-text-tertiary">[]</span>
    return (
      <div className="pl-3 border-l border-border/50 space-y-1">
        {value.map((item, i) => (
          <div key={i} className="flex gap-2">
            <span className="text-text-tertiary text-xs shrink-0">{i}:</span>
            <div className="min-w-0">{formatValue(item)}</div>
          </div>
        ))}
      </div>
    )
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.length === 0) return <span className="text-text-tertiary">{'{}'}</span>
    return (
      <div className="pl-3 border-l border-border/50 space-y-1">
        {entries.map(([key, val]) => (
          <div key={key} className="flex gap-2">
            <span className="text-text-tertiary text-xs shrink-0">{key}:</span>
            <div className="min-w-0">{formatValue(val)}</div>
          </div>
        ))}
      </div>
    )
  }
  return <span className="text-text-secondary">{String(value)}</span>
}

export function StructuredFallback({ data }: { data: unknown }): ReactNode {
  if (data === null || data === undefined) {
    return <span className="text-text-tertiary italic">No parameters</span>
  }
  if (typeof data !== 'object') {
    return formatValue(data)
  }
  return (
    <div className="space-y-1 text-sm">
      {formatValue(data)}
    </div>
  )
}
