/**
 * CostBreakdownCard — estimated-cost summary with pricing-coverage indicator.
 *
 * Comate's analog of the reference app's BillingBreakdownCard. The reference
 * splits tokens into billing_total vs conversation_only (a distinction rooted
 * in the Claude Code CLI's sidechain metadata); comate transcripts don't
 * carry that distinction (probe during planning found no `result`-typed
 * entries and no per-turn cost field), so this card instead surfaces what
 * R11 requires: estimated cost, plus a coverage indicator showing the share
 * of tokens whose model pricing is known.
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import { Activity } from 'lucide-react'

import { formatCurrency, formatNumber } from './analytics-utils.js'
import { SectionCard } from './SectionCard.js'

interface CostBreakdownCardProps {
  estimatedCostUsd: number
  costCoveragePercent: number
  totalTokens: number
  className?: string
}

export const CostBreakdownCard: React.FC<CostBreakdownCardProps> = ({
  estimatedCostUsd,
  costCoveragePercent,
  totalTokens,
  className,
}) => {
  const { t } = useTranslation('analytics')
  const coverage = Math.max(0, Math.min(100, costCoveragePercent))
  const uncovered = 100 - coverage

  return (
    <SectionCard
      title={t('estimatedCost')}
      icon={Activity}
      colorVariant="blue"
      className={className}
    >
      <div className="space-y-3">
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-2xl font-bold text-text-primary tabular-nums">
            {formatCurrency(estimatedCostUsd)}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-text-tertiary">
            {t('estimated')}
          </span>
        </div>

        <p className="text-[11px] text-text-tertiary">{t('coverageHelp')}</p>

        <div>
          <div className="flex items-baseline justify-between mb-1">
            <span className="text-[11px] font-medium text-text-primary/80">
              {t('pricingCoverage')}
            </span>
            <span className="font-mono text-[11px] text-text-tertiary tabular-nums">
              {coverage.toFixed(1)}%
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-surface-hover/30 overflow-hidden flex">
            <div
              className="h-full transition-all duration-300"
              style={{
                width: `${coverage}%`,
                backgroundColor: 'hsl(var(--color-metric-green))',
              }}
            />
            <div
              className="h-full transition-all duration-300"
              style={{
                width: `${uncovered}%`,
                backgroundColor: 'hsl(var(--color-metric-amber))',
              }}
            />
          </div>
          <div className="flex items-center justify-between mt-1">
            <span className="text-[10px] text-text-tertiary">
              {formatNumber(totalTokens)} {t('tooltip.tokens')}
            </span>
            <span className="text-[10px] text-text-tertiary">
              {coverage < 100
                ? t('partialCoverageNote')
                : t('fullCoverageNote')}
            </span>
          </div>
        </div>
      </div>
    </SectionCard>
  )
}

CostBreakdownCard.displayName = 'CostBreakdownCard'
