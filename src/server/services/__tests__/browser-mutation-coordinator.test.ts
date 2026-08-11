import '../../test-utils/test-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SqliteStore } from '../../storage/sqlite-store.js';
import {
  BrowserMutationConflictError,
  BrowserMutationCoordinator,
  type BrowserInvocationScope,
} from '../browser-mutation-coordinator.js';
import { buildBrowserToolDefinitions } from '../browser-mcp.js';

function scope(overrides: Partial<BrowserInvocationScope> = {}): BrowserInvocationScope {
  return Object.freeze({
    workspaceId: 'ws-1',
    sessionId: 'session-1',
    runtimeGeneration: 'runtime-1',
    capabilityId: 'cap-1',
    principalId: 'principal-1',
    operationId: 'operation-1',
    signal: new AbortController().signal,
    isCurrent: () => true,
    ...overrides,
  });
}

function coordinator(store = new SqliteStore(':memory:')) {
  return { store, coordinator: new BrowserMutationCoordinator({ store }) };
}

describe('BrowserMutationCoordinator', () => {
  it('uses request-fresh invocation authority when a BrowserToolContext is reused', async () => {
    const captured: BrowserInvocationScope[] = [];
    const fakeCoordinator = {
      execute(invocation: BrowserInvocationScope) {
        captured.push(invocation);
        return Promise.resolve({ outcome: 'not_dispatched', dispatchState: 'not_dispatched', verified: false, retrySafe: true, reason: 'target_unavailable', delta: { kind: 'none', changed: false } });
      },
    } as unknown as BrowserMutationCoordinator;
    const contextRegistry = new Map();
    const common = {
      sessionId: 'session-reused', workspaceId: 'ws-1', contextRegistry,
      mutationCoordinator: fakeCoordinator,
    };
    const first = buildBrowserToolDefinitions({
      ...common, runtimeGeneration: 'runtime-old', capabilityId: 'cap-old', principalId: 'principal-1',
      isInvocationCurrent: () => false,
    }).find((tool) => tool.name === 'open')!;
    const second = buildBrowserToolDefinitions({
      ...common, runtimeGeneration: 'runtime-new', capabilityId: 'cap-new', principalId: 'principal-1',
      isInvocationCurrent: () => true,
    }).find((tool) => tool.name === 'open')!;
    await first.handler({ operationId: 'old-op', url: 'https://example.test' } as never, {});
    await second.handler({ operationId: 'new-op', url: 'https://example.test' } as never, {});
    assert.equal(captured[0].runtimeGeneration, 'runtime-old');
    assert.equal(captured[0].capabilityId, 'cap-old');
    assert.equal(await captured[0].isCurrent(), false);
    assert.equal(captured[1].runtimeGeneration, 'runtime-new');
    assert.equal(captured[1].capabilityId, 'cap-new');
    assert.equal(await captured[1].isCurrent(), true);
    assert.ok(Object.isFrozen(captured[1]));
  });

  it('persists intent before dispatch and replays the terminal receipt once', async () => {
    const { store, coordinator: mutations } = coordinator();
    let dispatches = 0;
    const run = () => mutations.execute(scope(), {
      action: 'fill',
      privateParameters: { ref: 'e1', text: 'private article text' },
      dispatch: async () => {
        dispatches += 1;
        assert.equal(store.getBrowserOperation('principal-1', 'operation-1')?.state, 'dispatch_intent');
        return {
          outcome: 'dispatched_verified' as const,
          dispatchState: 'dispatched' as const,
          verified: true,
          retrySafe: false,
          matchesRequested: true,
          normalizedLength: 20,
          delta: { kind: 'field' as const, changed: true },
        };
      },
    });

    const first = await run();
    const replay = await run();
    assert.deepEqual(replay, first);
    assert.equal(dispatches, 1);
    const row = store.getBrowserOperation('principal-1', 'operation-1');
    assert.equal(row?.state, 'terminal');
    assert.equal(JSON.stringify(row).includes('private article text'), false);
    const audit = store.listBrowserAudit('ws-1', { sessionId: 'session-1' });
    assert.equal(audit.length, 1);
    assert.equal(JSON.stringify(audit).includes(row!.parameterDigest), false);
    assert.equal(JSON.stringify(audit).includes('private article text'), false);
  });

  it('coalesces same-principal replay while isolating operation IDs by principal', async () => {
    const { coordinator: mutations } = coordinator();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let dispatches = 0;
    const run = () => mutations.execute(scope(), {
      action: 'open', privateParameters: { url: 'https://example.test/a?secret=1' },
      dispatch: async () => {
        dispatches += 1;
        await blocked;
        return { outcome: 'dispatched_verified', dispatchState: 'dispatched', verified: true, retrySafe: false, delta: { kind: 'none', changed: true } };
      },
    });
    const one = run();
    const two = run();
    release();
    assert.deepEqual(await two, await one);
    assert.equal(dispatches, 1);

    await assert.rejects(
      mutations.execute(scope(), { action: 'open', privateParameters: { url: 'https://example.test/changed' }, dispatch: async () => assert.fail('must not dispatch') }),
      BrowserMutationConflictError,
    );
    const otherPrincipal = await mutations.execute(scope({ principalId: 'principal-2' }), {
      action: 'open',
      privateParameters: { url: 'https://example.test/a?secret=1' },
      dispatch: async () => ({
        outcome: 'dispatched_verified', dispatchState: 'dispatched', verified: true,
        retrySafe: false, delta: { kind: 'none', changed: true },
      }),
    });
    assert.equal(otherPrincipal.outcome, 'dispatched_verified');
  });

  it('serializes mutations by session while observations remain unblocked', async () => {
    const { coordinator: mutations } = coordinator();
    const order: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = mutations.execute(scope({ operationId: 'op-a' }), {
      action: 'fill', privateParameters: { n: 1 }, dispatch: async () => {
        order.push('a:start'); await blocked; order.push('a:end');
        return { outcome: 'dispatched_verified', dispatchState: 'dispatched', verified: true, retrySafe: false, delta: { kind: 'field', changed: true } };
      },
    });
    const second = mutations.execute(scope({ operationId: 'op-b' }), {
      action: 'select', privateParameters: { n: 2 }, dispatch: async () => {
        order.push('b');
        return { outcome: 'dispatched_verified', dispatchState: 'dispatched', verified: true, retrySafe: false, delta: { kind: 'field', changed: true } };
      },
    });
    const observed = await mutations.observe('session-1', async () => 'visible');
    assert.equal(observed, 'visible');
    assert.deepEqual(order, ['a:start']);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['a:start', 'a:end', 'b']);
  });

  it('cancels stale authority after approval and releases the session mutex', async () => {
    const { coordinator: mutations } = coordinator();
    let current = true;
    let releaseApproval!: () => void;
    const approval = new Promise<boolean>((resolve) => { releaseApproval = () => resolve(true); });
    let dispatches = 0;
    const stale = mutations.execute(scope({ isCurrent: () => current }), {
      action: 'submit', privateParameters: { ref: 'e9' }, requestApproval: async () => approval,
      dispatch: async () => { dispatches += 1; return { outcome: 'dispatched_verified', dispatchState: 'dispatched', verified: true, retrySafe: false, delta: { kind: 'activation', changed: true } }; },
    });
    current = false;
    releaseApproval();
    const staleReceipt = await stale;
    assert.equal(staleReceipt.outcome, 'not_dispatched');
    assert.equal(staleReceipt.reason, 'runtime_replaced');
    assert.equal(dispatches, 0);

    const next = await mutations.execute(scope({ operationId: 'op-next' }), {
      action: 'fill', privateParameters: { ref: 'e1' }, dispatch: async () => ({ outcome: 'dispatched_verified', dispatchState: 'dispatched', verified: true, retrySafe: false, delta: { kind: 'field', changed: true } }),
    });
    assert.equal(next.outcome, 'dispatched_verified');
  });

  it('cancels approval waits out-of-band on control takeover', async () => {
    const { coordinator: mutations } = coordinator();
    let dispatches = 0;
    const pending = mutations.execute(scope(), {
      action: 'close', privateParameters: { reason: 'done' },
      requestApproval: async (_requestId, signal) => new Promise<boolean>((resolve) => signal.addEventListener('abort', () => resolve(false), { once: true })),
      dispatch: async () => { dispatches += 1; return { outcome: 'dispatched_verified', dispatchState: 'dispatched', verified: true, retrySafe: false, delta: { kind: 'none', changed: false } }; },
    });
    mutations.cancelSession('session-1', 'control_taken_over');
    const receipt = await pending;
    assert.equal(receipt.outcome, 'not_dispatched');
    assert.equal(receipt.reason, 'control_taken_over');
    assert.equal(dispatches, 0);
  });

  it('recovers orphaned rows without redispatch and keeps ledger private', async () => {
    const store = new SqliteStore(':memory:');
    store.proposeBrowserOperation({ operationId: 'proposed', principalId: 'p', workspaceId: 'ws', sessionId: 's', runtimeGeneration: 'r', capabilityId: 'c', action: 'fill', parameterDigest: 'v1:digest-a' });
    store.proposeBrowserOperation({ operationId: 'intent', principalId: 'p', workspaceId: 'ws', sessionId: 's', runtimeGeneration: 'r', capabilityId: 'c', action: 'upload', parameterDigest: 'v1:digest-b' });
    store.markBrowserOperationDispatchIntent('p', 'intent');
    new BrowserMutationCoordinator({ store });
    assert.equal(store.getBrowserOperation('p', 'proposed')?.receipt?.outcome, 'not_dispatched');
    assert.equal(store.getBrowserOperation('p', 'intent')?.receipt?.outcome, 'outcome_unknown');
    assert.equal(store.getBrowserOperation('p', 'intent')?.receipt?.retrySafe, false);

    const columns = store.listBrowserOperationColumns();
    for (const forbidden of ['text', 'url', 'query', 'path', 'filename', 'params', 'exception']) {
      assert.equal(columns.some((column) => column.toLowerCase().includes(forbidden)), false, forbidden);
    }
  });

  it('does not dispatch when intent persistence fails and returns unknown when terminal persistence fails', async () => {
    const first = coordinator();
    const originalIntent = first.store.markBrowserOperationDispatchIntent.bind(first.store);
    first.store.markBrowserOperationDispatchIntent = () => { throw new Error('private raw persistence exception'); };
    let dispatches = 0;
    const notDispatched = await first.coordinator.execute(scope(), {
      action: 'fill', privateParameters: { secret: 'article' }, dispatch: async () => { dispatches += 1; throw new Error('must not run'); },
    });
    assert.equal(notDispatched.outcome, 'not_dispatched');
    assert.equal(dispatches, 0);
    first.store.markBrowserOperationDispatchIntent = originalIntent;

    const second = coordinator();
    second.store.completeBrowserOperation = () => { throw new Error('private raw terminal exception'); };
    const unknown = await second.coordinator.execute(scope(), {
      action: 'fill', privateParameters: { secret: 'article' }, dispatch: async () => ({ outcome: 'dispatched_verified', dispatchState: 'dispatched', verified: true, retrySafe: false, delta: { kind: 'field', changed: true } }),
    });
    assert.equal(unknown.outcome, 'outcome_unknown');
    assert.equal(unknown.retrySafe, false);

    const third = coordinator();
    third.store.completeBrowserOperation = () => { throw new Error('private raw cancellation terminal exception'); };
    const aborted = new AbortController();
    aborted.abort();
    const cancelledUnknown = await third.coordinator.execute(scope({ operationId: 'cancelled-terminal', signal: aborted.signal }), {
      action: 'close', privateParameters: {}, dispatch: async () => { throw new Error('must not run'); },
    });
    assert.equal(cancelledUnknown.outcome, 'outcome_unknown');
    assert.equal(cancelledUnknown.retrySafe, false);
  });
});
