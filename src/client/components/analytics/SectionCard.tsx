/**
 * SectionCard — wrapper card with header (icon + title) and accent color.
 * Ported from the reference app, adapted to comate's color tokens.
 */

import React from 'react'

import { cn } from '../ui/utils.js'
import { metricColor } from './analytics-utils.js'
import type { SectionCardProps } from './types.js'

export const SectionCard: React.FC<SectionCardProps> = ({
  title,
  icon: Icon,
  colorVariant = 'accent',
  children,
  className,
}) => {
  const colorVar =
    colorVariant === 'accent'
      ? 'hsl(var(--color-accent))'
      : metricColor(colorVariant)

  return (
    <div
      className={cn(
        'relative overflow-hidden',
        'rounded-lg',
        'bg-surface/80 backdrop-blur-sm',
        'border border-border/40',
        'transition-all duration-300',
        'hover:bg-surface hover:border-border/60',
        className,
      )}
    >
      <div className="p-3 md:p-5">
        <div className="flex items-center gap-3 mb-4">
          {Icon && (
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{
                background: `color-mix(in oklch, ${colorVar} 15%, transparent)`,
              }}
            >
              <Icon className="w-4 h-4" style={{ color: colorVar }} />
            </div>
          )}
          <h3 className="text-[11px] font-bold text-text-primary/90 uppercase tracking-[0.12em] truncate flex-1">
            {title}
          </h3>
        </div>

        {children}
      </div>
    </div>
  )
}

SectionCard.displayName = 'SectionCard'
