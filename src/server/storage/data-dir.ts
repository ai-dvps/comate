import { join } from 'path';
import { homedir } from 'os';

/**
 * Resolve the directory holding Comate's persistent data (the SQLite database,
 * JSON stores, logs, path config).
 *
 * Honors `COMATE_DATA_DIR` when set (the Tauri shell always sets it to the
 * app's data dir); otherwise falls back to `~/.comate`, which is the de-facto
 * dev database.
 */
export function getStorageDir(): string {
  const dir = process.env.COMATE_DATA_DIR ?? join(homedir(), '.comate');

  // Record that resolution happened, so the test harness can detect a
  // misordered import — anything that pulls sqlite-store (or another module
  // that resolves storage at load) in before test-utils/test-env set the
  // redirect. The flag is inert in production; only test-env reads it.
  (globalThis as Record<string, unknown>).__COMATE_STORAGE_DIR_RESOLVED = true;

  // Hard guard: while tests are running, never resolve to a production path.
  // This fires at the first call (module load of sqlite-store), before the
  // singleton opens the file, so it prevents the file from ever being opened
  // against real data even when COMATE_DATA_DIR was misconfigured.
  if (process.env.COMATE_TEST_MODE === '1' && looksLikeProductionStorageDir(dir)) {
    throw new Error(
      `Refusing to resolve storage dir to a production path during tests: "${dir}". ` +
        'Import test-utils/test-env first so it redirects COMATE_DATA_DIR to a temp directory.',
    );
  }
  return dir;
}

/** A path is "production" if it is the home fallback or the Tauri app-data dir. */
function looksLikeProductionStorageDir(dir: string): boolean {
  return dir === join(homedir(), '.comate') || dir.includes('com.comate.app');
}
