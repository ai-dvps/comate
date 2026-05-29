import { useCallback } from 'react'
import { X, Copy } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CodeBlockContent } from './ai-elements/code-block'
import MarkdownPreview from './MarkdownPreview'
import { getLanguageFromFilename } from '../lib/language'

function isMarkdown(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase()
  return ext === 'md' || ext === 'markdown'
}

export interface ViewedFile {
  path: string
  name: string
  content: string
}

interface FilePanelProps {
  files: ViewedFile[]
  activeFilePath: string
  width: number
  onSelectFile: (path: string) => void
  onCloseFile: (path: string) => void
  onWidthChange: (width: number) => void
  onCopy: () => void
}

export default function FilePanel({
  files,
  activeFilePath,
  width,
  onSelectFile,
  onCloseFile,
  onWidthChange,
  onCopy,
}: FilePanelProps) {
  const { t } = useTranslation('common')

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = width

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const delta = startX - moveEvent.clientX
        onWidthChange(startWidth + delta)
      }

      const handleMouseUp = () => {
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        document.body.style.userSelect = ''
        document.body.style.cursor = ''
      }

      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [width, onWidthChange]
  )

  const activeFile = files.find((f) => f.path === activeFilePath)

  if (files.length === 0 || !activeFile) return null

  return (
    <aside
      className="relative bg-surface border-r border-border flex flex-col flex-shrink-0"
      style={{ width }}
    >
      {/* Resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent/50 transition-colors z-10"
        onMouseDown={handleMouseDown}
      />

      {/* Tab bar */}
      <div className="flex items-center gap-1 overflow-x-auto scrollbar-hide flex-shrink-0 px-2 py-2 border-b border-border/50">
        {files.map((file) => {
          const isActive = file.path === activeFilePath
          return (
            <div
              key={file.path}
              className={`group flex items-center gap-1.5 px-3 py-1.5 rounded-lg cursor-pointer text-xs transition-all whitespace-nowrap flex-shrink-0 ${
                isActive
                  ? 'bg-surface-hover text-text-primary'
                  : 'text-text-tertiary hover:text-text-secondary hover:bg-surface-hover'
              }`}
              onClick={() => onSelectFile(file.path)}
            >
              <span className="truncate max-w-[120px]">{file.name}</span>
              <button
                className={`ml-0.5 p-0.5 rounded hover:bg-surface-hover hover:text-destructive transition-all ${
                  isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                }`}
                onClick={(e) => {
                  e.stopPropagation()
                  onCloseFile(file.path)
                }}
                title={t('close')}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )
        })}
      </div>

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border/50 flex-shrink-0">
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
          <span className="text-sm text-text-primary font-mono truncate">
            {activeFile.name}
          </span>
        </div>
        <button
          onClick={onCopy}
          className="px-2 py-1.5 rounded-md text-xs text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
          title={t('copyContent')}
        >
          <Copy className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {isMarkdown(activeFile.name) ? (
          <MarkdownPreview content={activeFile.content} />
        ) : (
          <CodeBlockContent
            code={activeFile.content}
            language={getLanguageFromFilename(activeFile.name)}
            showLineNumbers={true}
            className="!p-0"
          />
        )}
      </div>
    </aside>
  )
}
