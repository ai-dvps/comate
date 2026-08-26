import type { Thread } from '../generated/codex-protocol/v2/Thread.js';
import type { ThreadUsage } from '../generated/codex-protocol/v2/ThreadUsage.js';
import type {
  DailyStatEntry,
  HeatmapCell,
  ModelUsageEntry,
  SessionAnalyticsRow,
  ToolUsageEntry,
} from '../storage/analytics-cache.js';
import { mapToolName } from './opencode-event-mapper.js';
import { projectCodexToolItem } from './codex-event-mapper.js';
import type { OpencodeRestMessage } from './opencode-transcript.js';
import { calculateModelCostUsd, hasExplicitModelPricing } from './analytics-pricing.js';

interface BaseExtractionInput {
  sessionId: string;
  workspaceId: string;
  fingerprint: number;
  extractedAt: number;
}

interface DayBucket {
  tokens: number;
  messages: number;
  durationMs: number;
}

interface HeatBucket {
  dayOfWeek: number;
  hour: number;
  tokens: number;
  messages: number;
}

function dateKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function addActivity(
  daily: Map<string, DayBucket>,
  heatmap: Map<string, HeatBucket>,
  timestamp: number,
  tokens: number,
  messages: number,
  durationMs: number,
): void {
  if (!Number.isFinite(timestamp)) return;
  const date = new Date(timestamp);
  const key = dateKey(date);
  const day = daily.get(key) ?? { tokens: 0, messages: 0, durationMs: 0 };
  day.tokens += tokens;
  day.messages += messages;
  day.durationMs += durationMs;
  daily.set(key, day);

  const heatKey = `${date.getDay()}-${date.getHours()}`;
  const heat = heatmap.get(heatKey) ?? {
    dayOfWeek: date.getDay(),
    hour: date.getHours(),
    tokens: 0,
    messages: 0,
  };
  heat.tokens += tokens;
  heat.messages += messages;
  heatmap.set(heatKey, heat);
}

