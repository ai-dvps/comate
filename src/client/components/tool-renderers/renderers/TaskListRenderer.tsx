import { List } from 'lucide-react'
import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

function TaskListRenderer(_: unknown): ReactNode | null {
  void _
  return (
    <div className="flex items-center gap-2">
      <List className="size-3.5 text-text-tertiary" />
      <span className="text-text-secondary text-sm">List tasks</span>
    </div>
  )
}

registerToolRenderer('TaskList', TaskListRenderer)
