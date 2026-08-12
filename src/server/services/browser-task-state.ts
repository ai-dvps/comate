import { randomUUID } from 'crypto';
import {
  store as defaultStore,
  type BrowserTaskStored,
  type BrowserTaskStoredSlot,
  type BrowserFinalActionEntry,
  type BrowserFinalEvidenceStatus,
  type SqliteStore,
} from '../storage/sqlite-store.js';
import type { DecisionObservationBudget } from './browser-decision-observation.js';
import type { BrowserBinding } from '../utils/credential-crypto.js';

export type BrowserTaskLifecycle =
  | 'active' | 'awaiting-user' | 'validating' | 'ready' | 'blocked'
  | 'outcome-unknown' | 'complete' | 'abandoned';
export type SlotDiscovery = 'unavailable' | 'available' | 'blocked';
export type SlotPopulation = 'empty' | 'populated';
export type SlotValidation = 'unverified' | 'pending' | 'verified' | 'stale';
export type SlotAuthority = 'not_required' | 'awaiting_user' | 'confirmed' | 'declined' | 'stale';
export type PopulationBucket = 'empty' | 'short' | 'medium' | 'long' | 'present';
export type BrowserTaskEvidenceClass = 'target_local' | 'business_completion';
export type BrowserTaskRecoveryClass = 'off_viewport' | 'task_overlay';

export interface BrowserTaskScope {
  workspaceId: string;
  sessionId: string;
  principalId: string;
  runtimeGeneration: string;
  capabilityId: string;
}

export interface BrowserTaskSlot {
  slotKey: string;
  discovery: SlotDiscovery;
  required: boolean;
  population: SlotPopulation;
  validation: SlotValidation;
  authority: SlotAuthority;
  populationBucket: PopulationBucket;
  evidenceId: string | null;
  observationEpoch: number | null;
  pendingOperationId?: string | null;
  baselineObservationEpoch?: number | null;
  baselineObservationId?: string | null;
  baselineDocumentIdentity?: string | null;
  baselineStructuralChecksum?: string | null;
  pendingTargetBinding?: string | null;
  pendingRuntimeGeneration?: string | null;
  pendingCapabilityId?: string | null;
  pendingControlEpoch?: string | null;
  pendingEvidenceClass?: BrowserTaskEvidenceClass | null;
}

export interface BrowserTaskState extends BrowserTaskScope {
  taskId: string;
  goalEpoch: string;
  version: number;
  lifecycle: BrowserTaskLifecycle;
  observationCount: number;
  slots: BrowserTaskSlot[];
  createdAt: string;
  updatedAt: string;
}

