/**
 * Read a Workflow tool run from the SDK transcript directory and normalize it
 * into a client-ready WorkflowState shape.
 *
 * On-disk layout (observed from SDK 0.3.202):
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>/workflows/<runId>.json
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>/subagents/workflows/<runId>/agent-<id>.jsonl
 */

import { existsSync, promises as fs } from 'fs';
import path from 'path';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { reconstructSubagentState } from './subagent-loader.js';
import { resolveTranscriptDir } from './analytics-transcript-path.js';
import { diagLog } from '../utils/diag-logger.js';
import type {
  SubagentState,
  WorkflowPhase,
  WorkflowProgressAgent,
  WorkflowProgressItem,
  WorkflowState,
  WorkflowStatus,
} from '../types/message.js';

/** Allowed characters for filesystem-safe workflow IDs. */
const WORKFLOW_ID_RE = /^[a-zA-Z0-9_-]+$/;

function safeParseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function isValidWorkflowId(value: string): boolean {
  return WORKFLOW_ID_RE.test(value);
}

function assertPathSafe(baseDir: string, targetPath: string): boolean {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  const prefix = resolvedBase.endsWith(path.sep) ? resolvedBase : resolvedBase + path.sep;
  return resolvedTarget === resolvedBase || resolvedTarget.startsWith(prefix);
}

function asWorkflowStatus(value: unknown): WorkflowStatus {
  if (value === 'running' || value === 'completed' || value === 'error' || value === 'killed') {
    return value;
  }
  // Treat any unknown SDK status as an error rather than falsely showing "running".
  return 'error';
}

function parsePhases(raw: unknown): WorkflowPhase[] {
  if (!Array.isArray(raw)) return [];
  const phases: WorkflowPhase[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const title = asString((item as Record<string, unknown>).title);
    const detail = asString((item as Record<string, unknown>).detail);
    if (!title) continue;
    phases.push({ title, detail: detail || undefined });
  }
  return phases;
}

function parseProgress(raw: unknown): WorkflowProgressItem[] {
  if (!Array.isArray(raw)) return [];
  const progress: WorkflowProgressItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    const type = it.type;

    if (type === 'workflow_phase') {
      const index = asNumber(it.index);
      const title = asString(it.title);
      if (index === undefined || !title) continue;
      progress.push({ type: 'workflow_phase', index, title });
      continue;
    }

    if (type === 'workflow_agent') {
      const index = asNumber(it.index);
      const agentId = asString(it.agentId);
      if (index === undefined || !agentId) continue;

      const agent: WorkflowProgressAgent = { type: 'workflow_agent', index, agentId };

      const label = asString(it.label);
      if (label) agent.label = label;

      const phaseIndex = asNumber(it.phaseIndex);
      if (phaseIndex !== undefined) agent.phaseIndex = phaseIndex;

      const phaseTitle = asString(it.phaseTitle);
      if (phaseTitle) agent.phaseTitle = phaseTitle;

      const state = asString(it.state);
      if (state === 'running' || state === 'done') agent.state = state;

      const model = asString(it.model);
      if (model) agent.model = model;

      const startedAt = asNumber(it.startedAt);
      if (startedAt !== undefined) agent.startedAt = startedAt;

      const queuedAt = asNumber(it.queuedAt);
      if (queuedAt !== undefined) agent.queuedAt = queuedAt;

      const lastProgressAt = asNumber(it.lastProgressAt);
      if (lastProgressAt !== undefined) agent.lastProgressAt = lastProgressAt;

      const attempt = asNumber(it.attempt);
      if (attempt !== undefined) agent.attempt = attempt;

      const tokens = asNumber(it.tokens);
      if (tokens !== undefined) agent.tokens = tokens;

      const toolCalls = asNumber(it.toolCalls);
      if (toolCalls !== undefined) agent.toolCalls = toolCalls;

      const durationMs = asNumber(it.durationMs);
      if (durationMs !== undefined) agent.durationMs = durationMs;

      const lastToolName = asString(it.lastToolName);
      if (lastToolName) agent.lastToolName = lastToolName;

      const lastToolSummary = asString(it.lastToolSummary);
      if (lastToolSummary) agent.lastToolSummary = lastToolSummary;

      const promptPreview = asString(it.promptPreview);
      if (promptPreview) agent.promptPreview = promptPreview;

      const resultPreview = asString(it.resultPreview);
      if (resultPreview) agent.resultPreview = resultPreview;

      progress.push(agent);
    }
  }
  return progress;
}

