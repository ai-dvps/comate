import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { verifyPackagedUpdaterFeeds } from './verify-packaged-updater-feed';

interface PackageJson {
  engines?: Record<string, string>;
  scripts?: Record<string, string>;
}

interface WorkflowStep {
  name?: string;
  run?: string;
}

interface BuildWorkflow {
  jobs?: {
    build?: { steps?: WorkflowStep[] };
    'bridge-manifest'?: { steps?: WorkflowStep[] };
    'release-signing-status'?: { steps?: WorkflowStep[] };
  };
}

function requiredWorkflowStep(steps: WorkflowStep[] | undefined, name: string): WorkflowStep {
  const step = steps?.find(candidate => candidate.name === name);
  assert.ok(step, `workflow must contain the ${name} step`);
  return step;
}

test('the repository and sidecar build share the Node 22 runtime contract', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as PackageJson;
  const nvmVersion = readFileSync('.nvmrc', 'utf8').trim();
  const sidecarBuildSource = readFileSync('scripts/build-sidecar.ts', 'utf8');

  assert.equal(nvmVersion, '22', '.nvmrc must select the release sidecar Node major');
  assert.equal(packageJson.engines?.node, '>=22 <23', 'package engines must reject other majors');
  assert.match(
    sidecarBuildSource,
    /assertSupportedSidecarBuildNode\(\);[\s\S]*?if \(existsSync\(sidecarDir\)\)/,
    'the sidecar build must reject unsupported Node versions before cleaning build output',
  );
  assert.doesNotMatch(
    sidecarBuildSource,
    /getPkgTarget/,
    'every packaged sidecar and CLI must use the pinned Node target helper',
  );
});

test('the Electron distribution build produces both renderer and shell bundles', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as PackageJson;
  const buildCommand = packageJson.scripts?.['build:electron'] ?? '';

  assert.match(
    buildCommand,
    /(?:^|&&)\s*(?:npm run build:client|vite build)\s*(?:&&|$)/,
    'build:electron must build dist/client before electron-builder packages it',
  );
  assert.match(
    buildCommand,
    /(?:^|&&)\s*(?:npm run build:electron:shell|electron-vite build)\s*(?:&&|$)/,
    'build:electron must build the Electron main and preload bundles',
  );
});

test('every release package must contain updater metadata even when signing is unavailable', () => {
  const workflow = readFileSync('.github/workflows/build.yml', 'utf8');
  const parsedWorkflow = parse(workflow) as BuildWorkflow;
  const builderConfig = readFileSync('electron-builder.config.ts', 'utf8');

  assert.match(
    workflow,
    /name: Guard packaged updater feed\s+shell: bash[\s\S]*?verify-packaged-updater-feed\.ts release "\$\{\{ runner\.os \}\}"/,
    'every release job must fail when electron-builder omits app-update.yml',
  );
  assert.match(
    builderConfig,
    /publish: githubPublish/,
    'electron-builder must retain its publish configuration so --publish never still generates manifests',
  );
  assert.doesNotMatch(
    builderConfig,
    /publish: releaseReady \? githubPublish : null/,
    'missing signing credentials must not suppress updater manifests',
  );
  assert.match(
    workflow,
    /assets=\(release\/\*\.dmg release\/\*\.zip release\/\*\.exe release\/latest\*\.yml release\/\*\.blockmap\)/,
    'unsigned macOS and Windows release uploads must include updater manifests and blockmaps',
  );
  const signingReadiness = requiredWorkflowStep(
    parsedWorkflow.jobs?.build?.steps,
    'Determine signing readiness',
  ).run;
  assert.ok(signingReadiness, 'Determine signing readiness must define its shell condition');

  const windowsReadiness = signingReadiness.match(
    /elif \[ "\$\{\{ runner\.os \}\}" = 'Windows' \] \\\n([\s\S]*?); then/,
  )?.[0];
  assert.ok(windowsReadiness, 'Windows signing readiness must have a dedicated condition');
  for (const credential of [
    'AZURE_TENANT_ID',
    'AZURE_CLIENT_ID',
    'AZURE_CLIENT_SECRET',
    'AZURE_TRUSTED_SIGNING_PUBLISHER',
    'AZURE_TRUSTED_SIGNING_ENDPOINT',
    'AZURE_TRUSTED_SIGNING_CERT_PROFILE',
    'AZURE_TRUSTED_SIGNING_ACCOUNT',
  ]) {
    assert.match(
      windowsReadiness,
      new RegExp(`\\[ -n "\\$${credential}" \\]`),
      `Windows release readiness must require ${credential}`,
    );
  }
  assert.match(
    builderConfig,
    /const defaultWindowsPublisherName = 'ai-dvps'/,
    'unsigned Windows packages must pin the expected future signing identity',
  );
  assert.match(
    builderConfig,
    /publisherName: \[windowsPublisherName\]/,
    'the stable Windows publisher identity must be included in updater configuration',
  );

  const linuxReadiness = signingReadiness.match(
    /elif \[ "\$\{\{ runner\.os \}\}" = 'Linux' \]; then[\s\S]*?ready=true/,
  )?.[0];
  assert.ok(linuxReadiness, 'Linux signing readiness must always mark Linux builds ready');
  assert.doesNotMatch(
    linuxReadiness,
    /TAURI_SIGNING_PRIVATE_KEY/,
    'Linux packaging readiness must be independent of the Tauri bridge key',
  );

  const signingStatus = requiredWorkflowStep(
    parsedWorkflow.jobs?.['release-signing-status']?.steps,
    'Preserve notes and record signing status',
  ).run;
  assert.ok(signingStatus, 'release signing-status step must define its release-body update');
  assert.match(
    signingStatus,
    /windows_status='SIGNED with Azure Trusted Signing'/,
    'release notes must identify signed Windows assets consistently',
  );
  assert.match(
    signingStatus,
    /windows_status='UNSIGNED — full Azure Trusted Signing credentials were unavailable'/,
    'release notes must identify unsigned Windows assets consistently',
  );
  assert.match(
    signingStatus,
    /gh release edit "\$GITHUB_REF_NAME" --notes-file "\$updated_body"/,
    'the managed signing status must be persisted to the draft release body',
  );
});

