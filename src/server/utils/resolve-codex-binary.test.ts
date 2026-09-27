import '../test-utils/test-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { CODEX_EXPECTED_VERSION, codexPlatformPackage, codexVendorTriple, resolveCodexBinary } from './resolve-codex-binary.js';

describe('resolveCodexBinary', () => {
  it('maps every supported platform package and native triple', () => {
    assert.equal(codexPlatformPackage('darwin', 'arm64'), '@openai/codex-darwin-arm64');
    assert.equal(codexVendorTriple('darwin', 'x64'), 'x86_64-apple-darwin');
    assert.equal(codexVendorTriple('linux', 'arm64'), 'aarch64-unknown-linux-musl');
    assert.equal(codexVendorTriple('win32', 'x64'), 'x86_64-pc-windows-msvc');
    assert.throws(() => codexPlatformPackage('freebsd', 'x64'));
  });

  it('resolves the pinned host binary and matches its version', () => {
    const binary = resolveCodexBinary();
    assert.ok(binary, 'expected the host optional dependency to be installed');
    assert.match(execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(), new RegExp(`${CODEX_EXPECTED_VERSION.replaceAll('.', '\\.')}$`));
  });
});
