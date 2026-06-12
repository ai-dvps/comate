import { execSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  cpSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from 'fs';
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

function getNodeMajor(): string {
  return process.version.split('.')[0].replace('v', '');
}

function getPkgTarget(triple: string): string {
  const nodeMajor = getNodeMajor();
  if (triple.includes('aarch64-apple-darwin')) {
    return `node${nodeMajor}-darwin-arm64`;
  }
  if (triple.includes('x86_64-apple-darwin')) {
    return `node${nodeMajor}-darwin-x64`;
  }
  if (triple.includes('x86_64-pc-windows-msvc')) {
    return `node${nodeMajor}-win-x64`;
  }
  if (triple.includes('x86_64-unknown-linux-gnu')) {
    return `node${nodeMajor}-linux-x64`;
  }
  if (triple.includes('aarch64-unknown-linux-gnu')) {
    return `node${nodeMajor}-linux-arm64`;
  }
  throw new Error(`Unsupported target triple: ${triple}`);
}

function getHostTriple(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'darwin') {
    return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  }
  if (platform === 'win32') {
    return 'x86_64-pc-windows-msvc';
  }
  if (platform === 'linux') {
    return arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
  }
  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

function getBinaryName(triple: string): string {
  const ext = triple.includes('windows') ? '.exe' : '';
  return `sidecar-node-${triple}${ext}`;
}

function buildSidecarTriple(triple: string, bundlePath: string) {
  const target = getPkgTarget(triple);
  const binaryName = getBinaryName(triple);

  console.log(`\n--- Packaging with pkg for ${triple} ---`);
  run(
    `npx pkg ${bundlePath} ` +
      `--targets ${target} ` +
      `--output ${join(sidecarDir, `sidecar-node-${triple}`)} ` +
      `--no-bytecode ` +
      `--public ` +
      `--public-packages "*"`,
  );

  console.log('\n--- Copying binary ---');
  const sourceBinary = join(sidecarDir, `sidecar-node-${triple}${triple.includes('windows') ? '.exe' : ''}`);
  const destBinary = join(binariesDir, binaryName);
  copyFileSync(sourceBinary, destBinary);
  console.log(`Copied to ${destBinary}`);
}

async function build() {
  // 1. Clean and prepare directories
  if (existsSync(sidecarDir)) {
    rmSync(sidecarDir, { recursive: true });
  }
  mkdirSync(sidecarDir, { recursive: true });

  // Remove stale tsbuildinfo so TypeScript re-emits output files
  // (dist/ is gitignored but .tsbuildinfo may be stale on CI)
  const tsBuildInfo = join(rootDir, 'tsconfig.server.tsbuildinfo');
  if (existsSync(tsBuildInfo)) {
    rmSync(tsBuildInfo);
    console.log('Removed stale tsconfig.server.tsbuildinfo');
  }

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

  // Fix import.meta.url polyfills for pkg compatibility.
  // Use __filename instead of a hardcoded file:// URL so the path is a valid
  // absolute path on every platform (Windows, macOS, Linux). createRequire
  // accepts absolute path strings, and __filename inside a pkg snapshot is
  // already the snapshot's absolute path.
  const bundleContent = readFileSync(bundlePath, 'utf-8');
  const fixedContent = bundleContent
    .replace(
      /var import_meta(\d*) = \{\};/g,
      (_match, num) => `var import_meta${num} = { url: __filename };`,
    )
    .replace(
      /^(\s*)import_meta(\d*) = \{\};$/gm,
      (_match, ws, num) => `${ws}import_meta${num} = { url: __filename };`,
    );
  writeFileSync(bundlePath, fixedContent);

  // Sanity check: fail the build if any unpatched import_meta shim survives.
  if (/^\s*import_meta\d* = \{\};\s*$/m.test(fixedContent)) {
    throw new Error(
      'build-sidecar: unpatched `import_meta{N} = {};` found in bundle — ' +
        'extend the regex in scripts/build-sidecar.ts to cover the new shape.',
    );
  }

  // 4. Package with pkg for host platform
  const hostTriple = getHostTriple();
  buildSidecarTriple(hostTriple, bundlePath);

  // On macOS, also build the other architecture for universal support
  if (process.platform === 'darwin') {
    const otherTriple = hostTriple === 'aarch64-apple-darwin'
      ? 'x86_64-apple-darwin'
      : 'aarch64-apple-darwin';
    buildSidecarTriple(otherTriple, bundlePath);
  }

  // 5. Copy Claude Code CLI binary to src-tauri/resources/
  console.log('\n--- Copying Claude Code binary ---');
  const platform = process.platform;
  const arch = process.arch;
  const sdkBinaryName = platform === 'win32'
    ? 'claude.exe'
    : 'claude';
  const sdkBinarySource = join(
    rootDir,
    'node_modules',
    `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`,
    sdkBinaryName,
  );
  if (existsSync(sdkBinarySource)) {
    const sdkBinaryDest = join(resourcesDir, sdkBinaryName);
    copyFileSync(sdkBinarySource, sdkBinaryDest);
    console.log(`Copied to ${sdkBinaryDest}`);
  } else {
    console.warn(`Warning: SDK binary not found at ${sdkBinarySource}`);
  }

  // 6. Copy wecom CLI to src-tauri/resources/
  console.log('\n--- Copying wecom CLI ---');
  const wecomCliSource = join(rootDir, 'packages', 'wecom-cli', 'dist', 'index.js');
  if (existsSync(wecomCliSource)) {
    const wecomCliDest = join(resourcesDir, 'wecom-send.js');
    copyFileSync(wecomCliSource, wecomCliDest);
    console.log(`Copied to ${wecomCliDest}`);
  } else {
    console.warn(`Warning: WeCom CLI not found at ${wecomCliSource}`);
  }

  // 7. Copy ripgrep binary to src-tauri/resources/
  console.log('\n--- Copying ripgrep binary ---');
  const rgBinaryName = platform === 'win32' ? 'rg.exe' : 'rg';
  const rgPlatformPkg = `@vscode/ripgrep-${platform}-${arch}`;
  const rgBinarySource = join(
    rootDir,
    'node_modules',
    rgPlatformPkg,
    'bin',
    rgBinaryName,
  );
  const rgFallbackSource = join(
    rootDir,
    'node_modules',
    '@vscode',
    'ripgrep',
    'bin',
    rgBinaryName,
  );
  let rgSource: string | null = null;
  if (existsSync(rgBinarySource)) {
    rgSource = rgBinarySource;
  } else if (existsSync(rgFallbackSource)) {
    rgSource = rgFallbackSource;
  }
  if (rgSource) {
    const rgDest = join(resourcesDir, rgBinaryName);
    copyFileSync(rgSource, rgDest);
    console.log(`Copied to ${rgDest}`);
  } else {
    console.warn(
      `Warning: ripgrep binary not found at ${rgBinarySource} or ${rgFallbackSource}`,
    );
  }

  // 8. Copy better_sqlite3.node to src-tauri/resources/
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

  // 9. Copy built-in Claude Code marketplace to src-tauri/resources/
  console.log('\n--- Copying built-in Claude Code marketplace ---');
  const marketplaceSource = join(rootDir, 'claude-code-plugin');
  const marketplaceDest = join(resourcesDir, 'claude-code-plugin');
  if (existsSync(marketplaceSource)) {
    if (existsSync(marketplaceDest)) {
      rmSync(marketplaceDest, { recursive: true, force: true });
    }
    cpSync(marketplaceSource, marketplaceDest, { recursive: true, force: true });
    console.log(`Copied to ${marketplaceDest}`);
  } else {
    console.warn(`Warning: Built-in marketplace not found at ${marketplaceSource}`);
  }

  console.log('\n=== Sidecar build complete ===');
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
