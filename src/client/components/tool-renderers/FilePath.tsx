import { Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useToolRendererContext } from './use-tool-renderer-context'
import { cn } from '../ui/utils'
import { basename, getPathDisplayInfo, truncateStart } from './path-utils'

function useModifierActive(): boolean {
  const [active, setActive] = useState(false)

  useEffect(() => {
    const update = (e: KeyboardEvent | MouseEvent) => {
      setActive(e.metaKey || e.ctrlKey)
    }
    const reset = () => setActive(false)

    document.addEventListener('keydown', update)
    document.addEventListener('keyup', update)
    window.addEventListener('blur', reset)

    return () => {
      document.removeEventListener('keydown', update)
      document.removeEventListener('keyup', update)
      window.removeEventListener('blur', reset)
    }
  }, [])

  return active
}

export interface FilePathProps {
  path: string
  isDirectory?: boolean
  className?: string
  maxDisplayLength?: number
}

export default function FilePath({
  path,
  isDirectory,
  className,
  maxDisplayLength = 40,
}: FilePathProps) {
  const { workspacePath, onOpenFile } = useToolRendererContext()
  const modifierActive = useModifierActive()

  const { displayText, displayAbsolute, relativePath } = getPathDisplayInfo(path, workspacePath)
  const directoryLike = isDirectory || /[\\/]$/.test(path)
  const clickable = relativePath !== null && !directoryLike && relativePath !== '.'
  const showClickable = clickable && modifierActive

  const truncatedText = truncateStart(displayText, maxDisplayLength)

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!clickable || !relativePath || relativePath === '.') return
    if (!e.metaKey && !e.ctrlKey) return
    const name = basename(relativePath)
    onOpenFile(relativePath, name)
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(relativePath ?? displayAbsolute)
    } catch (err) {
      console.error('Failed to copy path:', err)
    }
  }

  const baseClasses =
    'inline-block font-mono text-xs text-text-primary bg-transparent border-0 p-0 m-0 rounded cursor-default align-middle'

  const pathEl = clickable ? (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        baseClasses,
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
        showClickable && 'cursor-pointer hover:underline',
        className,
      )}
      title={displayAbsolute}
    >
      {truncatedText}
    </button>
  ) : (
    <span
      className={cn(baseClasses, className)}
      title={displayAbsolute}
    >
      {truncatedText}
    </span>
  )

  return (
    <span className="inline-flex items-center gap-1 min-w-0">
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
