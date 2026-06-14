/**
 * Per-session transcript extractor (see plan 2026-06-13-007, U2).
 *
 * Reads a Claude Agent SDK JSONL transcript directly and produces one
 * `SessionAnalyticsRow` worth of aggregates. Direct file reads are required
 * because the SDK accessor (`getSessionMessages`) returns only the live
 * post-compaction view — probe on a heavily-compacted session showed 10.5%
 * coverage. The raw JSONL contains every turn including compacted-away ones.
 *
 * Extraction rules (confirmed by the characterization probe):
 *   - Per-turn usage lives on `assistant.message.usage` with keys
 *     `input_tokens`, `cache_creation_input_tokens`,
 *     `cache_read_input_tokens`, `output_tokens`.
 *   - Per-turn model attribution uses `assistant.message.model`.
 *   - Tool-use blocks live in `assistant.message.content[]` with
 *     `{ type: 'tool_use', name }`.
 *   - Duration comes from `system` entries carrying `durationMs`
 *     (turn_duration entries); sum across the file.
 *   - `compact_boundary` entries (anywhere in the file) flip `hasCompaction`.
 *   - Timestamps are ISO strings; bucket by local day for `dailyStats` and
 *     day-of-week × hour for the heatmap.
 *   - There is NO `result`-type entry and NO `total_cost_usd`; cost is
 *     always computed from usage × pricing (see analytics-pricing.ts).
 *   - JSONL field names are camelCase (`compactMetadata`, `durationMs`,
 *     `preTokens`, `postTokens`), NOT the SDK type's snake_case.
 *
 * `messageCount` counts assistant turns with usage (the token-bearing turns);
 * this is the headline "messages" metric and intentionally excludes pure user
 * turns. The SDK's `system/turn_duration.messageCount` corroborates but is not
 * authoritative for token attribution.
 */

import { existsSync, readFileSync } from 'fs';
import type {
  DailyStatEntry,
  HeatmapCell,
  ModelUsageEntry,
  SessionAnalyticsRow,
  ToolUsageEntry,
} from '../storage/analytics-cache.js';
import {
  calculateModelCostUsd,
  hasExplicitModelPricing,
} from './analytics-pricing.js';

interface TranscriptUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface TranscriptContentBlock {
  type?: string;
  name?: string;
}

interface TranscriptAssistantMessage {
  usage?: TranscriptUsage;
  model?: string;
  content?: TranscriptContentBlock[];
}

interface TranscriptEntry {
  type?: string;
  timestamp?: string;
  message?: TranscriptAssistantMessage;
  /** Present on `system`/`turn_duration` entries. */
  durationMs?: number;
  messageCount?: number;
}

/** Per-day accumulator (keyed YYYY-MM-DD). */
interface DayBucket {
  tokens: number;
  messages: number;
  durationMs: number;
}

/** Heatmap accumulator (keyed `${dayOfWeek}-${hour}`). */
interface HeatmapBucket {
  tokens: number;
  messages: number;
}

/**
 * Aggregates produced by walking the transcript. Excludes cache metadata
 * fields (sessionId, workspaceId, mtime, extractedAt) which the file-reading
 * wrapper supplies.
 */
export interface TranscriptAggregates {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCostUsd: number;
  costCoveragePercent: number;
  durationMs: number;
  messageCount: number;
  firstMessageTs: number | null;
  lastMessageTs: number | null;
  hasCompaction: boolean;
  modelUsage: ModelUsageEntry[];
  toolUsage: ToolUsageEntry[];
  dailyStats: DailyStatEntry[];
  heatmap: HeatmapCell[];
}

function toBucketKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Walk a transcript's raw JSONL text and produce per-session aggregates.
 * Pure: no filesystem access, deterministic given the same input. Used
 * directly by tests with synthetic fixtures.
 */
