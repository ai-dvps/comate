import { describe, it } from 'vitest'
import assert from 'node:assert'
import { getCurrentPhaseTitle, getWorkflowPhaseIndex, getSubagentCounts } from './workflow-utils'
import type { WorkflowState } from '../types/message'

function makeWorkflow(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    runId: 'wf-1',
    sessionId: 's1',
    status: 'running',
    startTime: 1,
    agentCount: 0,
    phases: [],
    progress: [],
    subagents: [],
    ...overrides,
  }
}

describe('workflow-utils', () => {
  describe('getCurrentPhaseTitle', () => {
    it('returns the current phase from progress, not the last configured phase', () => {
      const workflow = makeWorkflow({
        phases: [
          { title: 'Scope', detail: '' },
          { title: 'Research', detail: '' },
          { title: 'Synthesize', detail: '' },
        ],
        progress: [
          { type: 'workflow_phase', index: 0, title: 'Scope' },
          { type: 'workflow_phase', index: 1, title: 'Research' },
        ],
      })
      assert.strictEqual(getCurrentPhaseTitle(workflow), 'Research')
    })

    it('falls back to the last phase progress title when phases config is empty', () => {
      const workflow = makeWorkflow({
        progress: [
          { type: 'workflow_phase', index: 0, title: 'Scope' },
          { type: 'workflow_phase', index: 1, title: 'Research' },
        ],
      })
      assert.strictEqual(getCurrentPhaseTitle(workflow), 'Research')
    })

    it('returns the first configured phase when there is no progress', () => {
      const workflow = makeWorkflow({
        phases: [{ title: 'Scope', detail: '' }],
      })
      assert.strictEqual(getCurrentPhaseTitle(workflow), 'Scope')
    })

    it('returns undefined when there is no phase information', () => {
      const workflow = makeWorkflow()
      assert.strictEqual(getCurrentPhaseTitle(workflow), undefined)
    })
  })

  describe('getWorkflowPhaseIndex', () => {
    it('returns the index of the most recent phase progress item', () => {
      const workflow = makeWorkflow({
        progress: [
          { type: 'workflow_phase', index: 2, title: 'Research' },
          { type: 'workflow_phase', index: 5, title: 'Synthesize' },
        ],
      })
      assert.strictEqual(getWorkflowPhaseIndex(workflow), 5)
    })

    it('returns -1 when there are no phase progress items', () => {
      const workflow = makeWorkflow()
      assert.strictEqual(getWorkflowPhaseIndex(workflow), -1)
    })
  })

  describe('getSubagentCounts', () => {
    it('counts agents from progress when available', () => {
      const workflow = makeWorkflow({
        progress: [
          { type: 'workflow_agent', index: 0, agentId: 'a1', state: 'done' },
          { type: 'workflow_agent', index: 1, agentId: 'a2', state: 'running' },
          { type: 'workflow_agent', index: 2, agentId: 'a3' },
        ],
      })
      assert.deepStrictEqual(getSubagentCounts(workflow), { completed: 1, running: 1, total: 3 })
    })

    it('falls back to subagent state when progress has no agents', () => {
      const workflow = makeWorkflow({
        agentCount: 2,
        subagents: [
          {
            parentToolUseId: 'workflow:wf-1:a1',
            description: 'A1',
            state: 'completed',
            startTime: 1,
            toolCount: 0,
            progressHint: '',
            messages: [{ id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] }],
          },
          {
            parentToolUseId: 'workflow:wf-1:a2',
            description: 'A2',
            state: 'running',
            startTime: 1,
            toolCount: 0,
            progressHint: '',
            messages: [{ id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] }],
          },
        ],
      })
      assert.deepStrictEqual(getSubagentCounts(workflow), { completed: 1, running: 1, total: 2 })
    })
  })
})
