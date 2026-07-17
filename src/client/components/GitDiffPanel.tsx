import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Columns2, AlignLeft, AlertTriangle, FileWarning, FileX } from 'lucide-react'
import { DiffView, DiffModeEnum } from '@git-diff-view/react'
import '@git-diff-view/react/styles/diff-view.css'
import { CodeBlockContent } from './ai-elements/code-block'
import MarkdownPreview from './MarkdownPreview'
import { getLanguageFromFilename } from '../lib/language'
import { type FontSizePreset } from '../lib/font-size'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import './git-diff-panel.css'

const MIN_SIDE_BY_SIDE_WIDTH = 360

const DIFF_FONT_SIZE_PX: Record<FontSizePreset, number> = {
  small: 12,
  medium: 14,
  large: 16,
}

export interface ViewedDiff {
  path: string
  name: string
  diff: string
  isBinary: boolean
  truncated: boolean
  isUntracked: boolean
  isDeleted: boolean
  untrackedContent?: string
  error?: string
}

interface GitDiffPanelProps {
  files: ViewedDiff[]
  activeFilePath: string
  width: number
  workspacePath?: string
  uiFontSize: FontSizePreset
  onSelectFile: (path: string) => void
  onCloseFile: (path: string) => void
  onWidthChange: (width: number) => void
}

function isMarkdown(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase()
  return ext === 'md' || ext === 'markdown'
}

function useIsDarkTheme(): boolean {
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'))

  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => {
      setIsDark(root.classList.contains('dark'))
    })
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  return isDark
}

interface DiffViewerProps {
  file: ViewedDiff
  isDark: boolean
  diffMode: 'unified' | 'sideBySide'
  uiFontSize: FontSizePreset
}

function DiffViewer({ file, isDark, diffMode, uiFontSize }: DiffViewerProps) {
  const data = useMemo(
    () => ({
      oldFile: { fileName: file.name, content: '' },
      newFile: { fileName: file.name, content: '' },
      hunks: [file.diff],
    }),
    [file.name, file.diff],
  )

  return (
    <div className="h-full min-h-0">
      <DiffView
        data={data}
        diffViewMode={diffMode === 'unified' ? DiffModeEnum.Unified : DiffModeEnum.SplitGitHub}
        diffViewTheme={isDark ? 'dark' : 'light'}
        diffViewHighlight
        diffViewFontSize={DIFF_FONT_SIZE_PX[uiFontSize]}
        diffViewWrap={false}
      />
    </div>
  )
}

export default function GitDiffPanel({
  files,
  activeFilePath,
  width,
  workspacePath,
  uiFontSize,
  onSelectFile,
  onCloseFile,
  onWidthChange,
}: GitDiffPanelProps) {
  const { t } = useTranslation('common')
  const contentRef = useRef<HTMLDivElement>(null)
  const [diffMode, setDiffMode] = useState<'unified' | 'sideBySide'>('unified')
  const isDark = useIsDarkTheme()

  const activeFile = files.find((f) => f.path === activeFilePath)

  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = 0
    }
  }, [activeFilePath])

  useEffect(() => {
    if (width < MIN_SIDE_BY_SIDE_WIDTH && diffMode === 'sideBySide') {
      setDiffMode('unified')
    }
  }, [width, diffMode])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const asideEl = (e.currentTarget as HTMLElement).parentElement as HTMLElement
      const startWidth = asideEl.getBoundingClientRect().width

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const delta = moveEvent.clientX - startX
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
    [onWidthChange],
  )

  const handleToggleDiffMode = useCallback(() => {
    setDiffMode((mode) => {
      const next = mode === 'unified' ? 'sideBySide' : 'unified'
      if (next === 'sideBySide' && width < MIN_SIDE_BY_SIDE_WIDTH) {
        return 'unified'
      }
      return next
    })
  }, [width])

  const resolveAbsolutePath = (relativePath: string): string => {
    if (!workspacePath) return relativePath
    const base = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '')
    const relative = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath
    return `${base}/${relative}`
  }

  if (files.length === 0 || !activeFile) return null

  const activeAbsolutePath = resolveAbsolutePath(activeFile.path)

  return (
    <aside
      className="relative bg-surface border-l border-border flex flex-col flex-shrink-0"
      style={{ width, maxWidth: '70%' }}
      data-testid="git-diff-panel"
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
          <span
            className="text-sm text-text-primary font-mono truncate"
            title={activeAbsolutePath}
          >
            {activeFile.path}
          </span>
        </div>

        {!activeFile.isUntracked && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleToggleDiffMode}
                className="p-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
                aria-label={
                  diffMode === 'unified'
                    ? t('gitChanges.diffModeSideBySide')
                    : t('gitChanges.diffModeUnified')
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
                ? t('gitChanges.diffModeSideBySide')
                : t('gitChanges.diffModeUnified')}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Content */}
      <div ref={contentRef} className="git-diff-panel-content flex-1 overflow-auto p-2 min-h-0">
        {activeFile.error ? (
          <div className="flex flex-col gap-2 text-destructive text-sm">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" />
              <span>{t('gitChanges.errorGeneric')}</span>
            </div>
            <p className="text-xs opacity-80">{activeFile.error}</p>
          </div>
        ) : activeFile.isUntracked ? (
          renderUntracked(activeFile)
        ) : activeFile.isBinary ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary">
            <FileWarning className="w-8 h-8" />
            <p className="text-sm">{t('gitChanges.binaryPlaceholder')}</p>
          </div>
        ) : activeFile.isDeleted ? (
          <div className="space-y-2 h-full">
            <div className="flex items-center gap-2 text-xs text-destructive">
              <FileX className="w-3.5 h-3.5" />
              <span>{t('gitChanges.deletedFileHeader')}</span>
            </div>
            <DiffViewer file={activeFile} isDark={isDark} diffMode={diffMode} uiFontSize={uiFontSize} />
          </div>
        ) : activeFile.truncated ? (
          <div className="space-y-2 h-full">
            <div className="flex items-center gap-2 text-xs text-warning">
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>{t('gitChanges.truncatedPlaceholder')}</span>
            </div>
            <DiffViewer file={activeFile} isDark={isDark} diffMode={diffMode} uiFontSize={uiFontSize} />
          </div>
        ) : (
          <DiffViewer file={activeFile} isDark={isDark} diffMode={diffMode} uiFontSize={uiFontSize} />
        )}
      </div>
    </aside>
  )
}

function renderUntracked(file: ViewedDiff) {
  const content = file.untrackedContent ?? ''
  if (isMarkdown(file.name)) {
    return <MarkdownPreview content={content} />
  }
  return (
    <CodeBlockContent
      code={content}
      language={getLanguageFromFilename(file.name)}
      showLineNumbers={false}
      className="!p-0 text-sm"
    />
  )
}
