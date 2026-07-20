import path from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { PassThrough, Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { promisify } from 'util';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'fs';
import { execFile } from 'child_process';
import AdmZip from 'adm-zip';
import { getStorageDir } from '../storage/data-dir.js';
import { sidecarLog } from './sidecar-logger.js';
import { normalizeWindowsPath } from './normalize-windows-path.js';
import { findInPath } from './find-in-path.js';

const execFileAsync = promisify(execFile);

/**
 * Chromium resolution ladder (R16):
 *   1. System Chrome / Edge (well-known install paths + PATH lookup)
 *   2. Configured path (COMATE_CHROMIUM_PATH)
 *   3. Lazy download of a pinned Chrome for Testing build:
 *      fixed version + per-platform SHA-256 + download-to-temp + atomic rename,
 *      checksum mismatch fails closed (temp artifacts removed, no half state).
 *
 * Chromium is never bundled with the app. When every rung misses, callers get
 * `undefined` and must surface an explicit, actionable error (R17/AE5).
 */

export type ChromiumSource = 'system' | 'config' | 'download';

export interface ChromiumResolution {
  executablePath: string;
  source: ChromiumSource;
  /** Present for lazy-downloaded Chrome for Testing builds. */
  version?: string;
}

export const CHROME_FOR_TESTING_VERSION = '151.0.7922.34';
const CFT_BASE_URL = 'https://storage.googleapis.com/chrome-for-testing-public';

interface CftPlatformSpec {
  /** Directory/archive name used by the Chrome for Testing endpoints. */
  zipName: string;
  /** SHA-256 of the official zip, captured at pin time. */
  sha256: string;
  /** Executable path relative to the extraction root. */
  executableRelPath: string;
}

const CFT_PLATFORMS: Record<string, CftPlatformSpec> = {
  'darwin-arm64': {
    zipName: 'mac-arm64',
    sha256: '01a23ef9501b2745e0c2944c2e583207e6f6132d8d91c3a87ff65b5079e438ef',
    executableRelPath: path.join(
      'chrome-mac-arm64',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    ),
  },
  'darwin-x64': {
    zipName: 'mac-x64',
    sha256: '69bcc853db975a2380767e9ff36da17f1d7b782fbbe191a210f676d2d5967d3e',
    executableRelPath: path.join(
      'chrome-mac-x64',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    ),
  },
  'linux-x64': {
    zipName: 'linux64',
    sha256: 'ae8736ac28bc69278551500f219fc749575648263c43ec5990749eff43b9fcf8',
    executableRelPath: path.join('chrome-linux64', 'chrome'),
  },
  'win32-x64': {
    zipName: 'win64',
    sha256: '045621e45a9dd27002c7fc1d8e10fe9f5f71f4cadbf44ec6f397f56f0179725c',
    executableRelPath: path.join('chrome-win64', 'chrome.exe'),
  },
};

export class ChromiumChecksumMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(
      `Chrome for Testing download failed SHA-256 verification ` +
        `(expected ${expected}, got ${actual}). Refusing to use the download.`,
    );
    this.name = 'ChromiumChecksumMismatchError';
  }
}

export interface ChromiumDeps {
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  fileExists: (p: string) => boolean;
  findInPath: (command: string) => string | undefined;
  /** Root under which lazy downloads are installed (<storageDir>/chromium). */
  storageDir: string;
  /** Performs the download+verify+install, returning the executable path. */
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

function cftInstallDir(storageDir: string, spec: CftPlatformSpec, version: string): string {
  return path.join(storageDir, 'chromium', `cft-${version}-${spec.zipName}`);
}

/**
 * Extract a Chrome for Testing zip. The macOS archives contain symlinks inside
 * the .app bundle (framework Versions/Current etc.) which adm-zip cannot
 * restore, so posix platforms prefer the system extractor (always present on
 * macOS; `unzip` on desktop Linux) and fall back to adm-zip when it is
 * missing. Windows archives have no symlinks and go through adm-zip.
 */
async function extractCftZip(zipPath: string, destDir: string): Promise<void> {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    const tool = process.platform === 'darwin' ? 'ditto' : 'unzip';
    const args = process.platform === 'darwin'
      ? ['-x', '-k', zipPath, destDir]
      : ['-q', zipPath, '-d', destDir];
    try {
      await execFileAsync(tool, args);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
      sidecarLog(`[resolveChromium] ${tool} not found, falling back to adm-zip`);
    }
  }
  new AdmZip(zipPath).extractAllTo(destDir, true);
  // adm-zip does not reliably restore unix exec bits; make the tree usable.
  if (process.platform !== 'win32') {
    await execFileAsync('chmod', ['-R', 'a+rX', destDir]);
  }
}

