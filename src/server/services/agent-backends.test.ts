import '../test-utils/test-env.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKEND_IDS,
  getCapability,
  getBackendServices,
  registerBackendServices,
  registerBackendRuntime,
  getBackendAvailability,
  resetBackendRegistryForTests,
  getDefaultBackend,
  setDefaultBackend,
  clearDefaultBackend,
  resolveDefaultBackend,
  codexProductionGate,
} from './agent-backends.js';

describe('getCapability', () => {
  it('registers codex as a peer backend whose undeclared capabilities fail closed', () => {
    assert.ok(BACKEND_IDS.includes('codex'));
    const entry = getCapability('codex', 'browser');
    assert.equal(entry.state, 'unavailable');
    assert.equal(entry.reasonKey, 'backend.capabilityUndeclared');
  });

  it('returns the declared entry for a declared capability', () => {
    const entry = getCapability('opencode', 'analytics');
    assert.equal(entry.state, 'unavailable');
    assert.ok(entry.reasonKey, 'analytics degradation must carry a reason (KTD-10)');
  });

  it('defaults undeclared capabilities to full on claude', () => {
    const entry = getCapability('claude', 'slashCommands');
    assert.equal(entry.state, 'full');
  });

  it('defaults undeclared capabilities to unavailable-with-reason on opencode', () => {
    // doc-review correction: default-full would present unverified features as
    // available on the new backend, violating the disable+reason rule (R10).
    const entry = getCapability('opencode', 'hooks');
    assert.equal(entry.state, 'unavailable');
    assert.ok(entry.reasonKey);
  });
});

describe('Codex production parity gate', () => {
  it('holds production selection closed unless controlled evaluation is explicit', () => {
    assert.match(String(codexProductionGate('production', undefined)), /parity gate/i);
    assert.equal(codexProductionGate('production', '1'), true);
    assert.equal(codexProductionGate('development', undefined), true);
    assert.equal(codexProductionGate('test', undefined), true);
  });
});

describe('backend service facets', () => {
  beforeEach(() => {
    resetBackendRegistryForTests();
  });

  it('fails closed when a backend has no service facet registration', () => {
    assert.throws(() => getBackendServices('codex'), /services.*codex.*not registered/i);
  });

  it('returns explicitly registered facets without inventing missing capabilities', () => {
    const services = {
      backendId: 'codex' as const,
      createDriver: () => ({ backendId: 'codex' as const }),
    };
    registerBackendServices('codex', services);
    assert.equal(getBackendServices('codex'), services);
  });
});

describe('getBackendAvailability', () => {
  beforeEach(() => {
    resetBackendRegistryForTests();
  });

  it('is unavailable with a reason when the backend has no registered runtime', async () => {
    const availability = await getBackendAvailability('opencode');
    assert.equal(availability.status, 'unavailable');
    assert.ok(availability.reason);
  });

  it('is unavailable with a reason when the binary cannot be resolved', async () => {
    registerBackendRuntime('opencode', {
      resolveBinaryPath: () => undefined,
    });
    const availability = await getBackendAvailability('opencode');
    assert.equal(availability.status, 'unavailable');
    assert.match(availability.reason ?? '', /binary|missing|not found/i);
  });

  it('is unavailable with a reason when the health check fails', async () => {
    registerBackendRuntime('opencode', {
      resolveBinaryPath: () => '/fake/opencode',
      healthCheck: async () => 'exit code 127',
    });
    const availability = await getBackendAvailability('opencode');
    assert.equal(availability.status, 'unavailable');
    assert.match(availability.reason ?? '', /127/);
  });

  it('is available when the binary resolves and the health check passes', async () => {
    registerBackendRuntime('opencode', {
      resolveBinaryPath: () => '/fake/opencode',
      healthCheck: async () => true,
    });
    const availability = await getBackendAvailability('opencode');
    assert.equal(availability.status, 'available');
  });

  it('caches the availability result per backend', async () => {
    let checks = 0;
    registerBackendRuntime('opencode', {
      resolveBinaryPath: () => '/fake/opencode',
      healthCheck: async () => {
        checks += 1;
        return true;
      },
    });
    await getBackendAvailability('opencode');
    await getBackendAvailability('opencode');
    assert.equal(checks, 1);
  });

  it('coalesces concurrent availability checks per backend', async () => {
    let checks = 0;
    registerBackendRuntime('opencode', {
      resolveBinaryPath: () => '/fake/opencode',
      healthCheck: async () => {
        checks += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return true;
      },
    });
    const [first, second] = await Promise.all([
      getBackendAvailability('opencode'),
      getBackendAvailability('opencode'),
    ]);
    assert.deepEqual(first, second);
    assert.equal(checks, 1);
  });
});

describe('default backend', () => {
  beforeEach(async () => {
    resetBackendRegistryForTests();
    await clearDefaultBackend();
  });

  it('round-trips an explicit setting', async () => {
    await setDefaultBackend('codex');
    assert.equal(await getDefaultBackend(), 'codex');
    await setDefaultBackend('opencode');
    assert.equal(await getDefaultBackend(), 'opencode');
    await setDefaultBackend('claude');
    assert.equal(await getDefaultBackend(), 'claude');
  });

  it('resolves to the stored backend when it is available', async () => {
    registerBackendRuntime('claude', {
      resolveBinaryPath: () => '/fake/claude',
      healthCheck: async () => true,
    });
    await setDefaultBackend('claude');
    const resolved = await resolveDefaultBackend();
    assert.equal(resolved.backend, 'claude');
    assert.equal(resolved.fallbackFrom, undefined);
  });

  it('falls back with a notice when the stored backend is unavailable', async () => {
    registerBackendRuntime('claude', {
      resolveBinaryPath: () => undefined,
    });
    registerBackendRuntime('opencode', {
      resolveBinaryPath: () => '/fake/opencode',
      healthCheck: async () => true,
    });
    await setDefaultBackend('claude');
    const resolved = await resolveDefaultBackend();
    assert.equal(resolved.backend, 'opencode');
    assert.equal(resolved.fallbackFrom, 'claude');
  });

  it('defaults to claude when nothing is stored and claude is available', async () => {
    registerBackendRuntime('claude', {
      resolveBinaryPath: () => '/fake/claude',
      healthCheck: async () => true,
    });
    const resolved = await resolveDefaultBackend();
    assert.equal(resolved.backend, 'claude');
  });
});

describe('listBackendCapabilities', () => {
  it('fully resolves defaults per backend', async () => {
    const { listBackendCapabilities, CAPABILITY_IDS } = await import('./agent-backends.js');
    const claudeTable = listBackendCapabilities('claude');
    for (const id of CAPABILITY_IDS) {
      if (id === 'hooks') continue; // hooks declared unavailable on BOTH backends (U7)
      assert.equal(claudeTable[id].state, 'full');
    }
    assert.equal(claudeTable.hooks.state, 'unavailable');
    assert.equal(claudeTable.hooks.reasonKey, 'backend.hooksNotWired');
    assert.equal(claudeTable.imageInput.state, 'full');
    const opencodeTable = listBackendCapabilities('opencode');
    assert.equal(opencodeTable.analytics.state, 'unavailable');
    assert.equal(opencodeTable.analytics.reasonKey, 'backend.analyticsNotCounted');
    assert.equal(opencodeTable.hooks.state, 'unavailable');
    assert.equal(opencodeTable.imageInput.state, 'full');
  });
});
