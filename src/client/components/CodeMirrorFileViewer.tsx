import { useTranslation } from 'react-i18next'
import { Copy, FileWarning } from 'lucide-react'
import { useCallback, useMemo } from 'react'
import { cn } from './ui/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import MarkdownPreview from './MarkdownPreview'
import CodeMirrorEditor from './CodeMirrorEditor'
import { getCodeMirrorLanguage } from '../lib/codemirror-language'
import { getPathDisplayInfo } from '../lib/path-utils'
import { isMarkdown } from '../lib/file-helpers'
import { useAppSettings } from '../hooks/use-app-settings'
import { fontSizeClass, fontSizeValue } from '../lib/font-size'
import type { FileTab } from '../stores/right-panel-store'

interface CodeMirrorFileViewerProps {
  tab: FileTab
  workspacePath?: string
}

export default function CodeMirrorFileViewer({
  tab,
  workspacePath,
}: CodeMirrorFileViewerProps) {
  const { t } = useTranslation('common')
  const { chatFontSize } = useAppSettings()
  const absolutePath = getPathDisplayInfo(tab.path, workspacePath).displayAbsolute
  const language = useMemo(() => getCodeMirrorLanguage(tab.name), [tab.name])
  const fontSize = useMemo(() => fontSizeValue(chatFontSize ?? 'small'), [chatFontSize])
  const contentFontClass = useMemo(() => fontSizeClass(chatFontSize ?? 'small'), [chatFontSize])

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(tab.content)
    } catch (err) {
      console.error('Failed to copy content:', err)
    }
  }, [tab.content])

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
        </div>

        {!tab.isBinary && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleCopy}
                className="px-2 py-1.5 rounded-md text-xs text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
                aria-label={t('copyContent')}
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('copyContent')}</TooltipContent>
          </Tooltip>
        )}
      </div>

      <div className={cn('flex-1 overflow-auto', isMarkdown(tab.name) && 'p-0')} data-testid="file-viewer-content">
        {tab.isBinary ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary">
            <FileWarning className="w-8 h-8" />
            <p className="text-sm">{t('gitChanges.binaryPlaceholder')}</p>
          </div>
        ) : isMarkdown(tab.name) ? (
          <MarkdownPreview content={tab.content} className={contentFontClass} />
        ) : (
          <CodeMirrorEditor
            value={tab.content}
            language={language}
            readOnly={true}
            className="h-full"
            fontSize={fontSize}
          />
        )}
      </div>
    </div>
  )
}
