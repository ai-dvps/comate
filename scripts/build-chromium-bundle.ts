import { existsSync, mkdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  CHROME_FOR_TESTING_VERSION,
  CFT_PLATFORMS,
  type CftPlatformSpec,
  downloadAndVerifyCftZip,
} from '../src/server/utils/cft-spec.js';

/**
 * Vendor the pinned Chrome for Testing (CfT) zip into
 * src-tauri/resources/chromium/<platform-arch>/chrome-<zipName>.zip.
 *
 * The runtime resolver (`resolve-chromium.ts`) extracts this zip into the app
 * data dir on first browser spawn, giving the embedded browser an isolated
 * Chrome (`com.google.chrome.for.testing`) that never drives the user's
 * installed Chrome. Shipping the zip in the app bundle makes this work fully
 * offline (intranet). The download+SHA-256 verification is shared with the
 * runtime via cft-spec.ts.
 *
 * Mirrors build-steel-bundle.ts: exports buildChromiumBundle() for
 * build-sidecar.ts, and also runs standalone via `tsx scripts/...`.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const resourcesDir = join(rootDir, 'src-tauri', 'resources');

// Loose guard against a truncated/corrupt fetch that somehow passed SHA-256
// (shouldn't happen) — the smallest pinned CfT zip is ~150 MB.
const CFT_MIN_BYTES = 50 * 1024 * 1024;

function hostPlatformKey(): string | undefined {
  const key = `${process.platform}-${process.arch}`;
  return CFT_PLATFORMS[key] ? key : undefined;
}

export async function buildChromiumBundle(): Promise<void> {
  const platformKey = hostPlatformKey();
  if (!platformKey) {
    console.warn(
      `build-chromium-bundle: no pinned Chrome for Testing build for ` +
        `${process.platform}-${process.arch}; skipping (the embedded browser ` +
        `will fall back to the lazy download rung).`,
    );
    return;
  }
  const spec: CftPlatformSpec = CFT_PLATFORMS[platformKey];
  const destDir = join(resourcesDir, 'chromium', platformKey);
  const destZip = join(destDir, `chrome-${spec.zipName}.zip`);

  if (existsSync(destZip) && statSync(destZip).size >= CFT_MIN_BYTES) {
    console.log(
      `build-chromium-bundle: cached ${destZip} ` +
        `(${(statSync(destZip).size / 1048576).toFixed(1)} MiB), skipping download`,
    );
    return;
  }

  console.log(
    `build-chromium-bundle: fetching Chrome for Testing ${CHROME_FOR_TESTING_VERSION} ` +
      `(${platformKey})`,
  );
  mkdirSync(destDir, { recursive: true });
  await downloadAndVerifyCftZip(spec, CHROME_FOR_TESTING_VERSION, {
    destZipPath: destZip,
    onLog: (m) => console.log(m),
  });

  const bytes = statSync(destZip).size;
  if (bytes < CFT_MIN_BYTES) {
    throw new Error(
      `build-chromium-bundle: ${destZip} is unexpectedly small (${bytes} bytes)`,
    );
  }
  console.log(
    `build-chromium-bundle: installed ${destZip} (${(bytes / 1048576).toFixed(1)} MiB)`,
  );
}

// Run standalone (tsx scripts/build-chromium-bundle.ts). When imported by
// build-sidecar.ts, the caller invokes buildChromiumBundle() instead.
const invokedAsScript = (() => {
  try {
    return Boolean(process.argv[1]) && __filename === join(process.argv[1]!);
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  buildChromiumBundle().catch((err) => {
    console.error('Chromium bundle build failed:', err);
    process.exit(1);
  });
}
