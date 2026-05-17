import {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from 'react'
import { Loader2, Folder, FileCode, FileJson, FileText, File } from 'lucide-react'
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

function getIconForPath(path: string, type: 'file' | 'folder') {
  if (type === 'folder') {
    return <Folder className="w-3.5 h-3.5 text-yellow-600 flex-shrink-0" />
  }
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
      refetchOnOpen = false,
      hideFilterInput = false,
    },
    ref,
  ) {
    const { files, loading, error, fetch, refresh } = useFiles(workspaceId)
    const [filter, setFilter] = useState(initialFilter)
    const [activeIndex, setActiveIndex] = useState(0)

    const filterInputRef = useRef<HTMLInputElement>(null)
    const listRef = useRef<HTMLDivElement>(null)
    const rowRefs = useRef<Array<HTMLButtonElement | null>>([])
    const wasOpenRef = useRef(false)

    useEffect(() => {
      if (!open) return
      if (refetchOnOpen) {
        void refresh()
      } else {
        void fetch()
      }
    }, [open, refetchOnOpen, fetch, refresh])

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

    const filtered = useMemo(() => {
      if (filter === '') return files
      const needle = filter.toLowerCase()
      return files.filter((f) => f.path.toLowerCase().includes(needle))
    }, [files, filter])

    useEffect(() => {
      if (activeIndex >= filtered.length) {
        setActiveIndex(filtered.length > 0 ? filtered.length - 1 : 0)
      }
    }, [filtered, activeIndex])

    useEffect(() => {
      if (!open) return
      const row = rowRefs.current[activeIndex]
      row?.scrollIntoView({ block: 'nearest' })
    }, [activeIndex, open])

    const commit = useCallback(
      (index: number) => {
        const entry = filtered[index]
        if (!entry) return
        onSelect(entry.path)
        onOpenChange(false)
      },
      [filtered, onSelect, onOpenChange],
    )

    useImperativeHandle(
      ref,
      () => ({
        moveDown: () => {
          if (filtered.length === 0) return
          setActiveIndex((i) => (i + 1) % filtered.length)
        },
        moveUp: () => {
          if (filtered.length === 0) return
          setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length)
        },
        commitActive: () => commit(activeIndex),
      }),
      [filtered, activeIndex, commit],
    )

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (filtered.length === 0) return
        setActiveIndex((i) => (i + 1) % filtered.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (filtered.length === 0) return
        setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length)
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

    const showLoadingState = loading && files.length === 0
    const showErrorState = !!error && files.length === 0
    const showEmptyWorkspace =
      !showLoadingState && !showErrorState && files.length === 0
    const showEmptyFilter =
      !showLoadingState &&
      !showErrorState &&
      !showEmptyWorkspace &&
      filtered.length === 0

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
            {showEmptyWorkspace && (
              <div className="px-2 py-3 text-xs text-text-tertiary">
                This workspace is empty
              </div>
            )}
            {showEmptyFilter && (
              <div className="px-2 py-3 text-xs text-text-tertiary">
                No files match{filter ? ` \`${filter}\`` : ''}
              </div>
            )}
            {!showLoadingState &&
              !showErrorState &&
              !showEmptyWorkspace &&
              filtered.map((entry, i) => (
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
                    {getIconForPath(entry.path, entry.type)}
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