export interface BrowserTaskProjection {
  taskId: string;
  version: number;
  lifecycle: BrowserTaskLifecycle;
  required: number;
  populatedPendingValidation: number;
  verified: number;
  awaitingAuthority: number;
  recoveryExhausted: boolean;
  outcome?: {
    possibleDispatch: boolean;
    evidenceStatus: BrowserFinalEvidenceStatus;
    lastCheckedAt: string | null;
    canRecheck: boolean;
    canAbandon: boolean;
    canAcknowledgeDuplicateRisk: boolean;
  };
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SLOT = /^[a-z][a-z0-9_]{0,63}$/;

function assertScope(scope: BrowserTaskScope): void {
  for (const [key, value] of Object.entries(scope)) {
    if (!ID.test(value)) throw new Error(`invalid_browser_task_scope:${key}`);
  }
}

function normalizeSlots(slots: BrowserTaskSlot[]): BrowserTaskSlot[] {
  const seen = new Set<string>();
  return slots.map((slot) => {
    if (!SLOT.test(slot.slotKey) || seen.has(slot.slotKey)) throw new Error('invalid_browser_task_slot');
    seen.add(slot.slotKey);
    if (slot.evidenceId !== null && !ID.test(slot.evidenceId)) throw new Error('invalid_browser_task_evidence');
    if (slot.observationEpoch !== null && (!Number.isSafeInteger(slot.observationEpoch) || slot.observationEpoch < 0)) {
      throw new Error('invalid_browser_task_observation_epoch');
    }
    return { ...slot, pendingOperationId: slot.pendingOperationId ?? null,
      baselineObservationEpoch: slot.baselineObservationEpoch ?? null,
      baselineObservationId: slot.baselineObservationId ?? null,
      baselineDocumentIdentity: slot.baselineDocumentIdentity ?? null,
      baselineStructuralChecksum: slot.baselineStructuralChecksum ?? null,
      pendingTargetBinding: slot.pendingTargetBinding ?? null,
      pendingRuntimeGeneration: slot.pendingRuntimeGeneration ?? null,
      pendingCapabilityId: slot.pendingCapabilityId ?? null,
      pendingControlEpoch: slot.pendingControlEpoch ?? null,
      pendingEvidenceClass: slot.pendingEvidenceClass ?? null };
  });
}

export function deriveBrowserTaskLifecycle(slots: BrowserTaskSlot[]): BrowserTaskLifecycle {
  if (slots.some((slot) => slot.discovery === 'blocked')) return 'blocked';
  if (slots.some((slot) => slot.authority === 'awaiting_user' || slot.authority === 'declined' || slot.authority === 'stale')) return 'awaiting-user';
  if (slots.some((slot) => slot.validation === 'pending')) return 'validating';
  const required = slots.filter((slot) => slot.required);
  if (required.length > 0 && required.every((slot) =>
    slot.discovery === 'available' && slot.population === 'populated' &&
    slot.validation === 'verified' && (slot.authority === 'not_required' || slot.authority === 'confirmed'))) return 'ready';
  return 'active';
}

function fromStored(task: BrowserTaskStored): BrowserTaskState {
  return { ...task, lifecycle: task.lifecycle as BrowserTaskLifecycle,
    slots: task.slots as BrowserTaskSlot[] };
}

function toStored(slots: BrowserTaskSlot[]): BrowserTaskStoredSlot[] {
  return slots.map((slot) => ({ ...slot, pendingOperationId: slot.pendingOperationId ?? null,
    baselineObservationEpoch: slot.baselineObservationEpoch ?? null,
    baselineObservationId: slot.baselineObservationId ?? null,
    baselineDocumentIdentity: slot.baselineDocumentIdentity ?? null,
    baselineStructuralChecksum: slot.baselineStructuralChecksum ?? null,
    pendingTargetBinding: slot.pendingTargetBinding ?? null,
    pendingRuntimeGeneration: slot.pendingRuntimeGeneration ?? null,
    pendingCapabilityId: slot.pendingCapabilityId ?? null,
    pendingControlEpoch: slot.pendingControlEpoch ?? null,
    pendingEvidenceClass: slot.pendingEvidenceClass ?? null }));
}

export class BrowserTaskStateService {
  private readonly listeners = new Set<(workspaceId: string, sessionId: string, projection: BrowserTaskProjection | null) => void>();
  constructor(
    private readonly store: SqliteStore = defaultStore,
    private readonly options: { maxObservationsPerTask?: number } = {},
  ) {}

  createOrReplace(scope: BrowserTaskScope, slots: BrowserTaskSlot[], options: { replaceTaskId?: string } = {}): BrowserTaskState {
    assertScope(scope);
    const normalized = normalizeSlots(slots);
    const taskId = randomUUID();
    const goalEpoch = randomUUID();
    const task = fromStored(this.store.createBrowserTask({ ...scope, taskId, goalEpoch,
      lifecycle: deriveBrowserTaskLifecycle(normalized) }, toStored(normalized), options.replaceTaskId));
    this.emit(task);
    return task;
  }

  getActive(scope: BrowserTaskScope): BrowserTaskState | null {
    assertScope(scope);
    const task = this.loadActive(scope.workspaceId, scope.sessionId);
    return task && task.principalId === scope.principalId &&
      task.runtimeGeneration === scope.runtimeGeneration && task.capabilityId === scope.capabilityId
      ? task : null;
  }

