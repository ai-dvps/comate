import { execFileSync, execSync } from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  cpSync,
  rmSync,
  statSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  assertNoDanglingSymlinks,
  assertNoNonAsciiPaths,
} from '../src/server/utils/native-artifact-audit.js';
import { parseBundleBackends, resolveHostTriple } from './lib/host-config.js';
import {
  assertSupportedSidecarBuildNode,
  getSidecarPkgTarget,
} from './lib/sidecar-node-version.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const distDir = join(rootDir, 'dist');
const sidecarDir = join(distDir, 'sidecar');
// Runtime resource staging area (U9: re-homed from the retired Tauri
// resources tree). Consumed by electron-builder.config.ts
// extraResources (non-mac platforms; macOS consumes the per-arch trees in
// build/resources-darwin-<arch> staged by step 11) and by the dev shell
// (electron/sidecar.ts). Gitignored build output, like build/sidecar.
const resourcesDir = join(rootDir, 'resources');
// Sidecar binary staging area: consumed by electron-builder.config.ts
// extraResources (arch-macro names) and by the dev shell (triple names).
const electronSidecarDir = join(rootDir, 'build', 'sidecar');

function run(cmd: string, opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: opts?.cwd || rootDir, env: { ...process.env, ...opts?.env } });
}

function getBinaryName(triple: string): string {
  const ext = triple.includes('windows') ? '.exe' : '';
  return `sidecar-node-${triple}${ext}`;
}

function signMacBinary(binaryPath: string): void {
  // pkg's generated identifier can pass `codesign --verify` while macOS 26
  // taskgated still rejects it at exec time. Supplying our own stable
  // identifier forces codesign to replace that CodeDirectory instead of
  // reproducing pkg's rejected one.
  execFileSync(
    'codesign',
    ['--force', '--sign', '-', '--identifier', 'com.comate.app.sidecar', binaryPath],
    { stdio: 'inherit' },
  );
  execFileSync('codesign', ['--verify', '--strict', '--verbose=2', binaryPath], {
    stdio: 'inherit',
  });
}

function buildSidecarTriple(triple: string, bundlePath: string) {
  const target = getSidecarPkgTarget(triple);
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

  const sourceBinary = join(sidecarDir, `sidecar-node-${triple}${triple.includes('windows') ? '.exe' : ''}`);
  console.log('\n--- Copying binary ---');
  // Dev resolution (electron/sidecar.ts) uses the triple-named binary.
  const destBinary = join(electronSidecarDir, binaryName);
  mkdirSync(electronSidecarDir, { recursive: true });
  copyFileSync(sourceBinary, destBinary);
  if (triple.includes('apple-darwin')) signMacBinary(destBinary);
  console.log(`Copied to ${destBinary}`);

  // Packaged resolution: also stage a copy named by electron-builder's
  // `${arch}` macro (arm64/x64), so the functional electron-builder.config.ts
  // extraResources entry `build/sidecar/sidecar-node-${arch}` resolves the
  // right binary for each arch of the single-runner dual-arch mac build.
  const electronArch = triple.includes('aarch64') ? 'arm64' : 'x64';
  const stagedBinary = join(
    electronSidecarDir,
    `sidecar-node-${electronArch}${triple.includes('windows') ? '.exe' : ''}`,
  );
  mkdirSync(electronSidecarDir, { recursive: true });
  copyFileSync(sourceBinary, stagedBinary);
  if (triple.includes('apple-darwin')) signMacBinary(stagedBinary);
  console.log(`Staged for electron-builder at ${stagedBinary}`);
}

