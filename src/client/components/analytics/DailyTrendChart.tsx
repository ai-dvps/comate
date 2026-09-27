/**
 * DailyTrendChart — compact bar chart for daily activity.
 * Ported from the reference app; consumes comate's camelCase DailyStatEntry.
 */

import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { Tooltip, TooltipTrigger } from '../ui/tooltip.js'
import { ChartTooltip } from '../ui/chart-tooltip.js'
import { formatNumber } from './analytics-utils.js'
import type { DailyStatEntry } from '@server/services/analytics-aggregation.js'

interface DailyTrendChartProps {
  dailyData: DailyStatEntry[]
}

const BAR_HEIGHT = 48 // px

export const DailyTrendChart: React.FC<DailyTrendChartProps> = ({ dailyData }) => {
  const { t } = useTranslation('analytics')

  const today = useMemo(() => new Date().toISOString().split('T')[0], [])

  if (!dailyData.length) {
    return <div className="text-xs text-text-tertiary italic py-4 text-center">{t('noActivity')}</div>
  }

  const maxTokens = Math.max(...dailyData.map((d) => d.tokens), 1)
  const totalTokens = dailyData.reduce((sum, d) => sum + d.tokens, 0)
  const totalMessages = dailyData.reduce((sum, d) => sum + d.messages, 0)
  const activeDays = dailyData.filter((d) => d.tokens > 0).length

  const getDayName = (dateStr: string) => {
    const dayNames = t('weekdayNamesShort', { returnObjects: true }) as string[]
    const day = new Date(dateStr).getDay()
    return dayNames[day] || ''
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-thin">
        {dailyData.map((stat) => {
          const isToday = stat.date === today
          const ratio = stat.tokens / maxTokens
          const barHeight = stat.tokens > 0 ? Math.max(ratio * BAR_HEIGHT, 4) : 2
          const hasActivity = stat.tokens > 0

          return (
            <Tooltip key={stat.date}>
              <TooltipTrigger asChild>
                <div className="flex-1 min-w-[12px] flex flex-col items-center cursor-pointer group">
                  <div
                    className="w-full flex items-end justify-center"
                    style={{ height: `${BAR_HEIGHT}px` }}
                  >
                    <div
                      className="w-full max-w-[20px] rounded-t-sm transition-all duration-200 group-hover:brightness-110"
                      style={{
                        height: `${barHeight}px`,
                        backgroundColor: isToday
                          ? 'hsl(var(--color-metric-green))'
                          : hasActivity
                            ? 'hsl(var(--color-metric-green) / 0.5)'
                            : 'hsl(var(--color-text-tertiary) / 0.15)',
                      }}
                    />
                  </div>
                  <span
                    className="text-[9px] font-mono tabular-nums mt-1 whitespace-nowrap"
                    style={{
                      fontWeight: isToday ? 600 : 400,
                      color: isToday
                        ? 'hsl(var(--color-metric-green))'
                        : 'hsl(var(--color-text-tertiary))',
                      opacity: isToday ? 1 : 0.5,
                    }}
                  >
                    {stat.date?.slice(8)}
                  </span>
                </div>
              </TooltipTrigger>
              <ChartTooltip
                title={stat.date}
                subtitle={`(${getDayName(stat.date)})`}
                className="z-50"
                rows={[
                  {
                    label: t('tooltip.tokens'),
                    value: formatNumber(stat.tokens),
                    color: 'hsl(var(--color-metric-green))',
                  },
                  { label: t('tooltip.messages'), value: stat.messages },
                ]}
              />
            </Tooltip>
          )
        })}
      </div>

      <div className="flex items-center justify-between text-[10px] pt-2 border-t border-border/20">
        <div className="flex items-center gap-4">
          <div>
            <span className="text-text-tertiary">{t('dailyAvgTokens')}: </span>
            <span className="font-mono font-semibold text-text-primary">
              {formatNumber(Math.round(totalTokens / dailyData.length))}
            </span>
          </div>
          <div>
            <span className="text-text-tertiary">{t('dailyAvgMessages')}: </span>
            <span className="font-mono font-semibold text-text-primary">
              {Math.round(totalMessages / dailyData.length)}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-text-tertiary/60">
          <div
            className="w-1.5 h-1.5 rounded-full"
            style={{ backgroundColor: 'hsl(var(--color-metric-green))' }}
          />
          <span>
            {activeDays}/{dailyData.length} {t('activeDays')}
          </span>
        </div>
      </div>
    </div>
  )
}

DailyTrendChart.displayName = 'DailyTrendChart'
