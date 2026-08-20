import { useTranslation } from 'react-i18next'
import { Copy, FileAudio, FileWarning } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { cn } from './ui/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import MarkdownPreview from './MarkdownPreview'
import CodeMirrorEditor from './CodeMirrorEditor'
import { getCodeMirrorLanguage } from '../lib/codemirror-language'
import { getPathDisplayInfo } from '../lib/path-utils'
import { isMarkdown } from '../lib/file-helpers'
import { useAppSettings } from '../hooks/use-app-settings'
import { fontSizeValue } from '../lib/font-size'
import type { FileContextTab } from '../stores/context-tab-store'

interface CodeMirrorFileViewerProps {
  tab: FileContextTab
  workspacePath?: string
  /** Extra actions rendered at the header's top-right (e.g. the navigator toggle). */
  headerActions?: ReactNode
}

export default function CodeMirrorFileViewer({
  tab,
  workspacePath,
  headerActions,
}: CodeMirrorFileViewerProps) {
  const { t } = useTranslation('common')
  const { chatFontSize } = useAppSettings()
  const absolutePath = getPathDisplayInfo(tab.path, workspacePath).displayAbsolute
  const language = useMemo(() => getCodeMirrorLanguage(tab.name), [tab.name])
  const fontSize = fontSizeValue(chatFontSize)
  const [failedMediaUrl, setFailedMediaUrl] = useState<string>()
  const videoLoadFailed = Boolean(tab.videoUrl && failedMediaUrl === tab.videoUrl)
  const audioLoadFailed = Boolean(tab.audioUrl && failedMediaUrl === tab.audioUrl)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(tab.content)
    } catch (err) {
      console.error('Failed to copy content:', err)
    }
  }, [tab.content])

  return (
    <div className="flex flex-col h-full">
      <div
        data-testid="file-viewer-header"
        className="flex items-center justify-between px-4 py-1.5 border-b border-border/50 flex-shrink-0"
      >
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

        <div className="flex flex-shrink-0 items-center gap-0.5">
          {!tab.isBinary && !tab.imageDataUrl && !tab.videoUrl && !tab.audioUrl && (
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
          {headerActions}
        </div>
      </div>

      <div className={cn('flex-1 overflow-auto', isMarkdown(tab.name) && 'p-0')} data-testid="file-viewer-content">
        {tab.videoUrl && !videoLoadFailed ? (
          <div className="flex items-center justify-center h-full p-4 bg-black/90">
            <video
              src={tab.videoUrl}
              controls
              preload="metadata"
              onError={() => setFailedMediaUrl(tab.videoUrl)}
              aria-label={t('videoPreviewLabel', { name: tab.name })}
              className="max-w-full max-h-full"
            />
          </div>
        ) : videoLoadFailed ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center text-text-secondary">
            <FileWarning className="w-8 h-8" />
            <p className="text-sm">{t('videoPreviewError')}</p>
          </div>
        ) : tab.audioUrl && !audioLoadFailed ? (
          <div className="flex flex-col items-center justify-center h-full gap-4 px-6 bg-surface/50">
            <FileAudio className="w-10 h-10 text-text-secondary" aria-hidden="true" />
            <span
              className="text-sm font-mono text-text-secondary break-all text-center max-w-full"
              title={tab.name}
            >
              {tab.name}
            </span>
            <audio
              src={tab.audioUrl}
              controls
              preload="metadata"
              onError={() => setFailedMediaUrl(tab.audioUrl)}
              aria-label={t('audioPreviewLabel', { name: tab.name })}
              className="w-full max-w-xl"
            />
          </div>
        ) : audioLoadFailed ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center text-text-secondary">
            <FileWarning className="w-8 h-8" />
            <p className="text-sm">{t('audioPreviewError')}</p>
          </div>
        ) : tab.imageDataUrl ? (
          <div className="flex items-center justify-center h-full p-4 bg-surface/50">
            <img
              src={tab.imageDataUrl}
              alt={tab.name}
              className="max-w-full max-h-full object-contain"
            />
          </div>
        ) : tab.isBinary ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary">
            <FileWarning className="w-8 h-8" />
            <p className="text-sm">{t('gitChanges.binaryPlaceholder')}</p>
          </div>
        ) : isMarkdown(tab.name) ? (
          <MarkdownPreview content={tab.content} style={{ fontSize }} />
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