  recordTrustedDiscovery(scope: BrowserTaskScope, taskId: string, expectedVersion: number, discovered: BrowserTaskSlot[]): BrowserTaskState {
    const task = this.requireCurrent(scope, taskId);
    const byKey = new Map(task.slots.map((slot) => [slot.slotKey, slot]));
    for (const slot of normalizeSlots(discovered)) {
      const prior = byKey.get(slot.slotKey);
      byKey.set(slot.slotKey, prior ? {
        ...slot,
        required: prior.required || slot.required,
        population: prior.population,
        populationBucket: prior.populationBucket,
        authority: prior.authority,
      } : { ...slot, validation: 'unverified', authority: 'not_required' });
    }
    return this.cas(task, expectedVersion, [...byKey.values()]);
  }

  recordMutationPending(scope: BrowserTaskScope, taskId: string, expectedVersion: number, input: {
    slotKey: string; operationId: string; baselineObservationEpoch: number;
    baselineObservationId: string; baselineDocumentIdentity: string; baselineStructuralChecksum: string;
    targetBindingDigest: string; controlEpoch: string; evidenceClass: BrowserTaskEvidenceClass;
  }): BrowserTaskState {
    for (const value of [input.operationId, input.baselineObservationId, input.baselineDocumentIdentity, input.baselineStructuralChecksum,
      input.targetBindingDigest, input.controlEpoch]) {
      if (!ID.test(value)) throw new Error('invalid_browser_task_causal_binding');
    }
    if (input.evidenceClass !== 'target_local' && input.evidenceClass !== 'business_completion') {
      throw new Error('invalid_browser_task_evidence_class');
    }
    const task = this.requireCurrent(scope, taskId);
    const slots = task.slots.map((slot) => slot.slotKey === input.slotKey ? {
      ...slot, population: 'populated' as const, validation: 'pending' as const,
      evidenceId: null, pendingOperationId: input.operationId,
      baselineObservationEpoch: input.baselineObservationEpoch,
      baselineObservationId: input.baselineObservationId,
      baselineDocumentIdentity: input.baselineDocumentIdentity,
      baselineStructuralChecksum: input.baselineStructuralChecksum,
      pendingTargetBinding: input.targetBindingDigest,
      pendingRuntimeGeneration: scope.runtimeGeneration,
      pendingCapabilityId: scope.capabilityId,
      pendingControlEpoch: input.controlEpoch,
      pendingEvidenceClass: input.evidenceClass,
    } : slot.slotKey.startsWith('declaration_') && slot.authority === 'confirmed'
      ? { ...slot, authority: 'stale' as const }
      : slot);
    if (!slots.some((slot) => slot.slotKey === input.slotKey)) throw new Error('browser_task_slot_missing');
    return this.cas(task, expectedVersion, slots, { revokeBindings: true });
  }

  beginDeclarationRequest(scope: BrowserTaskScope, taskId: string, expectedVersion: number,
    slotKey: string, binding: BrowserBinding): BrowserTaskState {
    const task = this.requireCurrent(scope, taskId);
    if (!slotKey.startsWith('declaration_') || !task.slots.some((slot) => slot.slotKey === slotKey)) {
      throw new Error('browser_task_declaration_slot_missing');
    }
    return this.cas(task, expectedVersion, task.slots.map((slot) => slot.slotKey === slotKey
      ? { ...slot, authority: 'awaiting_user' as const }
      : slot), { putBinding: { purpose: declarationPurpose('request', slotKey), keyVersion: binding.version, digest: binding.digest } });
  }

  consumeDeclarationRequest(scope: BrowserTaskScope, taskId: string, expectedVersion: number,
    slotKey: string, binding: BrowserBinding, decision: 'approved' | 'denied' | 'later' | 'revoked'): BrowserTaskState {
    const task = this.requireCurrent(scope, taskId);
    const authority: SlotAuthority = decision === 'denied' ? 'declined' : decision === 'revoked' ? 'stale' : 'awaiting_user';
    return this.cas(task, expectedVersion, task.slots.map((slot) => slot.slotKey === slotKey
      ? { ...slot, authority }
      : slot), { consumeBinding: { purpose: declarationPurpose('request', slotKey), keyVersion: binding.version, digest: binding.digest } });
  }

