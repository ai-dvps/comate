import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  ChevronRight,
  File,
  FilePenLine,
  Folder,
  FolderOpen,
  GitBranch,
  List,
  ListTree,
  HelpCircle,
  RefreshCw,
} from 'lucide-react'
import { useWorkspaceStore } from '../stores/workspace-store'
import { useGitChangesStore, useGitChanges, type GitStatusItem } from '../stores/git-changes-store'
import { useRightPanelStore } from '../stores/right-panel-store'
import { cn } from './ui/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { isUntrackedFile, getStatusBadgeClass } from '../lib/git-status-helpers'

interface TreeNode {
  name: string
  path: string
  type: 'folder' | 'file'
  file?: GitStatusItem
  children: TreeNode[]
}

interface FileSide {
  staged: boolean
  statusCode: string
  /** True when the file has both staged and unstaged changes (render a label). */
  both: boolean
}

/**
 * Expand a status entry into one or two viewable sides. A file with changes in
 * both the index and the working tree (e.g. `MM`, `AM`) yields two entries so
 * the user can review the staged diff AND the unstaged diff independently; the
 * previous single-entry model made the unstaged half unreachable.
 */
function buildFileSides(file: GitStatusItem): FileSide[] {
  if (isUntrackedFile(file)) {
    return [{ staged: false, statusCode: '?', both: false }]
  }
  const hasStaged = file.indexStatus !== ' ' && file.indexStatus !== '?' && file.indexStatus !== ''
  const hasUnstaged =
    file.workingTreeStatus !== ' ' && file.workingTreeStatus !== '?' && file.workingTreeStatus !== ''
  const both = hasStaged && hasUnstaged
  const sides: FileSide[] = []
  if (hasStaged) sides.push({ staged: true, statusCode: file.indexStatus, both })
  if (hasUnstaged) sides.push({ staged: false, statusCode: file.workingTreeStatus, both })
  if (sides.length === 0) {
    sides.push({ staged: false, statusCode: file.indexStatus || '?', both: false })
  }
  return sides
}

function insertIntoTree(nodes: TreeNode[], item: GitStatusItem, parts: string[], depth = 0): void {
  const name = parts[depth]
  if (depth === parts.length - 1) {
    nodes.push({ name, path: item.path, type: 'file', file: item, children: [] })
    return
  }
  let folder = nodes.find((n) => n.type === 'folder' && n.name === name)
  if (!folder) {
    folder = {
      name,
      path: parts.slice(0, depth + 1).join('/'),
      type: 'folder',
      children: [],
    }
    nodes.push(folder)
  }
  insertIntoTree(folder.children, item, parts, depth + 1)
}

function sortTree(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name)
    return a.type === 'folder' ? -1 : 1
  })
  for (const node of nodes) {
    if (node.type === 'folder') sortTree(node.children)
  }
}

function buildTree(items: GitStatusItem[]): TreeNode[] {
  const nodes: TreeNode[] = []
  for (const item of items) {
    const parts = item.path.split('/')
    insertIntoTree(nodes, item, parts)
  }
  sortTree(nodes)
  return nodes
}

function getVisibleNodePaths(nodes: TreeNode[], expanded: Set<string>): string[] {
  const result: string[] = []
  for (const node of nodes) {
    result.push(node.path)
    if (node.type === 'folder' && expanded.has(node.path)) {
      result.push(...getVisibleNodePaths(node.children, expanded))
    }
  }
  return result
}

