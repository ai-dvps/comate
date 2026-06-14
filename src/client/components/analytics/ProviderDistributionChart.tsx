/**
 * ProviderDistributionChart — ranked list of providers (Claude / OpenAI /
 * Google / Other) with token-share bars. Ported from the reference app;
 * consumes comate's camelCase ProviderUsageEntry.
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import { Server } from 'lucide-react'

import { cn } from '../ui/utils.js'
import { providerDisplayName } from './analytics-utils.js'
import type { ProviderUsageEntry } from '@server/services/analytics-aggregation.js'

interface ProviderDistributionChartProps {
  providers: ProviderUsageEntry[]
}

const PROVIDER_COLORS: Record<string, string> = {
  claude: 'hsl(var(--color-metric-amber))',
  openai: 'hsl(var(--color-metric-green))',
  google: 'hsl(var(--color-metric-purple))',
  other: 'hsl(var(--color-metric-blue))',
  unknown: 'hsl(var(--color-text-tertiary))',
}

export const ProviderDistributionChart: React.FC<ProviderDistributionChartProps> = ({
  providers,
}) => {
  const { t } = useTranslation('analytics')

  const sortedProviders = [...providers].sort((a, b) => b.tokens - a.tokens)
  const totalTokens = sortedProviders.reduce((sum, provider) => sum + provider.tokens, 0)
  const maxTokens = Math.max(...sortedProviders.map((provider) => provider.tokens), 1)

  if (sortedProviders.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-text-tertiary">
        <Server className="w-10 h-10 opacity-20" />
        <p className="text-[10px] uppercase tracking-wider mt-3">{t('noData')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {sortedProviders.map((provider) => {
        const color = PROVIDER_COLORS[provider.providerId] ?? 'hsl(var(--color-metric-purple))'
        const percentage = totalTokens > 0 ? (provider.tokens / totalTokens) * 100 : 0
        const barWidth = (provider.tokens / maxTokens) * 100

        return (
          <div
            key={provider.providerId}
            className={cn(
              'flex items-center gap-3 p-2.5 rounded-md',
              'transition-colors duration-200',
              'hover:bg-surface-hover/30',
            )}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline justify-between mb-1">
                <span className="text-[11px] font-medium text-text-primary/90 truncate pr-2">
                  {providerDisplayName(provider.providerId)}
                </span>
                <span className="font-mono text-[11px] font-semibold tabular-nums shrink-0 text-text-primary">
                  {provider.tokens.toLocaleString()}
                </span>
              </div>

              <div className="h-1.5 bg-surface-hover/30 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${barWidth}%`, backgroundColor: color, opacity: 0.85 }}
                />
              </div>
            </div>

            <div className="w-28 text-right shrink-0">
              <div className="font-mono text-[10px] text-text-tertiary tabular-nums">
                {percentage.toFixed(1)}%
              </div>
              <div className="text-[10px] text-text-tertiary">
                {t('providerMeta', { sessions: provider.sessions })}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

ProviderDistributionChart.displayName = 'ProviderDistributionChart'
