import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { publicProvider } from './providers.js';

describe('provider API projection', () => {
  it('never exposes stored credentials and defaults legacy protocol metadata', () => {
    const projected = publicProvider({
      id: 'provider-1',
      name: 'Legacy',
      baseUrl: 'https://example.com',
      authToken: 'super-secret',
      isDefault: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    assert.strictEqual(projected.authTokenPresent, true);
    assert.strictEqual(projected.protocol, 'anthropic');
    assert.ok(!JSON.stringify(projected).includes('super-secret'));
    assert.ok(!Object.hasOwn(projected, 'authToken'));
  });
});
