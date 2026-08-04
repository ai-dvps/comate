import '../../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Regression coverage for remote content intentionally rendered by the Tauri
 * webview: the local browser viewer and SkillHub Enterprise logos.
 */

describe('Tauri CSP allows required remote content', () => {
  it('includes the browser viewer and Enterprise logo origins', () => {
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

    const imgSrcMatch = /img-src\s+([^;]+)/.exec(csp);
    assert.ok(imgSrcMatch, `CSP is missing img-src directive: ${csp}`);
    assert.ok(
      imgSrcMatch[1].includes('https://oneid-private-prod-1258344699.cos.ap-guangzhou.myqcloud.com'),
      `img-src must allow the SkillHub Enterprise logo origin; got: ${imgSrcMatch[1]}`,
    );
  });
});
