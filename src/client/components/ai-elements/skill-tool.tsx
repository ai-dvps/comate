import { Zap } from 'lucide-react'

import { ToolInput } from './tool'

interface SkillToolInputProps {
  input: unknown
}

export default function SkillToolInput({ input }: SkillToolInputProps) {
  if (typeof input !== 'object' || input === null) {
    return <ToolInput input={input} />
  }

  const obj = input as Record<string, unknown>

  if (typeof obj.skill !== 'string') {
    return <ToolInput input={input} />
  }

  const { skill } = obj
  const args = typeof obj.args === 'string' ? obj.args : undefined

  return (
    <div className="space-y-2 overflow-hidden">
      <div className="flex items-center gap-2">
        <Zap className="size-3.5 text-text-tertiary" />
        <h4 className="font-medium text-text-tertiary text-xs uppercase tracking-wide">
          Skill
        </h4>
        <code className="text-xs font-mono text-text-primary bg-surface-hover/50 px-1.5 py-0.5 rounded">
          {skill}
        </code>
      </div>
      {args && (
        <div className="flex items-center gap-2">
          <span className="font-medium text-text-tertiary text-xs uppercase tracking-wide">
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
