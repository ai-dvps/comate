import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useWorkspaceStore } from '../stores/workspace-store'
import { useFiles } from '../stores/files-store'
import { revealInFileManager } from '../lib/desktop-api'
import { ChevronRight, Folder, Loader2, RefreshCw, X } from 'lucide-react'
import { cn } from './ui/utils'
import { getFileIcon } from '../lib/file-helpers'

interface FileNode {
  name: string
  type: 'file' | 'folder'
  children?: FileNode[]
}

interface TreeNodeProps {
  node: FileNode
  path: string
  workspaceId: string
  selectedPath?: string
  onSelectPath?: (path: string) => void
  onFilePreview?: (path: string, name: string) => void
  onFileOpen: (path: string, name: string) => void
  onContextMenu?: (e: React.MouseEvent, nodePath: string, nodeType: 'file' | 'folder') => void
  refreshToken: number
  level: number
}

function TreeNode({
  node,
  path,
  workspaceId,
  selectedPath,
  onSelectPath,
  onFilePreview,
  onFileOpen,
  onContextMenu,
  refreshToken,
  level,
}: TreeNodeProps) {
  const { t } = useTranslation('common')
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<FileNode[]>([])
  const [loading, setLoading] = useState(false)
  const requestRef = useRef<AbortController | null>(null)
  const lastRefreshTokenRef = useRef(refreshToken)

  const nodePath = path ? `${path}/${node.name}` : node.name

  const loadChildren = useCallback(async () => {
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setLoading(true)
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(nodePath)}`, {
        signal: controller.signal,
      })
      if (res.ok) {
        const data = await res.json()
        if (requestRef.current === controller) {
          setChildren(data.nodes || [])
        }
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        console.error('Failed to load folder:', err)
      }
    } finally {
      if (requestRef.current === controller) {
        setLoading(false)
      }
    }
  }, [nodePath, workspaceId])

  useEffect(() => () => requestRef.current?.abort(), [])

  useEffect(() => {
    if (lastRefreshTokenRef.current === refreshToken) return

    lastRefreshTokenRef.current = refreshToken
    if (expanded) {
      void loadChildren()
    }
  }, [expanded, loadChildren, refreshToken])

  const toggleExpand = useCallback(async () => {
    if (node.type !== 'folder') return

    if (!expanded && children.length === 0) {
      await loadChildren()
    }
    setExpanded(!expanded)
  }, [children.length, expanded, loadChildren, node.type])

  if (node.type === 'folder') {
    return (
      <div>
        <div
          className="flex items-center gap-1.5 py-1 px-2 hover:bg-surface-hover rounded-lg cursor-pointer group text-xs"
          onClick={toggleExpand}
          onContextMenu={(e) => onContextMenu?.(e, nodePath, 'folder')}
          style={{ paddingLeft: `${level * 12 + 8}px` }}
        >
          <ChevronRight
            className={`w-3 h-3 text-text-tertiary flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
          <Folder className="w-3.5 h-3.5 text-yellow-600 flex-shrink-0" />
          <span className="truncate text-text-secondary">{node.name}</span>
        </div>
        {expanded && (
          <div>
            {loading ? (
              <div className="py-1 px-2 text-[11px] text-text-tertiary" style={{ paddingLeft: `${(level + 1) * 12 + 8}px` }}>
                Loading...
              </div>
            ) : children.length === 0 ? (
              <div className="py-1 px-2 text-[11px] text-text-tertiary" style={{ paddingLeft: `${(level + 1) * 12 + 8}px` }}>
                {t('emptyFolder')}
              </div>
            ) : (
              children.map((child) => (
                <TreeNode
                  key={`${workspaceId}-${child.name}`}
                  node={child}
                  path={nodePath}
                  workspaceId={workspaceId}
                  selectedPath={selectedPath}
                  onSelectPath={onSelectPath}
                  onFilePreview={onFilePreview}
                  onFileOpen={onFileOpen}
                  onContextMenu={onContextMenu}
                  refreshToken={refreshToken}
                  level={level + 1}
                />
              ))
            )}
          </div>
        )}
      </div>
    )
  }

  const isSelected = selectedPath === nodePath

  return (
    <div
      className={cn(
        'flex items-center gap-1.5 py-1 px-2 rounded-lg cursor-pointer text-xs',
        isSelected ? 'bg-accent/10 text-text-primary' : 'hover:bg-surface-hover text-text-secondary',
      )}
      onClick={() => {
        onSelectPath?.(nodePath)
        onFilePreview?.(nodePath, node.name)
      }}
      onDoubleClick={() => onFileOpen(nodePath, node.name)}
      onContextMenu={(e) => onContextMenu?.(e, nodePath, 'file')}
      style={{ paddingLeft: `${level * 12 + 8}px` }}
    >
      <span className="w-3 flex-shrink-0" />
      {getFileIcon(node.name)}
      <span className="truncate">{node.name}</span>
    </div>
  )
}

