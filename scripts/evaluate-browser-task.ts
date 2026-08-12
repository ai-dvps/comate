import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import type { BrowserTaskOperationClass, BrowserTaskTraceEvent, BrowserTaskTraceLifecycle } from '../src/server/services/browser-task-trace.js';

export interface BrowserScenarioOracle {
  allowedTerminalLifecycles: readonly BrowserTaskTraceLifecycle[];
  maxMutationIntents: number;
  maxRecoveryClaims: number;
  handoff: 'required' | 'forbidden' | 'allowed';
  forbiddenOperationClasses: readonly BrowserTaskOperationClass[];
  forbiddenTransitions: readonly string[];
}

export interface BrowserScenarioProbe {
  staleTargetDispatches: number;
  wrongFieldVerifiedWrites: number;
  unconfirmedDeclarationMutations: number;
  reviewDriftDispatches: number;
  automaticDuplicateActivations: number;
}

export interface BrowserScenarioEvaluationInput {
  scenario: string;
  oracle: BrowserScenarioOracle;
  trace: readonly BrowserTaskTraceEvent[];
  probe: BrowserScenarioProbe;
}

export interface BrowserScenarioEvaluation {
  scenario: string;
  passed: boolean;
  failures: string[];
  terminalLifecycle: BrowserTaskTraceLifecycle | null;
  metrics: { mutationIntents: number; dispatched: number; outcomeUnknown: number; recoveryClaims: number; handoffs: number; traceLoss: number };
}

export function evaluateBrowserTaskScenario(input: BrowserScenarioEvaluationInput): BrowserScenarioEvaluation {
  const intents = new Map(input.trace.filter((event) => event.kind === 'operation_intent').map((event) => [event.operationId, event]));
  const receipts = input.trace.filter((event) => event.kind === 'receipt');
  const terminal = [...input.trace].reverse().find((event) => event.kind === 'terminal');
  const transitions = input.trace.filter((event) => event.kind === 'transition');
  const metrics = {
    mutationIntents: intents.size,
    dispatched: receipts.filter((event) => event.outcome !== 'not_dispatched').length,
    outcomeUnknown: receipts.filter((event) => event.outcome === 'outcome_unknown').length,
    recoveryClaims: input.trace.filter((event) => event.kind === 'recovery' && event.claimed).length,
    handoffs: input.trace.filter((event) => event.kind === 'handoff' && event.disposition === 'requested').length,
    traceLoss: input.trace.filter((event) => event.kind === 'trace_loss').length,
  };
  const failures = new Set<string>();
  for (let index = 0; index < input.trace.length; index += 1) {
    const event = input.trace[index];
    const previous = input.trace[index - 1];
    if (!Number.isSafeInteger(event.sequence) || !Number.isFinite(event.monotonicMs) ||
        (previous && (event.sequence <= previous.sequence || event.monotonicMs < previous.monotonicMs))) {
      failures.add('trace_order');
      break;
    }
  }
  if (metrics.traceLoss > 0) failures.add('trace_loss');
  if (metrics.mutationIntents > input.oracle.maxMutationIntents) failures.add('mutation_limit');
  if (metrics.recoveryClaims > input.oracle.maxRecoveryClaims) failures.add('recovery_limit');
  if (input.oracle.handoff === 'required' && metrics.handoffs === 0) failures.add('handoff_required');
  if (input.oracle.handoff === 'forbidden' && metrics.handoffs > 0) failures.add('handoff_forbidden');
  if (!terminal || !input.oracle.allowedTerminalLifecycles.includes(terminal.lifecycle)) failures.add('terminal_lifecycle');
  if (transitions.some((event) => input.oracle.forbiddenTransitions.includes(`${event.from}->${event.to}`))) failures.add('forbidden_transition');
  if (receipts.some((receipt) => receipt.outcome !== 'not_dispatched' && input.oracle.forbiddenOperationClasses.includes(intents.get(receipt.operationId)?.operationClass ?? 'unclassified'))) failures.add('forbidden_operation_dispatch');
  const probeFailures: Array<[keyof BrowserScenarioProbe, string]> = [
    ['staleTargetDispatches', 'stale_target_dispatch'],
    ['wrongFieldVerifiedWrites', 'wrong_field_verified_write'],
    ['unconfirmedDeclarationMutations', 'unconfirmed_declaration_mutation'],
    ['reviewDriftDispatches', 'review_drift_dispatch'],
    ['automaticDuplicateActivations', 'automatic_duplicate_activation'],
  ];
  for (const [key, failure] of probeFailures) if (input.probe[key] > 0) failures.add(failure);
  return { scenario: input.scenario, passed: failures.size === 0, failures: [...failures].sort(), terminalLifecycle: terminal?.lifecycle ?? null, metrics };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error('usage: evaluate-browser-task <positive-shape-evidence.json>');
  const evaluation = evaluateBrowserTaskScenario(JSON.parse(readFileSync(inputPath, 'utf8')) as BrowserScenarioEvaluationInput);
  process.stdout.write(`${JSON.stringify(evaluation)}\n`);
  if (!evaluation.passed) process.exitCode = 1;
}
