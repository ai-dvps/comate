import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createApiInfoLatch } from './api-info';

describe('API info startup latch', () => {
  it('keeps an early request pending until the sidecar handshake arrives', async () => {
    const latch = createApiInfoLatch();
    const pending = latch.wait();
    let settled = false;
    void pending.finally(() => {
      settled = true;
    });

    await Promise.resolve();
    assert.strictEqual(settled, false);

    latch.succeed({ port: 9123, token: 'desktop-token' });
    assert.deepStrictEqual(await pending, { port: 9123, token: 'desktop-token' });
  });

  it('rejects requests when sidecar startup has already failed', async () => {
    const latch = createApiInfoLatch();
    latch.fail(new Error('sidecar crashed before ready'));

    await assert.rejects(latch.wait(), /sidecar crashed before ready/);
  });

  it('keeps the first terminal result when later lifecycle events arrive', async () => {
    const latch = createApiInfoLatch();
    latch.succeed({ port: 9123, token: 'desktop-token' });
    latch.fail(new Error('sidecar exited'));

    assert.deepStrictEqual(await latch.wait(), { port: 9123, token: 'desktop-token' });
  });
});
