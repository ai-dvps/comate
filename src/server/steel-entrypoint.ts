import { pathToFileURL } from 'url';
import { resolveSteelBundle } from './utils/resolve-steel.js';

/**
 * Re-exec-self Steel entrypoint (KTD-2): the packaged sidecar binary cannot
 * `spawn('node', [steel.js])`, so the same binary hosts the vendored Steel API
 * server when launched with COMATE_STEEL=1 (mirroring the COMATE_SIDECAR=1
 * precedent). The parent orchestrator (browser-service) discovers the port via
 * Steel's own /v1/health probe.
 *
 * The Steel bundle is loaded from the real filesystem (Tauri resources in
 * production, src-tauri/resources/steel in dev) with a native dynamic import —
 * pkg's snapshot filesystem cannot serve Steel's __dirname-relative assets
 * (templates, fingerprint script, extension dirs), so bundling Steel into the
 * snapshot is deliberately avoided (see U2 spike notes in the plan unit).
 */
export async function bootSteelEntrypoint(): Promise<void> {
  const resolution = resolveSteelBundle();
  if (!resolution) {
    console.error(
      '[steel] COMATE_STEEL=1 set but the vendored Steel bundle was not found ' +
        '(searched TAURI_RESOURCE_DIR, the app data directory, and the dev ' +
        'resources tree). Cannot start Steel.',
    );
    process.exit(1);
  }

  // Steel's API must stay on loopback (KTD-7). Default it here as
  // defense-in-depth; the spawning orchestrator sets HOST explicitly.
  if (!process.env.HOST) {
    process.env.HOST = '127.0.0.1';
  }

  console.error(
    `[steel] starting vendored Steel from ${resolution.steelDir} (source=${resolution.source})`,
  );
  // Resolves once Steel's modules are loaded; the process then stays alive on
  // fastify's event loop.
  await import(pathToFileURL(resolution.entryPath).href);
}
