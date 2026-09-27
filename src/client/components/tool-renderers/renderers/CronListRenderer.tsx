import { List } from 'lucide-react'
import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

export default function CronListRenderer(_: unknown): ReactNode | null {
  void _
  return (
    <div className="flex items-center gap-2">
      <List className="size-3.5 text-text-tertiary" />
      <span className="text-text-secondary text-sm">List scheduled jobs</span>
    </div>
  )
}

registerToolRenderer('CronList', CronListRenderer)