  confirmDeclarationAuthority(scope: BrowserTaskScope, taskId: string, expectedVersion: number,
    slotKey: string, binding: BrowserBinding,
    evidence: { observationId: string; observationEpoch: number }): BrowserTaskState {
    if (!ID.test(evidence.observationId) || !Number.isSafeInteger(evidence.observationEpoch) || evidence.observationEpoch < 0) {
      throw new Error('invalid_browser_task_declaration_evidence');
    }
    const task = this.requireCurrent(scope, taskId);
    return this.cas(task, expectedVersion, task.slots.map((slot) => slot.slotKey === slotKey
      ? {
          ...slot,
          authority: 'confirmed' as const,
          population: 'populated' as const,
          validation: 'verified' as const,
          evidenceId: evidence.observationId,
          observationEpoch: evidence.observationEpoch,
        }
      : slot), { putBinding: { purpose: declarationPurpose('authority', slotKey), keyVersion: binding.version, digest: binding.digest } });
  }

  verifyDeclarationAuthority(taskId: string, slotKey: string, binding: BrowserBinding): boolean {
    const stored = this.store.getBrowserTaskBinding(taskId, declarationPurpose('authority', slotKey));
    return stored?.keyVersion === binding.version && stored.digest === binding.digest;
  }

  validateFromObservation(scope: BrowserTaskScope, taskId: string, expectedVersion: number, input: {
    slotKey: string; operationId: string; observationId: string; observationEpoch: number;
    documentIdentity: string; structuralChecksum: string; targetBindingDigest: string; controlEpoch: string; predicateMatched: boolean;
  }): BrowserTaskState {
    const task = this.requireCurrent(scope, taskId);
    const current = task.slots.find((slot) => slot.slotKey === input.slotKey);
    if (!current || current.pendingOperationId !== input.operationId ||
        current.baselineObservationEpoch == null || input.observationEpoch <= current.baselineObservationEpoch ||
        input.observationId === current.baselineObservationId || input.predicateMatched !== true ||
        input.documentIdentity !== current.baselineDocumentIdentity ||
        input.targetBindingDigest !== current.pendingTargetBinding ||
        scope.runtimeGeneration !== current.pendingRuntimeGeneration ||
        scope.capabilityId !== current.pendingCapabilityId || input.controlEpoch !== current.pendingControlEpoch) {
      throw new Error('browser_task_observation_not_causal');
    }
    if (!ID.test(input.observationId)) throw new Error('invalid_browser_task_evidence');
    return this.cas(task, expectedVersion, task.slots.map((slot) => slot.slotKey === input.slotKey ? {
      ...slot, validation: 'verified' as const, evidenceId: input.observationId,
      observationEpoch: input.observationEpoch, pendingOperationId: null,
      baselineObservationEpoch: null,
      baselineObservationId: null, baselineDocumentIdentity: null, baselineStructuralChecksum: null, pendingTargetBinding: null,
      pendingRuntimeGeneration: null, pendingCapabilityId: null, pendingControlEpoch: null,
      pendingEvidenceClass: null,
    } : slot));
  }

  claimRecovery(scope: BrowserTaskScope, taskId: string, expectedVersion: number,
    targetBindingDigest: string, failureClass: BrowserTaskRecoveryClass): boolean {
    if (!ID.test(targetBindingDigest) || !['off_viewport', 'task_overlay'].includes(failureClass)) {
      throw new Error('invalid_browser_task_recovery');
    }
    const task = this.requireCurrent(scope, taskId);
    if (task.version !== expectedVersion) throw new Error('browser_task_stale');
    return this.store.claimBrowserTaskRecovery(taskId, expectedVersion, targetBindingDigest, failureClass);
  }

  cancelMutationPending(scope: BrowserTaskScope, taskId: string, expectedVersion: number,
    slotKey: string, operationId: string): BrowserTaskState {
    const task = this.requireCurrent(scope, taskId);
    const current = task.slots.find((slot) => slot.slotKey === slotKey);
    if (!current || current.pendingOperationId !== operationId) throw new Error('browser_task_pending_mismatch');
    return this.cas(task, expectedVersion, task.slots.map((slot) => slot.slotKey === slotKey ? {
      ...slot, validation: 'unverified' as const, pendingOperationId: null, baselineObservationEpoch: null,
      baselineObservationId: null, baselineDocumentIdentity: null, baselineStructuralChecksum: null,
      pendingTargetBinding: null, pendingRuntimeGeneration: null, pendingCapabilityId: null,
      pendingControlEpoch: null, pendingEvidenceClass: null,
    } : slot));
  }

