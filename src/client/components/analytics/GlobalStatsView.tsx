/**
 * GlobalStatsView — dashboard across all comate workspaces (R3, R4, R5).
 *
 * Assembles MetricCards (headline), CostBreakdownCard (estimated cost +
 * coverage), provider/model/tool distribution sections, the activity
 * heatmap, and a top-workspaces ranking. Receives the rolled-up
 * GlobalStatsSummary from the store; rendering only.
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, BarChart3, Clock, Cpu, Layers, MessageCircle, Server, Wrench } from 'lucide-react'

import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.js'
import { cn } from '../ui/utils.js'
import {
  ActivityHeatmap,
  CostBreakdownCard,
  MetricCard,
  ProviderDistributionChart,
  SectionCard,
  ToolUsageChart,
  formatCurrency,
  formatDuration,
  formatNumber,
} from './index.js'
import type { GlobalStatsSummary } from '@server/services/analytics-aggregation.js'

interface GlobalStatsViewProps {
  summary: GlobalStatsSummary
}

export const GlobalStatsView: React.FC<GlobalStatsViewProps> = ({ summary }) => {
  const { t } = useTranslation('analytics')

  return (
    <div className="flex-1 p-3 md:p-6 overflow-auto space-y-4 md:space-y-6">
      {/* Headline metric cards (R4) */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
        <MetricCard
          icon={Activity}
          label={t('totalTokens')}
          value={formatNumber(summary.totalTokens)}
          subValue={`${t('estimatedCost')}: ${formatCurrency(summary.estimatedCostUsd)}`}
          colorVariant="blue"
        />
        <MetricCard
          icon={MessageCircle}
          label={t('totalMessages')}
          value={formatNumber(summary.totalMessages)}
          subValue={`${t('totalSessions')}: ${summary.totalSessions}`}
          colorVariant="purple"
        />
        <MetricCard
          icon={Clock}
          label={t('totalDuration')}
          value={formatDuration(summary.totalDurationMs)}
          colorVariant="green"
        />
        <MetricCard
          icon={Wrench}
          label={t('toolsUsed')}
          value={summary.distinctToolsUsed}
          colorVariant="amber"
        />
      </div>

      {/* Cost + coverage (R11) */}
      <CostBreakdownCard
        estimatedCostUsd={summary.estimatedCostUsd}
        costCoveragePercent={summary.costCoveragePercent}
        totalTokens={summary.totalTokens}
      />

      {/* Provider distribution + Model distribution + Tools (R5) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {summary.providerDistribution.length > 0 && (
          <SectionCard title={t('providerDistribution')} icon={Server} colorVariant="green">
            <ProviderDistributionChart providers={summary.providerDistribution} />
          </SectionCard>
        )}

        {summary.modelDistribution.length > 0 && (
          <SectionCard title={t('modelDistribution')} icon={Cpu} colorVariant="blue">
            <div className="space-y-3">
              {summary.modelDistribution.slice(0, 6).map((model) => {
                const percentage =
                  summary.totalTokens > 0
                    ? (model.totalTokens / summary.totalTokens) * 100
                    : 0
                return (
                  <div key={model.model}>
                    <div className="flex items-center justify-between mb-1.5">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="block max-w-[60%] text-[12px] font-medium text-text-primary truncate text-left cursor-default"
                          >
                            {model.model}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>{model.model}</TooltipContent>
                      </Tooltip>
                      <span className="font-mono text-[12px] font-semibold text-text-primary">
                        {formatNumber(model.totalTokens)}
                      </span>
                    </div>
                    <div className="h-2 bg-surface-hover/30 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${percentage}%`,
                          background:
                            'linear-gradient(90deg, hsl(var(--color-metric-purple)), hsl(var(--color-metric-blue)))',
                        }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </SectionCard>
        )}

        <SectionCard title={t('mostUsedTools')} icon={Wrench} colorVariant="amber">
          <ToolUsageChart tools={summary.mostUsedTools} />
        </SectionCard>
      </div>

      {/* Heatmap + Top workspaces (R5) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <SectionCard title={t('activityHeatmap')} icon={Layers} colorVariant="green">
          <ActivityHeatmap data={summary.dailyStats} />
        </SectionCard>

        {summary.topWorkspaces.length > 0 && (
          <SectionCard title={t('topWorkspaces')} icon={BarChart3} colorVariant="purple">
            <div className="space-y-2">
              {summary.topWorkspaces.slice(0, 8).map((ws, index) => (
                <div
                  key={ws.workspaceId}
                  className={cn(
                    'flex items-center justify-between p-2.5 rounded-lg',
                    'bg-surface-hover/30 hover:bg-surface-hover/50 transition-colors',
                  )}
                >
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="w-6 h-6 rounded-md flex items-center justify-center text-[12px] font-bold bg-surface-active text-text-tertiary">
                      {index + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="block w-full text-[12px] font-medium text-text-primary truncate text-left cursor-default"
                          >
                            {ws.workspaceName}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>{ws.workspaceName}</TooltipContent>
                      </Tooltip>
                      <p className="text-[12px] text-text-tertiary">
                        {t('topWorkspaceMeta', {
                          sessions: ws.sessions,
                          messages: ws.messages,
                        })}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-[12px] font-bold text-text-primary">
                      {formatNumber(ws.tokens)}
                    </p>
                    <p className="text-[12px] text-text-tertiary">{t('tooltip.tokens')}</p>
                  </div>
                </div>
              ))}
            </div>
          </SectionCard>
        )}
      </div>
    </div>
  )
}

GlobalStatsView.displayName = 'GlobalStatsView'