async function parseJsonlMessages(filePath: string): Promise<SessionMessage[]> {
  const raw = await fs.readFile(filePath, 'utf8');
  const messages: SessionMessage[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = safeParseJson<SessionMessage>(line);
    if (parsed) {
      messages.push(parsed);
    }
  }
  return messages;
}

async function loadWorkflowSubagents(
  folderPath: string,
  sessionId: string,
  runId: string,
  progress: WorkflowProgressItem[],
): Promise<SubagentState[]> {
  const transcriptDir = resolveTranscriptDir(folderPath);
  if (!transcriptDir) return [];

  const subagentDir = path.join(transcriptDir, sessionId, 'subagents', 'workflows', runId);
  if (!existsSync(subagentDir)) return [];

  const agentProgressById = new Map<string, WorkflowProgressItem & { type: 'workflow_agent' }>();
  for (const item of progress) {
    if (item.type === 'workflow_agent' && item.agentId) {
      agentProgressById.set(item.agentId, item as WorkflowProgressItem & { type: 'workflow_agent' });
    }
  }

  let files: string[];
  try {
    files = await fs.readdir(subagentDir);
  } catch (err) {
    diagLog('workflow-loader-readdir-error', { path: subagentDir, error: String(err) });
    return [];
  }

  const subagents: SubagentState[] = [];
  for (const file of files) {
    const match = /^agent-([a-zA-Z0-9-]+)\.jsonl$/.exec(file);
    if (!match) continue;
    const agentId = match[1];
    const filePath = path.join(subagentDir, file);

    let sdkMessages: SessionMessage[];
    try {
      sdkMessages = await parseJsonlMessages(filePath);
    } catch (err) {
      diagLog('workflow-loader-jsonl-error', { path: filePath, error: String(err) });
      continue;
    }

    const progressItem = agentProgressById.get(agentId);
    const description = progressItem?.label || `Agent ${agentId}`;
    const parentToolUseId = `workflow:${runId}:${agentId}`;
    const reconstructed = reconstructSubagentState(parentToolUseId, sdkMessages, description, {
      fallbackStartTime: progressItem?.startedAt,
      fallbackEndTime:
        progressItem?.state === 'done' ? progressItem?.lastProgressAt : undefined,
    });
    if (reconstructed) {
      // Reconcile the derived state with authoritative workflow progress metadata.
      if (progressItem?.state === 'done') {
        reconstructed.state = 'completed';
      } else if (progressItem?.state === 'running') {
        reconstructed.state = 'running';
      }
      if (progressItem?.toolCalls !== undefined) {
        reconstructed.toolCount = progressItem.toolCalls;
      }
      subagents.push(reconstructed);
    }
  }

  return subagents;
}

/**
 * Collect every agentId that belongs to any workflow under the session's
 * `subagents/workflows/` directory. These agents are loaded by `loadWorkflowState`
 * and should not be re-loaded as top-level subagents by `loadSubagentsForSession`.
 */