  blockRecoveryExhausted(scope: BrowserTaskScope, taskId: string, expectedVersion: number, slotKey: string): BrowserTaskState {
    const task = this.requireCurrent(scope, taskId);
    if (!task.slots.some((slot) => slot.slotKey === slotKey)) throw new Error('browser_task_slot_missing');
    return this.cas(task, expectedVersion, task.slots.map((slot) => slot.slotKey === slotKey
      ? { ...slot, discovery: 'blocked' as const }
      : slot));
  }

  reclaim(scope: BrowserTaskScope, taskId: string, expectedVersion: number): BrowserTaskState {
    assertScope(scope);
    const stored = this.store.getBrowserTask(taskId);
    if (!stored || stored.workspaceId !== scope.workspaceId || stored.sessionId !== scope.sessionId ||
        stored.principalId !== scope.principalId) throw new Error('browser_task_scope_mismatch');
    const task = fromStored(stored);
    const slots = task.slots.map((slot) => ({ ...slot,
      validation: slot.validation === 'unverified' ? 'unverified' as const : 'stale' as const,
      authority: slot.authority === 'not_required' ? 'not_required' as const : 'stale' as const,
      evidenceId: null, observationEpoch: null,
      pendingOperationId: null, baselineObservationEpoch: null,
      baselineObservationId: null, baselineDocumentIdentity: null, baselineStructuralChecksum: null, pendingTargetBinding: null,
      pendingRuntimeGeneration: null, pendingCapabilityId: null, pendingControlEpoch: null, pendingEvidenceClass: null }));
    return fromStored(this.store.casBrowserTask(taskId, expectedVersion, {
      runtimeGeneration: scope.runtimeGeneration, capabilityId: scope.capabilityId,
      lifecycle: deriveBrowserTaskLifecycle(slots), revokeBindings: true,
    }, toStored(slots)));
  }

  /** Application-owned runtime recovery: the server selects the session's active head. */
  reclaimActive(scope: BrowserTaskScope): BrowserTaskState | null {
    assertScope(scope);
    const task = this.loadActive(scope.workspaceId, scope.sessionId);
    if (!task) return null;
    if (task.principalId !== scope.principalId) throw new Error('browser_task_scope_mismatch');
    if (task.runtimeGeneration === scope.runtimeGeneration && task.capabilityId === scope.capabilityId) return task;
    const slots = task.slots.map((slot) => ({ ...slot,
      validation: slot.validation === 'unverified' ? 'unverified' as const : 'stale' as const,
      authority: slot.authority === 'not_required' ? 'not_required' as const : 'stale' as const,
      evidenceId: null, observationEpoch: null, pendingOperationId: null,
      baselineObservationEpoch: null, baselineObservationId: null, baselineDocumentIdentity: null, baselineStructuralChecksum: null,
      pendingTargetBinding: null, pendingRuntimeGeneration: null, pendingCapabilityId: null,
      pendingControlEpoch: null, pendingEvidenceClass: null }));
    const updated = fromStored(this.store.casBrowserTask(task.taskId, task.version, {
      runtimeGeneration: scope.runtimeGeneration, capabilityId: scope.capabilityId,
      lifecycle: deriveBrowserTaskLifecycle(slots), revokeBindings: true,
    }, toStored(slots)));
    this.emit(updated);
    return updated;
  }

