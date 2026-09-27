import { CheckCircleIcon, CircleIcon, ClockIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

function statusIcon(status: string): ReactNode {
  switch (status) {
    case 'completed':
      return <CheckCircleIcon className="size-3.5 text-success" />
    case 'in_progress':
      return <ClockIcon className="size-3.5 text-accent animate-pulse" />
    default:
      return <CircleIcon className="size-3.5 text-text-tertiary" />
  }
}

export default function TodoWriteRenderer(input: unknown): ReactNode | null {
  if (!input || typeof input !== 'object') return null

  const { todos } = input as Record<string, unknown>
  if (!Array.isArray(todos) || todos.length === 0) return null

  const items = todos.filter(
    (t): t is { content?: string; status?: string; activeForm?: string } =>
      typeof t === 'object' && t !== null,
  )

  if (items.length === 0) return null

  return (
    <div className="space-y-1.5">
      {items.map((todo, i) => {
        const status = typeof todo.status === 'string' ? todo.status : 'pending'
        const content = typeof todo.content === 'string' ? todo.content : ''
        return (
          <div key={i} className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0">{statusIcon(status)}</span>
            <span
              className={`text-sm whitespace-pre-wrap break-words ${status === 'completed' ? 'text-text-tertiary line-through' : 'text-text-secondary'}`}
            >
              {content}
            </span>
          </div>
        )
      })}
    </div>
  )
}

registerToolRenderer('TodoWrite', TodoWriteRenderer)
