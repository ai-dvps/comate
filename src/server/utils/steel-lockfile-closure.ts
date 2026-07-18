/**
 * Compute the production dependency closure of the Steel api workspace from
 * the upstream package-lock.json (lockfileVersion 3). Used by
 * scripts/build-steel-bundle.ts to vendor exactly the prod tree — `npm ci
 * --omit=dev -w api` is unreliable across npm versions (it installs
 * extraneous dev/platform packages), so the closure is derived directly from
 * the lockfile, which is the pinned source of truth (KTD-2).
 *
 * Pure function over parsed JSON — unit-tested with a fixture lockfile in
 * steel-lockfile-closure.test.ts.
 */

export interface LockfilePackage {
  version?: string;
  dev?: boolean;
  optional?: boolean;
  os?: string[];
  cpu?: string[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

export interface NpmLockfile {
  lockfileVersion: number;
  packages: Record<string, LockfilePackage | undefined>;
}

export interface ProdClosureOptions {
  lockfile: NpmLockfile;
  /** Lockfile path of the workspace package to seed from (e.g. 'api'). */
  workspacePath: string;
  /**
   * Packages replaced by pure-JS stubs in the vendored tree: traversal treats
   * them as terminal (their own deps are never copied) and the build writes
   * stub content instead of the real package.
   */
  stubbedPackages?: string[];
  /**
   * Optional-chain packages deliberately dropped from the vendored tree
   * (their declaring parents guard the require and fall back — e.g. tar-fs's
   * bare-* natives). Reaching one through a HARD dependency edge means the
   * guard assumption broke; the build fails loudly.
   */
  excludedPackages?: string[];
  /**
   * Packages that must never ship. Encountering one during traversal means a
   * non-stubbed package hard-depends on it — the build fails loudly.
   */
  removedPackages?: string[];
}

export interface ProdClosureResult {
  /** Lockfile package paths to copy, all rooted at 'node_modules/'. */
  paths: string[];
  /**
   * Optional packages excluded because they carry os/cpu platform constraints
   * (per-platform native binaries; consumers guard them per npm contract).
   * Unconstrained optional packages ARE included — they are regular pure-JS
   * runtime deps that happen to be marked optional (e.g. turndown), and
   * upstream code may import them directly.
   */
  excludedOptional: string[];
  /** Optional-chain packages deliberately excluded (see excludedPackages). */
  excluded: string[];
  /** Stubbed packages encountered as terminal leaves. */
  stubbed: string[];
}

function nonOptionalPeers(pkg: LockfilePackage): string[] {
  const peers = Object.keys(pkg.peerDependencies ?? {});
  const meta = pkg.peerDependenciesMeta ?? {};
  return peers.filter((name) => meta[name]?.optional !== true);
}

function depNames(pkg: LockfilePackage): string[] {
  return [
    ...Object.keys(pkg.dependencies ?? {}),
    // optionalDependencies are installed by npm when possible and upstream
    // code may import them directly (Steel imports turndown via defuddle),
    // so they are part of the runtime closure.
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...nonOptionalPeers(pkg),
  ];
}

/**
 * Resolve `name` from package path `fromPath` the way Node resolves from that
 * directory: nearest node_modules wins, walking up to the root node_modules.
 */
function resolveDep(
  packages: NpmLockfile['packages'],
  fromPath: string,
  name: string,
): string | undefined {
  let dir = fromPath;
  for (;;) {
    const candidate = dir ? `${dir}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[candidate]) {
      return candidate;
    }
    if (!dir) {
      return undefined;
    }
    const idx = dir.lastIndexOf('/');
    dir = idx === -1 ? '' : dir.slice(0, idx);
    // Never walk into a node_modules ancestor segment-wise: a path like
    // node_modules/a/node_modules/b climbs to node_modules/a then root.
    if (dir.endsWith('node_modules')) {
      const up = dir.lastIndexOf('/');
      dir = up === -1 ? '' : dir.slice(0, up);
    }
  }
}

export function computeProdClosure(options: ProdClosureOptions): ProdClosureResult {
  const { lockfile, workspacePath } = options;
  const stubbed = new Set(options.stubbedPackages ?? []);
  const excluded = new Set(options.excludedPackages ?? []);
  const removed = new Set(options.removedPackages ?? []);

  const seed = lockfile.packages[workspacePath];
  if (!seed) {
    throw new Error(`workspace '${workspacePath}' not found in lockfile packages`);
  }

  const paths: string[] = [];
  const excludedOptional = new Set<string>();
  const excludedHits = new Set<string>();
  const stubbedHits = new Set<string>();
  const visited = new Set<string>();
  const queue: Array<{ path: string; name: string; viaOptional: boolean }> = [];

  const enqueueDeps = (fromPath: string, pkg: LockfilePackage) => {
    const hard = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...nonOptionalPeers(pkg),
    ]);
    const optional = new Set(Object.keys(pkg.optionalDependencies ?? {}));
    for (const name of depNames(pkg)) {
      const resolved = resolveDep(lockfile.packages, fromPath, name);
      if (!resolved) {
        // Optional peers / optionalDependencies may legitimately be absent
        // from the installed tree.
        if (hard.has(name)) {
          throw new Error(
            `dependency '${name}' of '${fromPath}' not found in lockfile — ` +
              'lockfile and package.json are out of sync',
          );
        }
        continue;
      }
      queue.push({ path: resolved, name, viaOptional: optional.has(name) && !hard.has(name) });
    }
  };

  enqueueDeps(workspacePath, seed);

  while (queue.length > 0) {
    const { path, name, viaOptional } = queue.shift()!;

    if (excluded.has(name)) {
      // Deliberate optional-chain exclusion: legal only through optional
      // edges. A hard edge means the guard assumption broke. Deliberately not
      // marked visited so a later hard edge still trips the failure.
      if (!viaOptional) {
        throw new Error(
          `excluded package '${name}' is reachable through a hard dependency ` +
            `edge ('${path}') — its consumers cannot guard the missing require`,
        );
      }
      excludedHits.add(path);
      continue;
    }

    if (visited.has(path)) {
      continue;
    }
    visited.add(path);

    const pkg = lockfile.packages[path];
    if (!pkg) {
      throw new Error(`lockfile entry missing for resolved path '${path}'`);
    }

    if (removed.has(name)) {
      throw new Error(
        `removed package '${name}' is still reachable from '${path}' — ` +
          'a non-stubbed dependency hard-requires it; extend the stub set or patch policy',
      );
    }
    if (pkg.dev === true) {
      // Dev-only subtree: never ship, never traverse.
      continue;
    }
    if (pkg.optional === true && ((pkg.os?.length ?? 0) > 0 || (pkg.cpu?.length ?? 0) > 0)) {
      // Platform-constrained optional (per-OS/arch native binary such as
      // fsevents or @img/sharp-*): excluded — the vendored tree ships pure JS
      // for every target and consumers guard these requires per npm contract.
      excludedOptional.add(path);
      continue;
    }
    if (stubbed.has(name)) {
      stubbedHits.add(path);
      continue;
    }

    paths.push(path);
    enqueueDeps(path, pkg);
  }

  return {
    paths: paths.sort(),
    excludedOptional: [...excludedOptional].sort(),
    excluded: [...excludedHits].sort(),
    stubbed: [...stubbedHits].sort(),
  };
}