export interface CftDownloadOptions {
  /** Override the official endpoint (tests point this at a local server). */
  baseUrl?: string;
}

/**
 * Download the pinned Chrome for Testing zip, verify its SHA-256, extract to a
 * staging directory, and atomically rename into place. Any failure removes
 * temp artifacts and rethrows — the final install dir never holds half state.
 */
export async function downloadChromeForTesting(
  storageDir: string,
  spec: CftPlatformSpec,
  version: string,
  options?: CftDownloadOptions,
): Promise<string> {
  const baseUrl = options?.baseUrl ?? CFT_BASE_URL;
  const url = `${baseUrl}/${version}/${spec.zipName}/chrome-${spec.zipName}.zip`;
  const installRoot = path.join(storageDir, 'chromium');
  const finalDir = cftInstallDir(storageDir, spec, version);
  const finalExe = path.join(finalDir, spec.executableRelPath);
  if (existsSync(finalExe)) {
    return finalExe;
  }
  const token = `${process.pid}-${Date.now()}`;
  const tmpZip = path.join(installRoot, `.download-${token}.zip`);
  const stagingDir = path.join(installRoot, `.staging-${token}`);

  mkdirSync(installRoot, { recursive: true });

  const cleanup = () => {
    rmSync(tmpZip, { force: true });
    rmSync(stagingDir, { recursive: true, force: true });
  };

  try {
    sidecarLog(`[resolveChromium] downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(`Download failed: HTTP ${response.status} from ${url}`);
    }

    const hash = createHash('sha256');
    const tap = new PassThrough();
    tap.on('data', (chunk) => hash.update(chunk));
    await pipeline(Readable.fromWeb(response.body as never), tap, createWriteStream(tmpZip));

    const actual = hash.digest('hex');
    if (actual !== spec.sha256) {
      throw new ChromiumChecksumMismatchError(spec.sha256, actual);
    }

    mkdirSync(stagingDir, { recursive: true });
    await extractCftZip(tmpZip, stagingDir);

    const stagedExe = path.join(stagingDir, spec.executableRelPath);
    if (!existsSync(stagedExe)) {
      throw new Error(`Downloaded archive is missing ${spec.executableRelPath}`);
    }

    // Atomic publish: rename within the same filesystem. If a concurrent
    // download already published, discard our staging tree and use theirs.
    if (existsSync(path.join(finalDir, spec.executableRelPath))) {
      rmSync(stagingDir, { recursive: true, force: true });
    } else {
      renameSync(stagingDir, finalDir);
    }
    rmSync(tmpZip, { force: true });

    const publishedExe = path.join(finalDir, spec.executableRelPath);
    sidecarLog(`[resolveChromium] installed Chrome for Testing at ${publishedExe}`);
    return publishedExe;
  } catch (err) {
    cleanup();
    throw err;
  }
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
    download: downloadChromeForTesting,
  };
}

/**
 * Resolve a Chromium executable. `allowDownload` controls the lazy-download
 * rung — health checks pass false so a probe never triggers a large download;
 * first browser use passes true (F5).
 */
export async function resolveChromium(options?: {
  allowDownload?: boolean;
  deps?: Partial<ChromiumDeps>;
}): Promise<ChromiumResolution | undefined> {
  const deps: ChromiumDeps = { ...defaultDeps(), ...options?.deps };
  const allowDownload = options?.allowDownload ?? false;

  // Rung 1: system Chrome / Edge
  const system = resolveSystemChromium(deps);
  if (system) {
    return { executablePath: system, source: 'system' };
  }

  // Rung 2: configured path
  const configured = deps.env.COMATE_CHROMIUM_PATH;
  if (configured) {
    const normalized = normalizeWindowsPath(configured);
    if (deps.fileExists(normalized)) {
      sidecarLog(`[resolveChromium] config path hit: ${normalized}`);
      return { executablePath: normalized, source: 'config' };
    }
    sidecarLog(`[resolveChromium] COMATE_CHROMIUM_PATH set but missing: ${normalized}`);
  }

  // Rung 3: lazy download (pinned Chrome for Testing)
  const platformKey = `${deps.platform}-${deps.arch}`;
  const spec = CFT_PLATFORMS[platformKey];
  if (!spec) {
    sidecarLog(`[resolveChromium] no pinned CfT build for ${platformKey}`);
    return undefined;
  }
  const existingExe = path.join(
    cftInstallDir(deps.storageDir, spec, CHROME_FOR_TESTING_VERSION),
    spec.executableRelPath,
  );
  if (deps.fileExists(existingExe)) {
    return {
      executablePath: normalizeWindowsPath(existingExe),
      source: 'download',
      version: CHROME_FOR_TESTING_VERSION,
    };
  }
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