async function build() {
  // The pkg runtime and better-sqlite3 ABI must share one supported Node major.
  // Fail before cleaning or producing build output when the local toolchain
  // differs from the Node 22 runtime used by release CI.
  assertSupportedSidecarBuildNode();

  // 1. Clean and prepare directories
  if (existsSync(sidecarDir)) {
    rmSync(sidecarDir, { recursive: true });
  }
  mkdirSync(sidecarDir, { recursive: true });

  console.log('\n--- Building bundled CLIs ---');
  run('npm run build:cli');

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
  const hostTriple = resolveHostTriple(process.platform, process.arch);
  buildSidecarTriple(hostTriple, bundlePath);

  // On macOS, also build the other architecture for universal support
  if (process.platform === 'darwin') {
    const otherTriple = hostTriple === 'aarch64-apple-darwin'
      ? 'x86_64-apple-darwin'
      : 'aarch64-apple-darwin';
    buildSidecarTriple(otherTriple, bundlePath);
  }

  // 5. Copy agent backend binaries to resources/ (variant-gated).
  // COMATE_BUNDLE_BACKENDS selects which runtimes ship: the default
  // 'claude,opencode' produces the dual-backend flavor; 'opencode' produces
  // the claude-free enterprise flavor (R12) — no claude binary is copied and
  // the assertion below fails the build if one slipped in anyway.
  const bundleBackends = parseBundleBackends(process.env.COMATE_BUNDLE_BACKENDS);
  console.log(`\n--- Copying agent backend binaries (backends: ${[...bundleBackends].join(', ')}) ---`);
  const platform = process.platform;
  const arch = process.arch;

  // Remove stale backend binaries from earlier builds of a different flavor
  // (resources/ is build output; a claude binary from a previous dual-backend
  // build must not survive into a claude-free flavor).
  for (const [backend, binaryName] of [
    ['claude', platform === 'win32' ? 'claude.exe' : 'claude'],
    ['opencode', platform === 'win32' ? 'opencode.exe' : 'opencode'],
  ] as const) {
    if (!bundleBackends.has(backend)) {
      const stalePath = join(resourcesDir, binaryName);
      if (existsSync(stalePath)) {
        rmSync(stalePath);
        console.log(`Removed stale ${backend} binary from resources (${stalePath})`);
      }
    }
  }

  if (bundleBackends.has('claude')) {
    const sdkBinaryName = platform === 'win32' ? 'claude.exe' : 'claude';
    const sdkBinarySource = join(
      rootDir,
      'node_modules',
      `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`,
      sdkBinaryName,
    );
    if (existsSync(sdkBinarySource)) {
      const sdkBinaryDest = join(resourcesDir, sdkBinaryName);
      if (existsSync(sdkBinaryDest) && statSync(sdkBinaryDest).isDirectory()) {
        rmSync(sdkBinaryDest, { recursive: true });
      }
      copyFileSync(sdkBinarySource, sdkBinaryDest);
      console.log(`Copied claude binary to ${sdkBinaryDest}`);
    } else {
      throw new Error(`claude binary not found at ${sdkBinarySource} (required by COMATE_BUNDLE_BACKENDS)`);
    }
  }

  if (bundleBackends.has('opencode')) {
    const opencodeBinaryName = platform === 'win32' ? 'opencode.exe' : 'opencode';
    // opencode's platform packages are named `opencode-windows-x64` on Windows,
    // NOT `opencode-win32-x64` — unlike @anthropic-ai/claude-agent-sdk which
    // uses Node's `win32`. Map the segment or the Windows build can't find it.
    const opencodePlatformSegment = platform === 'win32' ? 'windows' : platform;
    const opencodeBinarySource = join(
      rootDir,
      'node_modules',
      `opencode-${opencodePlatformSegment}-${arch}`,
      'bin',
      opencodeBinaryName,
    );
    if (existsSync(opencodeBinarySource)) {
      const opencodeBinaryDest = join(resourcesDir, opencodeBinaryName);
      if (existsSync(opencodeBinaryDest) && statSync(opencodeBinaryDest).isDirectory()) {
        rmSync(opencodeBinaryDest, { recursive: true });
      }
      copyFileSync(opencodeBinarySource, opencodeBinaryDest);
      console.log(`Copied opencode binary to ${opencodeBinaryDest}`);
    } else {
      throw new Error(`opencode binary not found at ${opencodeBinarySource} (required by COMATE_BUNDLE_BACKENDS)`);
    }
  }

  // Variant assertion: resources must contain exactly the selected backends.
  const claudeBinaryPath = join(resourcesDir, platform === 'win32' ? 'claude.exe' : 'claude');
  const opencodeBinaryPath = join(resourcesDir, platform === 'win32' ? 'opencode.exe' : 'opencode');
  const isFile = (p: string): boolean => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (bundleBackends.has('claude') !== isFile(claudeBinaryPath)) {
    throw new Error(
      `backend variant mismatch: claude ${bundleBackends.has('claude') ? 'missing from' : 'present in'} resources (${claudeBinaryPath})`,
    );
  }
  if (bundleBackends.has('opencode') !== isFile(opencodeBinaryPath)) {
    throw new Error(
      `backend variant mismatch: opencode ${bundleBackends.has('opencode') ? 'missing from' : 'present in'} resources (${opencodeBinaryPath})`,
    );
  }

  // 6. Bundle a self-contained WeCom CLI. Copying only dist/index.js leaves
  // its command modules and package metadata behind, so the staged entrypoint
  // cannot run outside the workspace.
  console.log('\n--- Bundling self-contained WeCom CLI ---');
  const wecomCliDir = join(resourcesDir, 'wecom-cli');
  if (existsSync(wecomCliDir)) rmSync(wecomCliDir, { recursive: true, force: true });
  mkdirSync(wecomCliDir, { recursive: true });
  const wecomBundle = join(wecomCliDir, 'bundle.cjs');
  run(
    `npx esbuild ${join(rootDir, 'packages', 'wecom-cli', 'dist', 'index.js')} ` +
      `--bundle --platform=node --target=node20 --format=cjs ` +
      `--outfile=${wecomBundle} ` +
      `--banner:js="const __wecomImportMetaUrl = require('node:url').pathToFileURL(__filename).href;"`,
  );
  const wecomPackage = JSON.parse(
    readFileSync(join(rootDir, 'packages', 'wecom-cli', 'package.json'), 'utf8'),
  ) as { name: string; version: string };
  const fixedWecomBundle = readFileSync(wecomBundle, 'utf8')
    .replace(
      /var import_meta(\d*) = \{\};/g,
      (_match, num) => `var import_meta${num} = { url: __wecomImportMetaUrl };`,
    )
    .replace(
      /var packageJson = require\d*\("\.\.\/package\.json"\);/,
      `var packageJson = ${JSON.stringify({ name: wecomPackage.name, version: wecomPackage.version })};`,
    );
  if (/require\d*\("\.\.\/package\.json"\)/.test(fixedWecomBundle)) {
    throw new Error('self-contained WeCom CLI still contains a runtime package.json require');
  }
  writeFileSync(wecomBundle, fixedWecomBundle);
  const wecomCliTriples = process.platform === 'darwin'
    ? ['aarch64-apple-darwin', 'x86_64-apple-darwin']
    : [hostTriple];
  for (const triple of wecomCliTriples) {
    const commandDir = join(wecomCliDir, triple);
    mkdirSync(commandDir, { recursive: true });
    const command = join(commandDir, triple.includes('windows') ? 'wecom.exe' : 'wecom');
    run(`npx pkg ${wecomBundle} --targets ${getSidecarPkgTarget(triple)} --output ${command} --no-bytecode --public`);
    if (!isFile(command)) throw new Error(`native WeCom CLI missing after pkg (${command})`);
  }
  const wecomCommand = join(wecomCliDir, hostTriple, platform === 'win32' ? 'wecom.exe' : 'wecom');
  const wecomVersion = execFileSync(wecomCommand, ['--version'], {
    env: { PATH: '' },
    encoding: 'utf8',
  }).trim();
  if (!/^@webank\/wecom\/\d+\.\d+\.\d+/.test(wecomVersion)) {
    throw new Error(`native WeCom CLI smoke check returned an unexpected version: ${wecomVersion}`);
  }

  // Copying only the entrypoint is insufficient because this CLI imports the
  // shared API-contract package. Ship one fully bundled native runtime per
  // target so installed generated artifacts can invoke `comate` without Node.
  console.log('\n--- Bundling self-contained Comate CLI ---');
  const comateCliDir = join(resourcesDir, 'comate-cli');
  if (existsSync(comateCliDir)) rmSync(comateCliDir, { recursive: true, force: true });
  mkdirSync(comateCliDir, { recursive: true });
  const comateBundle = join(comateCliDir, 'bundle.cjs');
  run(
    `npx esbuild ${join(rootDir, 'packages', 'comate-cli', 'dist', 'index.js')} ` +
      `--bundle --platform=node --target=node20 --format=cjs ` +
      `--outfile=${comateBundle}`,
  );
  const cliTriples = process.platform === 'darwin'
    ? ['aarch64-apple-darwin', 'x86_64-apple-darwin']
    : [hostTriple];
  for (const triple of cliTriples) {
    const commandDir = join(comateCliDir, triple);
    mkdirSync(commandDir, { recursive: true });
    const command = join(commandDir, triple.includes('windows') ? 'comate.exe' : 'comate');
    run(`npx pkg ${comateBundle} --targets ${getSidecarPkgTarget(triple)} --output ${command} --no-bytecode --public`);
    if (!isFile(command)) throw new Error(`native Comate CLI missing after pkg (${command})`);
  }
  const comateCommand = join(
    comateCliDir,
    hostTriple,
    platform === 'win32' ? 'comate.exe' : 'comate',
  );
  const bundledSource = readFileSync(comateBundle, 'utf8');
  if (!isFile(comateCommand) || bundledSource.includes("from '@comate/api-contracts'")) {
    throw new Error(`self-contained Comate CLI resource assertion failed (${comateCommand})`);
  }
  try {
    execFileSync(comateCommand, ['not-a-command'], {
      env: { PATH: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    throw new Error('native Comate CLI smoke command unexpectedly succeeded');
  } catch (error) {
    const stderr = String((error as { stderr?: Buffer }).stderr ?? '');
    if (!stderr.includes('Usage: comate api request')) {
      throw new Error(`native Comate CLI failed without its own runtime: ${stderr}`);
    }
  }

  // 7. Copy ripgrep binary to resources/
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

  // 8. Copy better_sqlite3.node to resources/
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

  // ABI guard (KTD-1, U3): the pkg sidecar and this build process are both
  // pinned to Node 22, so the staged .node must load under the current Node.
  // node_modules can silently hold a foreign-ABI prebuild (an
  // npm install under a different Node major, or an Electron-ABI rebuild
  // flow); without this probe the defect only surfaces in the packaged app as
  // ERR_DLOPEN_FAILED at the first database open.
  try {
    execFileSync(process.execPath, ['-e', `require(${JSON.stringify(nativeModuleDest)})`], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (error) {
    throw new Error(
      `better_sqlite3.node ABI mismatch: it does not load under the build Node ` +
        `(${process.version}, modules ${process.versions.modules}). Run \`npm rebuild better-sqlite3\` ` +
        `with the same Node that runs this script, then rebuild. Cause: ${String((error as { stderr?: Buffer }).stderr ?? error)}`,
    );
  }

  // 9. Copy built-in Claude Code marketplace to resources/
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

  // 10. Whole-tree resource audit (KTD-13): the dangling-symlink and
  // non-ASCII-path gates run once here, at the end of resource staging, over
  // everything that will reach process.resourcesPath — electron-builder ships
  // the ENTIRE resources/ tree via extraResources.
  console.log('\n--- Resource tree audit (KTD-13) ---');
  assertNoDanglingSymlinks(resourcesDir);
  console.log('clean (no dangling symlinks)');
  assertNoNonAsciiPaths(resourcesDir);
  console.log('clean (no non-ASCII paths)');

  // 11. Per-arch macOS resource trees. The single-runner dual-arch mac build
  // (build.yml: electron-builder --mac --x64 --arm64) packages BOTH apps from
  // one host-arch node_modules, but the resources tree carries native payloads
  // (claude, opencode, rg, better_sqlite3.node) — shipping the host tree into
  // the cross-arch app puts arm64-only Mach-O binaries on Intel Macs
  // (ERR_DLOPEN_FAILED / spawn failures). electron-builder.config.ts therefore
  // maps build/resources-darwin-${arch} (like the sidecar binary already does),
  // and we stage one tree per electron arch here:
  //  - host tree: verbatim copy of the gated+audited resources/ tree;
  //  - cross tree: same base with every native payload replaced by the other
  //    arch's artifact. Cross-arch staging is deterministic and LOUD: any
  //    payload that cannot be obtained fails the whole build rather than
  //    silently shipping wrong-arch binaries.
  if (process.platform === 'darwin') {
    stageDarwinPerArchResources(bundleBackends, isFile);
  }

  console.log('\n=== Sidecar build complete ===');
}

// ---------------------------------------------------------------------------
// Step 11 helpers (macOS per-arch resource trees)
// ---------------------------------------------------------------------------

type ElectronArch = 'arm64' | 'x64';

function readPkgJson(...segments: string[]): Record<string, unknown> {
  return JSON.parse(readFileSync(join(...segments, 'package.json'), 'utf8'));
}

/**
 * Fetch one file out of an npm platform package (e.g.
 * `@anthropic-ai/claude-agent-sdk-darwin-x64`) without installing it: npm pack
 * the exact pinned version, extract the single file from the tarball, copy it
 * to dest with the executable bit. Throws on any failure.
 */
function stageNpmPackageFile(pkgName: string, version: string, pathInPkg: string, dest: string) {
  const tmp = mkdtempSync(join(tmpdir(), 'sidecar-cross-npm-'));
  try {
    const spec = `${pkgName}@${version}`;
    console.log(`> npm pack ${spec} (cross-arch payload)`);
    const out = execFileSync('npm', ['pack', spec, '--pack-destination', tmp], {
      cwd: tmp,
      encoding: 'utf8',
    });
    const tgzName = out.trim().split('\n').pop()!.trim();
    execFileSync('tar', ['-xzf', join(tmp, tgzName), '-C', tmp, `package/${pathInPkg}`]);
    const extracted = join(tmp, 'package', pathInPkg);
    if (!existsSync(extracted)) {
      throw new Error(`${spec} does not contain ${pathInPkg}`);
    }
    copyFileSync(extracted, dest);
    chmodSync(dest, 0o755);
    console.log(`Staged ${spec}:${pathInPkg} -> ${dest}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Obtain a better_sqlite3.node for the other macOS arch. A scratch
 * `npm install better-sqlite3@<ver>` runs better-sqlite3's own install script
 * (`prebuild-install || node-gyp rebuild --release`) with npm_config_arch/
 * npm_config_platform pointing at the target arch: on Node >= 22 (CI) this
 * downloads the official GitHub-releases prebuild (published from ABI v127);
 * otherwise prebuild-install misses and node-gyp cross-compiles from source
 * (clang -arch x86_64 works on arm64 hosts and vice versa). Either way the
 * result is arch-asserted by the caller before it ships.
 */
function stageBetterSqlite3Cross(version: string, targetArch: ElectronArch, dest: string) {
  const tmp = mkdtempSync(join(tmpdir(), 'sidecar-cross-bs3-'));
  try {
    run(`npm install better-sqlite3@${version} --no-save --no-audit --no-fund`, {
      cwd: tmp,
      env: { npm_config_arch: targetArch, npm_config_platform: 'darwin' },
    });
    const built = join(tmp, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
    if (!existsSync(built)) {
      throw new Error(`cross-arch better-sqlite3 install produced no binary at ${built}`);
    }
    copyFileSync(built, dest);
    chmodSync(dest, 0o755);
    console.log(`Staged better-sqlite3@${version} (${targetArch}) -> ${dest}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Assert a Mach-O file is built for the expected electron arch (file(1)). */
function assertMachOArch(filePath: string, expectedArch: ElectronArch) {
  const needle = expectedArch === 'x64' ? 'x86_64' : 'arm64';
  const desc = execFileSync('file', [filePath], { encoding: 'utf8' });
  if (!desc.includes('Mach-O') || !desc.includes(needle)) {
    throw new Error(`arch assertion failed for ${filePath}: expected ${needle}, got: ${desc.trim()}`);
  }
  console.log(`arch ok (${needle}): ${filePath}`);
}

function stageDarwinPerArchResources(bundleBackends: Set<string>, isFile: (p: string) => boolean) {
  console.log('\n--- Staging per-arch macOS resource trees (darwin) ---');
  const hostArch: ElectronArch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const crossArch: ElectronArch = hostArch === 'arm64' ? 'x64' : 'arm64';
  const hostTree = join(rootDir, 'build', `resources-darwin-${hostArch}`);
  const crossTree = join(rootDir, 'build', `resources-darwin-${crossArch}`);

  // Host tree: the resources/ tree was already variant-gated (step 5) and
  // audited (step 10), so the copy inherits both gates by construction.
  rmSync(hostTree, { recursive: true, force: true });
  cpSync(resourcesDir, hostTree, { recursive: true });
  console.log(`Copied resources/ -> ${hostTree}`);

  // Cross tree: same base (JS resources, marketplace, and the per-triple
  // comate-cli subdirs are already arch-correct), then replace every native
  // payload with the cross-arch artifact.
  rmSync(crossTree, { recursive: true, force: true });
  cpSync(resourcesDir, crossTree, { recursive: true });
  console.log(`Copied resources/ -> ${crossTree}`);

  if (bundleBackends.has('claude')) {
    const pkg = `@anthropic-ai/claude-agent-sdk-darwin-${crossArch}`;
    const sdkDeps = (readPkgJson(rootDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
      .optionalDependencies ?? {}) as Record<string, string>;
    if (!sdkDeps[pkg]) throw new Error(`${pkg} not pinned in @anthropic-ai/claude-agent-sdk optionalDependencies`);
    stageNpmPackageFile(pkg, sdkDeps[pkg], 'claude', join(crossTree, 'claude'));
  }

  if (bundleBackends.has('opencode')) {
    const pkg = `opencode-darwin-${crossArch}`;
    const rootDeps = (readPkgJson(rootDir).optionalDependencies ?? {}) as Record<string, string>;
    if (!rootDeps[pkg]) throw new Error(`${pkg} not pinned in package.json optionalDependencies`);
    stageNpmPackageFile(pkg, rootDeps[pkg], join('bin', 'opencode'), join(crossTree, 'opencode'));
  }

  const rgPkg = `@vscode/ripgrep-darwin-${crossArch}`;
  const rgDeps = (readPkgJson(rootDir, 'node_modules', '@vscode', 'ripgrep')
    .optionalDependencies ?? {}) as Record<string, string>;
  if (!rgDeps[rgPkg]) throw new Error(`${rgPkg} not pinned in @vscode/ripgrep optionalDependencies`);
  stageNpmPackageFile(rgPkg, rgDeps[rgPkg], join('bin', 'rg'), join(crossTree, 'rg'));

  const bs3Version = String(readPkgJson(rootDir, 'node_modules', 'better-sqlite3').version);
  stageBetterSqlite3Cross(bs3Version, crossArch, join(crossTree, 'better_sqlite3.node'));

  // Arch + audit gates over BOTH trees. The cross tree's .node cannot be
  // ABI-probed by require() on this host (wrong-arch Mach-O), so the Mach-O
  // arch assertion via file(1) is the executable check there; the host tree's
  // ABI probe already ran in step 8 against resources/.
  for (const [tree, treeArch] of [
    [hostTree, hostArch],
    [crossTree, crossArch],
  ] as const) {
    const nativePayloads = [
      ...(bundleBackends.has('claude') ? ['claude'] : []),
      ...(bundleBackends.has('opencode') ? ['opencode'] : []),
      'rg',
      'better_sqlite3.node',
    ];
    for (const name of nativePayloads) {
      const p = join(tree, name);
      if (!isFile(p)) throw new Error(`native payload missing from ${tree}: ${p}`);
      assertMachOArch(p, treeArch);
    }
    assertNoDanglingSymlinks(tree);
    assertNoNonAsciiPaths(tree);
    console.log(`tree clean (symlinks, ASCII paths): ${tree}`);
  }
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
