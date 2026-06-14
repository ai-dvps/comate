import { useState, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover'
import { cn } from './ui/utils'
import { Layers, CircleDot, Archive, FlaskConical, ChevronDown, Check } from 'lucide-react'
import type { SessionStatusFilter as SessionStatusFilterValue } from '../lib/session-filter'

const ICONS = {
  all: Layers,
  active: CircleDot,
  archived: Archive,
  wip: FlaskConical,
}

const OPTIONS: { value: SessionStatusFilterValue; labelKey: string }[] = [
  { value: 'all', labelKey: 'statusFilterAll' },
  { value: 'active', labelKey: 'statusFilterActive' },
  { value: 'archived', labelKey: 'statusFilterArchived' },
  { value: 'wip', labelKey: 'statusFilterWip' },
]

interface SessionStatusFilterControlProps {
  value: SessionStatusFilterValue
  onChange: (value: SessionStatusFilterValue) => void
  disabled?: boolean
  'aria-label': string
}

export default function SessionStatusFilterControl({
  value,
  onChange,
  disabled = false,
  'aria-label': ariaLabel,
}: SessionStatusFilterControlProps) {
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([])

  const activeIndex = OPTIONS.findIndex((o) => o.value === value)
  const ActiveIcon = ICONS[value] ?? CircleDot

  const focusOption = useCallback((index: number) => {
    const normalized = (index + OPTIONS.length) % OPTIONS.length
    optionRefs.current[normalized]?.focus()
  }, [])

  const handleOpenAutoFocus = useCallback(
    (e: Event) => {
      e.preventDefault()
      const target = optionRefs.current[Math.max(0, activeIndex)]
      target?.focus()
    },
    [activeIndex],
  )

  const handleSelect = useCallback(
    (nextValue: SessionStatusFilterValue) => {
      if (nextValue !== value) {
        onChange(nextValue)
      }
      setOpen(false)
    },
    [onChange, value],
  )

  const handleTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setOpen(true)
    }
  }

  const handleOptionKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        focusOption(index + 1)
        break
      case 'ArrowUp':
        e.preventDefault()
        focusOption(index - 1)
        break
      case 'Home':
        e.preventDefault()
        focusOption(0)
        break
      case 'End':
        e.preventDefault()
        focusOption(OPTIONS.length - 1)
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        handleSelect(OPTIONS[index].value)
        break
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-haspopup="listbox"
          onKeyDown={handleTriggerKeyDown}
          className={cn(
            'inline-flex items-center justify-center gap-1 px-2 py-2 rounded-lg border border-border bg-bg text-text-secondary hover:text-text-primary hover:border-border-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.97]',
            open && 'bg-surface-active border-accent/40 text-text-primary',
          )}
        >
          <ActiveIcon className="w-3.5 h-3.5" />
          <ChevronDown
            className={cn(
              'w-3 h-3 opacity-60 transition-transform',
              open && 'rotate-180',
            )}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={6}
        collisionPadding={8}
        onOpenAutoFocus={handleOpenAutoFocus}
        className={cn(
          'bg-surface-active border border-border rounded-lg shadow-lg p-1 z-50 min-w-[180px]',
          'transition-all duration-150 ease-out',
          'data-[state=open]:opacity-100 data-[state=open]:scale-100 data-[state=open]:translate-y-0',
          'data-[state=closed]:opacity-0 data-[state=closed]:scale-95 data-[state=closed]:translate-y-1',
          'origin-(--radix-popover-content-transform-origin)',
        )}
      >
        <div role="listbox" aria-label={ariaLabel} className="space-y-0.5">
          {OPTIONS.map((option, index) => {
            const isActive = option.value === value
            const Icon = ICONS[option.value]
            return (
              <button
                key={option.value}
                ref={(el) => {
                  optionRefs.current[index] = el
                }}
                type="button"
                role="option"
                aria-selected={isActive}
                tabIndex={-1}
                onClick={() => handleSelect(option.value)}
                onKeyDown={(e) => handleOptionKeyDown(e, index)}
                className={cn(
                  'w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs rounded-md transition-colors focus-visible:outline-none focus-visible:bg-surface-hover',
                  isActive
                    ? 'bg-accent/10 text-accent'
                    : 'text-text-secondary hover:bg-surface-hover',
                )}
              >
                <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="flex-1 min-w-0 truncate">{t(option.labelKey)}</span>
                <Check
                  className={cn(
                    'w-3.5 h-3.5 flex-shrink-0 ml-auto',
                    isActive ? 'opacity-100' : 'opacity-0',
                  )}
                />
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
