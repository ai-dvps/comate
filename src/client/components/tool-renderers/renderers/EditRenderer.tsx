import { unifiedMergeView } from '@codemirror/merge'
import { FileCode } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import CodeMirrorEditor from '../../CodeMirrorEditor'
import { getCodeMirrorLanguage } from '@/lib/codemirror-language'
import { registerToolRenderer } from '../registry'
import FilePath from '../FilePath'

interface EditDiffProps {
  filePath: string
  oldString: string
  newString: string
}

function EditDiff({ filePath, oldString, newString }: EditDiffProps) {
  const language = useMemo(() => getCodeMirrorLanguage(filePath), [filePath])
  const extensions = useMemo(
    () => [
      unifiedMergeView({
        original: oldString,
        highlightChanges: true,
        gutter: true,
        syntaxHighlightDeletions: true,
        mergeControls: false,
      }),
    ],
    [oldString],
  )

  return (
    <div className="rounded-md border border-border/50 overflow-hidden">
      <CodeMirrorEditor
        value={newString}
        language={language}
        readOnly={true}
        extensions={extensions}
      />
    </div>
  )
}

export default function EditRenderer(input: unknown): ReactNode | null {
  if (typeof input !== 'object' || input === null) {
    return null
  }

  const obj = input as Record<string, unknown>

  if (
    typeof obj.file_path !== 'string' ||
    typeof obj.old_string !== 'string' ||
    typeof obj.new_string !== 'string'
  ) {
    return null
  }

  const { file_path, old_string, new_string } = obj as {
    file_path: string
    old_string: string
    new_string: string
  }

  const replaceAll = obj.replace_all === true

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <FileCode className="size-3.5 text-text-tertiary" />
        <span className="text-text-tertiary text-xs uppercase tracking-wide">
          Editing
        </span>
        <FilePath path={file_path} />
        {replaceAll && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-text-tertiary/20 text-text-tertiary">
            Replace all
          </span>
        )}
      </div>

      {old_string.length > 0 || new_string.length > 0 ? (
        <EditDiff
          filePath={file_path}
          oldString={old_string}
          newString={new_string}
        />
      ) : null}
    </div>
  )
}

registerToolRenderer('Edit', EditRenderer)
