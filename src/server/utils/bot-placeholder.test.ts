import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ACKNOWLEDGMENT_POOL, getRandomAcknowledgment } from './bot-placeholder.js';

describe('bot-placeholder', () => {
  it('returns a message from the pool', () => {
    const message = getRandomAcknowledgment();
    assert.ok(ACKNOWLEDGMENT_POOL.includes(message));
  });

  it('uses the provided random function', () => {
    let callIndex = 0;
    const fakeRandom = () => {
      const value = callIndex / ACKNOWLEDGMENT_POOL.length;
      callIndex = (callIndex + 1) % ACKNOWLEDGMENT_POOL.length;
      return value;
    };

    for (let i = 0; i < ACKNOWLEDGMENT_POOL.length; i++) {
      assert.strictEqual(getRandomAcknowledgment(fakeRandom), ACKNOWLEDGMENT_POOL[i]);
    }
  });

  it('has a pool size between 3 and 8 with non-empty messages', () => {
    assert.ok(ACKNOWLEDGMENT_POOL.length >= 3);
    assert.ok(ACKNOWLEDGMENT_POOL.length <= 8);
    for (const message of ACKNOWLEDGMENT_POOL) {
      assert.ok(message.length > 0);
    }
  });
});
