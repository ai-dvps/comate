import { useToolRendererContext } from './ToolRendererContext'
import { cn } from '../ui/utils'

export interface FilePathProps {
  path: string
  isDirectory?: boolean
  className?: string
}

function normalizePath(p: string): string {
  const normalized = p.replace(/\\/g, '/')
  const isAbs = normalized.startsWith('/')
  const segments = normalized.split('/').filter((s) => s !== '' && s !== '.')
  const resolved: string[] = []

  for (const segment of segments) {
    if (segment === '..') {
      if (resolved.length > 0 && resolved[resolved.length - 1] !== '..') {
        resolved.pop()
      } else if (!isAbs) {
        resolved.push('..')
      }
    } else {
      resolved.push(segment)
    }
  }

  const joined = resolved.join('/')
  return isAbs ? `/${joined}` : joined
}

function stripTrailingSlash(p: string): string {
  return p.replace(/\/+$/, '') || '/'
}

function basename(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx >= 0 ? p.slice(idx + 1) : p
}

function getRelativePath(absPath: string, workspacePath: string): string | null {
  const normPath = normalizePath(absPath)
  const normWorkspace = normalizePath(workspacePath)
  const workspacePrefix = normWorkspace.endsWith('/')
    ? normWorkspace
    : `${normWorkspace}/`

  if (normPath === normWorkspace) {
    return '.'
  }

  if (normPath.startsWith(workspacePrefix)) {
    return normPath.slice(workspacePrefix.length)
  }

  return null
}

export default function FilePath({ path, isDirectory, className }: FilePathProps) {
  const { workspacePath, onOpenFile } = useToolRendererContext()

  const normalizedPath = normalizePath(path)
  const displayAbsolute = stripTrailingSlash(normalizedPath)
  const directoryLike = isDirectory || /[\\/]$/.test(path)

  let displayText = displayAbsolute
  let relativePath: string | null = null
  let clickable = false

  if (workspacePath) {
    relativePath = getRelativePath(path, workspacePath)
    if (relativePath !== null) {
      displayText = stripTrailingSlash(relativePath) || relativePath
      clickable = !directoryLike
    }
  }

  const handleClick = () => {
    if (!clickable || !relativePath) return
    const name = relativePath === '.' ? basename(normalizePath(workspacePath!)) : basename(relativePath)
    onOpenFile(relativePath, name)
  }

  if (!clickable) {
    return (
      <span
        className={cn('font-mono text-xs text-text-primary', className)}
        title={displayAbsolute}
      >
        {displayText}
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        'inline font-mono text-xs text-text-primary bg-transparent border-0 p-0 m-0 cursor-pointer',
        'hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent rounded',
        className,
      )}
      title={displayAbsolute}
    >
      {displayText}
    </button>
  )
}
