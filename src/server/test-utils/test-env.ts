import { mkdtempSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

// Redirect server tests away from the user's real data directory. This must be
// the FIRST import of any server test file — before any module that loads the
// SqliteStore singleton (storage/sqlite-store.js) or resolves storage at load
// (storage/json-store.js, utils/path-config.js). The import order is enforced
// statically by the ESLint rule in .eslintrc.cjs and defended at runtime below.
function looksLikeProductionStorageDir(dir: string): boolean {
  return dir === join(homedir(), '.comate') || dir.includes('com.comate.app');
}

if (!process.env.COMATE_DATA_DIR || looksLikeProductionStorageDir(process.env.COMATE_DATA_DIR)) {
  process.env.COMATE_DATA_DIR = mkdtempSync(join(tmpdir(), 'comate-test-'));
}

// Marker read by getStorageDir() so it can refuse to resolve a production path
// while tests are running. Must be set before any storage module loads.
process.env.COMATE_TEST_MODE = '1';

// Neutralize CLAUDE_CONFIG_DIR from the developer's shell. The SDK and
// analytics-transcript-path resolve transcripts under
// `<CLAUDE_CONFIG_DIR>/projects` with top priority, so an exported value
// (e.g. CLAUDE_CONFIG_DIR=~/.claude) would silently hijack tests that set up
// a fake HOME — they would resolve against the developer's real Claude
// projects tree instead of the test fixture.
delete process.env.CLAUDE_CONFIG_DIR;

// Preventive load-order check. data-dir.ts records the moment getStorageDir()
// first runs. If that already happened before we reached this line, some module
// imported ahead of us already constructed the store against an unguarded path.
// The store file was opened (no mutation yet), but a later beforeEach could
// delete real data — so abort loudly instead. The fix is to move this import to
// the very top of the test file.
const resolved = (globalThis as Record<string, unknown>).__COMATE_STORAGE_DIR_RESOLVED;
if (resolved) {
  throw new Error(
    'test-utils/test-env was imported after the storage layer already resolved a data directory. ' +
      'Move `import "../test-utils/test-env.js";` to the very first line of this test file, ' +
      'before any service, route, or storage import.',
  );
}
