import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { computeProdClosure, type NpmLockfile } from './steel-lockfile-closure.js';

/**
 * Prod-closure contract for the vendored Steel build (U2 build gate):
 * lockfile-driven, dev subtrees excluded, platform-constrained optionals
 * excluded, pure-JS optionals kept, stubbed packages terminal, removed
 * packages fail loudly.
 */

function lockfile(packages: NpmLockfile['packages']): NpmLockfile {
  return { lockfileVersion: 3, packages };
}

const base = lockfile({
  '': { name: 'root' },
  api: {
    dependencies: { a: '^1.0.0', 'dev-only': '^1.0.0' },
    peerDependencies: { 'peer-x': '^1.0.0', 'peer-opt': '^2.0.0' },
    peerDependenciesMeta: { 'peer-opt': { optional: true } },
  },
  'node_modules/a': {
    version: '1.0.0',
    dependencies: { c: '^1.0.0', stubbed: '^1.0.0' },
  },
  'node_modules/c': {
    version: '1.0.0',
    dependencies: { 'plat-opt': '^1.0.0', 'js-opt': '^1.0.0' },
  },
  'node_modules/plat-opt': { version: '1.0.0', optional: true, os: ['darwin'], cpu: ['arm64'] },
  'node_modules/js-opt': { version: '1.0.0', optional: true },
  'node_modules/dev-only': { version: '1.0.0', dev: true },
  'node_modules/peer-x': { version: '1.0.0' },
  'node_modules/stubbed': {
    version: '1.0.0',
    dependencies: { 'stub-child': '^1.0.0' },
  },
  'node_modules/stub-child': { version: '1.0.0' },
  'node_modules/nested-parent': { version: '1.0.0', dependencies: { deep: '^2.0.0' } },
  'node_modules/nested-parent/node_modules/deep': { version: '2.0.0' },
  'node_modules/deep': { version: '1.0.0' },
  'node_modules/uses-removed': { version: '1.0.0', dependencies: { gone: '^1.0.0' } },
  'node_modules/gone': { version: '1.0.0' },
  'node_modules/opt-parent': {
    version: '1.0.0',
    optionalDependencies: { 'opt-chain': '^1.0.0' },
  },
  'node_modules/opt-chain': { version: '1.0.0', optional: true },
  'node_modules/hard-parent': {
    version: '1.0.0',
    dependencies: { 'opt-chain': '^1.0.0' },
  },
});

describe('steel-lockfile-closure', { concurrency: false }, () => {
  it('walks declared deps and non-optional peers from the workspace seed', () => {
    const result = computeProdClosure({ lockfile: base, workspacePath: 'api' });
    assert.ok(result.paths.includes('node_modules/a'));
    assert.ok(result.paths.includes('node_modules/c'));
    assert.ok(result.paths.includes('node_modules/peer-x'));
  });

  it('excludes dev-flagged subtrees', () => {
    const result = computeProdClosure({ lockfile: base, workspacePath: 'api' });
    assert.ok(!result.paths.includes('node_modules/dev-only'));
  });

  it('skips optional peers at the seed without requiring them to exist', () => {
    // peer-opt has no lockfile entry at all — must not throw.
    const result = computeProdClosure({ lockfile: base, workspacePath: 'api' });
    assert.ok(!result.paths.some((p) => p.includes('peer-opt')));
  });

  it('excludes platform-constrained optionals but keeps pure-JS optionals', () => {
    const result = computeProdClosure({ lockfile: base, workspacePath: 'api' });
    assert.ok(!result.paths.includes('node_modules/plat-opt'));
    assert.ok(result.excludedOptional.includes('node_modules/plat-opt'));
    assert.ok(result.paths.includes('node_modules/js-opt'));
  });

  it('treats stubbed packages as terminal leaves (deps not traversed)', () => {
    const result = computeProdClosure({
      lockfile: base,
      workspacePath: 'api',
      stubbedPackages: ['stubbed'],
    });
    assert.ok(!result.paths.includes('node_modules/stubbed'));
    assert.ok(result.stubbed.includes('node_modules/stubbed'));
    assert.ok(!result.paths.includes('node_modules/stub-child'));
  });

  it('resolves through nested node_modules before ancestors', () => {
    const withNested = lockfile({
      ...base.packages,
      api: { dependencies: { 'nested-parent': '^1.0.0' } },
    });
    const result = computeProdClosure({ lockfile: withNested, workspacePath: 'api' });
    assert.ok(result.paths.includes('node_modules/nested-parent/node_modules/deep'));
    assert.ok(!result.paths.includes('node_modules/deep'));
  });

  it('traverses optionalDependencies (upstream may import them directly)', () => {
    const withOpt = lockfile({
      ...base.packages,
      api: { dependencies: { 'opt-parent': '^1.0.0' } },
    });
    const result = computeProdClosure({ lockfile: withOpt, workspacePath: 'api' });
    assert.ok(result.paths.includes('node_modules/opt-chain'));
  });

  it('excludes optional-chain packages only through optional edges', () => {
    const withOpt = lockfile({
      ...base.packages,
      api: { dependencies: { 'opt-parent': '^1.0.0' } },
    });
    const result = computeProdClosure({
      lockfile: withOpt,
      workspacePath: 'api',
      excludedPackages: ['opt-chain'],
    });
    assert.ok(!result.paths.includes('node_modules/opt-chain'));
    assert.ok(result.excluded.includes('node_modules/opt-chain'));
  });

  it('throws when an excluded package is reached through a hard edge', () => {
    const withHard = lockfile({
      ...base.packages,
      api: { dependencies: { 'hard-parent': '^1.0.0' } },
    });
    assert.throws(
      () =>
        computeProdClosure({
          lockfile: withHard,
          workspacePath: 'api',
          excludedPackages: ['opt-chain'],
        }),
      /excluded package 'opt-chain' is reachable through a hard dependency edge/,
    );
  });

  it('throws when a removed package is still reachable', () => {
    const withRemoved = lockfile({
      ...base.packages,
      api: { dependencies: { 'uses-removed': '^1.0.0' } },
    });
    assert.throws(
      () =>
        computeProdClosure({
          lockfile: withRemoved,
          workspacePath: 'api',
          removedPackages: ['gone'],
        }),
      /removed package 'gone' is still reachable/,
    );
  });

  it('throws when a declared dependency is missing from the lockfile', () => {
    const broken = lockfile({
      '': {},
      api: { dependencies: { ghost: '^1.0.0' } },
    });
    assert.throws(
      () => computeProdClosure({ lockfile: broken, workspacePath: 'api' }),
      /dependency 'ghost' of 'api' not found in lockfile/,
    );
  });

  it('throws when the workspace path is absent', () => {
    assert.throws(
      () => computeProdClosure({ lockfile: base, workspacePath: 'nope' }),
      /workspace 'nope' not found/,
    );
  });
});
