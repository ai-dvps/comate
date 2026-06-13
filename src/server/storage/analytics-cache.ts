import type Database from 'better-sqlite3';

/**
 * Per-session analytics cache (see plan 2026-06-13-007, U1).
 *
 * One row per session, keyed by session id. `transcript_mtime` drives
 * incremental re-extraction: a session is re-parsed only when its
 * transcript file mtime has changed since the row was written. Token
 * totals, cost (estimated), duration, message count, and timestamp
 * range are scalar columns; model/tool/daily distributions are JSON
 * blobs for v1 simplicity.
 *
 * Because extraction reads the JSONL transcript directly (compaction
 * makes the SDK accessor return only ~10% of turns), `has_compaction`
 * is recorded so the UI can surface an informational caveat — it does
 * NOT imply a coverage gap, since raw reads recover compacted-away turns.
 */

export interface ModelUsageEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
}

export interface ToolUsageEntry {
  tool: string;
  count: number;
}

export interface DailyStatEntry {
  /** YYYY-MM-DD */
  date: string;
  tokens: number;
  messages: number;
  durationMs: number;
}

export interface SessionAnalyticsRow {
  sessionId: string;
  workspaceId: string;
  transcriptMtime: number;
  extractedAt: number;
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
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS session_analytics_cache (
    session_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    transcript_mtime INTEGER NOT NULL,
    extracted_at INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_cost_usd REAL NOT NULL DEFAULT 0,
    cost_coverage_percent REAL NOT NULL DEFAULT 100,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    message_count INTEGER NOT NULL DEFAULT 0,
    first_message_ts INTEGER,
    last_message_ts INTEGER,
    has_compaction INTEGER NOT NULL DEFAULT 0,
    model_usage TEXT NOT NULL DEFAULT '[]',
    tool_usage TEXT NOT NULL DEFAULT '[]',
    daily_stats TEXT NOT NULL DEFAULT '[]'
  )
`;

/**
 * Create the analytics cache table + workspace index if absent. Called by
 * the store constructor at startup and by the cache class on construction
 * (so a bare in-memory DB in tests also has the table).
 */
export function ensureAnalyticsCacheSchema(db: Database.Database): void {
  db.exec(SCHEMA);
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_session_analytics_workspace ON session_analytics_cache(workspace_id)',
  );
}

const UPSERT_SQL = `
  INSERT INTO session_analytics_cache (
    session_id, workspace_id, transcript_mtime, extracted_at,
    total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
    estimated_cost_usd, cost_coverage_percent, duration_ms, message_count,
    first_message_ts, last_message_ts, has_compaction,
    model_usage, tool_usage, daily_stats
  ) VALUES (
    @sessionId, @workspaceId, @transcriptMtime, @extractedAt,
    @totalTokens, @inputTokens, @outputTokens, @cacheReadTokens, @cacheCreationTokens,
    @estimatedCostUsd, @costCoveragePercent, @durationMs, @messageCount,
    @firstMessageTs, @lastMessageTs, @hasCompaction,
    @modelUsage, @toolUsage, @dailyStats
  )
  ON CONFLICT(session_id) DO UPDATE SET
    workspace_id = excluded.workspace_id,
    transcript_mtime = excluded.transcript_mtime,
    extracted_at = excluded.extracted_at,
    total_tokens = excluded.total_tokens,
    input_tokens = excluded.input_tokens,
    output_tokens = excluded.output_tokens,
    cache_read_tokens = excluded.cache_read_tokens,
    cache_creation_tokens = excluded.cache_creation_tokens,
    estimated_cost_usd = excluded.estimated_cost_usd,
    cost_coverage_percent = excluded.cost_coverage_percent,
    duration_ms = excluded.duration_ms,
    message_count = excluded.message_count,
    first_message_ts = excluded.first_message_ts,
    last_message_ts = excluded.last_message_ts,
    has_compaction = excluded.has_compaction,
    model_usage = excluded.model_usage,
    tool_usage = excluded.tool_usage,
    daily_stats = excluded.daily_stats
`;

interface RawAnalyticsRow {
  session_id: string;
  workspace_id: string;
  transcript_mtime: number;
  extracted_at: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  estimated_cost_usd: number;
  cost_coverage_percent: number;
  duration_ms: number;
  message_count: number;
  first_message_ts: number | null;
  last_message_ts: number | null;
  has_compaction: number;
  model_usage: string;
  tool_usage: string;
  daily_stats: string;
}

function parseRow(row: RawAnalyticsRow): SessionAnalyticsRow {
  return {
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    transcriptMtime: row.transcript_mtime,
    extractedAt: row.extracted_at,
    totalTokens: row.total_tokens,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    estimatedCostUsd: row.estimated_cost_usd,
    costCoveragePercent: row.cost_coverage_percent,
    durationMs: row.duration_ms,
    messageCount: row.message_count,
    firstMessageTs: row.first_message_ts,
    lastMessageTs: row.last_message_ts,
    hasCompaction: row.has_compaction === 1,
    modelUsage: safeParseArray<ModelUsageEntry>(row.model_usage),
    toolUsage: safeParseArray<ToolUsageEntry>(row.tool_usage),
    dailyStats: safeParseArray<DailyStatEntry>(row.daily_stats),
  };
}

function safeParseArray<T>(json: string): T[] {
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    return [];
  }
}

export class AnalyticsCache {
  constructor(private readonly db: Database.Database) {
    ensureAnalyticsCacheSchema(db);
  }

  upsert(row: SessionAnalyticsRow): void {
    this.db.prepare(UPSERT_SQL).run({
      sessionId: row.sessionId,
      workspaceId: row.workspaceId,
      transcriptMtime: row.transcriptMtime,
      extractedAt: row.extractedAt,
      totalTokens: row.totalTokens,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheCreationTokens: row.cacheCreationTokens,
      estimatedCostUsd: row.estimatedCostUsd,
      costCoveragePercent: row.costCoveragePercent,
      durationMs: row.durationMs,
      messageCount: row.messageCount,
      firstMessageTs: row.firstMessageTs,
      lastMessageTs: row.lastMessageTs,
      hasCompaction: row.hasCompaction ? 1 : 0,
      modelUsage: JSON.stringify(row.modelUsage),
      toolUsage: JSON.stringify(row.toolUsage),
      dailyStats: JSON.stringify(row.dailyStats),
    });
  }

  get(sessionId: string): SessionAnalyticsRow | null {
    const row = this.db
      .prepare('SELECT * FROM session_analytics_cache WHERE session_id = ?')
      .get(sessionId) as RawAnalyticsRow | undefined;
    return row ? parseRow(row) : null;
  }

  listByWorkspace(workspaceId: string): SessionAnalyticsRow[] {
    const rows = this.db
      .prepare('SELECT * FROM session_analytics_cache WHERE workspace_id = ?')
      .all(workspaceId) as RawAnalyticsRow[];
    return rows.map(parseRow);
  }

  listAll(): SessionAnalyticsRow[] {
    const rows = this.db
      .prepare('SELECT * FROM session_analytics_cache')
      .all() as RawAnalyticsRow[];
    return rows.map(parseRow);
  }

  /**
   * Return the subset of session ids whose cached transcript_mtime differs
   * from the provided mtime, or that have no cached row at all. These are
   * the sessions that need re-extraction. Order of the returned ids is not
   * guaranteed to match the input order.
   */
  staleSessionIds(
    entries: ReadonlyArray<{ sessionId: string; mtime: number }>,
  ): string[] {
    if (entries.length === 0) return [];
    const ids = entries.map((e) => e.sessionId);
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT session_id, transcript_mtime FROM session_analytics_cache WHERE session_id IN (${placeholders})`,
      )
      .all(...ids) as Array<{ session_id: string; transcript_mtime: number }>;
    const cached = new Map(rows.map((r) => [r.session_id, r.transcript_mtime]));

    const stale: string[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.sessionId)) continue;
      seen.add(entry.sessionId);
      const stored = cached.get(entry.sessionId);
      if (stored === undefined || stored !== entry.mtime) {
        stale.push(entry.sessionId);
      }
    }
    return stale;
  }

  clearByWorkspace(workspaceId: string): number {
    const result = this.db
      .prepare('DELETE FROM session_analytics_cache WHERE workspace_id = ?')
      .run(workspaceId);
    return result.changes;
  }
}
