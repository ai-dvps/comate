import { Terminal } from 'lucide-react'

import { CodeBlockContent } from './code-block'
import { ToolInput } from './tool'

interface BashToolInputProps {
  input: unknown
}

export default function BashToolInput({ input }: BashToolInputProps) {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('command' in input) ||
    typeof (input as Record<string, unknown>).command !== 'string'
  ) {
    return <ToolInput input={input} />
  }

  const { command } = input as { command: string }

  return (
    <div className="space-y-2 overflow-hidden">
      <div className="flex items-center gap-2">
        <Terminal className="size-3.5 text-text-tertiary" />
        <h4 className="font-medium text-text-tertiary text-xs uppercase tracking-wide">
          Command
        </h4>
      </div>
      <div className="rounded-md bg-surface-hover/50 overflow-hidden">
        <CodeBlockContent code={command} language="bash" />
      </div>
    </div>
  )
}
