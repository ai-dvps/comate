/**
 * WorkspaceStatsView — dashboard for a single workspace (R7, R8, R11).
 *
 * Workspace-scoped analog of GlobalStatsView. Assembles MetricCards (with
 * 7-day token-growth trend when available), the cost + coverage card, an
 * activity-heatmap + tool-usage grid, the daily-trend bar chart, and a
 * token-distribution donut. Receives the rolled-up WorkspaceStatsSummary
 * from the store; rendering only — selector + loading/error states are
 * the parent modal's responsibility (U6).
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, Clock, Database, Layers, MessageCircle, TrendingUp, Wrench } from 'lucide-react'

import {
  ActivityHeatmap,
  CostBreakdownCard,
  DailyTrendChart,
  MetricCard,
  SectionCard,
  TokenDistributionChart,
  ToolUsageChart,
  formatDuration,
  formatNumber,
} from './index.js'
import type { WorkspaceStatsSummary } from '@server/services/analytics-aggregation.js'

interface WorkspaceStatsViewProps {
  summary: WorkspaceStatsSummary
}

export const WorkspaceStatsView: React.FC<WorkspaceStatsViewProps> = ({ summary }) => {
  const { t } = useTranslation('analytics')

  // recentGrowth is computed from the last 14 days of dailyStats; it tracks
  // tokens (not messages) so only the token card carries the trend chip.
  const tokenGrowth = summary.recentGrowth?.percentDelta

  return (
    <div className="flex-1 p-3 md:p-6 overflow-auto space-y-4 md:space-y-6">
      {/* Headline metric cards (R7) */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
        <MetricCard
          icon={MessageCircle}
          label={t('totalMessages')}
          value={formatNumber(summary.totalMessages)}
          colorVariant="purple"
        />
        <MetricCard
          icon={Activity}
          label={t('totalTokens')}
          value={formatNumber(summary.totalTokens)}
          trend={tokenGrowth}
          subValue={`${t('totalSessions')}: ${summary.totalSessions}`}
          colorVariant="blue"
        />
        <MetricCard
          icon={Clock}
          label={t('totalDuration')}
          value={formatDuration(summary.totalDurationMs)}
          subValue={`${t('avgDuration')}: ${formatDuration(summary.averageDurationMs)}`}
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

      {/* Heatmap + Tools (R8) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <SectionCard title={t('activityHeatmap')} icon={Layers} colorVariant="green">
          <ActivityHeatmap data={summary.dailyStats} />
        </SectionCard>

        <SectionCard title={t('mostUsedTools')} icon={Wrench} colorVariant="amber">
          <ToolUsageChart tools={summary.mostUsedTools} />
        </SectionCard>
      </div>

      {/* Daily trend (R8) */}
      {summary.dailyStats.length > 0 && (
        <SectionCard title={t('recentActivityTrend')} icon={TrendingUp} colorVariant="blue">
          <DailyTrendChart dailyData={summary.dailyStats} />
        </SectionCard>
      )}

      {/* Token distribution (R8) */}
      <SectionCard title={t('tokenTypeDistribution')} icon={Database} colorVariant="amber">
        <TokenDistributionChart distribution={summary.tokenDistribution} total={summary.totalTokens} />
      </SectionCard>
    </div>
  )
}

WorkspaceStatsView.displayName = 'WorkspaceStatsView'
