import { memo } from 'react'
import type { SearchHighlightRange } from '../hooks/useMessageSearch'

export interface HighlightTextProps {
  text: string
  ranges: SearchHighlightRange[]
  className?: string
}

/**
 * Renders plain text with search-match highlighting.
 *
 * Ranges are computed on the raw text by the message search hook; this component
 * splits the text into active/inactive segments and wraps matches in `<mark>`.
 */
export function HighlightText({
  text,
  ranges,
  className,
}: HighlightTextProps) {
  if (ranges.length === 0) {
    return (
      <span className={className}>{text}</span>
    )
  }

  const segments: { start: number; end: number; isActive: boolean }[] = []
  let last = 0
  for (const range of ranges) {
    if (range.start > last) {
      segments.push({ start: last, end: range.start, isActive: false })
    }
    segments.push({ start: range.start, end: range.end, isActive: range.isActive })
    last = range.end
  }
  if (last < text.length) {
    segments.push({ start: last, end: text.length, isActive: false })
  }

  return (
    <span className={className}>
      {segments.map((segment, idx) => {
        const content = text.slice(segment.start, segment.end)
        if (segment.isActive) {
          return (
            <mark
              key={idx}
              className="rounded bg-accent/70 px-0.5 text-text-primary ring-1 ring-accent"
              data-search-active="true"
            >
              {content}
            </mark>
          )
        }
        if (ranges.some((r) => segment.start >= r.start && segment.end <= r.end)) {
          // Defensive: should have been handled by isActive branch for exact matches,
          // but mark any overlapping segment as a regular match.
          return (
            <mark
              key={idx}
              className="rounded bg-accent/40 px-0.5 text-text-primary"
              data-search-match="true"
            >
              {content}
            </mark>
          )
        }
        return <span key={idx}>{content}</span>
      })}
    </span>
  )
}

export default memo(HighlightText)
