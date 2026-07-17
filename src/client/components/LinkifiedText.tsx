import { memo, useCallback } from 'react'
import type { SearchHighlightRange } from '../hooks/useMessageSearch'
import { HighlightText } from './ChatMessageRenderer'
import { openUrlInBrowser, splitTextByUrls } from '../lib/open-url'

export interface LinkifiedTextProps {
  text: string
  /** Search highlight ranges computed on the raw text. */
  ranges?: SearchHighlightRange[]
  className?: string
}

/**
 * Renders plain text with modifier-clickable URLs.
 *
 * URLs are not styled differently from surrounding text; holding Ctrl (Windows/
 * Linux) or Cmd (macOS) while clicking opens the URL in the system default
 * browser. Plain clicks keep the default behavior (text selection, copy, etc.).
 */
function LinkifiedText({ text, ranges = [], className }: LinkifiedTextProps) {
  const segments = splitTextByUrls(text)

  const handleUrlClick = useCallback(
    (event: React.MouseEvent, href: string) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      event.stopPropagation()
      void openUrlInBrowser(href)
    },
    [],
  )

  if (segments.length === 1 && segments[0].type === 'text') {
    return (
      <span className={className}>
        <HighlightText text={text} ranges={ranges} />
      </span>
    )
  }

  let cursor = 0
  return (
    <span className={className}>
      {segments.map((segment, index) => {
        const segmentStart = cursor
        const segmentEnd = cursor + segment.content.length
        cursor = segmentEnd

        const segmentRanges = ranges
          .filter(
            (range) => range.start < segmentEnd && range.end > segmentStart,
          )
          .map((range) => ({
            start: Math.max(range.start, segmentStart) - segmentStart,
            end: Math.min(range.end, segmentEnd) - segmentStart,
            isActive: range.isActive,
          }))

        if (segment.type === 'url' && segment.href) {
          return (
            <span
              key={index}
              onClick={(event) => handleUrlClick(event, segment.href!)}
            >
              <HighlightText text={segment.content} ranges={segmentRanges} />
            </span>
          )
        }
        return (
          <HighlightText
            key={index}
            text={segment.content}
            ranges={segmentRanges}
          />
        )
      })}
    </span>
  )
}

export default memo(LinkifiedText)