interface FileExplorerProps {
  selectedPath?: string
  onSelectPath?: (path: string) => void
  onFilePreview?: (path: string, name: string) => void
  onFileClick: (path: string, name: string) => void
}

function getRevealLabel(): string {
  if (typeof navigator !== 'undefined' && /Win/i.test(navigator.platform)) {
    return 'contextMenu.revealInExplorer'
  }
  if (typeof navigator !== 'undefined' && /Linux/i.test(navigator.platform)) {
    return 'contextMenu.revealInFileManager'
  }
  return 'contextMenu.revealInFinder'
}

export default function FileExplorer({ selectedPath, onSelectPath, onFilePreview, onFileClick }: FileExplorerProps) {
  const { t } = useTranslation('common')
  const { activeWorkspaceId, workspaces } = useWorkspaceStore()
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId)
  const { results, loading: searchLoading, error: searchError, search, clear } = useFiles(activeWorkspaceId ?? '')
  const [searchQuery, setSearchQuery] = useState('')
  const [rootNodes, setRootNodes] = useState<FileNode[]>([])
  const [treeLoading, setTreeLoading] = useState(false)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [treeRefreshToken, setTreeRefreshToken] = useState(0)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; itemPath: string; itemType: 'file' | 'folder' } | null>(null)
  const prevWorkspaceIdRef = useRef<string | null>(null)
  const rootRequestRef = useRef<AbortController | null>(null)

  useEffect(() => {
    setSearchQuery('')
    const prevId = prevWorkspaceIdRef.current
    if (prevId && prevId !== activeWorkspaceId) {
      clear()
    }
    prevWorkspaceIdRef.current = activeWorkspaceId ?? null
  }, [activeWorkspaceId, clear])

  const loadRoot = useCallback(async () => {
    if (!activeWorkspaceId) {
      setRootNodes([])
      return
    }

    rootRequestRef.current?.abort()
    const controller = new AbortController()
    rootRequestRef.current = controller
    setTreeLoading(true)
    setTreeError(null)
    try {
      const res = await fetch(`/api/workspaces/${activeWorkspaceId}/files`, {
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(t('failedToLoadFiles'))
      const data = await res.json()
      if (rootRequestRef.current === controller) {
        setRootNodes(data.nodes || [])
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      if (rootRequestRef.current === controller) {
        setTreeError(err instanceof Error ? err.message : t('unknownError'))
      }
    } finally {
      if (rootRequestRef.current === controller) {
        setTreeLoading(false)
      }
    }
  }, [activeWorkspaceId, t])

  useEffect(() => {
    void loadRoot()
    return () => rootRequestRef.current?.abort()
  }, [loadRoot])

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const query = e.target.value
      setSearchQuery(query)
      if (query.trim()) {
        search(query)
      } else {
        clear()
      }
    },
    [search, clear]
  )

  const isSearching = searchQuery.trim().length > 0

  const handleRefresh = useCallback(() => {
    setTreeRefreshToken((token) => token + 1)
    void loadRoot()
    if (searchQuery.trim()) {
      search(searchQuery)
    }
  }, [loadRoot, search, searchQuery])

  useEffect(() => {
    if (!contextMenu) return
    const handleClick = () => setContextMenu(null)
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [contextMenu])

  const resolveAbsolutePath = (relativePath: string): string => {
    if (!activeWorkspace?.folderPath) return relativePath
    const base = activeWorkspace.folderPath.replace(/\\/g, '/')
    const relative = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath
    return `${base}/${relative}`
  }

  const handleContextMenu = (e: React.MouseEvent, itemPath: string, itemType: 'file' | 'folder') => {
    e.preventDefault()
    if (!activeWorkspace?.folderPath) return
    setContextMenu({ x: e.clientX, y: e.clientY, itemPath, itemType })
  }

  const handleReveal = async () => {
    if (!contextMenu) return
    const absolutePath = resolveAbsolutePath(contextMenu.itemPath)
    setContextMenu(null)
    try {
      await revealInFileManager(absolutePath)
    } catch (err) {
      console.error('Failed to reveal file:', err)
    }
  }

  const handleCopyPath = async () => {
    if (!contextMenu) return
    const absolutePath = resolveAbsolutePath(contextMenu.itemPath)
    setContextMenu(null)
    try {
      await navigator.clipboard.writeText(absolutePath)
    } catch (err) {
      console.error('Failed to copy path:', err)
    }
  }

  if (!activeWorkspaceId) {
    return (
      <div className="p-3 text-xs text-text-tertiary text-center">
        {t('noWorkspaceToBrowse')}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Search input */}
      <div className="px-3 py-2 border-b border-border/50 flex-shrink-0 flex items-center gap-1">
        <input
          type="text"
          value={searchQuery}
          onChange={handleSearchChange}
          placeholder={t('searchFiles')}
          className="min-w-0 flex-1 bg-transparent text-xs text-text-primary placeholder:text-text-tertiary outline-none"
        />
        {searchQuery.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setSearchQuery('')
              clear()
            }}
            className="p-0.5 rounded text-text-tertiary hover:text-text-primary transition-colors"
            title={t('clear')}
            aria-label={t('clear')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={handleRefresh}
          disabled={treeLoading}
          className="p-0.5 rounded text-text-tertiary hover:text-text-primary transition-colors disabled:cursor-not-allowed"
          title={t('refreshFiles')}
          aria-label={t('refreshFiles')}
        >
          <RefreshCw className={cn('w-3.5 h-3.5', treeLoading && 'animate-spin')} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto py-1">
        {isSearching ? (
          <>
            {searchLoading && results.length === 0 && (
              <div className="flex items-center gap-2 px-3 py-3 text-xs text-text-tertiary">
                <Loader2 className="w-3 h-3 animate-spin" />
                {t('loadingFiles')}
              </div>
            )}
            {searchError && results.length === 0 && (
              <div className="px-3 py-3 text-xs text-accent">{searchError}</div>
            )}
            {!searchLoading && !searchError && results.length === 0 && (
              <div className="px-3 py-3 text-xs text-text-tertiary">
                {t('noFilesMatch', { filter: searchQuery ? ` \`${searchQuery}\`` : '' })}
              </div>
            )}
            {results.map((entry) => {
              const basename = entry.path.split('/').pop() || entry.path
              const isSelected = selectedPath === entry.path
              return (
                <div
                  key={entry.path}
                  className={cn(
                    'flex items-center gap-2 px-3 py-1.5 rounded-lg cursor-pointer text-xs',
                    isSelected ? 'bg-accent/10 text-text-primary' : 'hover:bg-surface-hover text-text-secondary',
                  )}
                  onClick={() => {
                    onSelectPath?.(entry.path)
                    onFilePreview?.(entry.path, basename)
                  }}
                  onDoubleClick={() => onFileClick(entry.path, basename)}
                  onContextMenu={(e) => handleContextMenu(e, entry.path, 'file')}
                >
                  {getFileIcon(basename)}
                  <span className="truncate">{entry.path}</span>
                </div>
              )
            })}
          </>
        ) : (
          <>
            {treeLoading && rootNodes.length === 0 && (
              <div className="p-3 text-xs text-text-tertiary">{t('loadingFiles')}</div>
            )}
            {treeError && (
              <div className="p-3 text-xs text-destructive">{treeError}</div>
            )}
            {!treeLoading && !treeError && rootNodes.length === 0 && (
              <div className="p-3 text-xs text-text-tertiary">{t('emptyWorkspace')}</div>
            )}
            {rootNodes.map((node) => (
              <TreeNode
                key={`${activeWorkspaceId}-${node.name}`}
                node={node}
                path=""
                workspaceId={activeWorkspaceId}
                selectedPath={selectedPath}
                onSelectPath={onSelectPath}
                onFilePreview={onFilePreview}
                onFileOpen={onFileClick}
                onContextMenu={handleContextMenu}
                refreshToken={treeRefreshToken}
                level={0}
              />
            ))}
          </>
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="fixed z-50 min-w-[180px] bg-surface-active border border-border rounded-lg shadow-lg py-1"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            onClick={handleReveal}
            className="w-full px-3 py-2 text-left text-xs text-text-secondary hover:bg-surface-hover transition-colors"
          >
            {t(getRevealLabel())}
          </button>
          <button
            onClick={handleCopyPath}
            className="w-full px-3 py-2 text-left text-xs text-text-secondary hover:bg-surface-hover transition-colors"
          >
            {t('contextMenu.copyFullPath')}
          </button>
        </div>
      )}
    </div>
  )
}
