/**
 * Analytics component barrel.
 *
 * Shared presentational components for the Global and Workspace dashboards.
 * See plan 2026-06-13-007 U4. All components are presentational — they
 * receive data via props and emit no IO. Behavioral state (loading, error,
 * workspace selection) lives in the views (U5) and store (U3).
 */

export { ActivityHeatmap } from './ActivityHeatmap.js'
export { AnalyticsEmptyState } from './AnalyticsEmptyState.js'
export { CostBreakdownCard } from './CostBreakdownCard.js'
export { DailyTrendChart } from './DailyTrendChart.js'
export { GlobalStatsView } from './GlobalStatsView.js'
export { MetricCard } from './MetricCard.js'
export { ProviderDistributionChart } from './ProviderDistributionChart.js'
export { SectionCard } from './SectionCard.js'
export { TokenDistributionChart } from './TokenDistributionChart.js'
export type { TokenDistribution } from './TokenDistributionChart.js'
export { ToolUsageChart } from './ToolUsageChart.js'
export { WorkspaceSelector } from './WorkspaceSelector.js'
export { WorkspaceStatsView } from './WorkspaceStatsView.js'

export type {
  MetricCardProps,
  SectionCardProps,
  SectionColorVariant,
} from './types.js'

export type { MetricColorVariant } from './analytics-utils.js'
export {
  calculateGrowthRate,
  colorForIndex,
  formatCurrency,
  formatDuration,
  formatNumber,
  getHeatColor,
  getRankMedal,
  metricColor,
  providerDisplayName,
} from './analytics-utils.js'
