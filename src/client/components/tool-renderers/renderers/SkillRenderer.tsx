import { Zap } from 'lucide-react'
import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

export default function SkillRenderer(input: unknown): ReactNode | null {
  if (typeof input !== 'object' || input === null) {
    return null
  }

  const obj = input as Record<string, unknown>

  if (typeof obj.skill !== 'string') {
    return null
  }

  const { skill } = obj
  const args = typeof obj.args === 'string' ? obj.args : undefined

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Zap className="size-3.5 text-text-tertiary" />
        <span className="text-text-tertiary text-xs uppercase tracking-wide">
          Skill
        </span>
        <code className="text-xs font-mono text-text-primary bg-surface-hover/50 px-1.5 py-0.5 rounded">
          {skill}
        </code>
      </div>
      {args && (
        <div className="flex items-center gap-2">
          <span className="text-text-tertiary text-xs uppercase tracking-wide">
            Args
          </span>
          <span className="font-mono text-xs text-text-primary truncate">
            {args}
          </span>
        </div>
      )}
    </div>
  )
}

registerToolRenderer('Skill', SkillRenderer)
