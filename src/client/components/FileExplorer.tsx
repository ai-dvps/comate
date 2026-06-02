import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useWorkspaceStore } from '../stores/workspace-store'
import { useFiles } from '../stores/files-store'
import { invoke } from '@tauri-apps/api/core'
import { ChevronRight, Folder, FileCode, FileJson, FileText, File, Loader2, X } from 'lucide-react'

interface FileNode {
  name: string
  type: 'file' | 'folder'
  children?: FileNode[]
}

function getFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase()
  if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx') {
    return <FileCode className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />
  }
  if (ext === 'json') {
    return <FileJson className="w-3.5 h-3.5 text-yellow-400 flex-shrink-0" />
  }
  if (ext === 'md' || ext === 'txt') {
    return <FileText className="w-3.5 h-3.5 text-text-secondary flex-shrink-0" />
  }
  return <File className="w-3.5 h-3.5 text-text-tertiary flex-shrink-0" />
}

interface TreeNodeProps {
  node: FileNode
  path: string
  workspaceId: string
  onFileClick: (path: string, name: string) => void
  onFileDoubleClick?: (path: string, name: string) => void
  onContextMenu?: (e: React.MouseEvent, nodePath: string, nodeType: 'file' | 'folder') => void
  level: number
}

function TreeNode({ node, path, workspaceId, onFileClick, onFileDoubleClick, onContextMenu, level }: TreeNodeProps) {
  const { t } = useTranslation('common')
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<FileNode[]>([])
  const [loading, setLoading] = useState(false)

  const nodePath = path ? `${path}/${node.name}` : node.name

  const toggleExpand = useCallback(async () => {
    if (node.type !== 'folder') return

    if (!expanded && children.length === 0) {
      setLoading(true)
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(nodePath)}`)
        if (res.ok) {
          const data = await res.json()
          setChildren(data.nodes || [])
        }
      } catch (err) {
        console.error('Failed to load folder:', err)
      } finally {
        setLoading(false)
      }
    }
    setExpanded(!expanded)
  }, [expanded, children.length, node.type, nodePath, workspaceId])

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
                  onFileClick={onFileClick}
                  onFileDoubleClick={onFileDoubleClick}
                  onContextMenu={onContextMenu}
                  level={level + 1}
                />
              ))
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className="flex items-center gap-1.5 py-1 px-2 hover:bg-surface-hover rounded-lg cursor-pointer text-xs"
      onClick={() => onFileClick(nodePath, node.name)}
      onDoubleClick={() => onFileDoubleClick?.(nodePath, node.name)}
      onContextMenu={(e) => onContextMenu?.(e, nodePath, 'file')}
      style={{ paddingLeft: `${level * 12 + 8}px` }}
    >
      <span className="w-3 flex-shrink-0" />
      {getFileIcon(node.name)}
      <span className="truncate text-text-secondary">{node.name}</span>
    </div>
  )
}

interface FileExplorerProps {
  onFileClick: (path: string, name: string) => void
  onFileDoubleClick?: (path: string, name: string) => void
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

export default function FileExplorer({ onFileClick, onFileDoubleClick }: FileExplorerProps) {
  const { t } = useTranslation('common')
  const { activeWorkspaceId, workspaces } = useWorkspaceStore()
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId)
  const { results, loading: searchLoading, error: searchError, search, clear } = useFiles(activeWorkspaceId ?? '')
  const [searchQuery, setSearchQuery] = useState('')
  const [rootNodes, setRootNodes] = useState<FileNode[]>([])
  const [treeLoading, setTreeLoading] = useState(false)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; itemPath: string; itemType: 'file' | 'folder' } | null>(null)
  const prevWorkspaceIdRef = useRef<string | null>(null)

  useEffect(() => {
    setSearchQuery('')
    const prevId = prevWorkspaceIdRef.current
    if (prevId && prevId !== activeWorkspaceId) {
      clear()
    }
    prevWorkspaceIdRef.current = activeWorkspaceId ?? null
  }, [activeWorkspaceId, clear])

  useEffect(() => {
    if (!activeWorkspaceId) {
      setRootNodes([])
      return
    }

    const controller = new AbortController()

    async function loadRoot() {
      setTreeLoading(true)
      setTreeError(null)
      try {
        const res = await fetch(`/api/workspaces/${activeWorkspaceId}/files`, {
          signal: controller.signal,
        })
        if (!res.ok) throw new Error(t('failedToLoadFiles'))
        const data = await res.json()
        setRootNodes(data.nodes || [])
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setTreeError(err instanceof Error ? err.message : t('unknownError'))
      } finally {
        setTreeLoading(false)
      }
    }

    loadRoot()
    return () => controller.abort()
  }, [activeWorkspaceId, t])

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
      await invoke('reveal_in_file_manager', { path: absolutePath, itemType: contextMenu.itemType })
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
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Search input */}
      <div className="px-3 py-2 border-b border-border/50 flex-shrink-0 relative">
        <input
          type="text"
          value={searchQuery}
          onChange={handleSearchChange}
          placeholder={t('searchFiles')}
          className="w-full bg-transparent text-xs text-text-primary placeholder:text-text-tertiary outline-none pr-6"
        />
        {searchQuery.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setSearchQuery('')
              clear()
            }}
            className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 rounded text-text-tertiary hover:text-text-primary transition-colors"
            title={t('clear')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
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
              return (
                <div
                  key={entry.path}
                  className="flex items-center gap-2 px-3 py-1.5 hover:bg-surface-hover rounded-lg cursor-pointer text-xs"
                  onClick={() => onFileClick(entry.path, basename)}
                  onContextMenu={(e) => handleContextMenu(e, entry.path, 'file')}
                >
                  {getFileIcon(basename)}
                  <span className="truncate text-text-secondary">{entry.path}</span>
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
                onFileClick={onFileClick}
                onFileDoubleClick={onFileDoubleClick}
                onContextMenu={handleContextMenu}
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
