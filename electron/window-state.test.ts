import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadWindowState, saveWindowState } from './window-state';

const primary = { x: 0, y: 25, width: 1440, height: 875 };

test('window state survives restart, including negative display coordinates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'comate-window-'));
  const path = join(dir, 'shell', 'window-state.json');
  try {
    assert.equal(loadWindowState(path, [primary]), undefined);
    const bounds = { x: -1300, y: 70, width: 1000, height: 700 };
    saveWindowState(path, bounds);
    assert.deepEqual(loadWindowState(path, [primary, { ...primary, x: -1440 }]), bounds);
    assert.deepEqual(loadWindowState(path, [primary]), { ...bounds, x: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid state falls back and oversized bounds fit the current display', () => {
  const dir = mkdtempSync(join(tmpdir(), 'comate-window-'));
  const path = join(dir, 'window-state.json');
  try {
    for (const value of ['broken', 'null', '{}', '{"x":0,"y":0,"width":-1,"height":800}']) {
      writeFileSync(path, value);
      assert.equal(loadWindowState(path, [primary]), undefined);
    }
    saveWindowState(path, { x: 100, y: -100, width: 3000, height: 2000 });
    assert.deepEqual(loadWindowState(path, [primary]), primary);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
