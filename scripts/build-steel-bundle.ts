import { execFileSync, execSync } from 'child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  assertNoDanglingSymlinks,
  assertNoNativeArtifacts,
  assertSizeBudget,
  walkFiles,
} from '../src/server/utils/native-artifact-audit.js';
import {
  computeProdClosure,
  type NpmLockfile,
} from '../src/server/utils/steel-lockfile-closure.js';

/**
 * Vendor the Steel browser API into src-tauri/resources/steel/ (KTD-2).
 *
 * Supply-chain discipline:
 *  - Steel is pinned by commit SHA (STEEL_COMMIT below); dependencies resolve
 *    through the upstream package-lock.json at that commit via `npm ci`.
 *  - Only the pure-JS api build product + production dependencies are
 *    vendored. The prod closure is computed from the lockfile itself
 *    (steel-lockfile-closure.ts) because `npm ci --omit=dev -w api` leaks
 *    extraneous dev/platform packages across npm versions.
 *  - Native audit: any .node / Mach-O / PE / ELF artifact in the vendored
 *    tree fails the build (native-artifact-audit.ts).
 *  - Size budget: the vendored tree must stay under STEEL_SIZE_BUDGET_BYTES.
 *
 * Known native/optional-heavy prod deps are neutralized explicitly:
 *  - classic-level (via `level`) and duckdb-async/duckdb → pure-JS stubs that
 *    load cleanly and throw only if actually used (Steel only constructs them
 *    on opt-in paths: LOG_STORAGE_ENABLED, session storage extraction).
 *  - pdf2html (+ its native sharp dep and postinstall jar downloads) → stub;
 *    only the PDF scrape action uses it and it fails explicitly.
 *  - @scalar/fastify-api-reference (the /documentation UI, ~20 MB with its
 *    katex/openapi-parser subtree) → no-op fastify plugin stub; the docs route
 *    404s, the API is unaffected.
 *  - fsevents (chokidar's optional macOS watcher) → excluded; chokidar guards
 *    the require and falls back to fs.watch.
 *  - Type declarations and sourcemaps are stripped from the vendored tree
 *    (dead weight at runtime, ~35 MB).
 *
 * Output layout consumed by resolve-steel.ts:
 *   src-tauri/resources/steel/build/index.js
 *   src-tauri/resources/steel/node_modules/...
 *   src-tauri/resources/steel/package.json
 *   src-tauri/resources/steel/steel-manifest.json
 *
 * Pull behavior:
 *  - The pinned checkout is cached under node_modules/.cache/comate-steel/,
 *    keyed by commit SHA. Within the TTL (default 7 days; override with
 *    STEEL_CACHE_TTL_MS) builds reuse the cached checkout instead of
 *    re-fetching from GitHub. Set STEEL_NO_CACHE=1 to bypass the cache
 *    entirely (no reads, no writes).
 *  - If the HTTPS fetch fails, the clone is retried over SSH
 *    (git@github.com:...). GitHub disabled the unauthenticated git://
 *    transport in 2022, so SSH is the only working non-HTTPS protocol.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

const STEEL_REPO = 'https://github.com/steel-dev/steel-browser';
const STEEL_REPO_SSH = 'git@github.com:steel-dev/steel-browser.git';
// Fetch remotes in fallback order: HTTPS first, SSH on failure. (GitHub
// disabled the unauthenticated git:// transport, so SSH is the fallback.)
const STEEL_REMOTES = [STEEL_REPO, STEEL_REPO_SSH];
// Pinned upstream commit (v0.5.3-beta). Bump deliberately; record why.
const STEEL_COMMIT = 'd6b15d5ba658eb748ebb376d9ea837043cad814b';
const STEEL_SIZE_BUDGET_BYTES = 80 * 1024 * 1024;

// Pinned-checkout cache: keyed by commit SHA (content is immutable), with a
// TTL so a corrupt/stale cache eventually self-heals. node_modules/.cache is
// the conventional spot (webpack/babel/eslint) and is already gitignored.
const STEEL_CACHE_TTL_DEFAULT_MS = 7 * 24 * 60 * 60 * 1000;
const steelCacheRoot = join(rootDir, 'node_modules', '.cache', 'comate-steel');

const STUBBED_PACKAGES = [
  'classic-level',
  'duckdb-async',
  'pdf2html',
  '@scalar/fastify-api-reference',
];
// Optional-chain packages whose declaring parents guard the require and fall
// back: tar-fs/streamx use the bare-* native helpers only when present.
const EXCLUDED_PACKAGES = [
  'bare-events',
  'bare-fs',
  'bare-path',
  'bare-os',
  'bare-stream',
  'bare-buffer',
];
const REMOVED_PACKAGES = ['duckdb'];

const destDir = join(rootDir, 'src-tauri', 'resources', 'steel');

// fs.cpSync's default resolves symlink targets against the SOURCE tree and
// writes absolute links at the destination. For npm trees that rewrites
// relative `.bin` links (e.g. archiver-utils/node_modules/.bin/glob) into
// absolute paths inside the temp build dir — dangling once it is deleted,
// which then fails `tauri build` ("resource path ... doesn't exist").
// verbatimSymlinks keeps the original relative links valid after the move.
const COPY_TREE_OPTS = { recursive: true, verbatimSymlinks: true } as const;

function run(cmd: string, opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: opts?.cwd ?? rootDir, env: opts?.env });
}

// ---------------------------------------------------------------------------
// Pure-JS stubs for Steel's opt-in native dependencies
// ---------------------------------------------------------------------------

const STUB_HEADER =
  '// Pure-JS stub injected by build-steel-bundle.ts — the real package is\n' +
  '// native (or drags in native/postinstall downloads) and is excluded from\n' +
  "// Comate's vendored Steel distribution. Loads cleanly; throws on use.\n";

function stubError(feature: string): string {
  return (
    `${feature} is unavailable in Comate's pure-JS vendored Steel ` +
    'distribution'
  );
}

const STUBS: Record<string, string> = {
  'classic-level':
    `${STUB_HEADER}` +
    `class ClassicLevel {\n` +
    `  constructor() { throw new Error(${JSON.stringify(stubError('classic-level (LevelDB session extraction)'))}); }\n` +
    `}\n` +
    `module.exports = { ClassicLevel };\n`,
  'duckdb-async':
    `${STUB_HEADER}` +
    `class Database {\n` +
    `  static async create() { throw new Error(${JSON.stringify(stubError('duckdb (log storage)'))}); }\n` +
    `}\n` +
    `module.exports = { Database };\n`,
  pdf2html:
    `${STUB_HEADER}` +
    `const unavailable = () =>\n` +
    `  Promise.reject(new Error(${JSON.stringify(stubError('pdf2html (PDF scrape)'))}));\n` +
    `module.exports = { html: unavailable, meta: unavailable, pages: unavailable };\n`,
  // Steel registers this plugin at boot (`fastify.register(...)`), so unlike
  // the throw-on-use stubs above it must register cleanly and simply not serve
  // the /documentation UI.
  '@scalar/fastify-api-reference':
    `${STUB_HEADER}` +
    `// No-op fastify plugin: the /documentation UI is excluded from Comate's\n` +
    `// vendored Steel distribution (size budget).\n` +
    `module.exports = async function scalarApiReferenceStub() {};\n`,
};

function writeStubPackage(nodeModulesDir: string, name: string, indexJs: string): void {
  const pkgDir = join(nodeModulesDir, name);
  rmSync(pkgDir, { recursive: true, force: true });
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify(
      {
        name,
        version: '0.0.0-stub',
        description:
          'Pure-JS stub injected by build-steel-bundle.ts (native package excluded ' +
          'from the vendored Steel distribution). Loads cleanly; throws on use.',
        main: 'index.js',
      },
      null,
      2,
    ),
  );
  writeFileSync(join(pkgDir, 'index.js'), indexJs);
}

// ---------------------------------------------------------------------------
// Build phases
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pinned-checkout cache
// ---------------------------------------------------------------------------

function steelCachePaths(): { dir: string; meta: string } {
  return {
    dir: join(steelCacheRoot, `steel-browser-${STEEL_COMMIT}`),
    meta: join(steelCacheRoot, `steel-browser-${STEEL_COMMIT}.json`),
  };
}

function steelCacheTtlMs(): number {
  const raw = process.env.STEEL_CACHE_TTL_MS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return STEEL_CACHE_TTL_DEFAULT_MS;
}

function steelCacheDisabled(): boolean {
  return process.env.STEEL_NO_CACHE === '1';
}

/**
 * Return the cached checkout dir when it is fresh enough and intact, else
 * null. Intact means: meta matches the pinned commit within the TTL and the
 * checkout's HEAD still resolves to the pinned SHA.
 */