  invalidateRuntime(workspaceId: string, sessionId: string): BrowserTaskState | null {
    const task = this.loadActive(workspaceId, sessionId);
    if (!task) return null;
    const slots = task.slots.map((slot) => ({ ...slot,
      validation: slot.validation === 'unverified' ? 'unverified' as const : 'stale' as const,
      authority: slot.authority === 'not_required' ? 'not_required' as const : 'stale' as const,
      evidenceId: null, observationEpoch: null,
      pendingOperationId: null, baselineObservationEpoch: null,
      baselineObservationId: null, baselineDocumentIdentity: null, baselineStructuralChecksum: null, pendingTargetBinding: null,
      pendingRuntimeGeneration: null, pendingCapabilityId: null, pendingControlEpoch: null, pendingEvidenceClass: null }));
    const updated = fromStored(this.store.casBrowserTask(task.taskId, task.version, {
      lifecycle: deriveBrowserTaskLifecycle(slots), revokeBindings: true,
    }, toStored(slots)));
    this.emit(updated);
    return updated;
  }

  markOutcomeUnknown(scope: BrowserTaskScope, taskId: string, expectedVersion: number): BrowserTaskState {
    const task = this.requireCurrent(scope, taskId);
    const updated = fromStored(this.store.casBrowserTask(taskId, expectedVersion,
      { lifecycle: 'outcome-unknown' }, toStored(task.slots)));
    this.emit(updated);
    return updated;
  }

  prepareFinalAction(scope: BrowserTaskScope, taskId: string, expectedVersion: number, input: {
    operationId: string; slotKey: string; targetBindingDigest: string; controlEpoch: string;
    reviewBinding: BrowserBinding; outcomePredicate: BrowserBinding;
  }): BrowserTaskState {
    for (const value of [input.operationId, input.slotKey, input.targetBindingDigest, input.controlEpoch]) {
      if (!ID.test(value)) throw new Error('invalid_browser_task_final_binding');
    }
    if (!input.reviewBinding.digest || input.reviewBinding.digest.length > 256 ||
        !input.outcomePredicate.digest || input.outcomePredicate.digest.length > 256) {
      throw new Error('invalid_browser_task_final_binding');
    }
    const task = this.requireCurrent(scope, taskId);
    if (task.version !== expectedVersion || task.lifecycle !== 'ready') throw new Error('browser_task_not_ready');
    const updated = fromStored(this.store.createBrowserFinalAction({
      taskId, expectedVersion, operationId: input.operationId, slotKey: input.slotKey,
      targetBindingDigest: input.targetBindingDigest, controlEpoch: input.controlEpoch,
      reviewKeyVersion: input.reviewBinding.version, reviewBindingDigest: input.reviewBinding.digest,
      predicateKeyVersion: input.outcomePredicate.version, predicateBindingDigest: input.outcomePredicate.digest,
    }));
    this.emit(updated);
    return updated;
  }

  awaitFinalReview(scope: BrowserTaskScope, taskId: string, expectedVersion: number): BrowserTaskState {
    const task = this.requireCurrent(scope, taskId);
    const updated = fromStored(this.store.casBrowserTask(taskId, expectedVersion,
      { lifecycle: 'awaiting-user' }, toStored(task.slots)));
    this.emit(updated);
    return updated;
  }

  getFinalAction(taskId: string): BrowserFinalActionEntry | null {
    return this.store.getBrowserFinalAction(taskId);
  }

  recordFinalDispatch(scope: BrowserTaskScope, taskId: string, expectedVersion: number, operationId: string): BrowserTaskState {
    this.requireCurrent(scope, taskId);
    const updated = fromStored(this.store.transitionBrowserFinalAction({
      taskId, expectedVersion, operationId, fromStates: ['reviewed'], state: 'outcome_unknown',
      lifecycle: 'outcome-unknown', evidenceStatus: 'none', revokeBindings: true,
    }));
    this.emit(updated);
    return updated;
  }

  cancelPreparedFinalAction(scope: BrowserTaskScope, taskId: string, expectedVersion: number, operationId: string): BrowserTaskState {
    this.requireCurrent(scope, taskId);
    const updated = fromStored(this.store.transitionBrowserFinalAction({
      taskId, expectedVersion, operationId, fromStates: ['reviewed'], state: 'cancelled',
      lifecycle: 'awaiting-user', revokeBindings: true,
    }));
    this.emit(updated);
    return updated;
  }

