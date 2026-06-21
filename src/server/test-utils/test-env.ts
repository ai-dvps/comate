import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Redirect server tests away from the user's real data directory. This must be
// imported before any module that loads the SqliteStore singleton.
if (!process.env.COMATE_DATA_DIR) {
  process.env.COMATE_DATA_DIR = mkdtempSync(join(tmpdir(), 'comate-test-'));
}
