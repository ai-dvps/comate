import '../../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Regression: the browser viewer iframe loads from the viewer proxy on
 * 127.0.0.1 (not localhost). Tauri's CSP must allow that origin in frame-src,
 * otherwise the iframe is blocked and the panel renders as a black rectangle.
 */

describe('Tauri CSP allows the browser viewer iframe origin', () => {
  it('frame-src includes both localhost and 127.0.0.1', () => {
    const configPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      '..',
      'src-tauri',
      'tauri.conf.json',
    );
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as {
      app?: { security?: { csp?: string } };
    };
    const csp = config.app?.security?.csp ?? '';

    const frameSrcMatch = /frame-src\s+([^;]+)/.exec(csp);
    assert.ok(frameSrcMatch, `CSP is missing frame-src directive: ${csp}`);
    const frameSrc = frameSrcMatch[1];
    assert.ok(
      frameSrc.includes("http://127.0.0.1:*"),
      `frame-src must allow the browser viewer proxy origin (http://127.0.0.1:*); got: ${frameSrc}`,
    );
    assert.ok(
      frameSrc.includes("http://localhost:*"),
      `frame-src should keep the sidecar API origin (http://localhost:*); got: ${frameSrc}`,
    );
  });
});
