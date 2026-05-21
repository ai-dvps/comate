import { FileCode, Pencil } from 'lucide-react'

import { getLanguageFromFilename } from '../../lib/language'
import { CodeBlockContent } from './code-block'
import { ToolInput } from './tool'

interface EditToolInputProps {
  input: unknown
}

export default function EditToolInput({ input }: EditToolInputProps) {
  if (typeof input !== 'object' || input === null) {
    return <ToolInput input={input} />
  }

  const obj = input as Record<string, unknown>

  if (
    typeof obj.file_path !== 'string' ||
    typeof obj.old_string !== 'string' ||
    typeof obj.new_string !== 'string'
  ) {
    return <ToolInput input={input} />
  }

  const { file_path, old_string, new_string } = obj as {
    file_path: string
    old_string: string
    new_string: string
  }

  const language = getLanguageFromFilename(file_path)
  const replaceAll = obj.replace_all === true

  return (
    <div className="space-y-3 overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap">
        <FileCode className="size-3.5 text-text-tertiary" />
        <h4 className="font-medium text-text-tertiary text-xs uppercase tracking-wide">
          Editing
        </h4>
        <span className="font-mono text-xs text-text-primary">{file_path}</span>
        {replaceAll && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-text-tertiary/20 text-text-tertiary">
            Replace all
          </span>
        )}
      </div>

      {old_string.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5">
            <Pencil className="size-3 text-destructive" />
            <span className="text-[11px] font-medium text-destructive uppercase tracking-wide">
              Before
            </span>
          </div>
          <div className="rounded-md bg-destructive/10 overflow-hidden">
            <CodeBlockContent code={old_string} language={language} />
          </div>
        </div>
      )}

      {new_string.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5">
            <Pencil className="size-3 text-success" />
            <span className="text-[11px] font-medium text-success uppercase tracking-wide">
              After
            </span>
          </div>
          <div className="rounded-md bg-success/10 overflow-hidden">
            <CodeBlockContent code={new_string} language={language} />
          </div>
        </div>
      )}
    </div>
  )
}
