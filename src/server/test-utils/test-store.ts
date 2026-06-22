import { SqliteStore } from '../storage/sqlite-store.js';

/**
 * Create a fresh, fully isolated {@link SqliteStore} for a test.
 *
 * Defaults to an in-memory database (`:memory:`): hermetic, no file artifacts,
 * no cleanup, and a distinct database per instance. Pass an explicit path to
 * use a temp file on disk instead (e.g. when a test exercises WAL or
 * persistence behavior that an in-memory DB cannot represent).
 *
 * Prefer this over importing the shared `store` singleton in unit tests — it
 * removes any dependence on import order or the `COMATE_DATA_DIR` redirect and
 * gives each test a private database.
 */
export function createIsolatedStore(dbPath: string = ':memory:'): SqliteStore {
  return new SqliteStore(dbPath);
}

/**
 * Run a test body against a fresh isolated store, then reset it. Handles both
 * sync and async bodies; the reset runs after the body settles.
 */
export async function withIsolatedStore<T>(
  testFn: (store: SqliteStore) => T | Promise<T>,
  dbPath?: string,
): Promise<T> {
  const store = createIsolatedStore(dbPath);
  try {
    return await testFn(store);
  } finally {
    store.resetData();
  }
}
