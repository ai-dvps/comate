/**
 * MetricCard — headline metric display with accent icon and optional trend.
 * Ported from the reference app, adapted to comate's color tokens.
 */

import React from 'react'
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'

import { cn } from '../ui/utils.js'
import { metricColor, type MetricColorVariant } from './analytics-utils.js'
import type { MetricCardProps } from './types.js'

export const MetricCard: React.FC<MetricCardProps> = ({
  icon: Icon,
  label,
  value,
  subValue,
  trend,
  colorVariant,
}) => {
  const colorVar = metricColor(colorVariant as MetricColorVariant)

  return (
    <div
      className={cn(
        'group relative overflow-hidden',
        'rounded-lg',
        'bg-surface/80 backdrop-blur-sm',
        'border border-border/40',
        'transition-all duration-300',
        'hover:bg-surface hover:border-border/60',
      )}
    >
      <div className="relative p-3 md:p-5 flex flex-col h-full">
        {/* Top row: Icon + Trend */}
        <div className="flex items-start justify-between mb-3">
          <div
            className="w-8 h-8 md:w-10 md:h-10 rounded-lg flex items-center justify-center"
            style={{
              background: `color-mix(in oklch, ${colorVar} 15%, transparent)`,
            }}
          >
            <Icon className="w-4 h-4 md:w-5 md:h-5" style={{ color: colorVar }} />
          </div>

          {trend !== undefined && (
            <div
              className={cn(
                'flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold',
                trend > 0
                  ? 'bg-success/10 text-success'
                  : trend < 0
                    ? 'bg-destructive/10 text-destructive'
                    : 'bg-surface-active text-text-tertiary',
              )}
            >
              {trend > 0 ? (
                <ArrowUpRight className="w-3 h-3" />
              ) : trend < 0 ? (
                <ArrowDownRight className="w-3 h-3" />
              ) : (
                <Minus className="w-3 h-3" />
              )}
              <span>{Math.abs(trend)}%</span>
            </div>
          )}
        </div>

        {/* Value */}
        <div className="font-mono text-xl md:text-3xl font-bold tracking-tight text-text-primary mb-1 tabular-nums">
          {value}
        </div>

        {/* Label */}
        <div className="text-[11px] font-medium text-text-tertiary uppercase tracking-wider mb-auto">
          {label}
        </div>

        {/* Sub value */}
        {subValue && (
          <div className="mt-3 pt-3 border-t border-border/30">
            <div className="font-mono text-[11px] text-text-tertiary/70">{subValue}</div>
          </div>
        )}
      </div>
    </div>
  )
}

MetricCard.displayName = 'MetricCard'
