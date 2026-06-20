import { FileCode } from 'lucide-react'
import type { ReactNode } from 'react'
import { CodeBlockContent } from '../../ai-elements/code-block'
import { getLanguageFromFilename } from '@/lib/language'
import { registerToolRenderer } from '../registry'
import FilePath from '../FilePath'

function WriteRenderer(input: unknown): ReactNode | null {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('file_path' in input) ||
    !('content' in input) ||
    typeof (input as Record<string, unknown>).file_path !== 'string' ||
    typeof (input as Record<string, unknown>).content !== 'string'
  ) {
    return null
  }

  const { file_path, content } = input as {
    file_path: string
    content: string
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <FileCode className="size-3.5 text-text-tertiary" />
        <span className="text-text-tertiary text-xs uppercase tracking-wide">
          Writing to
        </span>
        <FilePath path={file_path} />
      </div>
      <div className="rounded-md overflow-hidden">
        <CodeBlockContent
          code={content}
          language={getLanguageFromFilename(file_path)}
          showLineNumbers={true}
        />
      </div>
    </div>
  )
}

registerToolRenderer('Write', WriteRenderer)
