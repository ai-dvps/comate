import { FileText } from 'lucide-react'
import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'
import FilePath from '../FilePath'

function ReadRenderer(input: unknown): ReactNode | null {
  if (typeof input !== 'object' || input === null) {
    return null
  }

  const obj = input as Record<string, unknown>
  const filePath =
    typeof obj.file_path === 'string'
      ? obj.file_path
      : typeof obj.path === 'string'
        ? obj.path
        : undefined

  if (!filePath) {
    return null
  }

  return (
    <div className="flex items-center gap-2">
      <FileText className="size-3.5 text-text-tertiary" />
      <span className="text-text-tertiary text-xs uppercase tracking-wide">
        Reading
      </span>
      <FilePath path={filePath} />
    </div>
  )
}

registerToolRenderer('Read', ReadRenderer)
