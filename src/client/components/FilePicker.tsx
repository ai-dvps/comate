import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from 'react'
import { Loader2, FileCode, FileJson, FileText, File } from 'lucide-react'
import { Popover, PopoverAnchor, PopoverContent } from './ui/popover'
import { useFiles } from '../stores/files-store'

export interface FilePickerHandle {
  moveDown: () => void
  moveUp: () => void
  commitActive: () => void
}

interface FilePickerProps {
  workspaceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (path: string) => void
  anchor: React.ReactNode
  side?: 'top' | 'bottom'
  align?: 'start' | 'center' | 'end'
  initialFilter?: string
  /** @deprecated The search endpoint is per-query; no separate refresh path needed. Kept to avoid churning callers. */
  refetchOnOpen?: boolean
  hideFilterInput?: boolean
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

function getIconForPath(path: string) {
  const basename = path.split('/').pop() || path
  return getFileIcon(basename)
}

const FilePicker = forwardRef<FilePickerHandle, FilePickerProps>(
  function FilePicker(
    {
      workspaceId,
      open,
      onOpenChange,
      onSelect,
      anchor,
      side = 'top',
      align = 'start',
      initialFilter = '',
      hideFilterInput = false,
    },
    ref,
  ) {
    const { results, loading, error, search } = useFiles(workspaceId)
    const [filter, setFilter] = useState(initialFilter)
    const [activeIndex, setActiveIndex] = useState(0)

    const filterInputRef = useRef<HTMLInputElement>(null)
    const listRef = useRef<HTMLDivElement>(null)
    const rowRefs = useRef<Array<HTMLButtonElement | null>>([])
    const wasOpenRef = useRef(false)

    useEffect(() => {
      if (!open) return
      search(filter)
    }, [open, filter, search])

    useEffect(() => {
      if (open) {
        setFilter(initialFilter)
        setActiveIndex(0)
        if (!wasOpenRef.current) {
          wasOpenRef.current = true
          if (!hideFilterInput) {
            const id = requestAnimationFrame(() =>
              filterInputRef.current?.focus(),
            )
            return () => cancelAnimationFrame(id)
          }
        }
      } else if (wasOpenRef.current) {
        setFilter('')
        setActiveIndex(0)
        wasOpenRef.current = false
      }
    }, [open, hideFilterInput, initialFilter])

    useEffect(() => {
      if (activeIndex >= results.length) {
        setActiveIndex(results.length > 0 ? results.length - 1 : 0)
      }
    }, [results, activeIndex])

    useEffect(() => {
      if (!open) return
      const row = rowRefs.current[activeIndex]
      row?.scrollIntoView({ block: 'nearest' })
    }, [activeIndex, open])

    const commit = useCallback(
      (index: number) => {
        const entry = results[index]
        if (!entry) return
        onSelect(entry.path)
        onOpenChange(false)
      },
      [results, onSelect, onOpenChange],
    )

    useImperativeHandle(
      ref,
      () => ({
        moveDown: () => {
          if (results.length === 0) return
          setActiveIndex((i) => (i + 1) % results.length)
        },
        moveUp: () => {
          if (results.length === 0) return
          setActiveIndex((i) => (i - 1 + results.length) % results.length)
        },
        commitActive: () => commit(activeIndex),
      }),
      [results, activeIndex, commit],
    )

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (results.length === 0) return
        setActiveIndex((i) => (i + 1) % results.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (results.length === 0) return
        setActiveIndex((i) => (i - 1 + results.length) % results.length)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        commit(activeIndex)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        onOpenChange(false)
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        onOpenChange(false)
        return
      }
    }

    const showLoadingState = loading && results.length === 0
    const showErrorState = !!error && results.length === 0
    const showEmpty =
      !showLoadingState && !showErrorState && results.length === 0

    return (
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverAnchor asChild>{anchor}</PopoverAnchor>
        <PopoverContent
          side={side}
          align={align}
          sideOffset={6}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => {
            if (hideFilterInput) e.preventDefault()
          }}
          className="bg-surface border border-border rounded-lg shadow-lg z-50 w-[360px] max-h-[320px] flex flex-col p-2"
        >
          {!hideFilterInput && (
            <input
              ref={filterInputRef}
              type="text"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value)
                setActiveIndex(0)
              }}
              onKeyDown={handleKeyDown}
              placeholder="Search files…"
              className="w-full bg-transparent text-sm text-text-primary placeholder:text-text-tertiary px-2 py-1.5 border-b border-border focus:outline-none"
              autoComplete="off"
              spellCheck={false}
            />
          )}
          <div ref={listRef} className="flex-1 overflow-y-auto mt-1">
            {showLoadingState && (
              <div className="flex items-center gap-2 px-2 py-3 text-xs text-text-tertiary">
                <Loader2 className="w-3 h-3 animate-spin" />
                Loading files…
              </div>
            )}
            {showErrorState && (
              <div className="px-2 py-3 text-xs text-accent">{error}</div>
            )}
            {showEmpty && (
              <div className="px-2 py-3 text-xs text-text-tertiary">
                No files match{filter ? ` \`${filter}\`` : ''}
              </div>
            )}
            {!showLoadingState &&
              !showErrorState &&
              results.map((entry, i) => (
                <button
                  key={entry.path}
                  ref={(el) => {
                    rowRefs.current[i] = el
                  }}
                  type="button"
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => commit(i)}
                  className={`w-full text-left px-2 py-1.5 rounded-md transition-colors ${
                    i === activeIndex
                      ? 'bg-surface-hover'
                      : 'hover:bg-surface-hover'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {getIconForPath(entry.path)}
                    <span className="text-sm text-text-primary truncate">
                      {entry.path}
                    </span>
                  </div>
                </button>
              ))}
          </div>
        </PopoverContent>
      </Popover>
    )
  },
)

export default FilePicker