test('packaged updater feed guard validates every macOS architecture and exact feed values', () => {
  const releaseDir = mkdtempSync(join(tmpdir(), 'comate-updater-feed-'));
  const feed = 'provider: github\nowner: ai-dvps\nrepo: comate\n';
  const x64Resources = join(releaseDir, 'mac', 'Comate.app', 'Contents', 'Resources');
  const arm64Resources = join(releaseDir, 'mac-arm64', 'Comate.app', 'Contents', 'Resources');

  try {
    mkdirSync(x64Resources, { recursive: true });
    mkdirSync(arm64Resources, { recursive: true });
    writeFileSync(join(x64Resources, 'app-update.yml'), feed);
    writeFileSync(join(arm64Resources, 'app-update.yml'), feed);

    assert.equal(verifyPackagedUpdaterFeeds(releaseDir, 'macOS').length, 2);

    rmSync(join(arm64Resources, 'app-update.yml'));
    assert.throws(
      () => verifyPackagedUpdaterFeeds(releaseDir, 'macOS'),
      /signed package missing .*mac-arm64.*app-update\.yml/,
    );

    writeFileSync(join(arm64Resources, 'app-update.yml'), 'provider: github\nowner: ai-dvps-fork\nrepo: comate\n');
    assert.throws(
      () => verifyPackagedUpdaterFeeds(releaseDir, 'macOS'),
      /owner=ai-dvps-fork; expected ai-dvps/,
    );
  } finally {
    rmSync(releaseDir, { recursive: true, force: true });
  }
});