  recordOutcomeCheck(scope: BrowserTaskScope, taskId: string, expectedVersion: number, operationId: string,
    evidence: { status: 'insufficient' | 'conflicting' } |
      { status: 'durable'; evidenceId: string; correlatedOperationId: string }): BrowserTaskState {
    this.requireCurrent(scope, taskId);
    if (evidence.status === 'durable') {
      if (!ID.test(evidence.evidenceId) || evidence.correlatedOperationId !== operationId) {
        throw new Error('browser_task_durable_evidence_uncorrelated');
      }
      const updated = fromStored(this.store.transitionBrowserFinalAction({
        taskId, expectedVersion, operationId, fromStates: ['outcome_unknown'], state: 'complete',
        lifecycle: 'complete', evidenceStatus: 'durable', durableEvidenceId: evidence.evidenceId,
        checked: true, revokeBindings: true,
      }));
      this.emit(updated);
      return updated;
    }
    const updated = fromStored(this.store.transitionBrowserFinalAction({
      taskId, expectedVersion, operationId, fromStates: ['outcome_unknown'], state: 'outcome_unknown',
      lifecycle: 'outcome-unknown', evidenceStatus: evidence.status, checked: true,
    }));
    this.emit(updated);
    return updated;
  }

  abandonOutcomeTracking(scope: BrowserTaskScope, taskId: string, expectedVersion: number, operationId: string): BrowserTaskState {
    this.requireCurrent(scope, taskId);
    const updated = fromStored(this.store.transitionBrowserFinalAction({
      taskId, expectedVersion, operationId, fromStates: ['outcome_unknown'], state: 'abandoned',
      lifecycle: 'abandoned', revokeBindings: true,
    }));
    this.emit(updated);
    return updated;
  }

  acknowledgeDuplicateRisk(scope: BrowserTaskScope, taskId: string, expectedVersion: number, operationId: string): BrowserTaskState {
    const task = this.requireCurrent(scope, taskId);
    const slots = task.slots.map((slot) => slot.slotKey.startsWith('final_activation_') ? {
      ...slot, validation: 'stale' as const, evidenceId: null, observationEpoch: null,
    } : slot);
    const updated = fromStored(this.store.transitionBrowserFinalAction({
      taskId, expectedVersion, operationId, fromStates: ['outcome_unknown'], state: 'duplicate_risk_acknowledged',
      lifecycle: 'awaiting-user', slots: toStored(slots), revokeBindings: true,
    }));
    this.emit(updated);
    return updated;
  }

  recordDurableCompletion(scope: BrowserTaskScope, taskId: string, expectedVersion: number, durableEvidenceId: string): BrowserTaskState {
    void scope; void taskId; void expectedVersion; void durableEvidenceId;
    throw new Error('browser_task_trusted_outcome_observer_required');
  }

  abandon(scope: BrowserTaskScope, taskId: string, expectedVersion: number): boolean {
    this.requireCurrent(scope, taskId);
    const abandoned = this.store.abandonBrowserTask(scope.workspaceId, scope.sessionId, taskId, expectedVersion);
    if (abandoned) this.notify(scope.workspaceId, scope.sessionId, null);
    return abandoned;
  }

  purgeSession(workspaceId: string, sessionId: string): number {
    const purged = this.store.purgeBrowserTasksForSession(workspaceId, sessionId);
    if (purged) this.notify(workspaceId, sessionId, null);
    return purged;
  }

  purgeWorkspace(workspaceId: string): number {
    return this.store.purgeBrowserTasksForWorkspace(workspaceId);
  }

  projection(workspaceId: string, sessionId: string): BrowserTaskProjection | null {
    const task = this.loadActive(workspaceId, sessionId);
    if (!task) return null;
    const finalAction = this.store.getBrowserFinalAction(task.taskId);
    return {
      taskId: task.taskId,
      version: task.version,
      lifecycle: task.lifecycle,
      required: task.slots.filter((slot) => slot.required).length,
      populatedPendingValidation: task.slots.filter((slot) => slot.population === 'populated' && slot.validation !== 'verified').length,
      verified: task.slots.filter((slot) => slot.validation === 'verified').length,
      awaitingAuthority: task.slots.filter((slot) => slot.authority === 'awaiting_user' || slot.authority === 'declined' || slot.authority === 'stale').length,
      recoveryExhausted: task.lifecycle === 'blocked' && this.store.hasBrowserTaskRecovery(task.taskId),
      ...(task.lifecycle === 'outcome-unknown' && finalAction?.state === 'outcome_unknown' ? { outcome: {
        possibleDispatch: true,
        evidenceStatus: finalAction.evidenceStatus,
        lastCheckedAt: finalAction.lastCheckedAt,
        canRecheck: true,
        canAbandon: true,
        canAcknowledgeDuplicateRisk: true,
      } } : {}),
    };
  }

