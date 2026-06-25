import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

export default function WebFetchRenderer(input: unknown): ReactNode | null {
  if (!input || typeof input !== 'object') return null

  const { url, prompt } = input as Record<string, unknown>

  if (!url || typeof url !== 'string') return null

  const promptText = typeof prompt === 'string' ? prompt : null

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">URL</span>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent text-sm hover:underline truncate"
          title={url}
        >
          {url}
        </a>
      </div>
      {promptText && (
        <div className="flex items-start gap-2">
          <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Prompt</span>
          <span className="text-text-secondary text-sm whitespace-pre-wrap break-words">{promptText}</span>
        </div>
      )}
    </div>
  )
}

registerToolRenderer('web_fetch', WebFetchRenderer)
