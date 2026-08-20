import { useMemo } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useTheme } from '../hooks/use-theme'
import { getComateThemeExtension } from '../lib/codemirror-theme'

// Canonical CodeMirror recipe for filling a fixed-height parent: the editor
// takes the container height and .cm-scroller becomes the scroll container,
// keeping both scrollbars pinned to the visible editor area instead of the
// end of the document.
const fillHeightExtension: Extension = EditorView.theme({
  '&': { height: '100%' },
  '.cm-scroller': { overflow: 'auto' },
})

interface CodeMirrorEditorProps {
  value?: string
  language: Extension | null
  readOnly: boolean
  className?: string
  extensions?: Extension[]
  fontSize?: string
  /** Fill the parent's height and scroll inside the editor (requires a height-constrained parent). */
  fillHeight?: boolean
  onChange?: (value: string) => void
  onBlur?: () => void
}

export default function CodeMirrorEditor({
  value = '',
  language,
  readOnly,
  className,
  extensions = [],
  fontSize,
  fillHeight = false,
  onChange,
  onBlur,
}: CodeMirrorEditorProps) {
  const { theme } = useTheme()
  const allExtensions = useMemo(() => {
    const result: Extension[] = []
    if (language) {
      result.push(language)
    }
    result.push(...extensions)
    if (fillHeight) {
      result.push(fillHeightExtension)
    }
    return result
  }, [language, extensions, fillHeight])

  const themeExtension = useMemo(
    () => getComateThemeExtension(theme, fontSize),
    [theme, fontSize],
  )

  return (
    <CodeMirror
      value={value}
      theme={themeExtension}
      editable={!readOnly}
      readOnly={readOnly}
      basicSetup={{ lineNumbers: true }}
      extensions={allExtensions}
      className={className}
      onChange={onChange}
      onBlur={onBlur}
    />
  )
}
