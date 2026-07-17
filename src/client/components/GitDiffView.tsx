import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  ArrowLeft,
  AlignLeft,
  Columns2,
  FileWarning,
  FileX,
} from 'lucide-react'
import { CodeBlockContent } from './ai-elements/code-block'
import MarkdownPreview from './MarkdownPreview'
import { getLanguageFromFilename } from '../lib/language'
import { useGitChanges } from '../stores/git-changes-store'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

const MIN_SIDE_BY_SIDE_WIDTH = 360

interface GitDiffViewProps {
  workspaceId: string
  panelWidth: number
  onBack: () => void
}

function isMarkdown(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase()
  return ext === 'md' || ext === 'markdown'
}

function isUntrackedFile(file: { indexStatus: string; workingTreeStatus: string }): boolean {
  return file.indexStatus === '?' && file.workingTreeStatus === '?'
}

function isDeletedFile(file: { indexStatus: string; workingTreeStatus: string }): boolean {
  return file.indexStatus === 'D' || file.workingTreeStatus === 'D'
}

function getFileName(path: string): string {
  return path.split('/').pop() || path
}

function splitDiffForSideBySide(diff: string): { removed: string; added: string } {
  const lines = diff.split('\n')
  const removedLines: string[] = []
  const addedLines: string[] = []

  for (const line of lines) {
    if (line.startsWith('-')) {
      removedLines.push(line)
      addedLines.push('')
    } else if (line.startsWith('+')) {
      removedLines.push('')
      addedLines.push(line)
    } else {
      removedLines.push(line)
      addedLines.push(line)
    }
  }

  return {
    removed: removedLines.join('\n'),
    added: addedLines.join('\n'),
  }
}

