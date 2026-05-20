import { FileCode } from 'lucide-react'

import { getLanguageFromFilename } from '../../lib/language'
import { CodeBlockContent } from './code-block'
import { ToolInput } from './tool'

interface WriteToolInputProps {
  input: unknown
}

export default function WriteToolInput({ input }: WriteToolInputProps) {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('file_path' in input) ||
    !('content' in input) ||
    typeof (input as Record<string, unknown>).file_path !== 'string' ||
    typeof (input as Record<string, unknown>).content !== 'string'
  ) {
    return <ToolInput input={input} />
  }

  const { file_path, content } = input as {
    file_path: string
    content: string
  }

  return (
    <div className="space-y-2 overflow-hidden">
      <div className="flex items-center gap-2">
        <FileCode className="size-3.5 text-text-tertiary" />
        <h4 className="font-medium text-text-tertiary text-xs uppercase tracking-wide">
          Writing to
        </h4>
        <span className="font-mono text-xs text-text-primary">{file_path}</span>
      </div>
      <div className="rounded-md bg-surface-hover/50 overflow-hidden">
        <CodeBlockContent
          code={content}
          language={getLanguageFromFilename(file_path)}
          showLineNumbers={true}
        />
      </div>
    </div>
  )
}
