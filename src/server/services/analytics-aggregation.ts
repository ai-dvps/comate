/**
 * Pure rollup of cached session rows into Global/Workspace summaries
 * (see plan 2026-06-13-007, U2).
 *
 * The cache stores one row per session with all per-session aggregates
 * pre-computed by `analytics-transcript-reader.ts`. Rollup is pure summation
 * plus a small set of distribution merges (model/provider/tool maps, daily
 * buckets, 7×24 heatmap grid). No filesystem or SDK access here — this is
 * the unit-testable core.
 *
 * Output types are comate-native camelCase (the reference app uses
 * snake_case types because its data is server-backed; comate is TS-native).
 */

import type {
  DailyStatEntry,
  HeatmapCell,
  ModelUsageEntry,
  SessionAnalyticsRow,
  ToolUsageEntry,
} from '../storage/analytics-cache.js';
import { inferProviderId } from './analytics-pricing.js';

// Re-export the cache-layer types that appear in summary shapes so consumers
// (notably the client components) have a single import surface.
export type {
  DailyStatEntry,
  HeatmapCell,
  ModelUsageEntry,
  ToolUsageEntry,
} from '../storage/analytics-cache.js';

export interface WorkspaceStatsSummary {
  workspaceId: string;
  workspaceName: string;
  totalSessions: number;
  totalMessages: number;
  totalTokens: number;
  estimatedCostUsd: number;
  costCoveragePercent: number;
  totalDurationMs: number;
  averageDurationMs: number;
  distinctToolsUsed: number;
  mostUsedTools: ToolUsageEntry[];
  dailyStats: DailyStatEntry[];
  activityHeatmap: HeatmapCell[];
  tokenDistribution: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
  };
  /** Last 7 days vs prior 7 days, computed from `dailyStats`. Null when no prior window. */
  recentGrowth: {
    current: number;
    previous: number;
    /** Percentage delta; 0 when previous is 0 (matches `calculateGrowthRate` in reference). */
    percentDelta: number;
  } | null;
}

export interface ProviderUsageEntry {
  providerId: string;
  sessions: number;
  messages: number;
  tokens: number;
}

export interface WorkspaceRankingEntry {
  workspaceId: string;
  workspaceName: string;
  sessions: number;
  messages: number;
  tokens: number;
}

export interface GlobalStatsSummary {
  totalWorkspaces: number;
  totalSessions: number;
  totalMessages: number;
  totalTokens: number;
  estimatedCostUsd: number;
  costCoveragePercent: number;
  totalDurationMs: number;
  distinctToolsUsed: number;
  providerDistribution: ProviderUsageEntry[];
  modelDistribution: ModelUsageEntry[];
  mostUsedTools: ToolUsageEntry[];
  dailyStats: DailyStatEntry[];
  activityHeatmap: HeatmapCell[];
  topWorkspaces: WorkspaceRankingEntry[];
}

/** A workspace's id + display name, supplied to rollup by the service layer. */
export interface WorkspaceContext {
  workspaceId: string;
  workspaceName: string;
}