export async function listWorkflowAgentIds(folderPath: string, sessionId: string): Promise<Set<string>> {
  if (!isValidWorkflowId(sessionId)) {
    return new Set();
  }

  const transcriptDir = resolveTranscriptDir(folderPath);
  if (!transcriptDir) return new Set();

  const workflowsDir = path.join(transcriptDir, sessionId, 'subagents', 'workflows');
  if (!assertPathSafe(transcriptDir, workflowsDir)) {
    diagLog('workflow-loader-unsafe-path', { workflowsDir });
    return new Set();
  }

  if (!existsSync(workflowsDir)) return new Set();

  let runIds: string[];
  try {
    runIds = await fs.readdir(workflowsDir);
  } catch (err) {
    diagLog('workflow-loader-readdir-error', { path: workflowsDir, error: String(err) });
    return new Set();
  }

  const agentIds = new Set<string>();
  for (const runId of runIds) {
    if (!isValidWorkflowId(runId)) continue;
    const runDir = path.join(workflowsDir, runId);
    if (!assertPathSafe(workflowsDir, runDir)) continue;
    let files: string[];
    try {
      files = await fs.readdir(runDir);
    } catch (err) {
      diagLog('workflow-loader-readdir-error', { path: runDir, error: String(err) });
      continue;
    }
    for (const file of files) {
      const match = /^agent-([a-zA-Z0-9-]+)\.jsonl$/.exec(file);
      if (match) {
        agentIds.add(match[1]);
      }
    }
  }
  return agentIds;
}

export interface LoadWorkflowOptions {
  folderPath: string;
  sessionId: string;
  runId: string;
  toolUseId?: string;
}

/**
 * Load and normalize workflow state from disk.
 * Returns null when the workflow JSON is missing or unreadable.
 */
export async function loadWorkflowState(options: LoadWorkflowOptions): Promise<WorkflowState | null> {
  const { folderPath, sessionId, runId, toolUseId } = options;

  if (!isValidWorkflowId(sessionId) || !isValidWorkflowId(runId)) {
    return null;
  }

  const transcriptDir = resolveTranscriptDir(folderPath);
  if (!transcriptDir) {
    diagLog('workflow-loader-no-transcript-dir', { folderPath });
    return null;
  }

  const workflowPath = path.join(transcriptDir, sessionId, 'workflows', `${runId}.json`);
  if (!assertPathSafe(transcriptDir, workflowPath)) {
    diagLog('workflow-loader-unsafe-path', { workflowPath });
    return null;
  }

  if (!existsSync(workflowPath)) {
    return null;
  }

  let raw: string;
  try {
    raw = await fs.readFile(workflowPath, 'utf8');
  } catch (err) {
    diagLog('workflow-loader-read-error', { path: workflowPath, error: String(err) });
    return null;
  }

  const data = safeParseJson<Record<string, unknown>>(raw);
  if (!data) {
    diagLog('workflow-loader-parse-error', { path: workflowPath });
    return null;
  }

  const status = asWorkflowStatus(data.status);
  const startTime = asNumber(data.startTime) || Date.now();
  const phases = parsePhases(data.phases);
  const progress = parseProgress(data.workflowProgress);
  const subagents = await loadWorkflowSubagents(folderPath, sessionId, runId, progress);

  return {
    runId,
    sessionId,
    toolUseId,
    workflowName: asString(data.workflowName) || undefined,
    status,
    summary: asString(data.summary) || undefined,
    error: asString(data.error) || undefined,
    startTime,
    durationMs: asNumber(data.durationMs),
    totalTokens: asNumber(data.totalTokens),
    totalToolCalls: asNumber(data.totalToolCalls),
    agentCount: asNumber(data.agentCount) ?? subagents.length,
    phases,
    progress,
    subagents,
  };
}

/**
 * List workflow runIds that have on-disk state for a session.
 */
export async function listWorkflowRunIds(folderPath: string, sessionId: string): Promise<string[]> {
  if (!isValidWorkflowId(sessionId)) {
    return [];
  }

  const transcriptDir = resolveTranscriptDir(folderPath);
  if (!transcriptDir) return [];

  const workflowsDir = path.join(transcriptDir, sessionId, 'workflows');
  if (!assertPathSafe(transcriptDir, workflowsDir)) {
    diagLog('workflow-loader-unsafe-path', { workflowsDir });
    return [];
  }

  if (!existsSync(workflowsDir)) return [];

  let files: string[];
  try {
    files = await fs.readdir(workflowsDir);
  } catch (err) {
    diagLog('workflow-loader-readdir-error', { path: workflowsDir, error: String(err) });
    return [];
  }

  const runIds: string[] = [];
  for (const file of files) {
    if (file.endsWith('.json')) {
      runIds.push(file.slice(0, -5));
    }
  }
  return runIds;
}
