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
import { Loader2 } from 'lucide-react'
import { Popover, PopoverAnchor, PopoverContent } from './ui/popover'
import { cn } from './ui/utils'
import { useCommands, type SlashCommandDto } from '../stores/commands-store'
import { filterItems } from '../lib/picker-filter'

export interface CommandPickerHandle {
  moveDown: () => void
  moveUp: () => void
  commitActive: () => void
}

interface CommandPickerProps {
  workspaceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (command: SlashCommandDto) => void
  anchor: React.ReactNode
  side?: 'top' | 'bottom'
  align?: 'start' | 'center' | 'end'
  initialFilter?: string
  refetchOnOpen?: boolean
  hideFilterInput?: boolean
  contentWidth?: number
}

const CommandPicker = forwardRef<CommandPickerHandle, CommandPickerProps>(
  function CommandPicker(
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
      contentWidth,
    },
    ref,
  ) {
    const { t } = useTranslation('common')
    const { commands, loading, error, partial, partialReason, fetch, refresh } =
      useCommands(workspaceId)
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
      return filterItems(commands, filter, 'name')
    }, [commands, filter])

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
        const command = filtered[index]
        if (!command) return
        onSelect(command)
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

    const showLoadingState = loading && commands.length === 0
    const showErrorState = !!error && commands.length === 0

    return (
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverAnchor asChild>
          <span className="absolute top-0 left-0 w-0 h-0" aria-hidden="true" />
        </PopoverAnchor>
        {anchor}
        <PopoverContent
          side={side}
          align={align}
          sideOffset={6}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => {
            if (hideFilterInput) e.preventDefault()
          }}
          className={cn(
            'bg-surface border border-border rounded-lg shadow-lg z-50 max-h-[320px] flex flex-col p-2',
            contentWidth === undefined ? 'w-[360px]' : 'w-full',
          )}
          style={
            contentWidth === undefined
              ? undefined
              : { width: contentWidth, boxSizing: 'border-box' }
          }
        >
          {partial && (
            <div className="text-[11px] text-text-tertiary px-2 py-1 mb-1 rounded bg-surface-hover">
              {partialReason || t('commandPicker.partialFallback')}
            </div>
          )}
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
              placeholder={t('commandPicker.searchPlaceholder')}
              className="w-full bg-transparent text-sm text-text-primary placeholder:text-text-tertiary px-2 py-1.5 border-b border-border focus:outline-none"
              autoComplete="off"
              spellCheck={false}
            />
          )}
          <div ref={listRef} className="flex-1 overflow-y-auto mt-1">
            {showLoadingState && (
              <div className="flex items-center gap-2 px-2 py-3 text-xs text-text-tertiary">
                <Loader2 className="w-3 h-3 animate-spin" />
                {t('commandPicker.loading')}
              </div>
            )}
            {showErrorState && (
              <div className="px-2 py-3 text-xs text-accent">{error}</div>
            )}
            {!showLoadingState &&
              !showErrorState &&
              filtered.length === 0 && (
                <div className="px-2 py-3 text-xs text-text-tertiary">
                  {filter ? t('commandPicker.noMatch', { filter }) : t('commandPicker.noCommands')}
                </div>
              )}
            {!showLoadingState &&
              !showErrorState &&
              filtered.map((cmd, i) => (
                <button
                  key={cmd.name}
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
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm text-text-primary">/{cmd.name}</span>
                    {cmd.aliases?.length ? (
                      <span className="text-[11px] text-text-tertiary truncate">
                        {cmd.aliases.map((a) => `/${a}`).join(' ')}
                      </span>
                    ) : null}
                  </div>
                  {cmd.description && (
                    <div className="text-[11px] text-text-tertiary break-words mt-0.5">
                      {cmd.description}
                    </div>
                  )}
                </button>
              ))}
          </div>
        </PopoverContent>
      </Popover>
    )
  },
)

export default CommandPicker
