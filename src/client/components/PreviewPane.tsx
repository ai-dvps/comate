import { useMemo } from 'react'
import { sanitizePreviewHtml } from '../lib/sanitize-html'

interface PreviewPaneProps {
  html: string | null | undefined
  ariaLabel?: string
}

export default function PreviewPane({
  html,
  ariaLabel = 'Preview of selected option',
}: PreviewPaneProps) {
  const sanitized = useMemo(() => {
    if (!html) return ''
    return sanitizePreviewHtml(html)
  }, [html])

  if (!sanitized) {
    return (
      <div
        role="region"
        aria-label={ariaLabel}
        className="preview-content overflow-auto h-full px-3 py-2"
      >
        <p className="text-sm text-text-tertiary italic">
          No preview available for this option.
        </p>
      </div>
    )
  }

  return (
    <div
      role="region"
      aria-label={ariaLabel}
      className="preview-content overflow-auto h-full px-3 py-2"
      dangerouslySetInnerHTML={{ __html: sanitized }}
    />
  )
}
