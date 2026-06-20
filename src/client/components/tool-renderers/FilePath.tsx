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

  const handleClick = () => {
    if (!clickable || !relativePath || relativePath === '.') return
    const name = basename(relativePath)
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
