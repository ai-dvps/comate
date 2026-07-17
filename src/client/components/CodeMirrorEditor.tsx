import { useMemo } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import type { Extension } from '@codemirror/state'
import { useTheme } from '../hooks/use-theme'
import { getComateThemeExtension } from '../lib/codemirror-theme'

interface CodeMirrorEditorProps {
  value?: string
  language: Extension | null
  readOnly: boolean
  className?: string
  extensions?: Extension[]
}

export default function CodeMirrorEditor({
  value = '',
  language,
  readOnly,
  className,
  extensions = [],
}: CodeMirrorEditorProps) {
  const { theme } = useTheme()
  const allExtensions = useMemo(() => {
    const result: Extension[] = []
    if (language) {
      result.push(language)
    }
    result.push(...extensions)
    return result
  }, [language, extensions])

  const themeExtension = useMemo(
    () => getComateThemeExtension(theme),
    [theme],
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
    />
  )
}
