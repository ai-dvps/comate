import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  isKimiProvider,
  KimiLoopDetector,
  computeFingerprint,
} from './kimi-loop-detector.js';
import type { Provider } from '../models/provider.js';

function createProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'p1',
    name: 'Test Provider',
    baseUrl: 'http://test',
    authToken: 'test',
    model: 'test-model',
    isDefault: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('isKimiProvider', () => {
  it('returns false when provider is undefined', () => {
    assert.strictEqual(isKimiProvider(undefined), false);
  });

  it('detects Kimi by model prefix', () => {
    assert.strictEqual(isKimiProvider(createProvider({ model: 'kimi-k2' })), true);
    assert.strictEqual(isKimiProvider(createProvider({ model: 'KIMI-K2' })), true);
    assert.strictEqual(isKimiProvider(createProvider({ model: 'moonshot-v1' })), true);
    assert.strictEqual(isKimiProvider(createProvider({ model: 'Moonshot-v1' })), true);
  });

  it('detects Kimi by base URL', () => {
    assert.strictEqual(
      isKimiProvider(createProvider({ baseUrl: 'https://api.moonshot.cn/v1' })),
      true,
    );
    assert.strictEqual(
      isKimiProvider(createProvider({ baseUrl: 'https://kimi.example.com' })),
      true,
    );
  });

  it('returns false for non-Kimi providers', () => {
    assert.strictEqual(
      isKimiProvider(createProvider({ model: 'claude-3-5-sonnet', baseUrl: 'https://api.anthropic.com' })),
      false,
    );
  });
});

describe('KimiLoopDetector', () => {
  it('allows the first repeated call', () => {
    const detector = new KimiLoopDetector({ threshold: 3 });
    assert.deepStrictEqual(detector.beforeToolUse('Read', { file_path: '/a.txt' }), { behavior: 'allow' });
  });

  it('allows calls up to threshold - 1', () => {
    const detector = new KimiLoopDetector({ threshold: 3 });
    assert.deepStrictEqual(detector.beforeToolUse('Read', { file_path: '/a.txt' }), { behavior: 'allow' });
    assert.deepStrictEqual(detector.beforeToolUse('Read', { file_path: '/a.txt' }), { behavior: 'allow' });
  });

  it('denies at the threshold repeat', () => {
    const detector = new KimiLoopDetector({ threshold: 3 });
    detector.beforeToolUse('Read', { file_path: '/a.txt' });
    detector.beforeToolUse('Read', { file_path: '/a.txt' });

    const result = detector.beforeToolUse('Read', { file_path: '/a.txt' });
    assert.strictEqual(result.behavior, 'deny');
    assert.ok(
      (result as { message: string }).message.includes('already called Read'),
    );
  });

  it('keeps denying after the threshold', () => {
    const detector = new KimiLoopDetector({ threshold: 3 });
    detector.beforeToolUse('Read', { file_path: '/a.txt' });
    detector.beforeToolUse('Read', { file_path: '/a.txt' });

    assert.strictEqual(detector.beforeToolUse('Read', { file_path: '/a.txt' }).behavior, 'deny');
    assert.strictEqual(detector.beforeToolUse('Read', { file_path: '/a.txt' }).behavior, 'deny');
  });

  it('resets the window after a new user turn', () => {
    const detector = new KimiLoopDetector({ threshold: 3 });
    detector.beforeToolUse('Read', { file_path: '/a.txt' });
    detector.beforeToolUse('Read', { file_path: '/a.txt' });

    detector.reset();

    assert.deepStrictEqual(detector.beforeToolUse('Read', { file_path: '/a.txt' }), { behavior: 'allow' });
  });

  it('does not flag alternating tools', () => {
    const detector = new KimiLoopDetector({ threshold: 3 });
    for (let i = 0; i < 6; i++) {
      assert.deepStrictEqual(
        detector.beforeToolUse(i % 2 === 0 ? 'Read' : 'Grep', { pattern: i % 2 === 0 ? 'foo' : 'bar' }),
        { behavior: 'allow' },
      );
    }
  });

  it('does not flag the same tool with different inputs', () => {
    const detector = new KimiLoopDetector({ threshold: 3 });
    assert.deepStrictEqual(detector.beforeToolUse('Read', { file_path: '/a.txt' }), { behavior: 'allow' });
    assert.deepStrictEqual(detector.beforeToolUse('Read', { file_path: '/b.txt' }), { behavior: 'allow' });
    assert.deepStrictEqual(detector.beforeToolUse('Read', { file_path: '/a.txt' }), { behavior: 'allow' });
    assert.deepStrictEqual(detector.beforeToolUse('Read', { file_path: '/b.txt' }), { behavior: 'allow' });
  });

  it('treats equivalent inputs with different key order as identical', () => {
    const detector = new KimiLoopDetector({ threshold: 3 });
    detector.beforeToolUse('Read', { file_path: '/a.txt', offset: 0 });
    detector.beforeToolUse('Read', { offset: 0, file_path: '/a.txt' });

    const result = detector.beforeToolUse('Read', { file_path: '/a.txt', offset: 0 });
    assert.strictEqual(result.behavior, 'deny');
  });

  it('rejects a threshold below 2', () => {
    assert.throws(() => new KimiLoopDetector({ threshold: 1 }), /threshold must be at least 2/);
  });
});

describe('computeFingerprint', () => {
  it('produces stable fingerprints regardless of key order', () => {
    const fp1 = computeFingerprint('Read', { file_path: '/a.txt', offset: 0 });
    const fp2 = computeFingerprint('Read', { offset: 0, file_path: '/a.txt' });
    assert.strictEqual(fp1, fp2);
  });

  it('includes the tool name in the fingerprint', () => {
    const fp1 = computeFingerprint('Read', { file_path: '/a.txt' });
    const fp2 = computeFingerprint('Grep', { file_path: '/a.txt' });
    assert.notStrictEqual(fp1, fp2);
  });
});
