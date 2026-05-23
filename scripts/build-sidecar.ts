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

  // Fix import.meta.url polyfills for pkg compatibility.
  //
  // esbuild emits two shapes for the import_meta shim:
  //   (a) inline:   `var import_meta3 = {};`
  //   (b) hoisted:  `var ..., import_meta4, ...;` followed by `import_meta4 = {};`
  // Shape (b) appears inside ESM-CJS wrappers like fdir's `init_dist`, where
  // every module-scope binding is hoisted to a single `var` declaration and
  // the assignment runs lazily on first require. The fdir wrapper then calls
  // `createRequire(import_meta4.url)`; if url is undefined, Node throws
  // `TypeError: The argument 'filename' must be a file URL ...` and any code
  // path that triggers init_file_search_fallback (e.g. searchFiles falling
  // through to the pure-Node walker) fails. Patch both shapes.
  const bundleContent = readFileSync(bundlePath, 'utf-8');
  const fixedContent = bundleContent
    .replace(
      /var import_meta(\d*) = \{\};/g,
      (_match, num) => `var import_meta${num} = { url: 'file:///snapshot/bundle.js' };`,
    )
    .replace(
      /^(\s*)import_meta(\d*) = \{\};$/gm,
      (_match, ws, num) => `${ws}import_meta${num} = { url: 'file:///snapshot/bundle.js' };`,
    );
  writeFileSync(bundlePath, fixedContent);

  // Sanity check: fail the build if any unpatched import_meta shim survives.
  if (/^\s*import_meta\d* = \{\};\s*$/m.test(fixedContent)) {
    throw new Error(
      'build-sidecar: unpatched `import_meta{N} = {};` found in bundle — ' +
        'extend the regex in scripts/build-sidecar.ts to cover the new shape.',
    );
  }

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

  // 6. Copy Claude Code CLI binary to src-tauri/resources/
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

  // 7. Copy wecom CLI to src-tauri/resources/
  console.log('\n--- Copying wecom CLI ---');
  const wecomCliSource = join(rootDir, 'packages', 'wecom-cli', 'dist', 'index.js');
  if (existsSync(wecomCliSource)) {
    const wecomCliDest = join(resourcesDir, 'wecom-send.js');
    copyFileSync(wecomCliSource, wecomCliDest);
    console.log(`Copied to ${wecomCliDest}`);
  } else {
    console.warn(`Warning: WeCom CLI not found at ${wecomCliSource}`);
  }

  // 8. Copy ripgrep binary to src-tauri/resources/
  console.log('\n--- Copying ripgrep binary ---');
  const rgBinaryName = platform === 'win32' ? 'rg.exe' : 'rg';
  // @vscode/ripgrep ships the binary via a per-platform optional dependency
  // package — e.g. @vscode/ripgrep-darwin-arm64. The top-level package's
  // bin/ directory is a copy from the platform package; either works at
  // runtime, but the platform package is the canonical source.
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

  // 9. Copy better_sqlite3.node to src-tauri/resources/
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
