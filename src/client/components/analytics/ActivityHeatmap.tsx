/**
 * ActivityHeatmap — monthly calendar grid colored by message volume per day.
 * Ported from the reference app; consumes comate's camelCase DailyStatEntry.
 */

import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { Tooltip, TooltipTrigger } from '../ui/tooltip.js'
import { ChartTooltip } from '../ui/chart-tooltip.js'
import { cn } from '../ui/utils.js'
import { formatNumber, getHeatColor } from './analytics-utils.js'
import type { DailyStatEntry } from '@server/services/analytics-aggregation.js'

interface ActivityHeatmapProps {
  data: DailyStatEntry[]
}

/** Parse "YYYY-MM-DD" into a local Date (returns epoch fallback on invalid input). */
function parseDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number)
  const year = y ?? 0
  const month = m ?? 1
  const day = d ?? 1
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return new Date(0)
  }
  return new Date(year, month - 1, day)
}

/** Group DailyStatEntry[] by "YYYY-MM" key, sorted chronologically. */
function groupByMonth(data: DailyStatEntry[]): Map<string, DailyStatEntry[]> {
  const map = new Map<string, DailyStatEntry[]>()
  for (const entry of data) {
    const key = entry.date.slice(0, 7) // "YYYY-MM"
    const arr = map.get(key) ?? []
    arr.push(entry)
    map.set(key, arr)
  }
  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)))
}

interface CalendarDay {
  date: string | null
  dayNum: number
  tokens: number
  messages: number
  durationMs: number
}

const EMPTY_CELL: CalendarDay = {
  date: null,
  dayNum: 0,
  tokens: 0,
  messages: 0,
  durationMs: 0,
}

function buildMonthGrid(yearMonth: string, entries: DailyStatEntry[]): CalendarDay[][] {
  const [year, month] = yearMonth.split('-').map(Number)
  const y = year ?? 2000
  const m = (month ?? 1) - 1

  const firstDay = new Date(y, m, 1)
  const lastDay = new Date(y, m + 1, 0)
  const daysInMonth = lastDay.getDate()
  const startDow = firstDay.getDay()

  const lookup = new Map<number, DailyStatEntry>()
  for (const entry of entries) {
    lookup.set(parseDate(entry.date).getDate(), entry)
  }

  const weeks: CalendarDay[][] = []
  let currentWeek: CalendarDay[] = []

  for (let i = 0; i < startDow; i++) {
    currentWeek.push(EMPTY_CELL)
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const stats = lookup.get(day)
    const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    currentWeek.push({
      date: dateStr,
      dayNum: day,
      tokens: stats?.tokens ?? 0,
      messages: stats?.messages ?? 0,
      durationMs: stats?.durationMs ?? 0,
    })

    if (currentWeek.length === 7) {
      weeks.push(currentWeek)
      currentWeek = []
    }
  }

  if (currentWeek.length > 0) {
    while (currentWeek.length < 7) {
      currentWeek.push(EMPTY_CELL)
    }
    weeks.push(currentWeek)
  }

  return weeks
}

function formatMonthLabel(yearMonth: string): string {
  const [year, month] = yearMonth.split('-').map(Number)
  const date = new Date(year ?? 2000, (month ?? 1) - 1, 1)
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short' }).format(date)
}

const MonthBlock: React.FC<{
  yearMonth: string
  weeks: CalendarDay[][]
  maxActivity: number
  weekdayLabels: string[]
}> = React.memo(({ yearMonth, weeks, maxActivity, weekdayLabels }) => {
  const { t } = useTranslation('analytics')
  const monthLabel = formatMonthLabel(yearMonth)

  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] font-semibold text-text-primary/80 mb-0.5">{monthLabel}</div>

      <div className="grid grid-cols-7 gap-px">
        {weekdayLabels.map((label, i) => (
          <div
            key={i}
            className="w-[14px] h-[14px] flex items-center justify-center text-[8px] font-medium text-text-tertiary/50"
          >
            {label}
          </div>
        ))}
      </div>

      {weeks.map((week, weekIdx) => (
        <div key={weekIdx} className="grid grid-cols-7 gap-px">
          {week.map((cell, dayIdx) => {
            if (cell.date == null) {
              return <div key={dayIdx} className="w-[14px] h-[14px]" />
            }

            const intensity = maxActivity > 0 ? cell.messages / maxActivity : 0
            const heatColor = getHeatColor(intensity)

            return (
              <Tooltip key={dayIdx}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      'w-[14px] h-[14px] rounded-sm cursor-pointer',
                      'transition-transform duration-150',
                      'hover:scale-125 hover:z-10',
                      intensity > 0 && 'hover:ring-1 hover:ring-white/30',
                    )}
                    style={{ backgroundColor: heatColor }}
                    aria-label={`${cell.date}: ${cell.messages} ${t('tooltip.messages')}`}
                  >
                    {cell.dayNum === 1 && (
                      <span className="text-[6px] text-text-primary/40 leading-none flex items-center justify-center h-full">
                        1
                      </span>
                    )}
                  </button>
                </TooltipTrigger>
                <ChartTooltip
                  title={cell.date}
                  rows={[
                    {
                      label: t('tooltip.messages'),
                      value: cell.messages,
                      color: intensity > 0.3 ? 'hsl(var(--color-metric-green))' : undefined,
                    },
                    { label: t('tooltip.tokens'), value: formatNumber(cell.tokens) },
                  ]}
                />
              </Tooltip>
            )
          })}
        </div>
      ))}
    </div>
  )
})

MonthBlock.displayName = 'MonthBlock'

export const ActivityHeatmap: React.FC<ActivityHeatmapProps> = React.memo(({ data }) => {
  const { t } = useTranslation('analytics')

  const weekdayLabels = t('weekdayNamesShort', { returnObjects: true }) as string[]

  const { months, maxActivity, totalMessages } = useMemo(() => {
    const grouped = groupByMonth(data)
    let max = 0
    let total = 0

    const monthEntries: Array<{ key: string; weeks: CalendarDay[][] }> = []
    for (const [key, entries] of grouped) {
      const weeks = buildMonthGrid(key, entries)
      for (const week of weeks) {
        for (const cell of week) {
          if (cell.messages > max) max = cell.messages
          total += cell.messages
        }
      }
      monthEntries.push({ key, weeks })
    }

    return { months: monthEntries, maxActivity: Math.max(max, 1), totalMessages: total }
  }, [data])

  if (data.length === 0) {
    return (
      <div className="text-xs text-text-tertiary italic py-8 text-center">{t('noActivity')}</div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-4">
        {months.map(({ key, weeks }) => (
          <MonthBlock
            key={key}
            yearMonth={key}
            weeks={weeks}
            maxActivity={maxActivity}
            weekdayLabels={weekdayLabels}
          />
        ))}
      </div>

      <div className="flex items-center justify-between pt-3 border-t border-border/30">
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-medium text-text-tertiary">{t('legend.less')}</span>
          <div className="flex gap-0.5">
            {[0, 0.25, 0.5, 0.75, 1].map((intensity) => (
              <div
                key={intensity}
                className="w-3 h-3 rounded-sm"
                style={{ backgroundColor: getHeatColor(intensity) }}
              />
            ))}
          </div>
          <span className="text-[9px] font-medium text-text-tertiary">{t('legend.more')}</span>
        </div>

        <span className="text-[9px] font-mono text-text-tertiary">
          {t('calendarTotal', { count: totalMessages })}
        </span>
      </div>
    </div>
  )
})

ActivityHeatmap.displayName = 'ActivityHeatmap'
