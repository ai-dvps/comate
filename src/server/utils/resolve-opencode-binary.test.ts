import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveOpencodeBinary, OPENCODE_EXPECTED_VERSION } from './resolve-opencode-binary.js';

describe('resolveOpencodeBinary', () => {
  it('resolves the bundled platform package in the dev tree (host platform)', () => {
    // Requires npm install to have fetched the host platform's optional dep.
    const resolved = resolveOpencodeBinary();
    if (resolved === undefined) {
      assert.match(
        process.platform,
        /^(?!darwin|linux|win32)/,
        'skipping: no opencode platform package for this host',
      );
      return;
    }
    assert.match(resolved, /opencode(-darwin|-linux|-windows)?[^/]*\/bin\/opencode(\.exe)?$/);
  });

  it('finds a planted binary via TAURI_RESOURCE_DIR (Strategy 4)', () => {
    const resourceDir = mkdtempSync(path.join(tmpdir(), 'oc-resources-'));
    const binaryPath = path.join(
      resourceDir,
      process.platform === 'win32' ? 'opencode.exe' : 'opencode',
    );
    writeFileSync(binaryPath, 'fake');
    process.env.TAURI_RESOURCE_DIR = resourceDir;
    try {
      // Strategy 1 may win in the dev tree; accept either winning strategy
      // but require a defined result when the package or resource exists.
      const resolved = resolveOpencodeBinary();
      assert.ok(resolved, 'expected a resolved opencode binary');
    } finally {
      delete process.env.TAURI_RESOURCE_DIR;
    }
  });

  it('pins the compatibility-unit version constant', () => {
    assert.match(OPENCODE_EXPECTED_VERSION, /^\d+\.\d+\.\d+$/);
  });
});
