import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  patchCdpServicePrimaryPage,
  patchLiveSessionViewerNativeScale,
  pruneNonRuntimeDirs,
} from './build-steel-bundle.js';

/**
 * Vendored Steel pruning contract: we strip test/example/etc. trees to keep the
 * bundle small and avoid non-ASCII fixture names that break WiX, but the name
 * `doc` / `docs` is too generic — packages such as `yaml` ship runtime-required
 * modules under `dist/doc/`. Removing them causes MODULE_NOT_FOUND at Steel
 * startup and the browser process exits with code 1.
 */

describe('pruneNonRuntimeDirs', () => {
  it('preserves runtime-required doc directories like yaml/dist/doc', () => {
    const staging = mkdtempSync(join(tmpdir(), 'comate-steel-prune-'));
    try {
      const yamlDoc = join(staging, 'node_modules', 'yaml', 'dist', 'doc');
      const yamlCompose = join(staging, 'node_modules', 'yaml', 'dist', 'compose');
      const pkgTest = join(staging, 'node_modules', 'pkg', 'test');
      const pkgExamples = join(staging, 'node_modules', 'pkg', 'examples');

      mkdirSync(yamlDoc, { recursive: true });
      mkdirSync(yamlCompose, { recursive: true });
      mkdirSync(pkgTest, { recursive: true });
      mkdirSync(pkgExamples, { recursive: true });

      writeFileSync(join(yamlDoc, 'directives.js'), 'module.exports = {};');
      writeFileSync(join(yamlCompose, 'composer.js'), "require('../doc/directives.js');");
      writeFileSync(join(pkgTest, 'fixture.js'), '// test');
      writeFileSync(join(pkgExamples, 'demo.js'), '// example');

      pruneNonRuntimeDirs(staging);

      assert.ok(
        existsSync(join(yamlDoc, 'directives.js')),
        'yaml/dist/doc/directives.js must be preserved — it is required at runtime',
      );
      assert.ok(
        !existsSync(pkgTest),
        'test/ directories should still be pruned',
      );
      assert.ok(
        !existsSync(pkgExamples),
        'examples/ directories should still be pruned',
      );
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });
});

describe('patchCdpServicePrimaryPage', () => {
  it('creates a primary page when Chrome starts without an initial Puppeteer page', () => {
    const apiDir = mkdtempSync(join(tmpdir(), 'comate-steel-primary-page-'));
    const serviceDir = join(apiDir, 'build', 'services', 'cdp');
    const servicePath = join(serviceDir, 'cdp.service.js');
    try {
      mkdirSync(serviceDir, { recursive: true });
      writeFileSync(
        servicePath,
        'this.primaryPage = await executeCritical(async () => (await this.browserInstance.pages())[0], onError);',
      );

      patchCdpServicePrimaryPage(apiDir);

      const patched = readFileSync(servicePath, 'utf-8');
      assert.ok(
        patched.includes('(await this.browserInstance.pages())[0] ?? await this.browserInstance.newPage()'),
        'Steel must always publish a Puppeteer-managed page for live-details and the viewer',
      );
    } finally {
      rmSync(apiDir, { recursive: true, force: true });
    }
  });
});

describe('patchLiveSessionViewerNativeScale', () => {
  it('renders browser frames at native size and lets the viewer scroll', () => {
    const apiDir = mkdtempSync(join(tmpdir(), 'comate-steel-native-viewer-'));
    const templateDir = join(apiDir, 'src', 'templates');
    const templatePath = join(templateDir, 'live-session-streamer.ejs');
    try {
      mkdirSync(templateDir, { recursive: true });
      writeFileSync(
        templatePath,
        `.content {
            overflow: hidden;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .canvas-container {
            position: absolute;
            height: 100%;
            width: 100%;
        }
        .canvas-container.active {
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .canvas {
            position: absolute;
            height: 100%;
            width: auto;
            left: 50%;
            transform: translateX(-50%);
            object-fit: contain;
        }
        const parentHeight = container.clientHeight;

        // Scale to height while maintaining aspect ratio
        const targetHeight = parentHeight;
        const targetWidth = targetHeight * (tabData.currentImageWidth / tabData.currentImageHeight);

        canvas.width = targetWidth * dpr;
        canvas.height = targetHeight * dpr;

        canvas.style.height = '100%';
        canvas.style.width = 'auto';`,
      );

      patchLiveSessionViewerNativeScale(apiDir);

      const patched = readFileSync(templatePath, 'utf-8');
      assert.match(patched, /overflow: auto;/);
      assert.match(patched, /top: 0;/);
      assert.match(patched, /left: 0;/);
      assert.match(patched, /min-width: 100%;/);
      assert.match(patched, /\.canvas-container\.active \{\s*display: block;/);
      assert.match(patched, /\.canvas \{\s*position: relative;\s*display: block;/);
      assert.match(patched, /canvas\.width = tabData\.currentImageWidth \* dpr;/);
      assert.match(patched, /canvas\.height = tabData\.currentImageHeight \* dpr;/);
      assert.match(patched, /canvas\.style\.width = tabData\.currentImageWidth \+ 'px';/);
      assert.match(patched, /canvas\.style\.height = tabData\.currentImageHeight \+ 'px';/);
      assert.doesNotMatch(patched, /Scale to height while maintaining aspect ratio/);
      assert.doesNotMatch(patched, /transform: translateX\(-50%\)/);
    } finally {
      rmSync(apiDir, { recursive: true, force: true });
    }
  });

  it('fails when the required viewer template is missing', () => {
    const apiDir = mkdtempSync(join(tmpdir(), 'comate-steel-missing-viewer-'));
    try {
      assert.throws(
        () => patchLiveSessionViewerNativeScale(apiDir),
        /native-scale viewer template not found/,
      );
    } finally {
      rmSync(apiDir, { recursive: true, force: true });
    }
  });

  it('fails loudly when the pinned viewer structure drifts', () => {
    const apiDir = mkdtempSync(join(tmpdir(), 'comate-steel-drifted-viewer-'));
    const templateDir = join(apiDir, 'src', 'templates');
    try {
      mkdirSync(templateDir, { recursive: true });
      writeFileSync(
        join(templateDir, 'live-session-streamer.ejs'),
        '.content { overflow: visible; }',
      );

      assert.throws(
        () => patchLiveSessionViewerNativeScale(apiDir),
        /native-scale viewer patch drifted \(content overflow\)/,
      );
    } finally {
      rmSync(apiDir, { recursive: true, force: true });
    }
  });
});