function readSteelCache(): string | null {
  if (steelCacheDisabled()) return null;
  const { dir, meta } = steelCachePaths();
  try {
    const parsed = JSON.parse(readFileSync(meta, 'utf-8')) as {
      commit?: string;
      fetchedAt?: number;
    };
    if (parsed.commit !== STEEL_COMMIT || typeof parsed.fetchedAt !== 'number') {
      return null;
    }
    const ttl = steelCacheTtlMs();
    const ageMs = Date.now() - parsed.fetchedAt;
    if (ageMs > ttl) {
      console.log(
        `steel cache expired (age ${(ageMs / 3_600_000).toFixed(1)}h ` +
          `> ttl ${(ttl / 3_600_000).toFixed(1)}h); re-fetching`,
      );
      return null;
    }
    if (!existsSync(join(dir, '.git'))) return null;
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir })
      .toString()
      .trim();
    if (head !== STEEL_COMMIT) return null;
    return dir;
  } catch {
    return null;
  }
}

/** Best-effort cache write; never fails the build. */
function writeSteelCache(checkout: string): void {
  if (steelCacheDisabled()) return;
  const { dir, meta } = steelCachePaths();
  try {
    mkdirSync(steelCacheRoot, { recursive: true });
    // Stage beside the target then rename: same-filesystem rename is atomic,
    // so an interrupted build never leaves a half-copied cache behind.
    const tmp = `${dir}.tmp-${process.pid}`;
    rmSync(tmp, { recursive: true, force: true });
    cpSync(checkout, tmp, { recursive: true });
    rmSync(dir, { recursive: true, force: true });
    renameSync(tmp, dir);
    writeFileSync(
      meta,
      JSON.stringify({ commit: STEEL_COMMIT, fetchedAt: Date.now() }, null, 2),
    );
    console.log(`cached steel checkout at ${dir}`);
  } catch (err) {
    console.warn(`warning: failed to write steel cache: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Clone (with protocol fallback)
// ---------------------------------------------------------------------------

function cloneFromRemote(remote: string, checkout: string): void {
  rmSync(checkout, { recursive: true, force: true });
  mkdirSync(checkout, { recursive: true });
  // Fetch the pinned commit directly (GitHub allows fetching reachable SHAs).
  // GIT_TERMINAL_PROMPT=0 + ssh BatchMode: fail fast instead of hanging on a
  // credential/host-key prompt when a transport is unusable.
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
  };
  run('git init -q', { cwd: checkout });
  run(`git remote add origin ${remote}`, { cwd: checkout });
  run(`git fetch -q --depth 1 origin ${STEEL_COMMIT}`, { cwd: checkout, env });
  run('git checkout -q FETCH_HEAD', { cwd: checkout });
  const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout })
    .toString()
    .trim();
  if (actual !== STEEL_COMMIT) {
    throw new Error(
      `build-steel-bundle: pinned checkout drifted: ${actual} !== ${STEEL_COMMIT}`,
    );
  }
}

function clonePinnedSteel(workDir: string): string {
  const checkout = join(workDir, 'steel-browser');

  const cached = readSteelCache();
  if (cached) {
    console.log(`using cached steel checkout ${STEEL_COMMIT} (${cached})`);
    // Build on a copy so the cached tree stays pristine.
    cpSync(cached, checkout, { recursive: true });
    return checkout;
  }

  let lastError: unknown;
  for (const remote of STEEL_REMOTES) {
    try {
      cloneFromRemote(remote, checkout);
      writeSteelCache(checkout);
      return checkout;
    } catch (err) {
      lastError = err;
      console.warn(
        `clone from ${remote} failed: ${String(err)}\n` +
          'trying next remote (if any)',
      );
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`build-steel-bundle: all remotes failed: ${String(lastError)}`);
}

/**
 * Comate patch for Steel's Chrome arg construction.
 *
 * Steel hardcodes --remote-debugging-port=9222 in dynamicArgs. Comate passes
 * FILTER_CHROME_ARGS='--remote-debugging-port=9222' and
 * CHROME_ARGS='--remote-debugging-port=0' to let Chrome pick a free port.
 * Upstream Steel builds the arg list with `uniq([...dynamicArgs, ...env.CHROME_ARGS])`
 * and then filters; `uniq()` keeps the first occurrence (9222) and drops the
 * replacement (0), then the filter deletes 9222, leaving Chrome with NO remote
 * debugging port. External CDP clients (browser-mcp, the viewer proxy) cannot
 * connect, so /v1/sessions/default/live-details returns 500 and the pane stays
 * black.
 *
 * This patch filters FILTER_CHROME_ARGS out BEFORE uniq(), so env.CHROME_ARGS
 * replacements survive.
 */
function patchCdpServiceArgs(apiDir: string): void {
  const cdpServicePath = join(apiDir, 'build', 'services', 'cdp', 'cdp.service.js');
  if (!existsSync(cdpServicePath)) {
    console.warn(`warning: ${cdpServicePath} not found; skipping CDP args patch`);
    return;
  }
  const original = readFileSync(cdpServicePath, 'utf-8');
  const needle =
    "                const uniq = (xs) => Array.from(new Set(xs.filter(Boolean)));\n" +
    "                const launchArgs = uniq([\n" +
    "                    ...staticDefaultArgs,\n" +
    "                    ...(isHeadless ? headlessArgs : headfulArgs),\n" +
    "                    ...dynamicArgs,\n" +
    "                    ...extensionArgs,\n" +
    "                    ...(options.args || []),\n" +
    "                    ...(env.CHROME_ARGS || []),\n" +
    "                ]).filter((arg) => !env.FILTER_CHROME_ARGS.includes(arg));";
  if (!original.includes(needle)) {
    console.warn(
      `warning: CDP args patch needle not found in ${cdpServicePath}; ` +
        "Steel's launch-arg code may have drifted",
    );
    return;
  }
  const replacement =
    "                const uniq = (xs) => Array.from(new Set(xs.filter(Boolean)));\n" +
    "                // Comate patch: FILTER_CHROME_ARGS must drop Steel's hardcoded\n" +
    "                // defaults (e.g. --remote-debugging-port=9222) BEFORE uniq() so\n" +
    "                // that env.CHROME_ARGS can supply a replacement\n" +
    "                // (--remote-debugging-port=0). The previous order ran uniq()\n" +
    "                // first, which kept the hardcoded 9222 and then deleted it,\n" +
    "                // leaving Chrome with no remote debugging port at all and\n" +
    "                // breaking external CDP clients.\n" +
    "                const filterChromeArg = (arg) => !(env.FILTER_CHROME_ARGS || []).includes(arg);\n" +
    "                const launchArgs = uniq([\n" +
    "                    ...staticDefaultArgs,\n" +
    "                    ...(isHeadless ? headlessArgs : headfulArgs),\n" +
    "                    ...dynamicArgs.filter(filterChromeArg),\n" +
    "                    ...extensionArgs.filter(filterChromeArg),\n" +
    "                    ...(options.args || []).filter(filterChromeArg),\n" +
    "                    ...(env.CHROME_ARGS || []),\n" +
    "                ]);";
  writeFileSync(cdpServicePath, original.replace(needle, replacement));
  console.log(`patched ${cdpServicePath}: FILTER_CHROME_ARGS now applied before uniq()`);
}

function buildSteelApi(checkout: string): void {
  // Install the api workspace incl. devDependencies (typescript for tsc),
  // honoring the upstream lockfile. Scripts disabled: they download jars and
  // binaries we never ship (supply chain).
  run('npm ci --ignore-scripts --no-audit --no-fund -w api --include-workspace-root=false', {
    cwd: checkout,
  });
  const apiDir = join(checkout, 'api');
  console.log('> tsc (steel api)');
  execFileSync(join(checkout, 'node_modules', '.bin', 'tsc'), [], {
    stdio: 'inherit',
    cwd: apiDir,
    // npm's .bin shims are extensionless symlinks on POSIX but .cmd/.ps1
    // batch shims on Windows. Spawning the extensionless path directly throws
    // ENOENT on Windows, and spawning the .cmd directly throws EINVAL on
    // modern Node (CVE-2024-27980), so route through the shell there: cmd.exe
    // resolves `tsc` via PATHEXT to `tsc.cmd`. args is empty, so there is no
    // shell-quoting surface.
    shell: process.platform === 'win32',
  });
  patchCdpServiceArgs(apiDir);
  // Mirror the api package's copy:templates / copy:fingerprint scripts with
  // platform-independent fs calls.
  mkdirSync(join(apiDir, 'build', 'templates'), { recursive: true });
  mkdirSync(join(apiDir, 'build', 'scripts'), { recursive: true });
  cpSync(join(apiDir, 'src', 'templates'), join(apiDir, 'build', 'templates'), {
    recursive: true,
  });
  cpSync(
    join(apiDir, 'src', 'scripts', 'fingerprint.js'),
    join(apiDir, 'build', 'scripts', 'fingerprint.js'),
  );
}

function stageVendoredTree(checkout: string, workDir: string): string {
  const staging = join(workDir, 'vendored-steel');
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  // Steel API build product + its package.json ("type": "module" matters).
  cpSync(join(checkout, 'api', 'build'), join(staging, 'build'), { recursive: true });
  cpSync(join(checkout, 'api', 'package.json'), join(staging, 'package.json'));

  // Production dependency closure straight from the pinned lockfile.
  const lockfile = JSON.parse(
    readFileSync(join(checkout, 'package-lock.json'), 'utf-8'),
  ) as NpmLockfile;
  const closure = computeProdClosure({
    lockfile,
    workspacePath: 'api',
    stubbedPackages: STUBBED_PACKAGES,
    excludedPackages: EXCLUDED_PACKAGES,
    removedPackages: REMOVED_PACKAGES,
  });
  console.log(
    `prod closure: ${closure.paths.length} packages ` +
      `(+${closure.excludedOptional.length} platform-optional excluded, ` +
      `${closure.excluded.length} optional-chain excluded, ` +
      `${closure.stubbed.length} stubbed: ${closure.stubbed.join(', ') || 'none'})`,
  );
  if (closure.stubbed.length !== STUBBED_PACKAGES.length) {
    console.warn(
      `warning: expected ${STUBBED_PACKAGES.length} stubbed packages in the closure, ` +
        `found ${closure.stubbed.length} — Steel's dependency set may have drifted`,
    );
  }

  for (const lockPath of closure.paths) {
    // Every closure path is rooted at node_modules/; api-local nesting maps
    // under build/ so vendored resolution matches checkout semantics.
    const rel = lockPath.startsWith('api/node_modules/')
      ? join('build', lockPath.slice('api/'.length))
      : lockPath;
    cpSync(join(checkout, lockPath), join(staging, rel), COPY_TREE_OPTS);
  }

  for (const [name, content] of Object.entries(STUBS)) {
    writeStubPackage(join(staging, 'node_modules'), name, content);
  }
  // chokidar guards require('fsevents') and falls back to fs.watch.
  rmSync(join(staging, 'node_modules', 'fsevents'), { recursive: true, force: true });

  return staging;
}

