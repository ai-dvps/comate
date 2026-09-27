import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertSupportedSidecarBuildNode,
  getNodeMajor,
  getSidecarPkgTarget,
  SIDECAR_NODE_MAJOR,
} from './sidecar-node-version.js';

describe('sidecar Node version contract', () => {
  it('pins the packaged runtime to Node 22 on every supported target', () => {
    assert.equal(SIDECAR_NODE_MAJOR, 22);
    assert.equal(getSidecarPkgTarget('aarch64-apple-darwin'), 'node22-darwin-arm64');
    assert.equal(getSidecarPkgTarget('x86_64-apple-darwin'), 'node22-darwin-x64');
    assert.equal(getSidecarPkgTarget('x86_64-pc-windows-msvc'), 'node22-win-x64');
    assert.equal(getSidecarPkgTarget('x86_64-unknown-linux-gnu'), 'node22-linux-x64');
    assert.equal(getSidecarPkgTarget('aarch64-unknown-linux-gnu'), 'node22-linux-arm64');
  });

  it('allows Node 22 builds', () => {
    assert.doesNotThrow(() => assertSupportedSidecarBuildNode('v22.21.1'));
  });

  it('rejects a different build Node before packaging native dependencies', () => {
    assert.throws(
      () => assertSupportedSidecarBuildNode('v24.14.1'),
      /Sidecar builds require Node 22\.x, but v24\.14\.1 is running.*nvm use/s,
    );
  });

  it('rejects malformed Node version strings', () => {
    assert.throws(() => getNodeMajor('unknown'), /Unable to determine Node major version/);
  });

  it('rejects unsupported target triples', () => {
    assert.throws(() => getSidecarPkgTarget('riscv64-unknown-linux-gnu'), /Unsupported target triple/);
  });
});