export function extractFromTranscriptText(text: string): TranscriptAggregates {
  const modelUsageMap = new Map<string, ModelUsageEntry>();
  const toolUsageMap = new Map<string, number>();
  const dailyMap = new Map<string, DayBucket>();
  const heatmapMap = new Map<string, HeatmapBucket & { dayOfWeek: number; hour: number }>();

  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let coveredTokens = 0;
  let estimatedCostUsd = 0;
  let durationMs = 0;
  let messageCount = 0;
  let hasCompaction = false;
  let firstMessageTs: number | null = null;
  let lastMessageTs: number | null = null;

  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(trimmed) as TranscriptEntry;
    } catch {
      // Skip malformed lines silently — partial writes during streaming can
      // leave a trailing incomplete record.
      continue;
    }

    const type = entry.type;
    const parsedTs = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    const ts = Number.isNaN(parsedTs) ? null : parsedTs;
    const date = ts !== null ? new Date(ts) : null;

    if (date) {
      if (firstMessageTs === null || ts! < firstMessageTs) firstMessageTs = ts!;
      if (lastMessageTs === null || ts! > lastMessageTs) lastMessageTs = ts!;
    }

    if (type === 'assistant' && entry.message) {
      const usage = entry.message.usage;
      if (usage) {
        const ei = usage.input_tokens ?? 0;
        const eo = usage.output_tokens ?? 0;
        const ecc = usage.cache_creation_input_tokens ?? 0;
        const ecr = usage.cache_read_input_tokens ?? 0;
        const turnTotal = ei + eo + ecc + ecr;
        const model = entry.message.model ?? 'unknown';

        inputTokens += ei;
        outputTokens += eo;
        cacheCreationTokens += ecc;
        cacheReadTokens += ecr;
        totalTokens += turnTotal;
        messageCount += 1;

        const bucket = modelUsageMap.get(model) ?? {
          model,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          totalTokens: 0,
        };
        bucket.inputTokens += ei;
        bucket.outputTokens += eo;
        bucket.cacheCreationTokens += ecc;
        bucket.cacheReadTokens += ecr;
        bucket.totalTokens += turnTotal;
        modelUsageMap.set(model, bucket);

        estimatedCostUsd += calculateModelCostUsd(model, ei, eo, ecc, ecr);
        if (hasExplicitModelPricing(model)) coveredTokens += turnTotal;

        if (date) {
          const dayKey = toBucketKey(date);
          const day = dailyMap.get(dayKey) ?? { tokens: 0, messages: 0, durationMs: 0 };
          day.tokens += turnTotal;
          day.messages += 1;
          dailyMap.set(dayKey, day);

          const dayOfWeek = date.getDay();
          const hour = date.getHours();
          const heatKey = `${dayOfWeek}-${hour}`;
          const heat = heatmapMap.get(heatKey) ?? {
            dayOfWeek,
            hour,
            tokens: 0,
            messages: 0,
          };
          heat.tokens += turnTotal;
          heat.messages += 1;
          heatmapMap.set(heatKey, heat);
        }
      }

      const content = entry.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_use' && typeof block.name === 'string') {
            toolUsageMap.set(block.name, (toolUsageMap.get(block.name) ?? 0) + 1);
          }
        }
      }
    } else if (type === 'system' && typeof entry.durationMs === 'number') {
      // turn_duration entries carry durationMs (and a turn messageCount we
      // don't need — assistant-usage count is authoritative for token-bearing
      // turns).
      durationMs += entry.durationMs;
      if (date) {
        const dayKey = toBucketKey(date);
        const day = dailyMap.get(dayKey) ?? { tokens: 0, messages: 0, durationMs: 0 };
        day.durationMs += entry.durationMs;
        dailyMap.set(dayKey, day);
      }
    } else if (type === 'compact_boundary') {
      hasCompaction = true;
    }
  }

  const costCoveragePercent =
    totalTokens > 0 ? (coveredTokens / totalTokens) * 100 : 100;

  const modelUsage = [...modelUsageMap.values()].sort(
    (a, b) => b.totalTokens - a.totalTokens,
  );
  const toolUsage: ToolUsageEntry[] = [...toolUsageMap.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count);
  const dailyStats: DailyStatEntry[] = [...dailyMap.entries()]
    .map(([date, b]) => ({ date, ...b }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const heatmap: HeatmapCell[] = [...heatmapMap.values()]
    .map(({ dayOfWeek, hour, tokens, messages }) => ({
      dayOfWeek,
      hour,
      tokens,
      messages,
    }))
    .sort((a, b) =>
      a.dayOfWeek === b.dayOfWeek ? a.hour - b.hour : a.dayOfWeek - b.dayOfWeek,
    );

  return {
    totalTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    estimatedCostUsd,
    costCoveragePercent,
    durationMs,
    messageCount,
    firstMessageTs,
    lastMessageTs,
    hasCompaction,
    modelUsage,
    toolUsage,
    dailyStats,
    heatmap,
  };
}

export interface ExtractSessionInput {
  sessionId: string;
  workspaceId: string;
  transcriptPath: string;
  transcriptMtime: number;
  extractedAt: number;
}

export type ExtractSessionOutcome =
  | { row: SessionAnalyticsRow }
  | { row: null; reason: 'not-found' | 'empty' | 'read-error'; error?: string };

/**
 * Read a transcript file from disk and produce a complete cache row. Returns
 * `{ row: null, reason }` when the file is missing, empty, or unreadable so
 * callers (the service) can decide whether to skip or clear the row.
 */
export function extractSessionAnalytics(
  input: ExtractSessionInput,
): ExtractSessionOutcome {
  if (!existsSync(input.transcriptPath)) {
    return { row: null, reason: 'not-found' };
  }
  let text: string;
  try {
    text = readFileSync(input.transcriptPath, 'utf8');
  } catch (err) {
    return {
      row: null,
      reason: 'read-error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!text.trim()) {
    return { row: null, reason: 'empty' };
  }

  const aggregates = extractFromTranscriptText(text);
  return {
    row: {
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      transcriptMtime: input.transcriptMtime,
      extractedAt: input.extractedAt,
      ...aggregates,
    },
  };
}
