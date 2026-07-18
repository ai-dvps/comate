import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { sidecarLog } from './sidecar-logger.js';
import { normalizeWindowsPath } from './normalize-windows-path.js';
import { getStorageDir } from '../storage/data-dir.js';

/**
 * Resolution ladder for the vendored Steel bundle (re-exec-self distribution).
 *
 * The bundle is produced by scripts/build-steel-bundle.ts and laid out as:
 *   <steelDir>/build/index.js   (Steel API entrypoint, ESM)
 *   <steelDir>/node_modules/    (production deps, pure JS — native modules stubbed)
 *   <steelDir>/package.json
 *
 * Ladder (mirrors resolve-sdk-binary.ts):
 *   1. TAURI_RESOURCE_DIR/steel (production app bundle)
 *   2. <COMATE_DATA_DIR>/steel (data-dir override / future self-update)
 *   3. Dev source tree: <repo>/src-tauri/resources/steel
 *
 * Every step is explicit: when nothing resolves, callers surface an actionable
 * error (R17) instead of silently degrading.
 */

export type SteelSource = 'resource' | 'data' | 'dev';

export interface SteelResolution {
  /** Directory containing the vendored steel bundle. */
  steelDir: string;
  /** Absolute path to the Steel API entrypoint (`build/index.js`). */
  entryPath: string;
  source: SteelSource;
}

export interface SteelResolveDeps {
  env: NodeJS.ProcessEnv;
  fileExists: (p: string) => boolean;
  /** Candidate steel directories for the dev-tree fallback. */
  devCandidates: string[];
  /** Data directory (defaults to getStorageDir()). */
  storageDir?: string;
}

const STEEL_ENTRY_REL = path.join('build', 'index.js');

function defaultDevCandidates(): string[] {
  const candidates: string[] = [];
  // Source tree (tsx dev) or compiled dist tree: this file lives at
  // src/server/utils or dist/server/utils — both are two levels below the root
  // that holds src-tauri/.
  try {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(
      path.join(moduleDir, '..', '..', '..', 'src-tauri', 'resources', 'steel'),
    );
  } catch {
    // import.meta.url unavailable (some bundlers); skip module-relative probing.
  }
  // pkg-bundled sidecar in `tauri dev`: executable lives in src-tauri/binaries.
  const execDir = path.dirname(process.execPath);
  candidates.push(
    path.join(execDir, '..', 'resources', 'steel'),
    path.join(execDir, 'resources', 'steel'),
  );
  return candidates;
}

function probe(
  deps: SteelResolveDeps,
  source: SteelSource,
  steelDir: string,
): SteelResolution | undefined {
  const normalizedDir = normalizeWindowsPath(steelDir);
  const entryPath = path.join(normalizedDir, STEEL_ENTRY_REL);
  const found = deps.fileExists(entryPath);
  sidecarLog(`[resolveSteel] ${source}: ${normalizedDir}, entry exists=${found}`);
  if (!found) {
    return undefined;
  }
  return { steelDir: normalizedDir, entryPath, source };
}

export function resolveSteelBundle(
  overrides?: Partial<SteelResolveDeps>,
): SteelResolution | undefined {
  const deps: SteelResolveDeps = {
    env: process.env,
    fileExists: existsSync,
    devCandidates: defaultDevCandidates(),
    storageDir: undefined,
    ...overrides,
  };

  // Strategy 1: Tauri resource directory (production builds)
  const resourceDir = deps.env.TAURI_RESOURCE_DIR;
  if (resourceDir) {
    for (const base of [resourceDir, path.join(resourceDir, 'resources')]) {
      const hit = probe(deps, 'resource', path.join(base, 'steel'));
      if (hit) return hit;
    }
  }

  // Strategy 2: data directory (COMATE_DATA_DIR)
  const storageDir = deps.storageDir ?? getStorageDir();
  {
    const hit = probe(deps, 'data', path.join(storageDir, 'steel'));
    if (hit) return hit;
  }

  // Strategy 3: dev source tree
  for (const candidate of deps.devCandidates) {
    const hit = probe(deps, 'dev', candidate);
    if (hit) return hit;
  }

  sidecarLog('[resolveSteel] No strategy succeeded, returning undefined');
  return undefined;
}
