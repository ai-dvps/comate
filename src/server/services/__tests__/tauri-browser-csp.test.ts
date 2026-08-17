import '../../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Regression coverage for remote content intentionally rendered inside the
 * Electron shell: the local browser viewer and SkillHub Enterprise logos.
 *
 * U2: with Tauri gone, the CSP is no longer injected from tauri.conf.json —
 * it ships as a <meta http-equiv="Content-Security-Policy"> in index.html so
 * it applies in every serving mode (Electron app.comate:// scheme, Vite dev
 * server, sidecar static hosting). This test asserts the meta mechanism
 * really emits the required directives.
 */

function readCspFromIndexHtml(): string {
  const indexPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    'index.html',
  );
  const html = readFileSync(indexPath, 'utf-8');
  const metaMatch = /<meta\s+[^>]*http-equiv="Content-Security-Policy"[^>]*>/i.exec(html);
  assert.ok(metaMatch, 'index.html is missing the Content-Security-Policy meta tag');
  const contentMatch = /content="([^"]*)"/i.exec(metaMatch[0]);
  assert.ok(contentMatch, 'CSP meta tag is missing its content attribute');
  return contentMatch[1];
}

describe('Electron CSP allows required remote content', () => {
  it('delivers frame-src and connect-src directives via the index.html meta tag', () => {
    const csp = readCspFromIndexHtml();

    const frameSrcMatch = /frame-src\s+([^;]+)/.exec(csp);
    assert.ok(frameSrcMatch, `CSP is missing frame-src directive: ${csp}`);
    const frameSrc = frameSrcMatch[1];
    assert.ok(
      frameSrc.includes('http://127.0.0.1:*'),
      `frame-src must allow the browser viewer proxy origin (http://127.0.0.1:*); got: ${frameSrc}`,
    );
    assert.ok(
      frameSrc.includes('http://localhost:*'),
      `frame-src should keep the sidecar API origin (http://localhost:*); got: ${frameSrc}`,
    );

    const connectSrcMatch = /connect-src\s+([^;]+)/.exec(csp);
    assert.ok(connectSrcMatch, `CSP is missing connect-src directive: ${csp}`);
    const connectSrc = connectSrcMatch[1];
    for (const origin of [
      'http://localhost:*',
      'http://127.0.0.1:*',
      'ws://localhost:*',
      'ws://127.0.0.1:*',
    ]) {
      assert.ok(
        connectSrc.includes(origin),
        `connect-src must allow both loopback spellings over http/ws; missing ${origin} in: ${connectSrc}`,
      );
    }

    const imgSrcMatch = /img-src\s+([^;]+)/.exec(csp);
    assert.ok(imgSrcMatch, `CSP is missing img-src directive: ${csp}`);
    assert.ok(
      imgSrcMatch[1].includes('https://oneid-private-prod-1258344699.cos.ap-guangzhou.myqcloud.com'),
      `img-src must allow the SkillHub Enterprise logo origin; got: ${imgSrcMatch[1]}`,
    );
    assert.ok(
      imgSrcMatch[1].split(/\s+/).includes('data:'),
      `img-src must allow data URLs used by workspace image previews; got: ${imgSrcMatch[1]}`,
    );

    const mediaSrcMatch = /media-src\s+([^;]+)/.exec(csp);
    assert.ok(mediaSrcMatch, `CSP is missing media-src directive: ${csp}`);
    for (const origin of ['http://localhost:*', 'http://127.0.0.1:*']) {
      assert.ok(
        mediaSrcMatch[1].includes(origin),
        `media-src must allow streamed workspace videos; missing ${origin} in: ${mediaSrcMatch[1]}`,
      );
    }
  });
});
