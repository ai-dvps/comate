import { MessageSquare } from 'lucide-react'
import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

export default function BriefRenderer(input: unknown): ReactNode | null {
  if (!input || typeof input !== 'object') return null

  const { message, attachments, status } = input as Record<string, unknown>

  const msg = typeof message === 'string' ? message : null
  const attachList = Array.isArray(attachments)
    ? attachments.filter((a): a is string => typeof a === 'string')
    : null
  const isProactive = status === 'proactive'

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <MessageSquare className="size-3.5 text-text-tertiary" />
        {isProactive && (
          <span className="text-xs text-accent">Proactive</span>
        )}
      </div>
      {msg && (
        <p className="text-sm text-text-secondary whitespace-pre-wrap break-words">
          {msg}
        </p>
      )}
      {attachList && attachList.length > 0 && (
        <div className="flex items-start gap-2 flex-wrap">
          <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">
            Attachments
          </span>
          <div className="flex flex-wrap gap-1">
            {attachList.map((path, i) => (
              <span key={i} className="text-xs text-text-secondary font-mono bg-surface-hover px-1.5 py-0.5 rounded">
                {path}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

registerToolRenderer('SendUserMessage', BriefRenderer)
registerToolRenderer('Brief', BriefRenderer)
