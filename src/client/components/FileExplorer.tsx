import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useWorkspaceStore } from '../stores/workspace-store'
import { useFiles } from '../stores/files-store'
import { ChevronRight, Folder, FileCode, FileJson, FileText, File, Loader2 } from 'lucide-react'

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
  level: number
}

function TreeNode({ node, path, workspaceId, onFileClick, onFileDoubleClick, level }: TreeNodeProps) {
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
                  key={child.name}
                  node={child}
                  path={nodePath}
                  workspaceId={workspaceId}
                  onFileClick={onFileClick}
                  onFileDoubleClick={onFileDoubleClick}
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

export default function FileExplorer({ onFileClick, onFileDoubleClick }: FileExplorerProps) {
  const { t } = useTranslation('common')
  const { activeWorkspaceId } = useWorkspaceStore()
  const { results, loading: searchLoading, error: searchError, search, clear } = useFiles(activeWorkspaceId ?? '')
  const [searchQuery, setSearchQuery] = useState('')
  const [rootNodes, setRootNodes] = useState<FileNode[]>([])
  const [treeLoading, setTreeLoading] = useState(false)
  const [treeError, setTreeError] = useState<string | null>(null)

  useEffect(() => {
    setSearchQuery('')
    clear()
  }, [activeWorkspaceId, clear])

  useEffect(() => {
    if (!activeWorkspaceId) {
      setRootNodes([])
      return
    }

    async function loadRoot() {
      setTreeLoading(true)
      setTreeError(null)
      try {
        const res = await fetch(`/api/workspaces/${activeWorkspaceId}/files`)
        if (!res.ok) throw new Error(t('failedToLoadFiles'))
        const data = await res.json()
        setRootNodes(data.nodes || [])
      } catch (err) {
        setTreeError(err instanceof Error ? err.message : t('unknownError'))
      } finally {
        setTreeLoading(false)
      }
    }

    loadRoot()
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
      <div className="px-3 py-2 border-b border-border/50 flex-shrink-0">
        <input
          type="text"
          value={searchQuery}
          onChange={handleSearchChange}
          placeholder={t('searchFiles')}
          className="w-full bg-transparent text-xs text-text-primary placeholder:text-text-tertiary outline-none"
        />
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
                key={node.name}
                node={node}
                path=""
                workspaceId={activeWorkspaceId}
                onFileClick={onFileClick}
                onFileDoubleClick={onFileDoubleClick}
                level={0}
              />
            ))}
          </>
        )}
      </div>
    </div>
  )
}
