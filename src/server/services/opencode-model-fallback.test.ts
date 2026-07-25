import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideModelFallback,
  stripModelSuffix,
  isModelNotFoundError,
  expandModelAliases,
} from './opencode-model-fallback.js';

describe('stripModelSuffix', () => {
  it('strips trailing bracket aliases', () => {
    assert.equal(stripModelSuffix('glm-5.2[1m]'), 'glm-5.2');
    assert.equal(stripModelSuffix('k3[1m]'), 'k3');
    assert.equal(stripModelSuffix('glm-5.2'), 'glm-5.2');
    assert.equal(stripModelSuffix('kimi-for-coding'), 'kimi-for-coding');
  });
});

describe('isModelNotFoundError', () => {
  it('matches vendor model-not-found shapes', () => {
    assert.ok(isModelNotFoundError('[1211][模型不存在，请检查模型代码。]'));
    assert.ok(isModelNotFoundError('model does not exist: glm-5.2[1m]'));
    assert.ok(isModelNotFoundError('Unknown model: foo'));
    assert.ok(!isModelNotFoundError('rate limit exceeded'));
    assert.ok(!isModelNotFoundError('The API Key appears to be invalid'));
  });
});

describe('decideModelFallback', () => {
  it('retries with the base id on model-not-found with a suffixed model', () => {
    const d = decideModelFallback('[1211][模型不存在]', 'glm-5.2[1m]', false);
    assert.deepEqual(d, { action: 'retry', wireModelID: 'glm-5.2' });
  });

  it('forwards when the model has no suffix (nothing to retry with)', () => {
    const d = decideModelFallback('[1211][模型不存在]', 'glm-5.2', false);
    assert.equal(d.action, 'forward');
  });

  it('forwards non-model-not-found errors even with a suffix', () => {
    const d = decideModelFallback('rate limit exceeded', 'glm-5.2[1m]', false);
    assert.equal(d.action, 'forward');
  });

  it('retries at most once per resolution', () => {
    const d = decideModelFallback('[1211][模型不存在]', 'glm-5.2', true);
    assert.equal(d.action, 'forward');
  });
});

describe('expandModelAliases', () => {
  it('registers both alias and base form for suffixed models', () => {
    assert.deepEqual(expandModelAliases('glm-5.2[1m]'), {
      'glm-5.2[1m]': { name: 'glm-5.2[1m]' },
      'glm-5.2': { name: 'glm-5.2' },
    });
  });

  it('registers only the single form for plain models', () => {
    assert.deepEqual(expandModelAliases('kimi-for-coding'), {
      'kimi-for-coding': { name: 'kimi-for-coding' },
    });
  });
});
