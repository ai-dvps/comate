import { Terminal } from 'lucide-react'
import type { ReactNode } from 'react'
import { CodeBlockContent } from '../../ai-elements/code-block'
import { registerToolRenderer } from '../registry'

function BashRenderer(input: unknown): ReactNode | null {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('command' in input) ||
    typeof (input as Record<string, unknown>).command !== 'string'
  ) {
    return null
  }

  const { command } = input as { command: string }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Terminal className="size-3.5 text-text-tertiary" />
        <span className="text-text-tertiary text-xs uppercase tracking-wide">
          Command
        </span>
      </div>
      <div className="rounded-md overflow-hidden">
        <CodeBlockContent code={command} language="bash" />
      </div>
    </div>
  )
}

registerToolRenderer('Bash', BashRenderer)