/** Type declarations and sourcemaps are dead weight in a runtime artifact. */
function stripTypeDeclarationsAndMaps(staging: string): void {
  let removed = 0;
  for (const file of [...walkFiles(staging)]) {
    if (file.endsWith('.d.ts') || file.endsWith('.d.ts.map') || file.endsWith('.js.map')) {
      rmSync(file, { force: true });
      removed += 1;
    }
  }
  console.log(`stripped ${removed} type-declaration/sourcemap files`);
}

function writeManifest(staging: string, bytes: number): void {
  const apiPkg = JSON.parse(readFileSync(join(staging, 'package.json'), 'utf-8')) as {
    version?: string;
  };
  writeFileSync(
    join(staging, 'steel-manifest.json'),
    JSON.stringify(
      {
        name: 'steel-browser-vendored',
        upstreamRepo: STEEL_REPO,
        upstreamCommit: STEEL_COMMIT,
        upstreamVersion: apiPkg.version ?? null,
        generatedAt: new Date().toISOString(),
        bytes,
        nativeAudit: 'clean',
        stubbed: Object.keys(STUBS),
      },
      null,
      2,
    ),
  );
}

async function build(): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), 'comate-steel-build-'));
  console.log(`Working directory: ${workDir}`);
  try {
    const checkout = clonePinnedSteel(workDir);
    buildSteelApi(checkout);
    const staging = stageVendoredTree(checkout, workDir);
    stripTypeDeclarationsAndMaps(staging);

    console.log('\n--- Native artifact audit ---');
    assertNoNativeArtifacts(staging);
    console.log('clean (pure JS)');

    console.log('\n--- Size budget ---');
    const bytes = assertSizeBudget(staging, STEEL_SIZE_BUDGET_BYTES);
    console.log(
      `vendored size: ${(bytes / (1024 * 1024)).toFixed(1)} MiB ` +
        `(budget ${(STEEL_SIZE_BUDGET_BYTES / (1024 * 1024)).toFixed(0)} MiB)`,
    );

    console.log('\n--- Symlink audit ---');
    assertNoDanglingSymlinks(staging);
    console.log('clean (no dangling symlinks)');

    writeManifest(staging, bytes);

    console.log('\n--- Installing into src-tauri/resources/steel ---');
    const swapDir = `${destDir}.next`;
    rmSync(swapDir, { recursive: true, force: true });
    cpSync(staging, swapDir, COPY_TREE_OPTS);
    rmSync(destDir, { recursive: true, force: true });
    cpSync(swapDir, destDir, COPY_TREE_OPTS);
    rmSync(swapDir, { recursive: true, force: true });
    console.log(`Vendored Steel ${STEEL_COMMIT} -> ${destDir}`);

    if (!existsSync(join(destDir, 'build', 'index.js'))) {
      throw new Error('vendored tree is missing build/index.js after install');
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export async function buildSteelBundle(): Promise<void> {
  await build();
}

// Run standalone (tsx scripts/build-steel-bundle.ts). When imported by
// build-sidecar.ts, the caller invokes buildSteelBundle() instead.
const invokedAsScript = (() => {
  try {
    return Boolean(process.argv[1]) && __filename === join(process.argv[1]!);
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  build().catch((err) => {
    console.error('Steel bundle build failed:', err);
    process.exit(1);
  });
}
