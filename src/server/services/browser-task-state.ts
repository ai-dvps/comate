import { randomUUID } from 'crypto';
import {
  store as defaultStore,
  type BrowserTaskStored,
  type BrowserTaskStoredSlot,
  type SqliteStore,
} from '../storage/sqlite-store.js';
import type { DecisionObservationBudget } from './browser-decision-observation.js';

export type BrowserTaskLifecycle =
  | 'active' | 'awaiting-user' | 'validating' | 'ready' | 'blocked'
  | 'outcome-unknown' | 'complete' | 'abandoned';
export type SlotDiscovery = 'unavailable' | 'available' | 'blocked';
export type SlotPopulation = 'empty' | 'populated';
export type SlotValidation = 'unverified' | 'pending' | 'verified' | 'stale';
export type SlotAuthority = 'not_required' | 'awaiting_user' | 'confirmed' | 'stale';
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
  lifecycle: BrowserTaskLifecycle;
  required: number;
  populatedPendingValidation: number;
  verified: number;
  awaitingAuthority: number;
  recoveryExhausted: boolean;
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
  if (slots.some((slot) => slot.authority === 'awaiting_user' || slot.authority === 'stale')) return 'awaiting-user';
  if (slots.some((slot) => slot.validation === 'pending')) return 'validating';
  const required = slots.filter((slot) => slot.required);
  if (required.length > 0 && required.every((slot) =>
    slot.discovery === 'available' && slot.population === 'populated' &&
    slot.validation === 'verified' && slot.authority !== 'awaiting_user')) return 'ready';
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
    } : slot);
    if (!slots.some((slot) => slot.slotKey === input.slotKey)) throw new Error('browser_task_slot_missing');
    return this.cas(task, expectedVersion, slots);
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
        (current.pendingEvidenceClass === 'target_local' && input.structuralChecksum === current.baselineStructuralChecksum) ||
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
    const task = this.requireCurrent({ ...scope, runtimeGeneration: taskRuntime(this.store, taskId), capabilityId: taskCapability(this.store, taskId) }, taskId);
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

  recordDurableCompletion(scope: BrowserTaskScope, taskId: string, expectedVersion: number, durableEvidenceId: string): BrowserTaskState {
    if (!ID.test(durableEvidenceId)) throw new Error('invalid_browser_task_evidence');
    const task = this.requireCurrent(scope, taskId);
    if (task.lifecycle !== 'outcome-unknown' && task.lifecycle !== 'ready') throw new Error('browser_task_not_completable');
    const updated = fromStored(this.store.casBrowserTask(taskId, expectedVersion,
      { lifecycle: 'complete', revokeBindings: true }, toStored(task.slots)));
    this.emit(updated);
    return updated;
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
    return {
      lifecycle: task.lifecycle,
      required: task.slots.filter((slot) => slot.required).length,
      populatedPendingValidation: task.slots.filter((slot) => slot.population === 'populated' && slot.validation !== 'verified').length,
      verified: task.slots.filter((slot) => slot.validation === 'verified').length,
      awaitingAuthority: task.slots.filter((slot) => slot.authority === 'awaiting_user' || slot.authority === 'stale').length,
      recoveryExhausted: task.lifecycle === 'blocked' && this.store.hasBrowserTaskRecovery(task.taskId),
    };
  }

  onProjection(listener: (workspaceId: string, sessionId: string, projection: BrowserTaskProjection | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  decisionObservationBudget(scope: BrowserTaskScope): DecisionObservationBudget {
    return { consume: () => {
      const active = this.getActive(scope);
      if (!active || active.principalId !== scope.principalId || active.runtimeGeneration !== scope.runtimeGeneration ||
          active.capabilityId !== scope.capabilityId) return false;
      return this.store.consumeBrowserTaskObservation(scope.workspaceId, scope.sessionId, active.taskId,
        this.options.maxObservationsPerTask ?? 100);
    } };
  }

  private requireCurrent(scope: BrowserTaskScope, taskId: string): BrowserTaskState {
    assertScope(scope);
    const task = this.getActive(scope);
    if (!task || task.taskId !== taskId || task.workspaceId !== scope.workspaceId ||
        task.sessionId !== scope.sessionId || task.principalId !== scope.principalId ||
        task.runtimeGeneration !== scope.runtimeGeneration || task.capabilityId !== scope.capabilityId) {
      throw new Error('browser_task_scope_mismatch');
    }
    return task;
  }

  private loadActive(workspaceId: string, sessionId: string): BrowserTaskState | null {
    const task = this.store.getActiveBrowserTask(workspaceId, sessionId);
    return task ? fromStored(task) : null;
  }

  private cas(task: BrowserTaskState, expectedVersion: number, slots: BrowserTaskSlot[]): BrowserTaskState {
    const normalized = normalizeSlots(slots);
    const updated = fromStored(this.store.casBrowserTask(task.taskId, expectedVersion, {
      lifecycle: deriveBrowserTaskLifecycle(normalized),
    }, toStored(normalized)));
    this.emit(updated);
    return updated;
  }

  private emit(task: BrowserTaskState): void { this.notify(task.workspaceId, task.sessionId, this.projection(task.workspaceId, task.sessionId)); }
  private notify(workspaceId: string, sessionId: string, projection: BrowserTaskProjection | null): void {
    for (const listener of this.listeners) listener(workspaceId, sessionId, projection);
  }
}

function taskRuntime(store: SqliteStore, taskId: string): string {
  const task = store.getBrowserTask(taskId);
  if (!task) throw new Error('browser_task_missing');
  return task.runtimeGeneration;
}

function taskCapability(store: SqliteStore, taskId: string): string {
  const task = store.getBrowserTask(taskId);
  if (!task) throw new Error('browser_task_missing');
  return task.capabilityId;
}

export const browserTaskStateService = new BrowserTaskStateService();
