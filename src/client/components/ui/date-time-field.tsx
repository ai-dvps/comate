'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import i18next from 'i18next'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'

import { cn } from './utils'
import { Popover, PopoverContent, PopoverTrigger } from './popover'

const triggerCls =
  'flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary shadow-sm transition-colors focus:outline-none focus:border-accent data-[placeholder]:text-text-tertiary'
const panelCls = 'z-50 rounded-lg border border-border bg-surface p-2 text-text-primary shadow-lg'
const dayCellBase =
  'flex h-7 w-7 items-center justify-center rounded-md text-xs transition-colors focus:outline-none'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function toLocalValue(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function parseLocalValue(v: string): Date | null {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Weeks start Monday; returns up to 6 rows of 7 dates covering the month. */
function monthGrid(year: number, month: number): Date[][] {
  const first = new Date(year, month, 1)
  // Monday=0 ... Sunday=6
  const lead = (first.getDay() + 6) % 7
  const start = new Date(year, month, 1 - lead)
  const weeks: Date[][] = []
  for (let w = 0; w < 6; w++) {
    const week: Date[] = []
    for (let d = 0; d < 7; d++) {
      week.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d))
    }
    weeks.push(week)
    if (week[6].getMonth() !== month) break
  }
  return weeks
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function useLocaleBits(): { monthLabel: (d: Date) => string; weekdayInitials: string[] } {
  const { i18n } = useTranslation()
  return useMemo(() => {
    const lang = i18n.language
    const monthFmt = new Intl.DateTimeFormat(lang, { year: 'numeric', month: 'long' })
    const dayFmt = new Intl.DateTimeFormat(lang, { weekday: 'short' })
    // 2026-06-01 is a Monday
    const monday = new Date(2026, 5, 1)
    return {
      monthLabel: (d: Date) => monthFmt.format(d),
      weekdayInitials: Array.from({ length: 7 }, (_, i) => dayFmt.format(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i))),
    }
  }, [i18n.language])
}

interface CalendarProps {
  value: Date | null
  onSelect: (day: Date) => void
  minDate?: Date
}