function mergeModelUsage(rows: SessionAnalyticsRow[]): ModelUsageEntry[] {
  const map = new Map<string, ModelUsageEntry>();
  for (const row of rows) {
    for (const entry of row.modelUsage) {
      const bucket = map.get(entry.model) ?? {
        model: entry.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 0,
      };
      bucket.inputTokens += entry.inputTokens;
      bucket.outputTokens += entry.outputTokens;
      bucket.cacheReadTokens += entry.cacheReadTokens;
      bucket.cacheCreationTokens += entry.cacheCreationTokens;
      bucket.totalTokens += entry.totalTokens;
      map.set(entry.model, bucket);
    }
  }
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

function mergeToolUsage(rows: SessionAnalyticsRow[]): ToolUsageEntry[] {
  const map = new Map<string, number>();
  for (const row of rows) {
    for (const entry of row.toolUsage) {
      map.set(entry.tool, (map.get(entry.tool) ?? 0) + entry.count);
    }
  }
  return [...map.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count);
}

function mergeDailyStats(rows: SessionAnalyticsRow[]): DailyStatEntry[] {
  const map = new Map<string, DailyStatEntry>();
  for (const row of rows) {
    for (const entry of row.dailyStats) {
      const bucket = map.get(entry.date) ?? {
        date: entry.date,
        tokens: 0,
        messages: 0,
        durationMs: 0,
      };
      bucket.tokens += entry.tokens;
      bucket.messages += entry.messages;
      bucket.durationMs += entry.durationMs;
      map.set(entry.date, bucket);
    }
  }
  return [...map.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

function mergeHeatmap(rows: SessionAnalyticsRow[]): HeatmapCell[] {
  const map = new Map<string, HeatmapCell>();
  for (const row of rows) {
    for (const cell of row.heatmap) {
      const key = `${cell.dayOfWeek}-${cell.hour}`;
      const bucket = map.get(key) ?? {
        dayOfWeek: cell.dayOfWeek,
        hour: cell.hour,
        tokens: 0,
        messages: 0,
      };
      bucket.tokens += cell.tokens;
      bucket.messages += cell.messages;
      map.set(key, bucket);
    }
  }
  return [...map.values()].sort((a, b) =>
    a.dayOfWeek === b.dayOfWeek ? a.hour - b.hour : a.dayOfWeek - b.dayOfWeek,
  );
}

function computeCostCoverage(rows: SessionAnalyticsRow[]): {
  estimatedCostUsd: number;
  costCoveragePercent: number;
} {
  let cost = 0;
  let coveredTokens = 0;
  let totalTokens = 0;
  for (const row of rows) {
    cost += row.estimatedCostUsd;
    totalTokens += row.totalTokens;
    // row.costCoveragePercent was computed at extraction as covered/total × 100;
    // recover the covered-token count and re-average at the rollup level.
    coveredTokens += (row.costCoveragePercent / 100) * row.totalTokens;
  }
  const coverage = totalTokens > 0 ? (coveredTokens / totalTokens) * 100 : 100;
  return { estimatedCostUsd: cost, costCoveragePercent: coverage };
}

function computeRecentGrowth(dailyStats: DailyStatEntry[]): {
  current: number;
  previous: number;
  percentDelta: number;
} | null {
  if (dailyStats.length === 0) return null;
  const sorted = [...dailyStats].sort((a, b) => (a.date < b.date ? -1 : 1));
  const lastDate = new Date(sorted[sorted.length - 1]!.date);
  const windowMs = 7 * 24 * 60 * 60 * 1000;
  const currentStart = lastDate.getTime() - windowMs + 24 * 60 * 60 * 1000; // last 7 days inclusive of lastDate's day
  const previousStart = currentStart - windowMs;

  let current = 0;
  let previous = 0;
  for (const entry of sorted) {
    const ts = new Date(entry.date).getTime();
    if (ts >= currentStart) current += entry.tokens;
    else if (ts >= previousStart) previous += entry.tokens;
  }
  const percentDelta = previous === 0 ? 0 : Math.round(((current - previous) / previous) * 100);
  return { current, previous, percentDelta };
}

/**
 * Roll up a workspace's cached session rows into a workspace-scoped summary.
 * Empty input is allowed and yields a zero-valued summary (R13 empty state).
 */
export function rollupWorkspace(
  rows: SessionAnalyticsRow[],
  ctx: WorkspaceContext,
): WorkspaceStatsSummary {
  const totalTokens = sum(rows, (r) => r.totalTokens);
  const totalMessages = sum(rows, (r) => r.messageCount);
  const totalDurationMs = sum(rows, (r) => r.durationMs);
  const tools = mergeToolUsage(rows);
  const daily = mergeDailyStats(rows);
  const { estimatedCostUsd, costCoveragePercent } = computeCostCoverage(rows);

  return {
    workspaceId: ctx.workspaceId,
    workspaceName: ctx.workspaceName,
    totalSessions: rows.length,
    totalMessages,
    totalTokens,
    estimatedCostUsd,
    costCoveragePercent,
    totalDurationMs,
    averageDurationMs: rows.length > 0 ? Math.round(totalDurationMs / rows.length) : 0,
    distinctToolsUsed: tools.length,
    mostUsedTools: tools,
    dailyStats: daily,
    activityHeatmap: mergeHeatmap(rows),
    tokenDistribution: {
      input: sum(rows, (r) => r.inputTokens),
      output: sum(rows, (r) => r.outputTokens),
      cacheCreation: sum(rows, (r) => r.cacheCreationTokens),
      cacheRead: sum(rows, (r) => r.cacheReadTokens),
    },
    recentGrowth: computeRecentGrowth(daily),
  };
}

/**
 * Roll up every workspace's cached rows into a global summary. Accepts a
 * per-workspace bundle so the service can attach display names.
 */
export interface WorkspaceRollupInput {
  ctx: WorkspaceContext;
  rows: SessionAnalyticsRow[];
}

export function rollupGlobal(bundles: WorkspaceRollupInput[]): GlobalStatsSummary {
  const allRows: SessionAnalyticsRow[] = bundles.flatMap((b) => b.rows);
  const models = mergeModelUsage(allRows);
  const tools = mergeToolUsage(allRows);
  const daily = mergeDailyStats(allRows);
  const { estimatedCostUsd, costCoveragePercent } = computeCostCoverage(allRows);

  // Provider distribution: derive provider per model, accumulate per provider.
  const providerMap = new Map<string, ProviderUsageEntry>();
  for (const bundle of bundles) {
    // Tally sessions/messages/tokens per provider by scanning modelUsage on each row.
    const perProviderSessionTokens = new Map<string, { sessions: Set<string>; messages: number; tokens: number }>();
    for (const row of bundle.rows) {
      const provider =
        row.modelUsage.length > 0
          ? inferProviderId(row.modelUsage[0]!.model)
          : 'unknown';
      const acc = perProviderSessionTokens.get(provider) ?? {
        sessions: new Set<string>(),
        messages: 0,
        tokens: 0,
      };
      acc.sessions.add(row.sessionId);
      acc.messages += row.messageCount;
      acc.tokens += row.totalTokens;
      perProviderSessionTokens.set(provider, acc);
    }
    for (const [providerId, acc] of perProviderSessionTokens) {
      const bucket = providerMap.get(providerId) ?? {
        providerId,
        sessions: 0,
        messages: 0,
        tokens: 0,
      };
      bucket.sessions += acc.sessions.size;
      bucket.messages += acc.messages;
      bucket.tokens += acc.tokens;
      providerMap.set(providerId, bucket);
    }
  }
  const providerDistribution = [...providerMap.values()].sort((a, b) => b.tokens - a.tokens);

  const topWorkspaces: WorkspaceRankingEntry[] = bundles
    .map((b) => ({
      workspaceId: b.ctx.workspaceId,
      workspaceName: b.ctx.workspaceName,
      sessions: b.rows.length,
      messages: sum(b.rows, (r) => r.messageCount),
      tokens: sum(b.rows, (r) => r.totalTokens),
    }))
    .filter((entry) => entry.tokens > 0 || entry.sessions > 0)
    .sort((a, b) => b.tokens - a.tokens);

  return {
    totalWorkspaces: bundles.filter((b) => b.rows.length > 0).length,
    totalSessions: allRows.length,
    totalMessages: sum(allRows, (r) => r.messageCount),
    totalTokens: sum(allRows, (r) => r.totalTokens),
    estimatedCostUsd,
    costCoveragePercent,
    totalDurationMs: sum(allRows, (r) => r.durationMs),
    distinctToolsUsed: tools.length,
    providerDistribution,
    modelDistribution: models,
    mostUsedTools: tools,
    dailyStats: daily,
    activityHeatmap: mergeHeatmap(allRows),
    topWorkspaces,
  };
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  let total = 0;
  for (const item of items) total += pick(item);
  return total;
}
