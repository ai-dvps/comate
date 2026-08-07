import '../../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { resolveBrowserCdpTarget } from '../browser-target.js';

describe('resolveBrowserCdpTarget (R8/F2)', () => {
  const shellEnv = {
    COMATE_SHELL_DEBUG_PORT: '49200',
    COMATE_SHELL_CONTROL_PORT: '49300',
    COMATE_SHELL_CONTROL_TOKEN: 'tok',
  };

  it('auto: shell when the shell env is complete, steel otherwise', () => {
    assert.deepEqual(resolveBrowserCdpTarget({ ...shellEnv }), {
      kind: 'shell',
      debugPort: 49200,
      controlPort: 49300,
      controlToken: 'tok',
    });
    assert.deepEqual(resolveBrowserCdpTarget({ ...shellEnv, COMATE_BROWSER_CDP_TARGET: 'auto' }).kind, 'shell');
    assert.deepEqual(resolveBrowserCdpTarget({}), { kind: 'steel' });
    // Partial shell env must not half-activate the shell path.
    assert.deepEqual(resolveBrowserCdpTarget({ COMATE_SHELL_DEBUG_PORT: '49200' }), { kind: 'steel' });
  });

  it('explicit steel/shell overrides', () => {
    assert.deepEqual(resolveBrowserCdpTarget({ ...shellEnv, COMATE_BROWSER_CDP_TARGET: 'steel' }), { kind: 'steel' });
    assert.equal(resolveBrowserCdpTarget({ ...shellEnv, COMATE_BROWSER_CDP_TARGET: 'shell' }).kind, 'shell');
    const missing = resolveBrowserCdpTarget({ COMATE_BROWSER_CDP_TARGET: 'shell' });
    assert.equal(missing.kind, 'misconfigured');
    assert.match((missing as { reason: string }).reason, /COMATE_SHELL_DEBUG_PORT/);
  });

  it('external endpoints: http, ws, bare host:port, bare port', () => {
    assert.deepEqual(
      resolveBrowserCdpTarget({ COMATE_BROWSER_CDP_TARGET: 'http://127.0.0.1:9222' }),
      { kind: 'external', host: '127.0.0.1', port: 9222 },
    );
    assert.deepEqual(
      resolveBrowserCdpTarget({ COMATE_BROWSER_CDP_TARGET: 'ws://127.0.0.1:9222/devtools/browser/abc' }),
      { kind: 'external', host: '127.0.0.1', port: 9222 },
    );
    assert.deepEqual(
      resolveBrowserCdpTarget({ COMATE_BROWSER_CDP_TARGET: 'localhost:9333' }),
      { kind: 'external', host: 'localhost', port: 9333 },
    );
    assert.deepEqual(
      resolveBrowserCdpTarget({ COMATE_BROWSER_CDP_TARGET: '9444' }),
      { kind: 'external', host: '127.0.0.1', port: 9444 },
    );
  });

  it('garbage overrides are misconfigured, never silently steel', () => {
    const bad = resolveBrowserCdpTarget({ COMATE_BROWSER_CDP_TARGET: 'http://no-port/' });
    assert.equal(bad.kind, 'misconfigured');
    const garbage = resolveBrowserCdpTarget({ COMATE_BROWSER_CDP_TARGET: '???' });
    assert.equal(garbage.kind, 'misconfigured');
  });
});
