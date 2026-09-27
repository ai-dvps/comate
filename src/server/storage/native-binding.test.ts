import '../test-utils/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { getNativeBindingPath } from './native-binding.js';

const originalSidecar = process.env.COMATE_SIDECAR;
const originalResourceDir = process.env.TAURI_RESOURCE_DIR;

afterEach(() => {
  if (originalSidecar === undefined) delete process.env.COMATE_SIDECAR;
  else process.env.COMATE_SIDECAR = originalSidecar;

  if (originalResourceDir === undefined) delete process.env.TAURI_RESOURCE_DIR;
  else process.env.TAURI_RESOURCE_DIR = originalResourceDir;
});

describe('getNativeBindingPath', () => {
  it('resolves the native binding staged in the Electron resource directory', () => {
    const resourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comate-native-binding-'));
    try {
      const binding = path.join(resourceDir, 'better_sqlite3.node');
      fs.writeFileSync(binding, 'test binding');
      process.env.COMATE_SIDECAR = '1';
      process.env.TAURI_RESOURCE_DIR = resourceDir;

      assert.equal(getNativeBindingPath(), binding);
    } finally {
      fs.rmSync(resourceDir, { recursive: true, force: true });
    }
  });
});