export default function GitChangesPanel() {
  const { t } = useTranslation('common')
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const { setPanelVisible, setActiveWorkspaceId, refresh, setViewMode } =
    useGitChangesStore.getState()
  const {
    statusItems,
    statusLoading,
    statusError,
    viewMode,
    isWatcherAvailable,
  } = useGitChanges(activeWorkspaceId)
  const [highlightedPath, setHighlightedPath] = useState<string | null>(null)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set())

  // Subscription lifecycle lives here. RightPanel keeps this component mounted
  // (CSS-toggling visibility) for the whole time the right panel is expanded,
  // so switching the inner Files/Git-Changes tab no longer tears down and
  // recreates the watcher (and its .gitignore crawl) on every toggle.
  useEffect(() => {
    setPanelVisible(true)
    return () => {
      setPanelVisible(false)
    }
  }, [setPanelVisible])

  useEffect(() => {
    setActiveWorkspaceId(activeWorkspaceId)
  }, [activeWorkspaceId, setActiveWorkspaceId])

  useEffect(() => {
    setHighlightedPath(null)
    setExpandedPaths(() => {
      const next = new Set<string>()
      for (const item of statusItems) {
        const parts = item.path.split('/')
        if (parts.length > 1) {
          next.add(parts[0] as string)
        }
      }
      return next
    })
  }, [statusItems])

  const trackedItems = useMemo(
    () => statusItems.filter((item) => !isUntrackedFile(item)),
    [statusItems],
  )
  const untrackedItems = useMemo(
    () => statusItems.filter((item) => isUntrackedFile(item)),
    [statusItems],
  )
  const tree = useMemo(() => buildTree(trackedItems), [trackedItems])
  const untrackedTree = useMemo(() => buildTree(untrackedItems), [untrackedItems])

  const handleRefresh = useCallback(() => {
    if (!activeWorkspaceId) return
    void refresh(activeWorkspaceId)
  }, [activeWorkspaceId, refresh])

  const handleOpenFile = useCallback(
    (file: GitStatusItem, staged: boolean) => {
      if (!activeWorkspaceId) return
      useRightPanelStore
        .getState()
        .openDiff(activeWorkspaceId, file, staged)
        .catch((err) => {
          console.error('[GitChangesPanel] failed to open diff:', err)
        })
    },
    [activeWorkspaceId],
  )

  const handleSelect = useCallback((path: string) => {
    setHighlightedPath(path)
  }, [])

  const handleToggleExpand = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const handleTreeKeyDown = useCallback(
    (e: React.KeyboardEvent, nodes: TreeNode[]) => {
      const visiblePaths = getVisibleNodePaths(nodes, expandedPaths)
      const current = highlightedPath ?? visiblePaths[0]
      if (!current) return

      const idx = visiblePaths.indexOf(current)
      if (idx < 0) return

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        const next = visiblePaths[Math.min(idx + 1, visiblePaths.length - 1)]
        if (next) setHighlightedPath(next)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        const next = visiblePaths[Math.max(idx - 1, 0)]
        if (next) setHighlightedPath(next)
      } else if (e.key === 'ArrowRight') {
        const node = findNode(nodes, current)
        if (node?.type === 'folder' && !expandedPaths.has(current)) {
          e.preventDefault()
          handleToggleExpand(current)
        }
      } else if (e.key === 'ArrowLeft') {
        const node = findNode(nodes, current)
        if (node?.type === 'folder' && expandedPaths.has(current)) {
          e.preventDefault()
          handleToggleExpand(current)
        }
      } else if (e.key === 'Enter') {
        const node = findNode(nodes, current)
        if (!node) return
        e.preventDefault()
        if (node.type === 'folder') {
          handleToggleExpand(current)
        } else if (node.file) {
          const firstSide = buildFileSides(node.file)[0]
          if (firstSide) handleOpenFile(node.file, firstSide.staged)
        }
      }
    },
    [expandedPaths, highlightedPath, handleToggleExpand, handleOpenFile],
  )

  const allTreeNodes = useMemo(
    () => [...untrackedTree, ...tree],
    [untrackedTree, tree],
  )

  return (
    <div
      data-testid="git-changes-panel"
      className="flex flex-col h-full outline-none"
    >
      <div className="flex items-center justify-end px-3 py-1 border-b border-border/50 flex-shrink-0 gap-2">
        <div className="flex items-center gap-1 flex-shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                data-testid="git-tree-view-button"
                onClick={() => activeWorkspaceId && setViewMode(activeWorkspaceId, 'tree')}
                className={cn(
                  'h-6 w-6 flex items-center justify-center rounded-md transition-colors',
                  viewMode === 'tree'
                    ? 'text-text-primary bg-accent/10'
                    : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover',
                )}
                aria-label={t('gitChanges.viewModeTree')}
              >
                <ListTree className="w-3.5 h-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('gitChanges.viewModeTree')}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                data-testid="git-flat-view-button"
                onClick={() => activeWorkspaceId && setViewMode(activeWorkspaceId, 'flat')}
                className={cn(
                  'h-6 w-6 flex items-center justify-center rounded-md transition-colors',
                  viewMode === 'flat'
                    ? 'text-text-primary bg-accent/10'
                    : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover',
                )}
                aria-label={t('gitChanges.viewModeFlat')}
              >
                <List className="w-3.5 h-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('gitChanges.viewModeFlat')}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                data-testid="git-refresh-button"
                onClick={handleRefresh}
                disabled={statusLoading}
                className={cn(
                  'h-6 w-6 flex items-center justify-center rounded-md transition-colors',
                  statusLoading
                    ? 'text-text-tertiary'
                    : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover',
                )}
                aria-label={t('gitChanges.refresh')}
              >
                <RefreshCw className={cn('w-3.5 h-3.5', statusLoading && 'animate-spin')} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('gitChanges.refresh')}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {!isWatcherAvailable && (
        <div className="px-3 py-1.5 text-xs bg-warning/10 text-warning flex items-center gap-1.5 flex-shrink-0">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="truncate">{t('gitChanges.watcherUnavailable')}</span>
        </div>
      )}

      {statusError && (
        <div className="px-3 py-2 text-xs text-destructive flex-shrink-0">
          {t('gitChanges.refreshError')}: {statusError}
        </div>
      )}

      <div
        className="flex-1 overflow-y-auto"
        role="tree"
        aria-label={t('gitChanges.panelTitle')}
        onKeyDown={(e) => viewMode === 'tree' && handleTreeKeyDown(e, allTreeNodes)}
        tabIndex={0}
      >
          {statusLoading && statusItems.length === 0 && renderSkeleton()}

          {!statusLoading && statusItems.length === 0 && (
            <div
              data-testid="git-empty-state"
              className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary px-4"
            >
              <GitBranch className="w-8 h-8" />
              <p className="text-sm text-center">{t('gitChanges.emptyState')}</p>
            </div>
          )}

          {trackedItems.length > 0 && (
            <div data-testid="git-changed-tree" className="py-1">
              <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-hover/60 border-b border-border/50 text-[11px] font-semibold text-text-secondary uppercase tracking-wider">
                <FilePenLine className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
                {t('gitChanges.statusModified')}
                <span className="ml-auto text-text-tertiary normal-case">
                  {trackedItems.length}
                </span>
              </div>
              {viewMode === 'tree' ? (
                tree.map((node) => (
                  <TreeNodeView
                    key={node.path}
                    node={node}
                    level={0}
                    expandedPaths={expandedPaths}
                    highlightedPath={highlightedPath}
                    onToggleExpand={handleToggleExpand}
                    onSelect={handleSelect}
                    onOpen={handleOpenFile}
                  />
                ))
              ) : (
                trackedItems.flatMap((file) =>
                  buildFileSides(file).map((side) => (
                    <FileRow
                      key={`${file.path}:${side.staged ? 's' : 'w'}`}
                      file={file}
                      staged={side.staged}
                      statusCode={side.statusCode}
                      showSide={side.both}
                      path={file.path}
                      isHighlighted={highlightedPath === file.path}
                      onSelect={() => handleSelect(file.path)}
                      onOpen={() => handleOpenFile(file, side.staged)}
                    />
                  )),
                )
              )}
            </div>
          )}

          {untrackedItems.length > 0 && (
            <div
              data-testid="git-untracked-group"
              className={cn('py-1', trackedItems.length > 0 && 'border-t border-border/50')}
            >
              <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-hover/60 border-b border-border/50 text-[11px] font-semibold text-text-secondary uppercase tracking-wider">
                <HelpCircle className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
                {t('gitChanges.statusUntracked')}
                <span className="ml-auto text-text-tertiary normal-case">
                  {untrackedItems.length}
                </span>
              </div>
              {viewMode === 'tree' ? (
                untrackedTree.map((node) => (
                  <TreeNodeView
                    key={node.path}
                    node={node}
                    level={0}
                    expandedPaths={expandedPaths}
                    highlightedPath={highlightedPath}
                    onToggleExpand={handleToggleExpand}
                    onSelect={handleSelect}
                    onOpen={handleOpenFile}
                  />
                ))
              ) : (
                untrackedItems.map((file) => (
                  <FileRow
                    key={file.path}
                    file={file}
                    staged={false}
                    statusCode="?"
                    path={file.path}
                    isHighlighted={highlightedPath === file.path}
                    onSelect={() => handleSelect(file.path)}
                    onOpen={() => handleOpenFile(file, false)}
                  />
                ))
              )}
            </div>
          )}
        </div>
    </div>
  )
}

