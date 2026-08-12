import '../../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { BrowserTaskTrace } from '../browser-task-trace.js';

describe('BrowserTaskTrace', () => {
  it('keeps a bounded ordered positive-shape trace and reports loss explicitly', () => {
    const trace = new BrowserTaskTrace(2);
    const seen: string[] = [];
    trace.subscribe((event) => seen.push(event.kind));
    trace.append({ kind: 'operation_intent', taskId: 'task-1', taskVersion: 1, operationId: 'op-1', slotKey: 'title_0', operationClass: 'field' });
    trace.append({ kind: 'receipt', taskId: 'task-1', taskVersion: 1, operationId: 'op-1', outcome: 'not_dispatched' });
    trace.append({ kind: 'recovery', taskId: 'task-1', taskVersion: 1, category: 'off_viewport', claimed: true });
    assert.deepEqual(trace.snapshot().map((event) => event.kind), ['trace_loss', 'recovery']);
    assert.deepEqual(seen, ['operation_intent', 'receipt', 'trace_loss', 'recovery']);
    assert.equal(JSON.stringify(trace.snapshot()).includes('http'), false);
  });

  it('adds monotonic timing and task transition categories without retaining prose', () => {
    let now = 40;
    const trace = new BrowserTaskTrace(8, () => now++);
    trace.append({ kind: 'transition', taskId: 'task-1', taskVersion: 2, from: 'active', to: 'blocked', reason: 'policy' });
    assert.deepEqual(trace.snapshot()[0], {
      kind: 'transition', taskId: 'task-1', taskVersion: 2, from: 'active', to: 'blocked', reason: 'policy', sequence: 1, monotonicMs: 40,
    });
  });
});
