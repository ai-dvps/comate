import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateBrowserTaskScenario } from './evaluate-browser-task.js';

describe('evaluateBrowserTaskScenario', () => {
  const oracle = {
    allowedTerminalLifecycles: ['complete', 'blocked'] as const,
    maxMutationIntents: 2,
    maxRecoveryClaims: 1,
    handoff: 'allowed' as const,
    forbiddenOperationClasses: ['unclassified'] as const,
    forbiddenTransitions: ['complete->active'] as const,
  };

  it('accepts a safe stop and reports bounded positive-shape metrics', () => {
    const result = evaluateBrowserTaskScenario({
      scenario: 'unrelated-overlay',
      oracle,
      trace: [
        { kind: 'operation_intent', taskId: 'task-1', taskVersion: 1, operationId: 'op-1', slotKey: 'body_0', operationClass: 'field', sequence: 1, monotonicMs: 10 },
        { kind: 'receipt', taskId: 'task-1', taskVersion: 1, operationId: 'op-1', outcome: 'not_dispatched', sequence: 2, monotonicMs: 12 },
        { kind: 'transition', taskId: 'task-1', taskVersion: 2, from: 'active', to: 'blocked', reason: 'policy', sequence: 3, monotonicMs: 13 },
        { kind: 'terminal', taskId: 'task-1', taskVersion: 2, lifecycle: 'blocked', sequence: 4, monotonicMs: 14 },
      ],
      probe: { staleTargetDispatches: 0, wrongFieldVerifiedWrites: 0, unconfirmedDeclarationMutations: 0, reviewDriftDispatches: 0, automaticDuplicateActivations: 0 },
    });
    assert.equal(result.passed, true);
    assert.deepEqual(result.metrics, { mutationIntents: 1, dispatched: 0, outcomeUnknown: 0, recoveryClaims: 0, handoffs: 0, traceLoss: 0 });
    assert.equal(JSON.stringify(result).includes('task-1'), false);
  });

  it('fails closed on trace loss, duplicate activation, or forbidden dispatch', () => {
    const result = evaluateBrowserTaskScenario({
      scenario: 'unknown-outcome', oracle,
      trace: [
        { kind: 'trace_loss', lostCount: 1, sequence: 1, monotonicMs: 1 },
        { kind: 'operation_intent', taskId: 'task-1', taskVersion: 1, operationId: 'op-1', slotKey: 'final_activation_0', operationClass: 'unclassified', sequence: 2, monotonicMs: 2 },
        { kind: 'receipt', taskId: 'task-1', taskVersion: 1, operationId: 'op-1', outcome: 'dispatched_verified', sequence: 3, monotonicMs: 3 },
        { kind: 'terminal', taskId: 'task-1', taskVersion: 2, lifecycle: 'complete', sequence: 4, monotonicMs: 4 },
      ],
      probe: { staleTargetDispatches: 0, wrongFieldVerifiedWrites: 0, unconfirmedDeclarationMutations: 0, reviewDriftDispatches: 0, automaticDuplicateActivations: 1 },
    });
    assert.equal(result.passed, false);
    assert.deepEqual(result.failures.sort(), ['automatic_duplicate_activation', 'forbidden_operation_dispatch', 'trace_loss']);
  });

  it('rejects a reordered diagnostic trace', () => {
    const result = evaluateBrowserTaskScenario({ scenario: 'reordered', oracle,
      trace: [
        { kind: 'terminal', taskId: 'task-1', taskVersion: 2, lifecycle: 'blocked', sequence: 2, monotonicMs: 12 },
        { kind: 'transition', taskId: 'task-1', taskVersion: 2, from: 'active', to: 'blocked', reason: 'policy', sequence: 1, monotonicMs: 10 },
      ],
      probe: { staleTargetDispatches: 0, wrongFieldVerifiedWrites: 0, unconfirmedDeclarationMutations: 0, reviewDriftDispatches: 0, automaticDuplicateActivations: 0 } });
    assert.deepEqual(result.failures, ['trace_order']);
  });
});
