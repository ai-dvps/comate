import '../test-utils/test-env.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { loadWorkflowState, listWorkflowRunIds } from './workflow-loader.js';
import { encodeProjectDir } from './analytics-transcript-path.js';

function makeSessionMessage(role: 'user' | 'assistant', text: string) {
  return {
    type: role,
    uuid: `${role}-${Math.random().toString(36).slice(2)}`,
    session_id: 'session-1',
    parent_tool_use_id: null,
    message: { role, content: [{ type: 'text', text }] },
    timestamp: '2026-07-07T10:00:00.000Z',
  };
}

describe('workflow-loader', () => {
  let tempHome: string;
  let folderPath: string;
  let sessionId: string;
  let runId: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'comate-test-home-'));
    process.env.HOME = tempHome;
    folderPath = join(tempHome, 'project');
    sessionId = 'session-1';
    runId = 'wf_test-run-1';
  });

  function writeWorkflowJson(data: Record<string, unknown>) {
    const dir = join(tempHome, '.claude', 'projects', encodeProjectDir(folderPath), sessionId, 'workflows');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${runId}.json`), JSON.stringify(data));
  }

  function writeSubagentJsonl(agentId: string, messages: unknown[]) {
    const dir = join(
      tempHome,
      '.claude',
      'projects',
      encodeProjectDir(folderPath),
      sessionId,
      'subagents',
      'workflows',
      runId,
    );
    mkdirSync(dir, { recursive: true });
    const lines = messages.map((m) => JSON.stringify(m)).join('\n');
    writeFileSync(join(dir, `agent-${agentId}.jsonl`), lines);
  }

  it('returns null when the workflow JSON is missing', () => {
    const state = loadWorkflowState({ folderPath, sessionId, runId });
    assert.strictEqual(state, null);
  });

  it('returns null when the workflow JSON is malformed', () => {
    const dir = join(tempHome, '.claude', 'projects', encodeProjectDir(folderPath), sessionId, 'workflows');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${runId}.json`), 'not-json');
    const state = loadWorkflowState({ folderPath, sessionId, runId });
    assert.strictEqual(state, null);
  });

  it('loads a complete workflow state with phases and subagents', () => {
    writeWorkflowJson({
      runId,
      status: 'running',
      startTime: 1783405803581,
      workflowName: 'deep-research',
      summary: 'Researching...',
      agentCount: 2,
      totalTokens: 1234,
      totalToolCalls: 56,
      durationMs: 10000,
      phases: [{ title: 'Scope', detail: 'Decompose question' }],
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Scope' },
        {
          type: 'workflow_agent',
          index: 1,
          agentId: 'agenta',
          label: 'scope agent',
          phaseIndex: 1,
          phaseTitle: 'Scope',
          state: 'done',
          startedAt: 1783405804000,
          lastProgressAt: 1783405805000,
        },
      ],
    });

    writeSubagentJsonl('agenta', [
      makeSessionMessage('user', 'do research'),
      makeSessionMessage('assistant', 'result'),
    ]);

    const state = loadWorkflowState({ folderPath, sessionId, runId, toolUseId: 'tool-wf-1' });
    assert.ok(state);
    assert.strictEqual(state!.runId, runId);
    assert.strictEqual(state!.sessionId, sessionId);
    assert.strictEqual(state!.toolUseId, 'tool-wf-1');
    assert.strictEqual(state!.workflowName, 'deep-research');
    assert.strictEqual(state!.status, 'running');
    assert.strictEqual(state!.summary, 'Researching...');
    assert.strictEqual(state!.agentCount, 2);
    assert.strictEqual(state!.totalTokens, 1234);
    assert.strictEqual(state!.totalToolCalls, 56);
    assert.strictEqual(state!.durationMs, 10000);
    assert.strictEqual(state!.phases.length, 1);
    assert.strictEqual(state!.progress.length, 2);
    assert.strictEqual(state!.subagents.length, 1);
    assert.strictEqual(state!.subagents[0]!.parentToolUseId, `workflow:${runId}:agenta`);
    assert.strictEqual(state!.subagents[0]!.description, 'scope agent');
  });

  it('returns a workflow with an empty subagent list when the subagent dir is missing', () => {
    writeWorkflowJson({
      runId,
      status: 'completed',
      startTime: 1783405803581,
      agentCount: 0,
      phases: [],
      workflowProgress: [],
    });

    const state = loadWorkflowState({ folderPath, sessionId, runId });
    assert.ok(state);
    assert.strictEqual(state!.status, 'completed');
    assert.strictEqual(state!.subagents.length, 0);
  });

  it('skips malformed subagent jsonl files and keeps the rest', () => {
    writeWorkflowJson({
      runId,
      status: 'running',
      startTime: 1783405803581,
      agentCount: 2,
      phases: [],
      workflowProgress: [
        { type: 'workflow_agent', index: 1, agentId: 'good', state: 'done' },
        { type: 'workflow_agent', index: 2, agentId: 'bad', state: 'running' },
      ],
    });

    writeSubagentJsonl('good', [
      makeSessionMessage('user', 'hello'),
      makeSessionMessage('assistant', 'world'),
    ]);
    writeSubagentJsonl('bad', ['not-valid-json']);

    const state = loadWorkflowState({ folderPath, sessionId, runId });
    assert.ok(state);
    assert.strictEqual(state!.subagents.length, 1);
    assert.strictEqual(state!.subagents[0]!.parentToolUseId, `workflow:${runId}:good`);
  });

  it('lists workflow runIds from the session workflows directory', () => {
    runId = 'wf_a';
    writeWorkflowJson({ runId: 'wf_a', status: 'completed', startTime: 1, agentCount: 0, phases: [], workflowProgress: [] });
    runId = 'wf_b';
    writeWorkflowJson({ runId: 'wf_b', status: 'completed', startTime: 1, agentCount: 0, phases: [], workflowProgress: [] });

    const runIds = listWorkflowRunIds(folderPath, sessionId);
    assert.deepStrictEqual(runIds.sort(), ['wf_a', 'wf_b']);
  });

  it('normalizes an unknown status to running', () => {
    writeWorkflowJson({
      runId,
      status: 'weird',
      startTime: 1783405803581,
      agentCount: 0,
      phases: [],
      workflowProgress: [],
    });

    const state = loadWorkflowState({ folderPath, sessionId, runId });
    assert.ok(state);
    assert.strictEqual(state!.status, 'running');
  });
});
