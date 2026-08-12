import '../../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SqliteStore } from '../../storage/sqlite-store.js';
import {
  BrowserTaskStateService,
  deriveBrowserTaskLifecycle,
  type BrowserTaskSlot,
} from '../browser-task-state.js';
import { createBrowserBinding } from '../../utils/credential-crypto.js';

const scope = {
  workspaceId: 'ws-1', sessionId: 'session-1', principalId: 'principal-1',
  runtimeGeneration: 'runtime-1', capabilityId: 'capability-1',
};

function slot(overrides: Partial<BrowserTaskSlot> = {}): BrowserTaskSlot {
  return {
    slotKey: 'primary_content', discovery: 'available', required: true,
    population: 'empty', validation: 'unverified', authority: 'not_required',
    evidenceId: null, observationEpoch: null, populationBucket: 'empty', ...overrides,
  };
}

describe('BrowserTaskStateService', () => {
  it('reclaims the server-selected active head for a rebuilt runtime without caller task selection', () => {
    const service = new BrowserTaskStateService(new SqliteStore(':memory:'));
    const oldScope = { workspaceId: 'w', sessionId: 's', principalId: 'p', runtimeGeneration: 'g1', capabilityId: 'c1' };
    const task = service.createOrReplace(oldScope, [{
      slotKey: 'title_0', discovery: 'available', required: true, population: 'populated',
      validation: 'verified', authority: 'confirmed', populationBucket: 'short',
      evidenceId: 'ev1', observationEpoch: 1,
    }]);
    service.invalidateRuntime('w', 's');
    const nextScope = { ...oldScope, runtimeGeneration: 'g2', capabilityId: 'c2' };
    const reclaimed = service.reclaimActive(nextScope);
    assert.equal(reclaimed?.taskId, task.taskId);
    assert.equal(reclaimed?.runtimeGeneration, 'g2');
    assert.equal(reclaimed?.slots[0].validation, 'stale');
    assert.equal(reclaimed?.slots[0].authority, 'stale');
    assert.equal(reclaimed?.slots[0].evidenceId, null);
  });

  it('never lets a later discovery proposal downgrade a required slot', () => {
    const service = new BrowserTaskStateService(new SqliteStore(':memory:'));
    const scope = { workspaceId: 'w', sessionId: 's', principalId: 'p', runtimeGeneration: 'g', capabilityId: 'c' };
    const task = service.createOrReplace(scope, [{
      slotKey: 'title_0', discovery: 'available', required: true, population: 'empty',
      validation: 'unverified', authority: 'not_required', populationBucket: 'empty',
      evidenceId: 'ev1', observationEpoch: 1,
    }]);
    const updated = service.recordTrustedDiscovery(scope, task.taskId, task.version, [{
      slotKey: 'title_0', discovery: 'available', required: false, population: 'empty',
      validation: 'unverified', authority: 'not_required', populationBucket: 'empty',
      evidenceId: 'ev2', observationEpoch: 2,
    }]);
    assert.equal(updated.slots[0].required, true);
  });
  it('derives lifecycle from orthogonal slot states with safe priority', () => {
    assert.equal(deriveBrowserTaskLifecycle([slot()]), 'active');
    assert.equal(deriveBrowserTaskLifecycle([slot({ population: 'populated', validation: 'pending' })]), 'validating');
    assert.equal(deriveBrowserTaskLifecycle([slot({ population: 'populated', validation: 'verified' })]), 'ready');
    assert.equal(deriveBrowserTaskLifecycle([slot({ authority: 'awaiting_user' })]), 'awaiting-user');
    assert.equal(deriveBrowserTaskLifecycle([slot({ discovery: 'blocked' })]), 'blocked');
  });

  it('mints one active task, replaces it explicitly, and rejects stale CAS', () => {
    const store = new SqliteStore(':memory:');
    const service = new BrowserTaskStateService(store);
    const first = service.createOrReplace(scope, [slot()]);
    assert.equal(service.getActive(scope)?.taskId, first.taskId);
    assert.equal(service.getActive({ ...scope, principalId: 'other-principal' }), null);
    assert.throws(() => service.createOrReplace(scope, [slot()]));

    const updated = service.recordTrustedDiscovery(scope, first.taskId, first.version, [
      slot({ slotKey: 'description', required: false }),
    ]);
    assert.equal(updated.slots.length, 2);
    assert.throws(() => service.recordTrustedDiscovery(scope, first.taskId, first.version, []));

    const replacement = service.createOrReplace(scope, [slot()], { replaceTaskId: first.taskId });
    assert.notEqual(replacement.taskId, first.taskId);
    assert.equal(store.getBrowserTask(first.taskId)?.lifecycle, 'abandoned');
  });

  it('marks mutation pending and only accepts a newer causally bound observation', () => {
    const service = new BrowserTaskStateService(new SqliteStore(':memory:'));
    const task = service.createOrReplace(scope, [slot({ population: 'populated', validation: 'verified', evidenceId: 'e-1', observationEpoch: 1 })]);
    const pending = service.recordMutationPending(scope, task.taskId, task.version, {
      slotKey: 'primary_content', operationId: 'op-1', baselineObservationEpoch: 1,
      baselineObservationId: 'obs-1', baselineDocumentIdentity: 'document-1', baselineStructuralChecksum: 'shape-1',
      targetBindingDigest: 'target-1', controlEpoch: 'control-1', evidenceClass: 'target_local',
    });
    assert.equal(pending.slots[0].validation, 'pending');
    assert.throws(() => service.validateFromObservation(scope, task.taskId, pending.version, {
      slotKey: 'primary_content', operationId: 'op-1', observationId: 'obs-old', observationEpoch: 1,
      documentIdentity: 'document-1', structuralChecksum: 'shape-1', targetBindingDigest: 'target-1', controlEpoch: 'control-1', predicateMatched: true,
    }));
    assert.throws(() => service.validateFromObservation(scope, task.taskId, pending.version, {
      slotKey: 'primary_content', operationId: 'op-1', observationId: 'obs-wrong', observationEpoch: 2,
      documentIdentity: 'document-2', structuralChecksum: 'shape-2', targetBindingDigest: 'target-1', controlEpoch: 'control-1', predicateMatched: true,
    }), /browser_task_observation_not_causal/);
    const verified = service.validateFromObservation(scope, task.taskId, pending.version, {
      slotKey: 'primary_content', operationId: 'op-1', observationId: 'obs-2', observationEpoch: 2,
      documentIdentity: 'document-1', structuralChecksum: 'shape-2', targetBindingDigest: 'target-1', controlEpoch: 'control-1', predicateMatched: true,
    });
    assert.equal(verified.slots[0].validation, 'verified');
  });

  it('claims one recovery atomically for a task version, target, and server failure class', () => {
    const service = new BrowserTaskStateService(new SqliteStore(':memory:'));
    const task = service.createOrReplace(scope, [slot()]);
    assert.equal(service.claimRecovery(scope, task.taskId, task.version, 'target-binding-1', 'off_viewport'), true);
    assert.equal(service.claimRecovery(scope, task.taskId, task.version, 'target-binding-1', 'off_viewport'), false);
    assert.equal(service.claimRecovery(scope, task.taskId, task.version, 'target-binding-1', 'task_overlay'), true);
    assert.throws(() => service.claimRecovery(scope, task.taskId, task.version, 'target-binding-1', 'unknown'));
  });

  it('reclaims safe progress while revoking evidence, validation, and authority', () => {
    const service = new BrowserTaskStateService(new SqliteStore(':memory:'));
    const task = service.createOrReplace(scope, [slot({ population: 'populated', validation: 'verified', authority: 'confirmed', evidenceId: 'ev', observationEpoch: 4 })]);
    const reclaimed = service.reclaim({ ...scope, runtimeGeneration: 'runtime-2', capabilityId: 'capability-2' }, task.taskId, task.version);
    assert.equal(reclaimed.slots[0].population, 'populated');
    assert.equal(reclaimed.slots[0].validation, 'stale');
    assert.equal(reclaimed.slots[0].authority, 'stale');
    assert.equal(reclaimed.lifecycle, 'awaiting-user');
    assert.equal(reclaimed.slots[0].evidenceId, null);
  });

  it('atomically consumes the persistent observation budget including failures', () => {
    const service = new BrowserTaskStateService(new SqliteStore(':memory:'), { maxObservationsPerTask: 2 });
    service.createOrReplace(scope, [slot()]);
    assert.equal(service.decisionObservationBudget(scope).consume(), true);
    assert.equal(service.decisionObservationBudget(scope).consume(), true);
    assert.equal(service.decisionObservationBudget(scope).consume(), false);
  });

  it('consumes one declaration request exactly once and records purpose-separated authority', () => {
    const store = new SqliteStore(':memory:');
    const service = new BrowserTaskStateService(store);
    const task = service.createOrReplace(scope, [slot({
      slotKey: 'declaration_0', population: 'populated', validation: 'verified',
    })]);
    const request = createBrowserBinding('declaration-request', {
      taskId: task.taskId, taskVersion: task.version, slotKey: 'declaration_0', requestId: 'request-1',
    });
    const awaiting = service.beginDeclarationRequest(scope, task.taskId, task.version, 'declaration_0', request);
    assert.equal(awaiting.slots[0].authority, 'awaiting_user');

    const consumed = service.consumeDeclarationRequest(
      scope, task.taskId, awaiting.version, 'declaration_0', request, 'approved',
    );
    assert.equal(consumed.slots[0].authority, 'awaiting_user');
    assert.throws(() => service.consumeDeclarationRequest(
      scope, task.taskId, consumed.version, 'declaration_0', request, 'approved',
    ), /browser_task_binding_stale/);

    const authority = createBrowserBinding('declaration-authority', {
      taskId: task.taskId, slotKey: 'declaration_0', intendedState: true,
    });
    const confirmed = service.confirmDeclarationAuthority(
      scope, task.taskId, consumed.version, 'declaration_0', authority,
      { observationId: 'observation-confirmed', observationEpoch: 7 },
    );
    assert.equal(confirmed.slots[0].authority, 'confirmed');
    assert.equal(confirmed.slots[0].population, 'populated');
    assert.equal(confirmed.slots[0].validation, 'verified');
    assert.equal(confirmed.slots[0].evidenceId, 'observation-confirmed');
    assert.equal(confirmed.slots[0].observationEpoch, 7);
    assert.equal(service.verifyDeclarationAuthority(task.taskId, 'declaration_0', authority), true);
    assert.equal(service.verifyDeclarationAuthority(task.taskId, 'declaration_0', request), false);
  });

  it('keeps later awaiting user, records denial distinctly, and stales authority on mutation', () => {
    const store = new SqliteStore(':memory:');
    const service = new BrowserTaskStateService(store);
    let task = service.createOrReplace(scope, [
      slot({ slotKey: 'declaration_0', population: 'populated', validation: 'verified' }),
      slot({ slotKey: 'title_0', population: 'populated', validation: 'verified' }),
    ]);
    let request = createBrowserBinding('declaration-request', { request: 1 });
    task = service.beginDeclarationRequest(scope, task.taskId, task.version, 'declaration_0', request);
    task = service.consumeDeclarationRequest(scope, task.taskId, task.version, 'declaration_0', request, 'later');
    assert.equal(task.slots.find((item) => item.slotKey === 'declaration_0')?.authority, 'awaiting_user');

    request = createBrowserBinding('declaration-request', { request: 2 });
    task = service.beginDeclarationRequest(scope, task.taskId, task.version, 'declaration_0', request);
    task = service.consumeDeclarationRequest(scope, task.taskId, task.version, 'declaration_0', request, 'denied');
    assert.equal(task.slots.find((item) => item.slotKey === 'declaration_0')?.authority, 'declined');

    request = createBrowserBinding('declaration-request', { request: 3 });
    task = service.beginDeclarationRequest(scope, task.taskId, task.version, 'declaration_0', request);
    task = service.consumeDeclarationRequest(scope, task.taskId, task.version, 'declaration_0', request, 'approved');
    const authority = createBrowserBinding('declaration-authority', { authority: 1 });
    task = service.confirmDeclarationAuthority(scope, task.taskId, task.version, 'declaration_0', authority,
      { observationId: 'observation-confirmed', observationEpoch: 7 });
    const pending = service.recordMutationPending(scope, task.taskId, task.version, {
      slotKey: 'title_0', operationId: 'op-title', baselineObservationEpoch: 1,
      baselineObservationId: 'obs-title', baselineDocumentIdentity: 'document-title',
      baselineStructuralChecksum: 'shape-title', targetBindingDigest: 'target-title',
      controlEpoch: 'control-title', evidenceClass: 'target_local',
    });
    assert.equal(pending.slots.find((item) => item.slotKey === 'declaration_0')?.authority, 'stale');
    assert.equal(service.verifyDeclarationAuthority(task.taskId, 'declaration_0', authority), false);
  });

  it('persists only positive-shape columns and purges sessions without touching forks', () => {
    const store = new SqliteStore(':memory:');
    const service = new BrowserTaskStateService(store);
    service.createOrReplace(scope, [slot()]);
    service.createOrReplace({ ...scope, sessionId: 'fork-1' }, [slot()]);
    const names = Object.values(store.listBrowserTaskColumns()).flat().join(' ');
    for (const forbidden of ['text', 'url', 'coordinate', 'pixel', 'filename', 'content_value']) {
      assert.equal(names.includes(forbidden), false);
    }
    assert.equal(service.purgeSession(scope.workspaceId, scope.sessionId), 1);
    assert.equal(service.getActive(scope), null);
    assert.ok(service.getActive({ ...scope, sessionId: 'fork-1' }));
  });

  it('persists a version-bound final action and treats every possible dispatch as outcome unknown', () => {
    const store = new SqliteStore(':memory:');
    const service = new BrowserTaskStateService(store);
    const task = service.createOrReplace(scope, [slot({
      slotKey: 'final_activation_0', population: 'populated', validation: 'verified',
    })]);
    const review = createBrowserBinding('browser-final-review', { taskId: task.taskId, version: task.version });
    const predicate = createBrowserBinding('browser-final-outcome', { taskId: task.taskId, kind: 'durable_record' });

    const prepared = service.prepareFinalAction(scope, task.taskId, task.version, {
      operationId: 'publish-op-1', slotKey: 'final_activation_0', targetBindingDigest: 'target-final-1',
      controlEpoch: 'control-final-1', reviewBinding: review, outcomePredicate: predicate,
    });
    assert.equal(prepared.lifecycle, 'ready');
    const unknown = service.recordFinalDispatch(scope, task.taskId, prepared.version, 'publish-op-1');
    assert.equal(unknown.lifecycle, 'outcome-unknown');
    assert.deepEqual(service.projection(scope.workspaceId, scope.sessionId)?.outcome, {
      possibleDispatch: true, evidenceStatus: 'none', lastCheckedAt: null,
      canRecheck: true, canAbandon: true, canAcknowledgeDuplicateRisk: true,
    });
  });

  it('completes only from trusted correlated durable evidence and keeps weak evidence unknown', () => {
    const service = new BrowserTaskStateService(new SqliteStore(':memory:'));
    let task = service.createOrReplace(scope, [slot({
      slotKey: 'final_activation_0', population: 'populated', validation: 'verified',
    })]);
    const review = createBrowserBinding('browser-final-review', { taskId: task.taskId, version: task.version });
    const predicate = createBrowserBinding('browser-final-outcome', { taskId: task.taskId, kind: 'durable_record' });
    task = service.prepareFinalAction(scope, task.taskId, task.version, {
      operationId: 'publish-op-2', slotKey: 'final_activation_0', targetBindingDigest: 'target-final-2',
      controlEpoch: 'control-final-2', reviewBinding: review, outcomePredicate: predicate,
    });
    task = service.recordFinalDispatch(scope, task.taskId, task.version, 'publish-op-2');

    task = service.recordOutcomeCheck(scope, task.taskId, task.version, 'publish-op-2', { status: 'insufficient' });
    assert.equal(task.lifecycle, 'outcome-unknown');
    assert.throws(() => service.recordDurableCompletion(scope, task.taskId, task.version, 'caller-evidence'));
    task = service.recordOutcomeCheck(scope, task.taskId, task.version, 'publish-op-2', {
      status: 'durable', evidenceId: 'trusted-record-1', correlatedOperationId: 'publish-op-2',
    });
    assert.equal(task.lifecycle, 'complete');
  });

  it('acknowledges duplicate risk by advancing state without dispatch or success', () => {
    const service = new BrowserTaskStateService(new SqliteStore(':memory:'));
    let task = service.createOrReplace(scope, [slot({
      slotKey: 'final_activation_0', population: 'populated', validation: 'verified',
    })]);
    const review = createBrowserBinding('browser-final-review', { taskId: task.taskId, version: task.version });
    const predicate = createBrowserBinding('browser-final-outcome', { taskId: task.taskId, kind: 'durable_record' });
    task = service.prepareFinalAction(scope, task.taskId, task.version, {
      operationId: 'publish-op-3', slotKey: 'final_activation_0', targetBindingDigest: 'target-final-3',
      controlEpoch: 'control-final-3', reviewBinding: review, outcomePredicate: predicate,
    });
    task = service.recordFinalDispatch(scope, task.taskId, task.version, 'publish-op-3');
    const acknowledged = service.acknowledgeDuplicateRisk(scope, task.taskId, task.version, 'publish-op-3');
    assert.equal(acknowledged.lifecycle, 'awaiting-user');
    assert.equal(acknowledged.slots[0].validation, 'stale');
    assert.equal(service.projection(scope.workspaceId, scope.sessionId)?.outcome, undefined);
  });

  it('purges a workspace without affecting another workspace', () => {
    const store = new SqliteStore(':memory:');
    const service = new BrowserTaskStateService(store);
    service.createOrReplace(scope, [slot()]);
    const other = { ...scope, workspaceId: 'workspace-2', sessionId: 'session-2' };
    service.createOrReplace(other, [slot()]);

    assert.equal(service.purgeWorkspace(scope.workspaceId), 1);
    assert.equal(service.getActive(scope), null);
    assert.ok(service.getActive(other));
  });
});