function sortedDaily(map: Map<string, DayBucket>): DailyStatEntry[] {
  return [...map.entries()]
    .map(([date, bucket]) => ({ date, ...bucket }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function sortedHeatmap(map: Map<string, HeatBucket>): HeatmapCell[] {
  return [...map.values()].sort((a, b) =>
    a.dayOfWeek === b.dayOfWeek ? a.hour - b.hour : a.dayOfWeek - b.dayOfWeek,
  );
}

function sortedTools(map: Map<string, number>): ToolUsageEntry[] {
  return [...map.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));
}

function addModelUsage(
  map: Map<string, ModelUsageEntry>,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  totalTokens: number,
): void {
  const bucket = map.get(model) ?? {
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
  };
  bucket.inputTokens += inputTokens;
  bucket.outputTokens += outputTokens;
  bucket.cacheReadTokens += cacheReadTokens;
  bucket.cacheCreationTokens += cacheCreationTokens;
  bucket.totalTokens += totalTokens;
  map.set(model, bucket);
}

function finiteNumber(value: unknown): number {
  const number = typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function makeRow(
  input: BaseExtractionInput,
  values: Omit<SessionAnalyticsRow, 'sessionId' | 'workspaceId' | 'transcriptMtime' | 'extractedAt'>,
): SessionAnalyticsRow {
  return {
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    transcriptMtime: input.fingerprint,
    extractedAt: input.extractedAt,
    ...values,
  };
}

export function extractOpenCodeSessionAnalytics(
  input: BaseExtractionInput & { messages: OpencodeRestMessage[] },
): SessionAnalyticsRow {
  const models = new Map<string, ModelUsageEntry>();
  const tools = new Map<string, number>();
  const daily = new Map<string, DayBucket>();
  const heatmap = new Map<string, HeatBucket>();
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let totalTokens = 0;
  let estimatedCostUsd = 0;
  let coveredTokens = 0;
  let durationMs = 0;
  let messageCount = 0;
  let firstMessageTs: number | null = null;
  let lastMessageTs: number | null = null;

  for (const message of input.messages) {
    const created = message.info.time?.created;
    const completed = message.info.time?.completed;
    for (const timestamp of [created, completed]) {
      if (timestamp === undefined || !Number.isFinite(timestamp)) continue;
      firstMessageTs = firstMessageTs === null ? timestamp : Math.min(firstMessageTs, timestamp);
      lastMessageTs = lastMessageTs === null ? timestamp : Math.max(lastMessageTs, timestamp);
    }
    if (message.info.role !== 'assistant') continue;

    const usage = message.info.tokens;
    const turnInput = finiteNumber(usage?.input);
    // OpenCode stores reasoning separately from visible output. Analytics has
    // one output bucket, so fold reasoning into it just as OpenCode's own
    // stats command does instead of silently under-counting reasoning models.
    const turnOutput = finiteNumber(usage?.output) + finiteNumber(usage?.reasoning);
    const turnCacheRead = finiteNumber(usage?.cache.read);
    const turnCacheCreation = finiteNumber(usage?.cache.write);
    const turnTotal = turnInput + turnOutput + turnCacheRead + turnCacheCreation;
    const model = message.info.modelID ?? 'unknown';
    const turnDuration = created !== undefined && completed !== undefined
      ? Math.max(0, completed - created)
      : 0;

    inputTokens += turnInput;
    outputTokens += turnOutput;
    cacheReadTokens += turnCacheRead;
    cacheCreationTokens += turnCacheCreation;
    totalTokens += turnTotal;
    durationMs += turnDuration;
    messageCount += 1;
    addModelUsage(models, model, turnInput, turnOutput, turnCacheRead, turnCacheCreation, turnTotal);

    if (typeof message.info.cost === 'number' && Number.isFinite(message.info.cost)) {
      estimatedCostUsd += message.info.cost;
      coveredTokens += turnTotal;
    } else {
      estimatedCostUsd += calculateModelCostUsd(
        model,
        turnInput,
        turnOutput,
        turnCacheCreation,
        turnCacheRead,
      );
      if (hasExplicitModelPricing(model)) coveredTokens += turnTotal;
    }
    if (created !== undefined) {
      addActivity(daily, heatmap, created, turnTotal, 1, turnDuration);
    }

    for (const part of message.parts) {
      if (part.type !== 'tool') continue;
      const tool = mapToolName(part.tool ?? 'unknown');
      tools.set(tool, (tools.get(tool) ?? 0) + 1);
    }
  }

  return makeRow(input, {
    totalTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    estimatedCostUsd,
    costCoveragePercent: totalTokens > 0 ? (coveredTokens / totalTokens) * 100 : 100,
    durationMs,
    messageCount,
    firstMessageTs,
    lastMessageTs,
    hasCompaction: false,
    modelUsage: [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    toolUsage: sortedTools(tools),
    dailyStats: sortedDaily(daily),
    heatmap: sortedHeatmap(heatmap),
  });
}

export function extractCodexSessionAnalytics(
  input: BaseExtractionInput & { thread: Thread; usage: ThreadUsage | null },
): SessionAnalyticsRow {
  const models = new Map<string, ModelUsageEntry>();
  const tools = new Map<string, number>();
  const daily = new Map<string, DayBucket>();
  const heatmap = new Map<string, HeatBucket>();
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let totalTokens = 0;
  let estimatedCostUsd = 0;
  let coveredTokens = 0;
  let durationMs = 0;
  let messageCount = 0;
  let hasCompaction = false;

  for (const group of input.usage?.groups ?? []) {
    const cached = finiteNumber(group.cachedInputTokens);
    const reportedInput = finiteNumber(group.inputTokens);
    const freshInput = group.netNewInputTokens === null
      ? Math.max(0, reportedInput - cached)
      : finiteNumber(group.netNewInputTokens);
    const output = finiteNumber(group.outputTokens);
    const total = group.totalTokens === null
      ? freshInput + cached + output
      : finiteNumber(group.totalTokens);
    const model = group.model ?? 'codex';
    inputTokens += freshInput;
    outputTokens += output;
    cacheReadTokens += cached;
    totalTokens += total;
    addModelUsage(models, model, freshInput, output, cached, 0, total);
  }

  const reportedCost = input.usage?.estimatedUsageUsdMicros;
  if (reportedCost !== null && reportedCost !== undefined) {
    estimatedCostUsd = finiteNumber(reportedCost) / 1_000_000;
    coveredTokens = totalTokens;
  } else {
    for (const model of models.values()) {
      estimatedCostUsd += calculateModelCostUsd(
        model.model,
        model.inputTokens,
        model.outputTokens,
        model.cacheCreationTokens,
        model.cacheReadTokens,
      );
      if (hasExplicitModelPricing(model.model)) coveredTokens += model.totalTokens;
    }
  }

  let firstMessageTs: number | null = null;
  let lastMessageTs: number | null = null;
  for (const turn of input.thread.turns) {
    const started = turn.startedAt === null ? null : turn.startedAt * 1_000;
    const completed = turn.completedAt === null ? null : turn.completedAt * 1_000;
    for (const timestamp of [started, completed]) {
      if (timestamp === null || !Number.isFinite(timestamp)) continue;
      firstMessageTs = firstMessageTs === null ? timestamp : Math.min(firstMessageTs, timestamp);
      lastMessageTs = lastMessageTs === null ? timestamp : Math.max(lastMessageTs, timestamp);
    }
    const turnDuration = turn.durationMs ?? (
      started !== null && completed !== null ? Math.max(0, completed - started) : 0
    );
    durationMs += turnDuration;
    messageCount += 1;
    if (started !== null) addActivity(daily, heatmap, started, 0, 1, turnDuration);

    for (const item of turn.items) {
      if (item.type === 'contextCompaction') hasCompaction = true;
      const tool = projectCodexToolItem(item);
      if (tool) tools.set(tool.name, (tools.get(tool.name) ?? 0) + 1);
    }
  }

  if (firstMessageTs === null) firstMessageTs = input.thread.createdAt * 1_000;
  if (lastMessageTs === null) lastMessageTs = input.thread.updatedAt * 1_000;

  return makeRow(input, {
    totalTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens: 0,
    estimatedCostUsd,
    costCoveragePercent: totalTokens > 0 ? (coveredTokens / totalTokens) * 100 : 100,
    durationMs,
    messageCount,
    firstMessageTs,
    lastMessageTs,
    hasCompaction,
    modelUsage: [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    toolUsage: sortedTools(tools),
    dailyStats: sortedDaily(daily),
    heatmap: sortedHeatmap(heatmap),
  });
}
