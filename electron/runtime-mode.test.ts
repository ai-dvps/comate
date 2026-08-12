import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolvePackagedRuntime, shouldEnableUpdater } from './runtime-mode';

describe('resolvePackagedRuntime', () => {
  it('keeps an Electron Vite development launch in dev mode after the executable is rebranded', () => {
    assert.equal(resolvePackagedRuntime(true, 'development'), false);
  });

  it('uses Electron packaging state outside an Electron Vite development launch', () => {
    assert.equal(resolvePackagedRuntime(true, 'production'), true);
    assert.equal(resolvePackagedRuntime(true, undefined), true);
    assert.equal(resolvePackagedRuntime(false, 'development'), false);
  });
});

describe('shouldEnableUpdater', () => {
  it('keeps updater checks quiet in dev unless a dev feed is configured', () => {
    assert.equal(shouldEnableUpdater(false, false), false);
    assert.equal(shouldEnableUpdater(false, true), true);
    assert.equal(shouldEnableUpdater(true, false), true);
  });
});