function renderSkeleton() {
  return (
    <div className="space-y-1.5 p-3 animate-pulse">
      <div className="h-3 bg-surface-hover rounded w-3/4" />
      <div className="h-3 bg-surface-hover rounded w-1/2" />
      <div className="h-3 bg-surface-hover rounded w-5/6" />
      <div className="h-3 bg-surface-hover rounded w-2/3" />
    </div>
  )
}

interface FileRowProps {
  file: GitStatusItem
  staged: boolean
  statusCode: string
  showSide?: boolean
  path: string
  name?: string
  level?: number
  showFileIcon?: boolean
  isHighlighted: boolean
  onSelect: () => void
  onOpen: () => void
}

function FileRow({
  file,
  staged,
  statusCode,
  showSide,
  path,
  name,
  level,
  showFileIcon,
  isHighlighted,
  onSelect,
  onOpen,
}: FileRowProps) {
  const { t } = useTranslation('common')
  const displayName = name ?? path
  const untracked = isUntrackedFile(file)
  return (
    <div
      data-testid="git-file-row"
      role="treeitem"
      aria-selected={isHighlighted}
      className={cn(
        'flex items-center gap-2 py-1 px-3 text-xs cursor-pointer select-none',
        isHighlighted ? 'bg-accent/10 text-text-primary' : 'hover:bg-surface-hover text-text-secondary',
      )}
      style={level !== undefined ? { paddingLeft: `${24 + level * 12}px` } : undefined}
      onClick={onSelect}
      onDoubleClick={onOpen}
    >
      <span
        className={cn(
          'flex items-center justify-center flex-shrink-0 w-5 h-4 text-[10px] font-mono font-medium',
          untracked ? 'text-text-secondary' : cn('rounded', getStatusBadgeClass(statusCode)),
        )}
        title={untracked ? t('gitChanges.statusUntracked') : statusCode}
      >
        {untracked ? (
          <HelpCircle className="w-3 h-3" />
        ) : (
          statusCode
        )}
      </span>
      {showFileIcon && (
        <File className="w-3.5 h-3.5 text-text-tertiary flex-shrink-0" aria-hidden="true" />
      )}
      <span className="truncate font-mono min-w-0" title={path}>
        {displayName}
        {showSide && (
          <span className="ml-1 text-text-tertiary text-[10px] font-sans">
            {staged ? t('gitChanges.staged') : t('gitChanges.workingTree')}
          </span>
        )}
      </span>
    </div>
  )
}

