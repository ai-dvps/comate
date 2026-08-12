import '../../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SqliteStore } from '../../storage/sqlite-store.js';
import {
  BrowserTaskStateService,
  deriveBrowserTaskLifecycle,
  type BrowserTaskSlot,
} from '../browser-task-state.js';

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
    });
    assert.equal(pending.slots[0].validation, 'pending');
    assert.throws(() => service.validateFromObservation(scope, task.taskId, pending.version, {
      slotKey: 'primary_content', operationId: 'op-1', observationId: 'obs-old', observationEpoch: 1,
    }));
    const verified = service.validateFromObservation(scope, task.taskId, pending.version, {
      slotKey: 'primary_content', operationId: 'op-1', observationId: 'obs-2', observationEpoch: 2,
    });
    assert.equal(verified.slots[0].validation, 'verified');
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
