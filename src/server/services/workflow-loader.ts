/**
 * Read a Workflow tool run from the SDK transcript directory and normalize it
 * into a client-ready WorkflowState shape.
 *
 * On-disk layout (observed from SDK 0.3.202):
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>/workflows/<runId>.json
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>/subagents/workflows/<runId>/agent-<id>.jsonl
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { reconstructSubagentState } from './subagent-loader.js';
import { resolveTranscriptDir } from './analytics-transcript-path.js';
import { diagLog } from '../utils/diag-logger.js';
import type {
  SubagentState,
  WorkflowPhase,
  WorkflowProgressItem,
  WorkflowState,
  WorkflowStatus,
} from '../types/message.js';

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

function asWorkflowStatus(value: unknown): WorkflowStatus {
  if (value === 'running' || value === 'completed' || value === 'error' || value === 'killed') {
    return value;
  }
  return 'running';
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
    if (item && typeof item === 'object') {
      progress.push(item as WorkflowProgressItem);
    }
  }
  return progress;
}

function parseJsonlMessages(filePath: string): SessionMessage[] {
  const raw = readFileSync(filePath, 'utf8');
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

function loadWorkflowSubagents(
  folderPath: string,
  sessionId: string,
  runId: string,
  progress: WorkflowProgressItem[],
): SubagentState[] {
  const transcriptDir = resolveTranscriptDir(folderPath);
  if (!transcriptDir) return [];

  const subagentDir = join(transcriptDir, sessionId, 'subagents', 'workflows', runId);
  if (!existsSync(subagentDir)) return [];

  const agentProgressById = new Map<string, WorkflowProgressItem & { type: 'workflow_agent' }>();
  for (const item of progress) {
    if (item.type === 'workflow_agent' && item.agentId) {
      agentProgressById.set(item.agentId, item);
    }
  }

  let files: string[];
  try {
    files = readdirSync(subagentDir);
  } catch (err) {
    diagLog('workflow-loader-readdir-error', { path: subagentDir, error: String(err) });
    return [];
  }

  const subagents: SubagentState[] = [];
  for (const file of files) {
    const match = /^agent-([a-zA-Z0-9-]+)\.jsonl$/.exec(file);
    if (!match) continue;
    const agentId = match[1];
    const filePath = join(subagentDir, file);

    let sdkMessages: SessionMessage[];
    try {
      sdkMessages = parseJsonlMessages(filePath);
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
      subagents.push(reconstructed);
    }
  }

  return subagents;
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
export function loadWorkflowState(options: LoadWorkflowOptions): WorkflowState | null {
  const { folderPath, sessionId, runId, toolUseId } = options;

  const transcriptDir = resolveTranscriptDir(folderPath);
  if (!transcriptDir) {
    diagLog('workflow-loader-no-transcript-dir', { folderPath });
    return null;
  }

  const workflowPath = join(transcriptDir, sessionId, 'workflows', `${runId}.json`);
  if (!existsSync(workflowPath)) {
    return null;
  }

  let raw: string;
  try {
    raw = readFileSync(workflowPath, 'utf8');
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
  const subagents = loadWorkflowSubagents(folderPath, sessionId, runId, progress);

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
export function listWorkflowRunIds(folderPath: string, sessionId: string): string[] {
  const transcriptDir = resolveTranscriptDir(folderPath);
  if (!transcriptDir) return [];

  const workflowsDir = join(transcriptDir, sessionId, 'workflows');
  if (!existsSync(workflowsDir)) return [];

  let files: string[];
  try {
    files = readdirSync(workflowsDir);
  } catch {
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