test('the Electron shell builds a dedicated least-privilege detached-browser preload', () => {
  const viteConfig = readFileSync('electron.vite.config.ts', 'utf8');
  const detachedPreload = readFileSync('electron/detached-browser-preload.ts', 'utf8');
  const mainSource = readFileSync('electron/main.ts', 'utf8');

  assert.match(
    viteConfig,
    /['"]detached-browser-preload['"]:\s*resolve\(__dirname, ['"]electron\/detached-browser-preload\.ts['"]\)/,
    'the detached browser must have its own preload output',
  );

  for (const forbiddenCapability of [
    'updater',
    'fileManager',
    'showOpenDialog',
    'notification',
    'setBadge',
    'mainWindow',
    'detachedBrowser: {\n    detach',
    'detachedBrowser: {\n    focus',
  ]) {
    assert.doesNotMatch(
      detachedPreload,
      new RegExp(forbiddenCapability),
      `the detached preload must not expose ${forbiddenCapability}`,
    );
  }

  assert.match(
    mainSource,
    /loadUi\([^,\n]+, ['"]detached-browser['"]\)/,
    'the independent window must route to the minimal renderer mode',
  );
  assert.match(
    mainSource,
    /preload: join\(__dirname, ['"]\.\.['"], ['"]preload['"], ['"]detached-browser-preload\.cjs['"]\)/,
    'the independent window must load the dedicated preload bundle',
  );
});

test('the Electron development command stops all dev servers when the app quits', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as PackageJson;
  const devCommand = packageJson.scripts?.['dev:electron'] ?? '';

  assert.match(
    devCommand,
    /concurrently\s+(?=[^\n]*--kill-others)(?=[^\n]*--success\s+first)/,
    'dev:electron must stop the Vite server and exit successfully when Electron quits',
  );
});

test('the renderer development server refuses to reuse an occupied port', () => {
  const viteConfig = readFileSync('vite.config.ts', 'utf8');

  assert.match(
    viteConfig,
    /server:\s*\{[\s\S]*?port:\s*5173,[\s\S]*?strictPort:\s*true,/,
    'dev startup must fail instead of attaching Electron to a stale Vite server',
  );
});

test('the Electron development command rebuilds the server sidecar and CLIs before launch', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as PackageJson;
  const devCommand = packageJson.scripts?.['dev:electron'] ?? '';
  const sidecarCommand = packageJson.scripts?.['build:sidecar'] ?? '';
  const sidecarBuildSource = readFileSync('scripts/build-sidecar.ts', 'utf8');

  assert.match(
    devCommand,
    /^npm run patch:electron-dev-name\s*&&\s*npm run build:sidecar\s*&&\s*concurrently\b/,
    'dev:electron must rebrand the macOS dev bundle and rebuild the sidecar before starting Electron',
  );
  assert.match(
    devCommand,
    /["']npm run dev:client["']/,
    'dev:electron must keep the Vite client watcher',
  );
  assert.match(
    devCommand,
    /["']electron-vite dev["']/,
    'dev:electron must keep the Electron main and preload watchers',
  );
  assert.match(
    sidecarCommand,
    /^tsx scripts\/build-sidecar\.ts\s*&&\s*npm run test:sidecar-new-chat$/,
    'build:sidecar must package the sidecar and verify the New Chat path in that binary',
  );
  assert.match(
    sidecarBuildSource,
    /run\(['"]npm run build:cli['"]\)/,
    'the sidecar build must rebuild the bundled CLIs',
  );
  assert.match(
    sidecarBuildSource,
    /run\(['"]npx tsc -p tsconfig\.server\.json['"]\)/,
    'the sidecar build must recompile the server',
  );
  assert.match(
    sidecarBuildSource,
    /Bundling self-contained WeCom CLI/,
    'the sidecar build must not stage only the WeCom CLI entrypoint',
  );
  assert.match(
    sidecarBuildSource,
    /execFileSync\(wecomCommand, \['--version'\]/,
    'the sidecar build must execute the staged WeCom CLI before launch',
  );
});

test('the sidecar build re-signs both final macOS staging binaries with a stable identifier', () => {
  const sidecarBuildSource = readFileSync('scripts/build-sidecar.ts', 'utf8');

  assert.match(
    sidecarBuildSource,
    /execFileSync\(\s*['"]codesign['"],[\s\S]*?['"]--force['"][\s\S]*?['"]--sign['"][\s\S]*?['"]-['"][\s\S]*?['"]--identifier['"][\s\S]*?['"]com\.comate\.app\.sidecar['"]/,
    'macOS sidecars must receive a fresh ad-hoc signature with an identifier that replaces pkg\'s taskgated-rejected identifier',
  );
  assert.match(
    sidecarBuildSource,
    /execFileSync\(['"]codesign['"],[\s\S]*?['"]--verify['"][\s\S]*?['"]--strict['"][\s\S]*?binaryPath/,
    'the sidecar build must fail immediately when macOS rejects the refreshed signature',
  );
  assert.match(
    sidecarBuildSource,
    /copyFileSync\(sourceBinary, destBinary\);[\s\S]*?signMacBinary\(destBinary\)/,
    'the development sidecar staging path must be signed after copying',
  );
  assert.match(
    sidecarBuildSource,
    /copyFileSync\(sourceBinary, stagedBinary\);[\s\S]*?signMacBinary\(stagedBinary\)/,
    'the electron-builder sidecar staging path must be signed after copying',
  );
});
