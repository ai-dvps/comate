import { useTranslation } from 'react-i18next'
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { ChevronDown, ChevronUp, FileDiff, SquareArrowOutUpRight } from 'lucide-react'

import { useChatStore, type TouchedFileEntry } from '../stores/chat-store'
import { useWorkspaceStore } from '../stores/workspace-store'
import { useChangedFilesExistence } from '../hooks/use-changed-files-existence'
import { useAppSettings } from '../hooks/use-app-settings'
import { getStatusBadgeClass } from '../lib/git-status-helpers'
import { useToolRendererContext } from './tool-renderers/use-tool-renderer-context'
import { basename, getRelativePath } from './tool-renderers/path-utils'
import { cn } from './ui/utils'

const EMPTY_ARRAY: TouchedFileEntry[] = []

interface ChangedFilesPanelProps {
  sessionId: string
}

interface ChangedFileRowData {
  absolutePath: string
  relativePath: string
  /** Directory portion of the relative path, rendered dimmed (e.g. "src/"). */
  directory: string
  fileName: string
  status: TouchedFileEntry['status']
}

type EffectiveStatus = 'created' | 'modified' | 'deleted'

const STATUS_BADGE_CODE: Record<EffectiveStatus, string> = {
  created: 'A',
  modified: 'M',
  deleted: 'D',
}

const STATUS_LABEL_KEY: Record<EffectiveStatus, string> = {
  created: 'changedFilesStatusCreated',
  modified: 'changedFilesStatusModified',
  deleted: 'changedFilesStatusDeleted',
}

interface ChangedFileRowProps {
  row: ChangedFileRowData
  effectiveStatus: EffectiveStatus
  onOpen: () => void
}

function ChangedFileRow({ row, effectiveStatus, onOpen }: ChangedFileRowProps) {
  const { t } = useTranslation('chat')
  const deleted = effectiveStatus === 'deleted'
  const badgeCode = STATUS_BADGE_CODE[effectiveStatus]
  const openLabel = t('changedFilesOpen', { name: row.fileName })

  return (
    <li className="flex items-center gap-2 py-1 px-1 rounded-md">
      <span
        className={cn(
          'flex items-center justify-center shrink-0 w-5 h-4 text-[10px] font-mono font-medium rounded',
          getStatusBadgeClass(badgeCode),
        )}
        title={t(STATUS_LABEL_KEY[effectiveStatus])}
      >
        {badgeCode}
      </span>
      <span
        className={cn(
          'truncate font-mono min-w-0 flex-1',
          deleted ? 'text-text-tertiary line-through' : 'text-text-primary',
        )}
        title={row.absolutePath}
      >
        {row.directory && <span className="text-text-tertiary">{row.directory}</span>}
        {row.fileName}
      </span>
      <button
        type="button"
        onClick={onOpen}
        disabled={deleted}
        aria-label={openLabel}
        title={openLabel}
        className="inline-flex items-center justify-center p-0.5 rounded shrink-0 text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-text-tertiary"
      >
        <SquareArrowOutUpRight className="size-3.5" aria-hidden="true" />
      </button>
    </li>
  )
}

export default function ChangedFilesPanel({ sessionId }: ChangedFilesPanelProps) {
  const { t } = useTranslation('chat')
  const entries = useChatStore((s) => s.touchedFiles[sessionId] ?? EMPTY_ARRAY)
  const activeWorkspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId),
  )
  const { onOpenFile } = useToolRendererContext()
  const { chatFontSize } = useAppSettings()
  const [expanded, setExpanded] = useState(true)

  const folderPath = activeWorkspace?.folderPath ?? ''

  // KTD6: workspace membership is judged here, at the panel layer — entries are
  // stored as normalized absolute paths and out-of-workspace paths are dropped.
  const rows = useMemo<ChangedFileRowData[]>(() => {
    if (!folderPath) return []
    const result: ChangedFileRowData[] = []
    for (const entry of entries) {
      const relativePath = getRelativePath(entry.path, folderPath)
      if (relativePath === null || relativePath === '.') continue
      const fileName = basename(relativePath)
      result.push({
        absolutePath: entry.path,
        relativePath,
        directory: relativePath.slice(0, relativePath.length - fileName.length),
        fileName,
        status: entry.status,
      })
    }
    return result
  }, [entries, folderPath])

  const absolutePaths = useMemo(() => rows.map((row) => row.absolutePath), [rows])

  // KTD4: deletion overlay — files missing on disk override to deleted.
  const missing = useChangedFilesExistence({
    workspaceId: activeWorkspace?.id ?? '',
    folderPath,
    paths: absolutePaths,
    enabled: expanded,
  })

  const toggle = useCallback(() => setExpanded((e) => !e), [])

  // Reset the collapse state on session switch (R3); the default is expanded.
  useEffect(() => {
    setExpanded(true)
  }, [sessionId])

  // Auto-expand when the session's first entry lands so file names surface at
  // a glance even if the card was previously collapsed and hidden.
  const hasRows = rows.length > 0
  const hadRowsRef = useRef(false)
  useEffect(() => {
    if (hasRows && !hadRowsRef.current) setExpanded(true)
    hadRowsRef.current = hasRows
  }, [hasRows])

  if (rows.length === 0) return null

  return (
    <div className="pointer-events-auto rounded-lg border border-border bg-surface p-3 shadow-lg max-w-xs">
      <button
        onClick={toggle}
        className="w-full flex items-center gap-2 hover:bg-surface-hover transition-colors rounded-md p-1 -m-1"
        aria-label={t('changedFilesTitle')}
      >
        <FileDiff className="size-4 text-text-tertiary shrink-0" />
        <span className="text-xs font-medium text-text-secondary shrink-0">
          {t('changedFilesTitle')}
        </span>
        <span className="flex-1 text-left text-xs text-text-tertiary">
          {rows.length}
        </span>
        {expanded ? (
          <ChevronUp className="size-3.5 text-text-tertiary shrink-0" />
        ) : (
          <ChevronDown className="size-3.5 text-text-tertiary shrink-0" />
        )}
      </button>

      {expanded && (
        <div
          className="mt-2 max-h-64 overflow-y-auto"
          style={{ fontSize: chatFontSize }}
        >
          <ul className="py-1">
            {rows.map((row) => {
              const effectiveStatus: EffectiveStatus = missing.has(row.absolutePath)
                ? 'deleted'
                : row.status
              return (
                <ChangedFileRow
                  key={row.absolutePath}
                  row={row}
                  effectiveStatus={effectiveStatus}
                  onOpen={() => onOpenFile(row.relativePath, row.fileName)}
                />
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
