/**
 * Analytics formatting + display helpers (see plan 2026-06-13-007, U4).
 *
 * Ported from the reference app's `utils/calculations.ts` minus the pricing
 * table (which lives server-side in `analytics-pricing.ts`). Client-side code
 * never computes cost — it receives the computed `estimatedCostUsd` from the
 * server and only formats it.
 */

/**
 * Percentage growth between two values. Returns 0 when `previous` is 0 to
 * match the reference app's `calculateGrowthRate` behavior (avoids Infinity).
 */
export function calculateGrowthRate(current: number, previous: number): number {
  if (previous === 0) return 0
  return Math.round(((current - previous) / previous) * 100)
}

/**
 * Compact formatter for large numbers (e.g. 12_400 → "12.4K", 1_200_000 → "1.2M").
 */
export function formatNumber(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`
  return num.toString()
}

/**
 * USD currency formatter. Drops cents above $100 for readability.
 */
export function formatCurrency(value: number): string {
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: value >= 100 ? 0 : 2,
    maximumFractionDigits: value >= 100 ? 0 : 2,
  })}`
}

/**
 * Format a millisecond duration as a human label (e.g. "1h 23m", "45m", "12s").
 */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '0s'
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m`
  return `${seconds}s`
}

/**
 * Heat color for an activity intensity (0..1) using comate's CSS theme tokens.
 * Returns a fully-resolved `hsl(...)` color string safe for inline styles.
 */
export function getHeatColor(intensity: number): string {
  if (intensity === 0) return 'hsl(var(--color-heatmap-empty))'
  if (intensity <= 0.3) return 'hsl(var(--color-heatmap-low))'
  if (intensity <= 0.6) return 'hsl(var(--color-heatmap-medium))'
  return 'hsl(var(--color-heatmap-high))'
}

/**
 * Metric accent color CSS value for a named variant. Returns a fully-resolved
 * `hsl(...)` color string. Used by MetricCard / SectionCard headers.
 */
export type MetricColorVariant = 'green' | 'purple' | 'blue' | 'amber' | 'orange' | 'pink'

export function metricColor(variant: MetricColorVariant): string {
  return `hsl(var(--color-metric-${variant}))`
}

/**
 * Provider display name from a providerId. Mirrors the reference's labels.
 */
export function providerDisplayName(providerId: string): string {
  switch (providerId) {
    case 'claude':
      return 'Claude Code'
    case 'openai':
      return 'Codex CLI'
    case 'google':
      return 'OpenCode'
    case 'other':
      return 'Other'
    case 'unknown':
    default:
      return 'Unknown'
  }
}

/**
 * Distinct, stable color for a tool or model name. Used for chart series.
 * Returns fully-resolved `hsl(...)` strings safe for inline styles.
 */
const CHART_COLORS = [
  'hsl(var(--color-metric-blue))',
  'hsl(var(--color-metric-green))',
  'hsl(var(--color-metric-purple))',
  'hsl(var(--color-metric-orange))',
  'hsl(var(--color-metric-pink))',
  'hsl(var(--color-metric-cyan))',
  'hsl(var(--color-metric-yellow))',
  'hsl(var(--color-metric-red))',
]

export function colorForIndex(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length]!
}
