import '../test-utils/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { resolveWecomCliPath } from './resolve-wecom-cli.js';

const originalResourceDir = process.env.TAURI_RESOURCE_DIR;

afterEach(() => {
  if (originalResourceDir === undefined) delete process.env.TAURI_RESOURCE_DIR;
  else process.env.TAURI_RESOURCE_DIR = originalResourceDir;
});

describe('resolveWecomCliPath', () => {
  it('prefers the sidecar-bundled CLI over global and source-tree fallbacks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-cli-resource-'));
    try {
      const triple = process.platform === 'darwin'
        ? (process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin')
        : process.platform === 'win32'
          ? 'x86_64-pc-windows-msvc'
          : (process.arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu');
      const command = path.join(root, 'wecom-cli', triple, process.platform === 'win32' ? 'wecom.exe' : 'wecom');
      fs.mkdirSync(path.dirname(command), { recursive: true });
      fs.writeFileSync(command, 'native-cli');
      process.env.TAURI_RESOURCE_DIR = root;

      assert.equal(resolveWecomCliPath(), command);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
