import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolvePackagedRuntime, resolveUpdaterRuntimeConfig } from './runtime-mode';

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

describe('resolveUpdaterRuntimeConfig', () => {
  it('requires app-update.yml from packaged resources', () => {
    let checkedPath = '';
    const config = resolveUpdaterRuntimeConfig(true, '/resources', '/app', (path) => {
      checkedPath = path;
      return false;
    });

    assert.deepEqual(config, {
      enabled: false,
      forceDevUpdateConfig: false,
    });
    assert.equal(checkedPath, '/resources/app-update.yml');
  });

  it('keeps development quiet without dev-app-update.yml', () => {
    let checkedPath = '';
    const config = resolveUpdaterRuntimeConfig(false, '/resources', '/app', (path) => {
      checkedPath = path;
      return false;
    });

    assert.deepEqual(config, {
      enabled: false,
      forceDevUpdateConfig: false,
    });
    assert.equal(checkedPath, '/app/dev-app-update.yml');
  });

  it('enables electron-updater development config when the file exists', () => {
    const config = resolveUpdaterRuntimeConfig(false, '/resources', '/app', () => true);

    assert.deepEqual(config, {
      enabled: true,
      forceDevUpdateConfig: true,
    });
  });
});
