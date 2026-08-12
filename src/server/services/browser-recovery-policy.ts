import type { BrowserMutationReason } from './browser-cdp.js';
import type { BrowserDecisionObservationErrorCode } from './browser-decision-observation.js';

export type BrowserRecoveryCategory =
  | 'off_viewport' | 'task_overlay' | 'fresh_observation' | 'disambiguation'
  | 'human_handoff' | 'outcome_unknown' | 'structured_only' | 'cancelled'
  | 'awaiting_user' | 'unmapped';
export type BrowserRecoveryPrimitive =
  | 'reveal' | 'observe' | 'observe_overlay' | 'disambiguate' | 'handoff'
  | 'reconcile_readonly' | 'structured_observe' | 'none';
export type BrowserRecoveryInvalidation = 'refs' | 'visual_binding' | 'validation' | 'authority';

export type BrowserRecoveryFailure =
  | {
      source: 'mutation';
      reason: BrowserMutationReason;
      dispatchState: 'not_dispatched' | 'dispatched';
      trustedFacts?: {
        connected: boolean;
        visible: boolean;
        inViewport: boolean;
        occluded: boolean;
        sameTaskOverlay?: boolean;
      };
    }
  | { source: 'observation'; reason: BrowserDecisionObservationErrorCode };

export interface BrowserRecoveryDecision {
  category: BrowserRecoveryCategory;
  allowedPrimitive: BrowserRecoveryPrimitive;
  invalidate: BrowserRecoveryInvalidation[];
  requiresReobservation: boolean;
  retryBudget: 0 | 1;
  terminalState: 'active' | 'awaiting-user' | 'blocked' | 'outcome-unknown';
}

const blocked = (category: BrowserRecoveryCategory = 'human_handoff'): BrowserRecoveryDecision => ({
  category, allowedPrimitive: 'handoff', invalidate: ['refs', 'visual_binding', 'validation'],
  requiresReobservation: true, retryBudget: 0, terminalState: 'blocked',
});

const observe: BrowserRecoveryDecision = {
  category: 'fresh_observation', allowedPrimitive: 'observe',
  invalidate: ['refs', 'visual_binding', 'validation'], requiresReobservation: true,
  retryBudget: 0, terminalState: 'active',
};

const structuredOnly: BrowserRecoveryDecision = {
  category: 'structured_only', allowedPrimitive: 'structured_observe',
  invalidate: ['visual_binding'], requiresReobservation: false,
  retryBudget: 0, terminalState: 'active',
};

function mutationDecision(failure: Extract<BrowserRecoveryFailure, { source: 'mutation' }>): BrowserRecoveryDecision {
  if (failure.dispatchState === 'dispatched') {
    return {
      category: 'outcome_unknown', allowedPrimitive: 'reconcile_readonly',
      invalidate: ['refs', 'visual_binding', 'validation'], requiresReobservation: true,
      retryBudget: 0, terminalState: 'outcome-unknown',
    };
  }
  switch (failure.reason) {
    case 'target_not_visible': {
      const facts = failure.trustedFacts;
      return facts?.connected === true && facts.visible === true && facts.inViewport === false && facts.occluded === false
        ? { category: 'off_viewport', allowedPrimitive: 'reveal', invalidate: ['visual_binding'],
            requiresReobservation: true, retryBudget: 1, terminalState: 'active' }
        : blocked();
    }
    case 'target_occluded':
      return failure.trustedFacts?.sameTaskOverlay === true
        ? { category: 'task_overlay', allowedPrimitive: 'observe_overlay', invalidate: ['visual_binding'],
            requiresReobservation: true, retryBudget: 1, terminalState: 'active' }
        : blocked();
    case 'target_unavailable':
    case 'target_disabled':
    case 'target_changed':
    case 'runtime_replaced':
      return observe;
    case 'verification_mismatch':
      return { category: 'disambiguation', allowedPrimitive: 'disambiguate', invalidate: ['validation'],
        requiresReobservation: true, retryBudget: 0, terminalState: 'awaiting-user' };
    case 'control_taken_over':
    case 'target_frame_mismatch':
    case 'unsupported_target':
    case 'unsupported_input_command':
      return blocked();
    case 'cancelled':
      return { category: 'cancelled', allowedPrimitive: 'observe', invalidate: ['validation'],
        requiresReobservation: true, retryBudget: 0, terminalState: 'active' };
    case 'user_denied':
      return { category: 'awaiting_user', allowedPrimitive: 'none', invalidate: [],
        requiresReobservation: false, retryBudget: 0, terminalState: 'awaiting-user' };
    case 'dispatch_failed':
      return blocked();
  }
}

function observationDecision(reason: BrowserDecisionObservationErrorCode): BrowserRecoveryDecision {
  switch (reason) {
    case 'observation_cancelled':
      return { category: 'cancelled', allowedPrimitive: 'observe', invalidate: ['validation'],
        requiresReobservation: true, retryBudget: 0, terminalState: 'active' };
    case 'observation_unavailable':
    case 'observation_unstable':
    case 'observation_timeout':
    case 'observation_invalid_image':
    case 'observation_too_large':
    case 'observation_invalid_transform':
    case 'observation_mask_failed':
    case 'observation_budget_exhausted':
      return structuredOnly;
  }
}

/** Closed, trusted-side classification. Agent arguments and page text never select recovery. */
export function classifyBrowserRecovery(failure: BrowserRecoveryFailure): BrowserRecoveryDecision {
  if (failure.source === 'mutation') {
    const known = new Set<string>([
      'target_unavailable', 'target_disabled', 'target_not_visible', 'target_occluded',
      'target_frame_mismatch', 'unsupported_target', 'unsupported_input_command',
      'dispatch_failed', 'verification_mismatch', 'runtime_replaced', 'control_taken_over',
      'cancelled', 'user_denied', 'target_changed',
    ]);
    if (!known.has(failure.reason)) return blocked('unmapped');
    return mutationDecision(failure);
  }
  const known = new Set<string>([
    'observation_cancelled', 'observation_unavailable', 'observation_unstable',
    'observation_timeout', 'observation_invalid_image', 'observation_too_large',
    'observation_invalid_transform', 'observation_mask_failed', 'observation_budget_exhausted',
  ]);
  return known.has(failure.reason) ? observationDecision(failure.reason) : blocked('unmapped');
}
