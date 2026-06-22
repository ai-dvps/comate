---
title: Use an isolated test database — never touch the production data.db in tests
date: 2026-06-20
category: conventions
problem_type: convention
component: testing_framework
module: backend-testing
severity: high
tags:
  - testing
  - sqlite
  - data-safety
  - comate_data_dir
---

## Context

The real Comate SQLite database is `data.db`, located inside the directory that
`COMATE_DATA_DIR` points to. The Tauri shell launches the Node sidecar with
`COMATE_DATA_DIR` set to Tauri's `app_data_dir()`:

- `src-tauri/src/lib.rs:384-409` spawns `sidecar-node` with
  `.env("COMATE_DATA_DIR", &data_dir)`.
- `src-tauri/tauri.conf.json:5` sets the bundle identifier to
  `com.comate.app`.
- On macOS, Tauri's `app_data_dir()` resolves to
  `~/Library/Application Support/<bundle-identifier>`.

So on a Mac the production database is:

```
~/Library/Application Support/com.comate.app/data.db
```

If the server is started outside Tauri (e.g. `npm run dev:server` without the
env var), `src/server/storage/data-dir.ts:4-9` falls back to `~/.comate`, making
`~/.comate/data.db` the de-facto dev database.

Several backend test suites — notably `src/server/storage/sqlite-store.test.ts` —
were running against the real database, deleting rows and mutating schema in
`beforeEach` hooks. The result was accidental data loss for the user.

## Guidance

1. **Every server test imports `test-utils/test-env` as its first statement.**
   That helper redirects `COMATE_DATA_DIR` to a fresh temp directory and sets a
   `COMATE_TEST_MODE` marker before any storage module loads. The import is
   enforced statically by the ESLint rule in `.eslintrc.cjs` (a server test
   file whose first import is not `test-env` fails lint) and defended at
   runtime by the guard in rule 4.
2. **Never run backend tests against the production database.** Treat
   `~/Library/Application Support/com.comate.app/data.db` (macOS) or the
   equivalent platform app-data path as production data.
3. **Prefer an isolated store over the shared singleton in unit tests.** Use
   `createIsolatedStore()` (in-memory by default) from
   `src/server/test-utils/test-store.ts`, or `new SqliteStore(':memory:')`
   directly, for a hermetic per-test instance. Reset state between cases with
   `store.resetData()` rather than reaching into the private `db` handle.
4. **A runtime guard refuses production paths during tests.**
   `src/server/storage/data-dir.ts` throws if `COMATE_TEST_MODE` is set and the
   resolved directory is a production root (`~/.comate` or the Tauri app-data
   path). `test-env` also aborts loudly if it is imported after the store was
   already constructed (a misordered import), so no `beforeEach` can mutate
   real data.

Run the whole server suite with:

```bash
npm run test:server
```

## Why This Matters

- **Prevents real data loss.** Tests that delete rows or drop tables should
  never operate on user data.
- **Makes tests deterministic.** A fresh database per run removes hidden
  ordering dependencies and stale state.
- **Avoids schema pollution.** Migrations and `ALTER TABLE` statements run
  during tests should not change the production schema.

## When to Apply

- Any backend test that imports or uses `src/server/storage/sqlite-store.ts`.
- Any test that exercises workspace, session, message, prompt-history, or
  analytics persistence.
- Before merging any PR that adds or modifies persistence-layer tests.

## Examples

### Bad: importing the store before the test-env redirect

```ts
import { store } from '../storage/sqlite-store.js'; // singleton opens ~/.comate/data.db
import '../test-utils/test-env.js';                  // too late — load-order guard throws
```

### Good: test-env first, isolated in-memory store, public reset

```ts
import '../test-utils/test-env.js'; // MUST be the first import
import { describe, it, beforeEach } from 'node:test';
import { createIsolatedStore } from '../test-utils/test-store.js';

describe('workspace store', () => {
  let store: ReturnType<typeof createIsolatedStore>;

  beforeEach(() => {
    store = createIsolatedStore(); // fresh in-memory database per test
  });

  // tests ...
});
```

For tests that exercise the shared singleton (routes/services), import
`test-env` first and call `workspaceStore.resetData()` in `beforeEach`. Never
reach into the private `db` field via a cast or `workspaceStore.db` — use the
public mutators or `resetData()`.

## See Also

- `src/server/test-utils/test-env.ts` — sets `COMATE_DATA_DIR` +
  `COMATE_TEST_MODE`, load-order guard
- `src/server/test-utils/test-store.ts` — `createIsolatedStore()` /
  `withIsolatedStore()` factory
- `src/server/storage/data-dir.ts` — `COMATE_DATA_DIR` / `~/.comate` resolution
  and the test-mode production-path guard
- `src/server/storage/sqlite-store.ts` — optional `dbPath` constructor arg,
  `:memory:` support, and `resetData()`
- `.eslintrc.cjs` — `no-restricted-syntax` override requiring `test-env` as the
  first import in server tests
- `src-tauri/src/lib.rs:384-409` — sidecar spawn that sets `COMATE_DATA_DIR`
- `src-tauri/tauri.conf.json:5` — bundle identifier `com.comate.app`
