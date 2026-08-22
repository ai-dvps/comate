import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getCodexDefaults, setCodexDefaults } from './codex-settings.js';

describe('Codex default settings', { concurrency: false }, () => {
  it('persists model, effort, and speed as one preference set', async () => {
    await setCodexDefaults({ model: 'gpt-5.6-codex', effort: 'high', speed: 'fast' });

    assert.deepStrictEqual(await getCodexDefaults(), {
      model: 'gpt-5.6-codex',
      effort: 'high',
      speed: 'fast',
    });
  });

  it('clears every default without leaving stale model-specific values', async () => {
    await setCodexDefaults({});

    assert.deepStrictEqual(await getCodexDefaults(), {});
  });
});
