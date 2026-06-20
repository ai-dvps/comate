import { Copy } from 'lucide-react'
import { useToolRendererContext } from './ToolRendererContext'
import { cn } from '../ui/utils'
import { basename, getPathDisplayInfo } from './path-utils'

export interface FilePathProps {
  path: string
  isDirectory?: boolean
  className?: string
}

export default function FilePath({ path, isDirectory, className }: FilePathProps) {
  const { workspacePath, onOpenFile } = useToolRendererContext()

  const { displayText, displayAbsolute, relativePath } = getPathDisplayInfo(path, workspacePath)
  const directoryLike = isDirectory || /[\\/]$/.test(path)
  const clickable = relativePath !== null && !directoryLike && relativePath !== '.'

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!clickable || !relativePath || relativePath === '.') return
    if (!e.metaKey && !e.ctrlKey) return
    const name = basename(relativePath)
    onOpenFile(relativePath, name)
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(displayAbsolute)
    } catch (err) {
      console.error('Failed to copy path:', err)
    }
  }

  const pathEl = clickable ? (
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
  ) : (
    <span
      className={cn('font-mono text-xs text-text-primary', className)}
      title={displayAbsolute}
    >
      {displayText}
    </span>
  )

  return (
    <span className="inline-flex items-center gap-1">
      {pathEl}
      <button
        type="button"
        onClick={handleCopy}
        className="inline-flex items-center justify-center p-0.5 rounded text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
        title="Copy path"
        aria-label="Copy path"
      >
        <Copy className="w-3 h-3" />
      </button>
    </span>
  )
}