function Calendar({ value, onSelect, minDate }: CalendarProps) {
  const today = useMemo(() => new Date(), [])
  const [cursor, setCursor] = useState(() => value ?? today)
  const { monthLabel, weekdayInitials } = useLocaleBits()
  const weeks = useMemo(() => monthGrid(cursor.getFullYear(), cursor.getMonth()), [cursor])

  const isDisabled = (day: Date): boolean => {
    if (!minDate) return false
    const a = new Date(day.getFullYear(), day.getMonth(), day.getDate())
    const b = new Date(minDate.getFullYear(), minDate.getMonth(), minDate.getDate())
    return a.getTime() < b.getTime()
  }

  return (
    <div className="w-[240px]" data-testid="dtf-calendar">
      <div className="mb-1 flex items-center justify-between px-1">
        <button
          type="button"
          className="rounded-md p-1 text-text-tertiary hover:bg-surface-hover hover:text-text-secondary"
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
          aria-label="previous month"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="text-xs font-medium text-text-primary">{monthLabel(cursor)}</div>
        <button
          type="button"
          className="rounded-md p-1 text-text-tertiary hover:bg-surface-hover hover:text-text-secondary"
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
          aria-label="next month"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      <div className="mb-1 grid grid-cols-7 gap-0.5 px-1">
        {weekdayInitials.map((w, i) => (
          <div key={i} className="flex h-6 items-center justify-center text-[10px] text-text-tertiary">
            {w}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-0.5 px-1">
        {weeks.flat().map((day, i) => {
          const inMonth = day.getMonth() === cursor.getMonth()
          const selected = value !== null && sameDay(day, value)
          const isToday = sameDay(day, today)
          const disabled = isDisabled(day)
          return (
            <button
              key={i}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(day)}
              className={cn(
                dayCellBase,
                inMonth ? 'text-text-primary' : 'text-text-tertiary opacity-50',
                isToday && !selected && 'ring-1 ring-accent/60',
                selected ? 'bg-accent text-white hover:bg-accent/90' : !disabled && 'hover:bg-surface-hover',
                disabled && 'cursor-not-allowed opacity-30 hover:bg-transparent',
              )}
            >
              {day.getDate()}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function TimeColumns({
  hour,
  minute,
  onChange,
  nowLabel = i18next.t('scheduledTasks:picker.now', 'Now'),
}: {
  hour: number
  minute: number
  onChange: (h: number, m: number) => void
  nowLabel?: string
}) {
  const [text, setText] = useState(`${pad(hour)}:${pad(minute)}`)
  const [textError, setTextError] = useState(false)
  const hourRef = useRef<HTMLButtonElement>(null)
  const minuteRef = useRef<HTMLButtonElement>(null)

  // Selected values scroll into view when the popover opens (eleken anti-pattern:
  // "scrolling endlessly" — the list should start centered on the current value).
  useEffect(() => {
    hourRef.current?.scrollIntoView({ block: 'center' })
    minuteRef.current?.scrollIntoView({ block: 'center' })
  }, [])

  useEffect(() => {
    setText(`${pad(hour)}:${pad(minute)}`)
    setTextError(false)
  }, [hour, minute])

  const commitText = () => {
    const m = text.trim().match(/^(\d{1,2}):(\d{1,2})$/)
    const h = m ? Number(m[1]) : NaN
    const min = m ? Number(m[2]) : NaN
    if (m && h >= 0 && h <= 23 && min >= 0 && min <= 59) {
      onChange(h, min)
      setTextError(false)
    } else {
      setTextError(true)
    }
  }

  // 5-minute steps (common-intervals pattern); the current minute is always
  // present even when not a multiple of 5 so the selection never disappears.
  const minuteOptions = useMemo(() => {
    const set = new Set<number>(Array.from({ length: 12 }, (_, i) => i * 5))
    set.add(minute)
    return [...set].sort((a, b) => a - b)
  }, [minute])

  return (
    <div data-testid="dtf-time">
      <div className="mb-1.5 flex items-center gap-1.5 border-t border-border pt-2">
        <input
          data-testid="dtf-time-input"
          className={cn(
            'w-16 rounded-md border bg-bg px-1.5 py-1 text-center text-xs text-text-primary focus:outline-none focus:border-accent',
            textError ? 'border-red-500' : 'border-border',
          )}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitText()
          }}
          placeholder="HH:mm"
        />
        <button
          type="button"
          className="rounded-md px-2 py-1 text-xs text-accent hover:bg-accent/10"
          onClick={() => {
            const now = new Date()
            onChange(now.getHours(), now.getMinutes())
          }}
        >
          {nowLabel}
        </button>
      </div>
      <div className="flex gap-1">
        <div className="max-h-32 w-14 overflow-y-auto rounded-md border border-border" data-testid="dtf-hour-col">
          {Array.from({ length: 24 }, (_, h) => (
            <button
              key={h}
              type="button"
              ref={h === hour ? hourRef : undefined}
              onClick={() => onChange(h, minute)}
              className={cn(
                'flex w-full items-center justify-center py-1 text-xs',
                h === hour ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-surface-hover',
              )}
            >
              {pad(h)}
            </button>
          ))}
        </div>
        <div className="max-h-32 w-14 overflow-y-auto rounded-md border border-border" data-testid="dtf-minute-col">
          {minuteOptions.map((m) => (
            <button
              key={m}
              type="button"
              ref={m === minute ? minuteRef : undefined}
              onClick={() => onChange(hour, m)}
              className={cn(
                'flex w-full items-center justify-center py-1 text-xs',
                m === minute ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-surface-hover',
              )}
            >
              {pad(m)}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export interface DateTimeFieldProps {
  /** "YYYY-MM-DDTHH:mm" local value; '' when empty. */
  value: string
  onChange: (value: string) => void
  /** Earliest selectable day (date part only compared). */
  min?: Date
  placeholder?: string
}

/** Comate-styled date+time picker: popover calendar with hour/minute columns. */
export function DateTimeField({ value, onChange, min, placeholder }: DateTimeFieldProps) {
  const [open, setOpen] = useState(false)
  const parsed = parseLocalValue(value)
  const display = parsed ? `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}` : (placeholder ?? '')

  const commit = (day: Date | null, hour: number, minute: number) => {
    if (!day) return
    onChange(toLocalValue(new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute)))
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={triggerCls} data-placeholder={parsed ? undefined : true}>
          <span className="truncate">{display}</span>
          <ChevronDown className="h-4 w-4 flex-shrink-0 text-text-tertiary opacity-70" />
        </button>
      </PopoverTrigger>
      <PopoverContent className={panelCls} align="start" sideOffset={4}>
        <Calendar
          value={parsed}
          minDate={min}
          onSelect={(day) => {
            const h = parsed?.getHours() ?? new Date().getHours()
            const m = parsed?.getMinutes() ?? 0
            commit(day, h, m)
          }}
        />
        <TimeColumns
          hour={parsed?.getHours() ?? new Date().getHours()}
          minute={parsed?.getMinutes() ?? 0}
          onChange={(h, m) => commit(parsed ?? new Date(), h, m)}
        />
      </PopoverContent>
    </Popover>
  )
}

export interface TimeFieldProps {
  /** "HH:mm" value. */
  value: string
  onChange: (value: string) => void
}

/** Comate-styled time-of-day picker: popover with hour/minute columns. */
export function TimeField({ value, onChange }: TimeFieldProps) {
  const [open, setOpen] = useState(false)
  const [h, m] = value.split(':').map(Number)
  const hour = Number.isFinite(h) ? h : 9
  const minute = Number.isFinite(m) ? m : 0

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={triggerCls}>
          <span>{`${pad(hour)}:${pad(minute)}`}</span>
          <ChevronDown className="h-4 w-4 flex-shrink-0 text-text-tertiary opacity-70" />
        </button>
      </PopoverTrigger>
      <PopoverContent className={panelCls} align="start" sideOffset={4}>
        <div className="w-[120px]">
          <TimeColumns hour={hour} minute={minute} onChange={(nh, nm) => onChange(`${pad(nh)}:${pad(nm)}`)} />
        </div>
      </PopoverContent>
    </Popover>
  )
}
