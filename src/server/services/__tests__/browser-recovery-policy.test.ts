import '../../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyBrowserRecovery,
  type BrowserRecoveryFailure,
} from '../browser-recovery-policy.js';
import type { BrowserMutationReason } from '../browser-cdp.js';
import type { BrowserDecisionObservationErrorCode } from '../browser-decision-observation.js';

const MUTATION_REASONS: BrowserMutationReason[] = [
  'target_unavailable', 'target_disabled', 'target_not_visible', 'target_occluded',
  'target_frame_mismatch', 'unsupported_target', 'unsupported_input_command',
  'dispatch_failed', 'verification_mismatch', 'runtime_replaced',
  'control_taken_over', 'cancelled', 'user_denied', 'target_changed',
];

const OBSERVATION_REASONS: BrowserDecisionObservationErrorCode[] = [
  'observation_cancelled', 'observation_unavailable', 'observation_unstable',
  'observation_timeout', 'observation_invalid_image', 'observation_too_large',
  'observation_invalid_transform', 'observation_mask_failed',
  'observation_budget_exhausted',
];

describe('closed browser recovery policy', () => {
  it('exhaustively maps every trusted mutation and observation failure', () => {
    const failures: BrowserRecoveryFailure[] = [
      ...MUTATION_REASONS.map((reason) => ({ source: 'mutation' as const, reason, dispatchState: 'not_dispatched' as const })),
      ...OBSERVATION_REASONS.map((reason) => ({ source: 'observation' as const, reason })),
    ];
    for (const failure of failures) {
      const decision = classifyBrowserRecovery(failure);
      assert.notEqual(decision.category, 'unmapped');
      assert.ok(decision.allowedPrimitive);
      assert.ok(decision.terminalState);
      assert.ok(Array.isArray(decision.invalidate));
    }
  });

  it('permits reveal only for a trusted off-viewport target', () => {
    assert.equal(classifyBrowserRecovery({
      source: 'mutation', reason: 'target_not_visible', dispatchState: 'not_dispatched',
      trustedFacts: { connected: true, visible: true, inViewport: false, occluded: false },
    }).allowedPrimitive, 'reveal');
    assert.equal(classifyBrowserRecovery({
      source: 'mutation', reason: 'target_not_visible', dispatchState: 'not_dispatched',
    }).allowedPrimitive, 'handoff');
  });

  it('never retries a mutation after possible dispatch', () => {
    const decision = classifyBrowserRecovery({
      source: 'mutation', reason: 'dispatch_failed', dispatchState: 'dispatched',
    });
    assert.equal(decision.category, 'outcome_unknown');
    assert.equal(decision.allowedPrimitive, 'reconcile_readonly');
    assert.equal(decision.retryBudget, 0);
  });

  it('fails closed for future unmapped reasons', () => {
    const decision = classifyBrowserRecovery({ source: 'mutation', reason: 'future_reason', dispatchState: 'not_dispatched' } as never);
    assert.equal(decision.category, 'unmapped');
    assert.equal(decision.allowedPrimitive, 'handoff');
    assert.equal(decision.terminalState, 'blocked');
  });
});
