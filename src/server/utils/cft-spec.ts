import path from 'path';
import { tmpdir } from 'os';
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

const execFileAsync = promisify(execFile);

/**
 * Pure Chrome for Testing (CfT) machinery: pinned version, per-platform specs,
 * checksum-verified download, and extract+publish. Kept free of sidecar-logger
 * and storage side effects so both the runtime resolver (`resolve-chromium.ts`)
 * and the build-time vendor step (`scripts/build-chromium-bundle.ts`) share one
 * source of truth.
 */

export const CHROME_FOR_TESTING_VERSION = '151.0.7922.34';
export const CFT_BASE_URL = 'https://storage.googleapis.com/chrome-for-testing-public';

export interface CftPlatformSpec {
  /** Directory/archive name used by the Chrome for Testing endpoints. */
  zipName: string;
  /** SHA-256 of the official zip, captured at pin time. */
  sha256: string;
  /** Executable path relative to the extraction root. */
  executableRelPath: string;
}

export const CFT_PLATFORMS: Record<string, CftPlatformSpec> = {
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

/** Relative path of the bundled CfT zip under the resources tree. */
export function bundledCftZipRel(platformKey: string): string | undefined {
  const spec = CFT_PLATFORMS[platformKey];
  if (!spec) return undefined;
  return path.join('chromium', platformKey, `chrome-${spec.zipName}.zip`);
}

export class ChromiumChecksumMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(
      `Chrome for Testing download failed SHA-256 verification ` +
        `(expected ${expected}, got ${actual}). Refusing to use the download.`,
    );
    this.name = 'ChromiumChecksumMismatchError';
  }
}

/** Directory where a pinned CfT build is materialized (<storageDir>/chromium/cft-<v>-<zip>). */
export function cftInstallDir(storageDir: string, spec: CftPlatformSpec, version: string): string {
  return path.join(storageDir, 'chromium', `cft-${version}-${spec.zipName}`);
}

/**
 * Extract a Chrome for Testing zip. The macOS archives contain symlinks inside
 * the .app bundle (framework Versions/Current etc.) which adm-zip cannot
 * restore, so posix platforms prefer the system extractor (always present on
 * macOS; `unzip` on desktop Linux) and fall back to adm-zip when it is
 * missing. Windows archives have no symlinks and go through adm-zip.
 */
export async function extractCftZip(
  zipPath: string,
  destDir: string,
  onLog?: (msg: string) => void,
): Promise<void> {
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
      onLog?.(`[cft] ${tool} not found, falling back to adm-zip`);
    }
  }
  new AdmZip(zipPath).extractAllTo(destDir, true);
  // adm-zip does not reliably restore unix exec bits; make the tree usable.
  if (process.platform !== 'win32') {
    await execFileAsync('chmod', ['-R', 'a+rX', destDir]);
  }
}

export interface CftFetchOptions {
  /** Override the official endpoint (tests point this at a local server). */
  baseUrl?: string;
  /**
   * Final on-disk path for the verified zip. When omitted the zip lands in a
   * temp file the caller must clean up. When set, the download is written to a
   * sibling `.partial` file and atomically renamed into place on success.
   */
  destZipPath?: string;
  /** Optional diagnostic sink (runtime passes the sidecar logger). */
  onLog?: (msg: string) => void;
}

/**
 * Download the pinned Chrome for Testing zip and verify its SHA-256. Returns
 * the path to the verified zip (either `destZipPath` or a temp file). Any
 * failure removes the partial file and rethrows.
 */
export async function downloadAndVerifyCftZip(
  spec: CftPlatformSpec,
  version: string,
  options?: CftFetchOptions,
): Promise<string> {
  const baseUrl = options?.baseUrl ?? CFT_BASE_URL;
  const url = `${baseUrl}/${version}/${spec.zipName}/chrome-${spec.zipName}.zip`;
  const token = `${process.pid}-${Date.now()}`;
  const finalPath = options?.destZipPath ?? path.join(tmpdir(), `comate-cft-${token}.zip`);
  const tmpPath = `${finalPath}.${token}.partial`;

  options?.onLog?.(`[cft] downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status} from ${url}`);
  }

  const hash = createHash('sha256');
  const tap = new PassThrough();
  tap.on('data', (chunk) => hash.update(chunk));

  try {
    await pipeline(Readable.fromWeb(response.body as never), tap, createWriteStream(tmpPath));
    const actual = hash.digest('hex');
    if (actual !== spec.sha256) {
      throw new ChromiumChecksumMismatchError(spec.sha256, actual);
    }
    mkdirSync(path.dirname(finalPath), { recursive: true });
    renameSync(tmpPath, finalPath);
    return finalPath;
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

/**
 * Extract a verified CfT zip into a staging directory and atomically rename it
 * into place under <storageDir>/chromium/cft-<version>-<zipName>/. Returns the
 * executable path. Short-circuits when the install already exists. Any failure
 * removes the staging tree and rethrows — the final install dir never holds
 * half state.
 */
export async function publishCftFromZip(
  zipPath: string,
  storageDir: string,
  spec: CftPlatformSpec,
  version: string,
  onLog?: (msg: string) => void,
): Promise<string> {
  const installRoot = path.join(storageDir, 'chromium');
  const finalDir = cftInstallDir(storageDir, spec, version);
  const finalExe = path.join(finalDir, spec.executableRelPath);
  if (existsSync(finalExe)) {
    return finalExe;
  }

  const token = `${process.pid}-${Date.now()}`;
  const stagingDir = path.join(installRoot, `.staging-${token}`);
  mkdirSync(installRoot, { recursive: true });

  try {
    mkdirSync(stagingDir, { recursive: true });
    await extractCftZip(zipPath, stagingDir, onLog);

    const stagedExe = path.join(stagingDir, spec.executableRelPath);
    if (!existsSync(stagedExe)) {
      throw new Error(`Chrome for Testing archive is missing ${spec.executableRelPath}`);
    }

    // Atomic publish: rename within the same filesystem. If a concurrent
    // publisher already published, discard our staging tree and use theirs.
    if (existsSync(path.join(finalDir, spec.executableRelPath))) {
      rmSync(stagingDir, { recursive: true, force: true });
    } else {
      renameSync(stagingDir, finalDir);
    }

    const publishedExe = path.join(finalDir, spec.executableRelPath);
    onLog?.(`[cft] installed Chrome for Testing ${version} at ${publishedExe}`);
    return publishedExe;
  } catch (err) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }
}