interface TreeNodeViewProps {
  node: TreeNode
  level: number
  expandedPaths: Set<string>
  highlightedPath: string | null
  onToggleExpand: (path: string) => void
  onSelect: (path: string) => void
  onOpen: (file: GitStatusItem, staged: boolean) => void
}

function TreeNodeView({
  node,
  level,
  expandedPaths,
  highlightedPath,
  onToggleExpand,
  onSelect,
  onOpen,
}: TreeNodeViewProps) {
  const { t } = useTranslation('common')
  const isExpanded = expandedPaths.has(node.path)
  const isHighlighted = highlightedPath === node.path

  if (node.type === 'folder') {
    return (
      <div role="treeitem" aria-expanded={isExpanded}>
        <div
          className={cn(
            'group flex items-center gap-1.5 py-1 px-3 text-xs cursor-pointer select-none',
            isHighlighted ? 'bg-accent/10 text-text-primary' : 'hover:bg-surface-hover text-text-secondary',
          )}
          style={{ paddingLeft: `${12 + level * 12}px` }}
          onClick={() => onSelect(node.path)}
          onDoubleClick={() => onToggleExpand(node.path)}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onToggleExpand(node.path)
            }}
            className="flex-shrink-0 p-0.5 rounded hover:bg-surface-hover transition-colors"
            aria-label={isExpanded ? t('gitChanges.collapseFolder') : t('gitChanges.expandFolder')}
          >
            <ChevronRight
              className={cn(
                'w-3.5 h-3.5 text-text-tertiary transition-transform duration-150',
                isExpanded && 'rotate-90',
              )}
              aria-hidden="true"
            />
          </button>
          {isExpanded ? (
            <FolderOpen className="w-3.5 h-3.5 text-yellow-600 flex-shrink-0" aria-hidden="true" />
          ) : (
            <Folder className="w-3.5 h-3.5 text-yellow-600 flex-shrink-0" aria-hidden="true" />
          )}
          <span className="truncate">{node.name}</span>
        </div>
        {isExpanded && (
          <div role="group">
            {node.children.length === 0 ? (
              <div
                className="py-1 px-3 text-[11px] text-text-tertiary"
                style={{ paddingLeft: `${24 + level * 12}px` }}
              >
                {t('emptyFolder')}
              </div>
            ) : (
              node.children.map((child) => (
                <TreeNodeView
                  key={child.path}
                  node={child}
                  level={level + 1}
                  expandedPaths={expandedPaths}
                  highlightedPath={highlightedPath}
                  onToggleExpand={onToggleExpand}
                  onSelect={onSelect}
                  onOpen={onOpen}
                />
              ))
            )}
          </div>
        )}
      </div>
    )
  }

  const file = node.file ?? { path: node.path, indexStatus: '?', workingTreeStatus: '?' }
  const sides = buildFileSides(file)
  return (
    <>
      {sides.map((side) => (
        <FileRow
          key={`${node.path}:${side.staged ? 's' : 'w'}`}
          file={file}
          staged={side.staged}
          statusCode={side.statusCode}
          showSide={side.both}
          path={node.path}
          name={node.name}
          level={level}
          showFileIcon
          isHighlighted={isHighlighted}
          onSelect={() => onSelect(node.path)}
          onOpen={() => onOpen(file, side.staged)}
        />
      ))}
    </>
  )
}

function findNode(nodes: TreeNode[], path: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node
    if (node.type === 'folder') {
      const found = findNode(node.children, path)
      if (found) return found
    }
  }
  return undefined
}
