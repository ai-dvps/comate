import { execSync } from 'child_process';
import { existsSync, mkdirSync, copyFileSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const distDir = join(rootDir, 'dist');
const sidecarDir = join(distDir, 'sidecar');
const tauriDir = join(rootDir, 'src-tauri');
const binariesDir = join(tauriDir, 'binaries');
const resourcesDir = join(tauriDir, 'resources');

function run(cmd: string, opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: opts?.cwd || rootDir, env: { ...process.env, ...opts?.env } });
}

function getPlatformTarget(): string {
  const platform = process.platform;
  const arch = process.arch;
  const nodeMajor = process.version.split('.')[0].replace('v', '');

  if (platform === 'darwin') {
    return arch === 'arm64' ? `node${nodeMajor}-darwin-arm64` : `node${nodeMajor}-darwin-x64`;
  }
  if (platform === 'win32') {
    return `node${nodeMajor}-win-x64`;
  }
  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

function getBinaryName(target: string): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'darwin') {
    const triple = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
    return `sidecar-node-${triple}`;
  }
  if (platform === 'win32') {
    return 'sidecar-node-x86_64-pc-windows-msvc.exe';
  }
  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

async function build() {
  // 1. Clean and prepare directories
  if (existsSync(sidecarDir)) {
    rmSync(sidecarDir, { recursive: true });
  }
  mkdirSync(sidecarDir, { recursive: true });

  // 2. Compile server TypeScript
  console.log('\n--- Compiling server ---');
  run('npx tsc -p tsconfig.server.json');

  // 3. Bundle with esbuild into single CJS file
  console.log('\n--- Bundling with esbuild ---');
  const bundlePath = join(sidecarDir, 'bundle.cjs');
  run(
    `npx esbuild dist/server/index.js ` +
      `--bundle ` +
      `--platform=node ` +
      `--target=node20 ` +
      `--format=cjs ` +
      `--outfile=${bundlePath} ` +
      `--external:better-sqlite3 ` +
      `--banner:js="#!/usr/bin/env node"`,
  );

  // Fix import.meta.url polyfills for pkg compatibility
  const bundleContent = readFileSync(bundlePath, 'utf-8');
  const fixedContent = bundleContent.replace(
    /var import_meta(\d*) = \{\};/g,
    (_match, num) => `var import_meta${num} = { url: 'file:///snapshot/bundle.js' };`,
  );
  writeFileSync(bundlePath, fixedContent);

  // 4. Package with pkg
  console.log('\n--- Packaging with pkg ---');
  const target = getPlatformTarget();
  const binaryName = getBinaryName(target);

  run(
    `npx pkg ${join(sidecarDir, 'bundle.cjs')} ` +
      `--targets ${target} ` +
      `--output ${join(sidecarDir, 'sidecar-node')} ` +
      `--no-bytecode ` +
      `--public ` +
      `--public-packages "*"`,
  );

  // 5. Copy binary to src-tauri/binaries/
  console.log('\n--- Copying binary ---');
  const sourceBinary = join(sidecarDir, process.platform === 'win32' ? 'sidecar-node.exe' : 'sidecar-node');
  const destBinary = join(binariesDir, binaryName);
  copyFileSync(sourceBinary, destBinary);
  console.log(`Copied to ${destBinary}`);

  // 6. Copy better_sqlite3.node to src-tauri/resources/
  console.log('\n--- Copying native module ---');
  const nativeModuleSource = join(
    rootDir,
    'node_modules',
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node',
  );
  if (!existsSync(nativeModuleSource)) {
    throw new Error(`Native module not found at ${nativeModuleSource}`);
  }
  const nativeModuleDest = join(resourcesDir, 'better_sqlite3.node');
  copyFileSync(nativeModuleSource, nativeModuleDest);
  console.log(`Copied to ${nativeModuleDest}`);

  console.log('\n=== Sidecar build complete ===');
  console.log(`Binary: ${destBinary}`);
  console.log(`Native module: ${nativeModuleDest}`);
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
