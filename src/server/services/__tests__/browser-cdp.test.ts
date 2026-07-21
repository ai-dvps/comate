import '../../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { retryDuringColdStart } from '../browser-cdp.js';

describe('retryDuringColdStart', () => {
  // A fake clock: `now()` returns the current virtual time; `sleep` advances it
  // by the interval so tests run instantly without real timers.
  function fakeClock() {
    let t = 0;
    return {
      now: () => t,
      sleep: (ms: number) => {
        t += ms;
        return Promise.resolve();
      },
    };
  }

  it('returns the value once attempt succeeds on a later try', async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await retryDuringColdStart(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('socket hang up');
        return 'attached';
      },
      { budgetMs: 1_000, intervalMs: 100, now: clock.now, sleep: clock.sleep },
    );
    assert.strictEqual(result, 'attached');
    assert.strictEqual(calls, 3, 'retries until success');
  });

  it('throws the last error once the budget is exhausted', async () => {
    const clock = fakeClock();
    let calls = 0;
    await assert.rejects(
      retryDuringColdStart(
        async () => {
          calls += 1;
          throw new Error(`attempt ${calls} failed`);
        },
        { budgetMs: 500, intervalMs: 200, now: clock.now, sleep: clock.sleep },
      ),
      /attempt 4 failed/,
    );
    // t0=0; attempts at t=0,200,400,600(exceeds 500 budget → throw after 4th).
    // Actually: attempt1@0 fail (0<500, sleep→200), attempt2@200 fail (sleep→400),
    // attempt3@400 fail (sleep→600), attempt4@600 fail (600>=500 → throw). = 4 calls.
    assert.ok(calls >= 3, `expected several retries, got ${calls}`);
  });

  it('does not retry when the first attempt succeeds', async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await retryDuringColdStart(
      async () => {
        calls += 1;
        return 'ok';
      },
      { budgetMs: 1_000, intervalMs: 100, now: clock.now, sleep: clock.sleep },
    );
    assert.strictEqual(result, 'ok');
    assert.strictEqual(calls, 1);
  });
});
