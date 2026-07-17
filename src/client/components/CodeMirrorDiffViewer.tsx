import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Columns2, AlignLeft, FileWarning, FileX } from 'lucide-react'
import { unifiedMergeView, MergeView } from '@codemirror/merge'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { cn } from './ui/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import MarkdownPreview from './MarkdownPreview'
import CodeMirrorEditor from './CodeMirrorEditor'
import { getCodeMirrorLanguage } from '../lib/codemirror-language'
import { getComateThemeExtension } from '../lib/codemirror-theme'
import { getPathDisplayInfo } from '../lib/path-utils'
import { isMarkdown } from '../lib/file-helpers'
import { getStatusBadgeClass } from '../lib/git-status-helpers'
import { useTheme } from '../hooks/use-theme'
import { useAppSettings } from '../hooks/use-app-settings'
import { fontSizeClass, fontSizeValue } from '../lib/font-size'
import type { DiffTab } from '../stores/right-panel-store'

const MIN_SIDE_BY_SIDE_WIDTH = 360

interface CodeMirrorDiffViewerProps {
  tab: DiffTab
  workspacePath?: string
  width?: number
}

export default function CodeMirrorDiffViewer({
  tab,
  workspacePath,
  width = 0,
}: CodeMirrorDiffViewerProps) {
  const { t } = useTranslation('common')
  const { theme } = useTheme()
  const { chatFontSize } = useAppSettings()
  const [diffMode, setDiffMode] = useState<'unified' | 'sideBySide'>('unified')
  const mergeRef = useRef<HTMLDivElement>(null)
  const absolutePath = getPathDisplayInfo(tab.path, workspacePath).displayAbsolute

  const fontSize = useMemo(() => fontSizeValue(chatFontSize ?? 'small'), [chatFontSize])
  const contentFontClass = useMemo(() => fontSizeClass(chatFontSize ?? 'small'), [chatFontSize])

  const language = useMemo(() => getCodeMirrorLanguage(tab.name), [tab.name])
  const mergeViewLanguageExtensions = useMemo(() => {
    const lang = getCodeMirrorLanguage(tab.name)
    return lang ? [lang] : []
  }, [tab.name])
  const unifiedExtensions = useMemo(
    () => [
      unifiedMergeView({
        original: tab.original,
        highlightChanges: true,
        gutter: true,
        syntaxHighlightDeletions: true,
        mergeControls: false,
      }),
    ],
    [tab.original],
  )

  useEffect(() => {
    if (width < MIN_SIDE_BY_SIDE_WIDTH && diffMode === 'sideBySide') {
      setDiffMode('unified')
    }
  }, [width, diffMode])

  const handleToggleDiffMode = useCallback(() => {
    setDiffMode((mode) => {
      if (mode === 'unified') {
        return width < MIN_SIDE_BY_SIDE_WIDTH ? 'unified' : 'sideBySide'
      }
      return 'unified'
    })
  }, [width])

  useEffect(() => {
    if (diffMode !== 'sideBySide' || !mergeRef.current || tab.isBinary || tab.error) {
      return
    }

    const themeExtension = getComateThemeExtension(theme, fontSize)
    const view = new MergeView({
      a: {
        doc: tab.original,
        extensions: [
          themeExtension,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          ...mergeViewLanguageExtensions,
        ],
      },
      b: {
        doc: tab.modified,
        extensions: [
          themeExtension,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          ...mergeViewLanguageExtensions,
        ],
      },
      parent: mergeRef.current,
      highlightChanges: true,
      gutter: true,
    })

    return () => {
      view.destroy()
    }
  }, [diffMode, tab.original, tab.modified, tab.name, tab.isBinary, tab.error, theme, fontSize, mergeViewLanguageExtensions])

  const renderFileContent = useCallback(() => {
    if (isMarkdown(tab.name)) {
      return <MarkdownPreview content={tab.modified} className={contentFontClass} />
    }
    return (
      <CodeMirrorEditor
        value={tab.modified}
        language={language}
        readOnly={true}
        className="h-full"
        fontSize={fontSize}
      />
    )
  }, [tab.modified, tab.name, language, fontSize, contentFontClass])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-1.5 border-b border-border/50 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <svg
            className="w-4 h-4 text-text-tertiary flex-shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
          <span
            className="text-sm text-text-primary font-mono truncate"
            title={absolutePath}
          >
            {absolutePath}
          </span>
          <span
            className={cn(
              'flex-shrink-0 px-1 py-0.5 rounded text-[10px] font-mono font-medium',
              getStatusBadgeClass(tab.statusCode),
            )}
            title={tab.statusCode}
          >
            {tab.statusCode}
          </span>
        </div>

        {!tab.isUntracked && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                data-testid="diff-mode-toggle"
                onClick={handleToggleDiffMode}
                disabled={width < MIN_SIDE_BY_SIDE_WIDTH}
                className={cn(
                  'p-1.5 rounded-md transition-colors',
                  width < MIN_SIDE_BY_SIDE_WIDTH
                    ? 'text-text-tertiary cursor-not-allowed'
                    : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover',
                )}
                aria-label={
                  diffMode === 'unified'
                    ? t('rightPanel.diffModeSideBySide')
                    : t('rightPanel.diffModeUnified')
                }
              >
                {diffMode === 'unified' ? (
                  <Columns2 className="w-3.5 h-3.5" />
                ) : (
                  <AlignLeft className="w-3.5 h-3.5" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {diffMode === 'unified'
                ? t('rightPanel.diffModeSideBySide')
                : t('rightPanel.diffModeUnified')}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {tab.error && (
        <div className="px-4 py-2 text-xs text-destructive flex items-center gap-2 flex-shrink-0 border-b border-border/50">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="font-medium">{t('gitChanges.errorGeneric')}</span>
          <span className="opacity-80 truncate">{tab.error}</span>
        </div>
      )}

      {tab.truncated && !tab.error && (
        <div className="px-4 py-2 text-xs text-warning flex items-center gap-2 flex-shrink-0 border-b border-border/50">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          <span>{t('gitChanges.truncatedPlaceholder')}</span>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        {tab.isBinary ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary">
            <FileWarning className="w-8 h-8" />
            <p className="text-sm">{t('gitChanges.binaryPlaceholder')}</p>
          </div>
        ) : tab.isDeleted ? (
          <div className="h-full space-y-2">
            <div className="flex items-center gap-2 px-4 py-2 text-xs text-destructive">
              <FileX className="w-3.5 h-3.5" />
              <span>{t('gitChanges.deletedFileHeader')}</span>
            </div>
            <CodeMirrorEditor
              value={tab.modified}
              language={language}
              readOnly={true}
              className="h-full"
              fontSize={fontSize}
              extensions={unifiedExtensions}
            />
          </div>
        ) : tab.isUntracked ? (
          renderFileContent()
        ) : diffMode === 'unified' ? (
          <CodeMirrorEditor
            value={tab.modified}
            language={language}
            readOnly={true}
            className="h-full"
            extensions={unifiedExtensions}
          />
        ) : (
          <div ref={mergeRef} className="h-full cm-mergeView" />
        )}
      </div>
    </div>
  )
}