export default function GitDiffView({ workspaceId, panelWidth, onBack }: GitDiffViewProps) {
  const { t } = useTranslation('common')
  const { selectedFile, diffContent, diffLoading, diffError } = useGitChanges(workspaceId)
  const [diffMode, setDiffMode] = useState<'unified' | 'sideBySide'>('unified')
  const [untrackedContent, setUntrackedContent] = useState<string | null>(null)
  const [untrackedLoading, setUntrackedLoading] = useState(false)
  const [untrackedError, setUntrackedError] = useState<string | null>(null)
  const backButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (panelWidth < MIN_SIDE_BY_SIDE_WIDTH && diffMode === 'sideBySide') {
      setDiffMode('unified')
    }
  }, [panelWidth, diffMode])

  useEffect(() => {
    backButtonRef.current?.focus()
  }, [selectedFile?.path])

  useEffect(() => {
    if (!selectedFile || !isUntrackedFile(selectedFile)) {
      setUntrackedContent(null)
      setUntrackedError(null)
      return
    }

    let cancelled = false
    setUntrackedLoading(true)
    setUntrackedError(null)

    fetch(`/api/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(selectedFile.path)}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: t('common:requestFailed') }))
          throw new Error(body.error || `HTTP ${res.status}`)
        }
        const data = (await res.json()) as { content?: string; isBinary?: boolean }
        if (cancelled) return
        setUntrackedContent(typeof data.content === 'string' ? data.content : '')
      })
      .catch((err) => {
        if (cancelled) return
        setUntrackedError(err instanceof Error ? err.message : t('gitChanges.errorGeneric'))
      })
      .finally(() => {
        if (!cancelled) setUntrackedLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [selectedFile, workspaceId, t])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onBack()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onBack])

  const handleToggleDiffMode = useCallback(() => {
    setDiffMode((mode) => {
      const next = mode === 'unified' ? 'sideBySide' : 'unified'
      if (next === 'sideBySide' && panelWidth < MIN_SIDE_BY_SIDE_WIDTH) {
        return 'unified'
      }
      return next
    })
  }, [panelWidth])

  const fileName = selectedFile ? getFileName(selectedFile.path) : ''

  const sideBySide = useMemo(() => {
    if (!diffContent) return { removed: '', added: '' }
    return splitDiffForSideBySide(diffContent.diff)
  }, [diffContent])

  if (!selectedFile) return null

  const untracked = isUntrackedFile(selectedFile)
  const deleted = isDeletedFile(selectedFile)

  return (
    <div className="flex flex-col flex-1 overflow-hidden" data-testid="git-diff-view">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/50 flex-shrink-0 gap-2">
        <button
          ref={backButtonRef}
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
          aria-label={t('gitChanges.back')}
        >
          <ArrowLeft className="w-4 h-4" />
          <span className="truncate max-w-[180px] font-mono" title={selectedFile.path}>
            {selectedFile.path}
          </span>
        </button>

        {!untracked && (
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

      <div className="flex-1 overflow-auto p-2">
        {untracked ? (
          untrackedLoading ? (
            renderSkeleton()
          ) : untrackedError ? (
            <div className="text-xs text-destructive">{untrackedError}</div>
          ) : (
            renderContent(untrackedContent ?? '', fileName)
          )
        ) : diffLoading ? (
          renderSkeleton()
        ) : diffError ? (
          <div className="flex flex-col gap-2 text-destructive text-sm">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" />
              <span>{t('gitChanges.errorGeneric')}</span>
            </div>
            <p className="text-xs opacity-80">{diffError}</p>
          </div>
        ) : !diffContent ? (
          renderSkeleton()
        ) : diffContent.isBinary ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary">
            <FileWarning className="w-8 h-8" />
            <p className="text-sm">{t('gitChanges.binaryPlaceholder')}</p>
          </div>
        ) : deleted ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-destructive">
              <FileX className="w-3.5 h-3.5" />
              <span>{t('gitChanges.deletedFileHeader')}</span>
            </div>
            <CodeBlockContent
              code={diffContent.diff}
              language="diff"
              showLineNumbers={false}
              className="!p-0 text-sm"
            />
          </div>
        ) : diffContent.truncated ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-warning">
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>{t('gitChanges.truncatedPlaceholder')}</span>
            </div>
            {diffMode === 'sideBySide' ? (
              renderSideBySide(sideBySide)
            ) : (
              <CodeBlockContent
                code={diffContent.diff}
                language="diff"
                showLineNumbers={false}
                className="!p-0 text-sm"
              />
            )}
          </div>
        ) : diffMode === 'sideBySide' ? (
          renderSideBySide(sideBySide)
        ) : (
          <CodeBlockContent
            code={diffContent.diff}
            language="diff"
            showLineNumbers={false}
            className="!p-0 text-sm"
          />
        )}
      </div>
    </div>
  )
}

function renderSkeleton() {
  return (
    <div className="space-y-2 animate-pulse">
      <div className="h-3 bg-surface-hover rounded w-3/4" />
      <div className="h-3 bg-surface-hover rounded w-1/2" />
      <div className="h-3 bg-surface-hover rounded w-5/6" />
      <div className="h-3 bg-surface-hover rounded w-2/3" />
    </div>
  )
}

function renderContent(content: string, fileName: string) {
  if (isMarkdown(fileName)) {
    return <MarkdownPreview content={content} />
  }
  return (
    <CodeBlockContent
      code={content}
      language={getLanguageFromFilename(fileName)}
      showLineNumbers={false}
      className="!p-0 text-sm"
    />
  )
}

function renderSideBySide(sideBySide: { removed: string; added: string }) {
  return (
    <div className="grid grid-cols-2 divide-x divide-border border border-border rounded-md overflow-hidden">
      <div className="overflow-auto">
        <CodeBlockContent
          code={sideBySide.removed}
          language="diff"
          showLineNumbers={false}
          className="!p-0 text-sm"
        />
      </div>
      <div className="overflow-auto">
        <CodeBlockContent
          code={sideBySide.added}
          language="diff"
          showLineNumbers={false}
          className="!p-0 text-sm"
        />
      </div>
    </div>
  )
}
