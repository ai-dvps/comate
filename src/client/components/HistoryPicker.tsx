import {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { History } from 'lucide-react'
import { Popover, PopoverAnchor, PopoverContent } from './ui/popover'
import { useSentPrompts } from '../hooks/useSentPrompts'
import { filterItems } from '../lib/picker-filter'

export interface HistoryPickerHandle {
  moveDown: () => void
  moveUp: () => void
  commitActive: () => void
}

interface HistoryPickerProps {
  sessionId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (prompt: string) => void
  anchor: React.ReactNode
  side?: 'top' | 'bottom'
  align?: 'start' | 'center' | 'end'
  initialFilter?: string
}

interface HistoryRow {
  text: string
}

function formatPromptPreview(text: string, t: TFunction) {
  const lines = text.split('\n')
  const first = lines[0]
  if (lines.length <= 1) return first
  return `${first} … (${t('historyLineCount', { count: lines.length - 1 })})`
}

const HistoryPicker = forwardRef<HistoryPickerHandle, HistoryPickerProps>(
  function HistoryPicker(
    {
      sessionId,
      open,
      onOpenChange,
      onSelect,
      anchor,
      side = 'top',
      align = 'start',
      initialFilter = '',
    },
    ref,
  ) {
    const { t } = useTranslation('chat')
    const prompts = useSentPrompts(sessionId)
    const rows = useMemo<HistoryRow[]>(
      () => prompts.map((text) => ({ text })),
      [prompts],
    )
    const [filter, setFilter] = useState(initialFilter)
    const [activeIndex, setActiveIndex] = useState(0)

    const filterInputRef = useRef<HTMLInputElement>(null)
    const listRef = useRef<HTMLDivElement>(null)
    const rowRefs = useRef<Array<HTMLButtonElement | null>>([])
    const wasOpenRef = useRef(false)

    useEffect(() => {
      if (open) {
        setFilter(initialFilter)
        setActiveIndex(0)
        if (!wasOpenRef.current) {
          wasOpenRef.current = true
          const id = requestAnimationFrame(() =>
            filterInputRef.current?.focus(),
          )
          return () => cancelAnimationFrame(id)
        }
      } else if (wasOpenRef.current) {
        setFilter('')
        setActiveIndex(0)
        wasOpenRef.current = false
      }
    }, [open, initialFilter])

    const filtered = useMemo(() => {
      return filterItems(rows, filter, 'text')
    }, [rows, filter])

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
        const row = filtered[index]
        if (!row) return
        onSelect(row.text)
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
        setActiveIndex(
          (i) => (i - 1 + filtered.length) % filtered.length,
        )
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

    const showEmpty = filtered.length === 0

    return (
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverAnchor asChild>{anchor}</PopoverAnchor>
        <PopoverContent
          side={side}
          align={align}
          sideOffset={6}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          className="bg-surface border border-border rounded-lg shadow-lg z-50 w-[360px] max-h-[320px] flex flex-col p-2"
        >
          <input
            ref={filterInputRef}
            type="text"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={handleKeyDown}
            placeholder={t('historySearchPlaceholder')}
            className="w-full bg-transparent text-sm text-text-primary placeholder:text-text-tertiary px-2 py-1.5 border-b border-border focus:outline-none"
            autoComplete="off"
            spellCheck={false}
          />
          <div ref={listRef} className="flex-1 overflow-y-auto mt-1">
            {showEmpty && (
              <div className="px-2 py-3 text-xs text-text-tertiary">
                {prompts.length === 0 ? t('historyEmpty') : t('historyNoMatch', { filter })}
              </div>
            )}
            {!showEmpty &&
              filtered.map((row, i) => (
                <button
                  key={`${row.text}-${i}`}
                  ref={(el) => {
                    rowRefs.current[i] = el
                  }}
                  type="button"
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => commit(i)}
                  title={row.text}
                  className={`w-full text-left px-2 py-1.5 rounded-md transition-colors ${
                    i === activeIndex
                      ? 'bg-surface-hover'
                      : 'hover:bg-surface-hover'
                  }`}
                >
                  <span className="text-sm text-text-primary whitespace-pre-wrap break-words line-clamp-2">
                    {formatPromptPreview(row.text, t)}
                  </span>
                </button>
              ))}
          </div>
        </PopoverContent>
      </Popover>
    )
  },
)

export default HistoryPicker

export { History }
