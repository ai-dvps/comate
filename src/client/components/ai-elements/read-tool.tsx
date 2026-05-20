import { FileText } from 'lucide-react'

import { ToolInput } from './tool'

interface ReadToolInputProps {
  input: unknown
}

export default function ReadToolInput({ input }: ReadToolInputProps) {
  if (typeof input !== 'object' || input === null) {
    return <ToolInput input={input} />
  }

  const obj = input as Record<string, unknown>
  const filePath =
    typeof obj.file_path === 'string'
      ? obj.file_path
      : typeof obj.path === 'string'
        ? obj.path
        : undefined

  if (!filePath) {
    return <ToolInput input={input} />
  }

  return (
    <div className="flex items-center gap-2">
      <FileText className="size-3.5 text-text-tertiary" />
      <h4 className="font-medium text-text-tertiary text-xs uppercase tracking-wide">
        Reading
      </h4>
      <span className="font-mono text-xs text-text-primary">{filePath}</span>
    </div>
  )
}
