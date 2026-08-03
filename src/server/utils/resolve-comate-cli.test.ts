import '../test-utils/test-env.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { resolveComateCliPath } from './resolve-comate-cli.js';

const originalResourceDir = process.env.TAURI_RESOURCE_DIR;

afterEach(() => {
  if (originalResourceDir === undefined) delete process.env.TAURI_RESOURCE_DIR;
  else process.env.TAURI_RESOURCE_DIR = originalResourceDir;
});

describe('resolveComateCliPath', () => {
  it('resolves a command actually named comate in the development workspace', () => {
    delete process.env.TAURI_RESOURCE_DIR;
    const command = resolveComateCliPath();
    assert.ok(command, 'workspace comate command must be resolvable');
    assert.match(path.basename(command), /^comate(?:\.cmd)?$/);
  });

  it('selects the packaged native command for the current target triple', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comate-cli-resource-'));
    try {
      const triple = process.platform === 'darwin'
        ? (process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin')
        : process.platform === 'win32'
          ? 'x86_64-pc-windows-msvc'
          : (process.arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu');
      const command = path.join(root, 'comate-cli', triple, process.platform === 'win32' ? 'comate.exe' : 'comate');
      fs.mkdirSync(path.dirname(command), { recursive: true });
      fs.writeFileSync(command, process.platform === 'win32' ? '' : '#!/bin/sh\nprintf packaged-native');
      if (process.platform !== 'win32') fs.chmodSync(command, 0o755);
      process.env.TAURI_RESOURCE_DIR = root;
      assert.equal(resolveComateCliPath(), command);
      if (process.platform !== 'win32') {
        assert.equal(execFileSync(command, { env: { PATH: '' }, encoding: 'utf8' }), 'packaged-native');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