  applicationResolveOutcome(workspaceId: string, sessionId: string, taskId: string, expectedVersion: number,
    action: 'recheck' | 'abandon' | 'acknowledge_duplicate_risk'): BrowserTaskState {
    const task = this.loadActive(workspaceId, sessionId);
    if (!task || task.taskId !== taskId || task.version !== expectedVersion || task.lifecycle !== 'outcome-unknown') {
      throw new Error('browser_task_outcome_stale');
    }
    const scope: BrowserTaskScope = {
      workspaceId, sessionId, principalId: task.principalId,
      runtimeGeneration: task.runtimeGeneration, capabilityId: task.capabilityId,
    };
    const finalAction = this.store.getBrowserFinalAction(taskId);
    if (!finalAction || finalAction.state !== 'outcome_unknown') throw new Error('browser_task_outcome_stale');
    if (action === 'abandon') return this.abandonOutcomeTracking(scope, taskId, expectedVersion, finalAction.operationId);
    if (action === 'acknowledge_duplicate_risk') return this.acknowledgeDuplicateRisk(scope, taskId, expectedVersion, finalAction.operationId);
    return this.recordOutcomeCheck(scope, taskId, expectedVersion, finalAction.operationId, { status: 'insufficient' });
  }

  onProjection(listener: (workspaceId: string, sessionId: string, projection: BrowserTaskProjection | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  decisionObservationBudget(scope: BrowserTaskScope): DecisionObservationBudget {
    return { consume: () => {
      const active = this.getActive(scope);
      if (!active) return false;
      return this.store.consumeBrowserTaskObservation(scope.workspaceId, scope.sessionId, active.taskId,
        this.options.maxObservationsPerTask ?? 100);
    } };
  }

  private requireCurrent(scope: BrowserTaskScope, taskId: string): BrowserTaskState {
    const task = this.getActive(scope);
    if (!task || task.taskId !== taskId || task.workspaceId !== scope.workspaceId ||
        task.sessionId !== scope.sessionId) {
      throw new Error('browser_task_scope_mismatch');
    }
    return task;
  }

  private loadActive(workspaceId: string, sessionId: string): BrowserTaskState | null {
    const task = this.store.getActiveBrowserTask(workspaceId, sessionId);
    return task ? fromStored(task) : null;
  }

  private cas(task: BrowserTaskState, expectedVersion: number, slots: BrowserTaskSlot[], patch: {
    revokeBindings?: boolean;
    putBinding?: { purpose: string; keyVersion: number; digest: string };
    consumeBinding?: { purpose: string; keyVersion: number; digest: string };
  } = {}): BrowserTaskState {
    const normalized = normalizeSlots(slots);
    const updated = fromStored(this.store.casBrowserTask(task.taskId, expectedVersion, {
      lifecycle: deriveBrowserTaskLifecycle(normalized), ...patch,
    }, toStored(normalized)));
    this.emit(updated);
    return updated;
  }

  private emit(task: BrowserTaskState): void { this.notify(task.workspaceId, task.sessionId, this.projection(task.workspaceId, task.sessionId)); }
  private notify(workspaceId: string, sessionId: string, projection: BrowserTaskProjection | null): void {
    for (const listener of this.listeners) listener(workspaceId, sessionId, projection);
  }
}

function declarationPurpose(kind: 'request' | 'authority', slotKey: string): string {
  const suffix = slotKey.replace(/_/g, '-').slice(-40);
  return `declaration-${kind}-${suffix}`;
}

export const browserTaskStateService = new BrowserTaskStateService();
