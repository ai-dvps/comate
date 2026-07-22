import path from 'path';
import { homedir } from 'os';
import { existsSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { getStorageDir } from '../storage/data-dir.js';
import { sidecarLog } from './sidecar-logger.js';
import { normalizeWindowsPath } from './normalize-windows-path.js';
import { findInPath } from './find-in-path.js';
import {
  CHROME_FOR_TESTING_VERSION,
  CFT_PLATFORMS,
  bundledCftZipRel,
  cftInstallDir,
  downloadAndVerifyCftZip,
  publishCftFromZip,
  type CftPlatformSpec,
} from './cft-spec.js';

export { CHROME_FOR_TESTING_VERSION, ChromiumChecksumMismatchError } from './cft-spec.js';

/**
 * Chromium resolution ladder:
 *   1. Configured path (COMATE_CHROMIUM_PATH) — explicit override.
 *   2. Opt-in system Chrome / Edge (COMATE_USE_SYSTEM_CHROME=1) — off by
 *      default: driving the user's installed Chrome destabilizes their browser
 *      (macOS app-identity coupling, window/activation churn).
 *   3. Bundled Chrome for Testing (the default): a pinned, SHA-256-verified CfT
 *      zip shipped in the app resources, extracted to the data dir on first
 *      spawn. Isolated app identity (`com.google.chrome.for.testing`) so it
 *      never touches the user's daily Chrome; works fully offline.
 *   4. Lazy download of the same pinned CfT build (online fallback).
 *
 * When every rung misses, callers get `undefined` and must surface an explicit,
 * actionable error (R17/AE5).
 */

export type ChromiumSource = 'system' | 'config' | 'bundled' | 'download';

export interface ChromiumResolution {
  executablePath: string;
  source: ChromiumSource;
  /** Present for Chrome for Testing builds (bundled or downloaded). */
  version?: string;
}

export interface ChromiumDeps {
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  fileExists: (p: string) => boolean;
  findInPath: (command: string) => string | undefined;
  /** Root under which CfT builds are installed (<storageDir>/chromium). */
  storageDir: string;
  /** Resolves the bundled CfT zip path for the current platform, if present. */
  bundledCftZip?: () => string | undefined;
  /** Extracts+publishes the bundled CfT zip, returning the executable path. */
  extractBundledCft?: (
    zipPath: string,
    storageDir: string,
    spec: CftPlatformSpec,
    version: string,
  ) => Promise<string>;
  /** Downloads+verifies+publishes the pinned CfT, returning the executable path. */
  download: (storageDir: string, spec: CftPlatformSpec, version: string) => Promise<string>;
}

function systemCandidates(deps: ChromiumDeps): string[] {
  const { platform, env, homeDir } = deps;
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(homeDir, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      path.join(homeDir, 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(
      (r): r is string => Boolean(r),
    );
    const rels = [
      path.join('Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join('Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join('Chromium', 'Application', 'chrome.exe'),
    ];
    const candidates: string[] = [];
    for (const root of roots) {
      for (const rel of rels) {
        candidates.push(path.join(root, rel));
      }
    }
    return candidates;
  }
  // linux and others: PATH lookup only
  return [];
}

const LINUX_PATH_COMMANDS = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
];

function resolveSystemChromium(deps: ChromiumDeps): string | undefined {
  for (const candidate of systemCandidates(deps)) {
    const normalized = normalizeWindowsPath(candidate);
    if (deps.fileExists(normalized)) {
      sidecarLog(`[resolveChromium] system candidate hit: ${normalized}`);
      return normalized;
    }
  }
  if (deps.platform === 'linux') {
    for (const command of LINUX_PATH_COMMANDS) {
      const found = deps.findInPath(command);
      if (found) {
        sidecarLog(`[resolveChromium] PATH hit: ${found}`);
        return normalizeWindowsPath(found);
      }
    }
  }
  return undefined;
}

function isSystemChromeOptIn(env: NodeJS.ProcessEnv): boolean {
  const v = env.COMATE_USE_SYSTEM_CHROME;
  return v === '1' || v === 'true';
}

export interface CftDownloadOptions {
  /** Override the official endpoint (tests point this at a local server). */
  baseUrl?: string;
}

/**
 * Download the pinned Chrome for Testing build, verify its SHA-256, extract to
 * a staging directory, and atomically rename into place. Short-circuits when
 * the install already exists (no network). Any failure removes temp artifacts
 * and rethrows — the final install dir never holds half state.
 */
export async function downloadChromeForTesting(
  storageDir: string,
  spec: CftPlatformSpec,
  version: string,
  options?: CftDownloadOptions,
): Promise<string> {
  const finalExe = path.join(cftInstallDir(storageDir, spec, version), spec.executableRelPath);
  if (existsSync(finalExe)) {
    return finalExe;
  }
  const zipPath = await downloadAndVerifyCftZip(spec, version, {
    baseUrl: options?.baseUrl,
    onLog: sidecarLog,
  });
  try {
    return await publishCftFromZip(zipPath, storageDir, spec, version, sidecarLog);
  } finally {
    rmSync(zipPath, { force: true });
  }
}

/**
 * Candidate locations of the bundled CfT zip, mirroring resolve-steel.ts:
 * TAURI_RESOURCE_DIR (prod, nested under `resources/`) and the dev source tree.
 */
function defaultBundledCftZipCandidates(): string[] {
  const platformKey = `${process.platform}-${process.arch}`;
  const rel = bundledCftZipRel(platformKey);
  if (!rel) return [];
  const candidates: string[] = [];
  const resourceDir = process.env.TAURI_RESOURCE_DIR;
  if (resourceDir) {
    candidates.push(path.join(resourceDir, 'resources', rel));
    candidates.push(path.join(resourceDir, rel));
  }
  try {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(
      path.join(moduleDir, '..', '..', '..', 'src-tauri', 'resources', rel),
    );
  } catch {
    // import.meta.url unavailable (some bundlers); skip module-relative probing.
  }
  const execDir = path.dirname(process.execPath);
  candidates.push(
    path.join(execDir, '..', 'resources', rel),
    path.join(execDir, 'resources', rel),
  );
  return candidates;
}

function findBundledCftZip(): string | undefined {
  for (const candidate of defaultBundledCftZipCandidates()) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function defaultDeps(): ChromiumDeps {
  return {
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    homeDir: homedir(),
    fileExists: existsSync,
    findInPath,
    storageDir: getStorageDir(),
    bundledCftZip: findBundledCftZip,
    extractBundledCft: (zipPath, storageDir, spec, version) =>
      publishCftFromZip(zipPath, storageDir, spec, version, sidecarLog),
    download: downloadChromeForTesting,
  };
}

/**
 * Resolve a Chromium executable. `allowDownload` controls the materialization
 * rungs — health checks pass false so a probe never pays the extract/download
 * cost; first browser use passes true (F5).
 */
export async function resolveChromium(options?: {
  allowDownload?: boolean;
  deps?: Partial<ChromiumDeps>;
}): Promise<ChromiumResolution | undefined> {
  const deps: ChromiumDeps = { ...defaultDeps(), ...options?.deps };
  const allowDownload = options?.allowDownload ?? false;

  // Rung 1: configured path (explicit override).
  const configured = deps.env.COMATE_CHROMIUM_PATH;
  if (configured) {
    const normalized = normalizeWindowsPath(configured);
    if (deps.fileExists(normalized)) {
      sidecarLog(`[resolveChromium] config path hit: ${normalized}`);
      return { executablePath: normalized, source: 'config' };
    }
    sidecarLog(`[resolveChromium] COMATE_CHROMIUM_PATH set but missing: ${normalized}`);
  }

  // Rung 2: opt-in system Chrome / Edge.
  if (isSystemChromeOptIn(deps.env)) {
    const system = resolveSystemChromium(deps);
    if (system) {
      return { executablePath: system, source: 'system' };
    }
    sidecarLog('[resolveChromium] COMATE_USE_SYSTEM_CHROME set but no system browser found');
  }

  // Rung 3 & 4: pinned Chrome for Testing — bundled (default) then lazy download.
  const platformKey = `${deps.platform}-${deps.arch}`;
  const spec = CFT_PLATFORMS[platformKey];
  if (!spec) {
    sidecarLog(`[resolveChromium] no pinned CfT build for ${platformKey}`);
    return undefined;
  }
  const extractedExe = path.join(
    cftInstallDir(deps.storageDir, spec, CHROME_FOR_TESTING_VERSION),
    spec.executableRelPath,
  );

  // Reuse an already-materialized CfT (bundled-extracted or downloaded).
  if (deps.fileExists(extractedExe)) {
    const bundledZip = deps.bundledCftZip?.();
    const bundledPresent = Boolean(bundledZip) && (!bundledZip || deps.fileExists(bundledZip));
    sidecarLog(`[resolveChromium] reused CfT at ${extractedExe}`);
    return {
      executablePath: normalizeWindowsPath(extractedExe),
      source: bundledPresent ? 'bundled' : 'download',
      version: CHROME_FOR_TESTING_VERSION,
    };
  }

  // Not yet extracted: prefer the bundled zip (offline); extract on first spawn.
  const bundledZip = deps.bundledCftZip?.();
  if (bundledZip && deps.fileExists(bundledZip)) {
    if (!allowDownload) {
      sidecarLog('[resolveChromium] bundled CfT zip present but allowDownload=false; deferring extraction');
      return undefined;
    }
    sidecarLog(`[resolveChromium] extracting bundled CfT from ${bundledZip}`);
    const exe = deps.extractBundledCft
      ? await deps.extractBundledCft(bundledZip, deps.storageDir, spec, CHROME_FOR_TESTING_VERSION)
      : await publishCftFromZip(bundledZip, deps.storageDir, spec, CHROME_FOR_TESTING_VERSION, sidecarLog);
    return {
      executablePath: normalizeWindowsPath(exe),
      source: 'bundled',
      version: CHROME_FOR_TESTING_VERSION,
    };
  }

  // No bundle: lazy download (online fallback).
  if (!allowDownload) {
    sidecarLog('[resolveChromium] download rung reached but allowDownload=false');
    return undefined;
  }
  const executablePath = await deps.download(
    deps.storageDir,
    spec,
    CHROME_FOR_TESTING_VERSION,
  );
  return {
    executablePath: normalizeWindowsPath(executablePath),
    source: 'download',
    version: CHROME_FOR_TESTING_VERSION,
  };
}
