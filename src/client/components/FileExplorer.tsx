import { useState, useEffect, useCallback } from 'react'
import { useWorkspaceStore } from '../stores/workspace-store'
import { ChevronRight, Folder, FileCode, FileJson, FileText, File } from 'lucide-react'

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
                Empty folder
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
  const { activeWorkspaceId } = useWorkspaceStore()
  const [rootNodes, setRootNodes] = useState<FileNode[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!activeWorkspaceId) {
      setRootNodes([])
      return
    }

    async function loadRoot() {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch(`/api/workspaces/${activeWorkspaceId}/files`)
        if (!res.ok) throw new Error('Failed to load files')
        const data = await res.json()
        setRootNodes(data.nodes || [])
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        setLoading(false)
      }
    }

    loadRoot()
  }, [activeWorkspaceId])

  if (!activeWorkspaceId) {
    return (
      <div className="p-3 text-xs text-text-tertiary text-center">
        Open a workspace to browse files
      </div>
    )
  }

  if (loading && rootNodes.length === 0) {
    return <div className="p-3 text-xs text-text-tertiary">Loading files...</div>
  }

  if (error) {
    return <div className="p-3 text-xs text-destructive">{error}</div>
  }

  if (rootNodes.length === 0) {
    return <div className="p-3 text-xs text-text-tertiary">Empty workspace</div>
  }

  return (
    <div className="flex-1 overflow-y-auto py-1">
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
    </div>
  )
}
