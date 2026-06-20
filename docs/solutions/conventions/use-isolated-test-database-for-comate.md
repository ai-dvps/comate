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

1. **Never run backend tests against the production database.** Treat
   `~/Library/Application Support/com.comate.app/data.db` (macOS) or the
   equivalent platform app-data path as production data.
2. **Always set `COMATE_DATA_DIR` to a temp directory before any test that
   initializes `SqliteStore`.**
3. **Use a fresh directory per test or per test file.** This keeps tests
   hermetic and avoids state leaking between runs.
4. Reset `COMATE_DATA_DIR` in `afterEach`/`afterAll` so later tests do not
   accidentally pick up the wrong path.

In `node:test` or Vitest, the pattern looks like this:

```ts
import os from 'os';
import path from 'path';
import { describe, it, before, after } from 'node:test';

const ORIGINAL_DATA_DIR = process.env.COMATE_DATA_DIR;

describe('sqlite store', () => {
  before(() => {
    process.env.COMATE_DATA_DIR = path.join(
      os.tmpdir(),
      `comate-test-${Date.now()}`,
    );
  });

  after(() => {
    process.env.COMATE_DATA_DIR = ORIGINAL_DATA_DIR;
    // Optional: fs.rmSync(process.env.COMATE_DATA_DIR!, { recursive: true, force: true });
  });

  // tests ...
});
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

### Bad: relying on the default data directory

```ts
import { store } from '../storage/sqlite-store.js';

describe('workspaces', () => {
  beforeEach(() => {
    store.db.prepare('DELETE FROM workspaces').run(); // touches ~/.comate/data.db
  });
});
```

### Good: redirecting to a temp directory

```ts
import os from 'os';
import path from 'path';
import { before, after } from 'node:test';

before(() => {
  process.env.COMATE_DATA_DIR = path.join(
    os.tmpdir(),
    `comate-test-${Date.now()}`,
  );
});

after(() => {
  delete process.env.COMATE_DATA_DIR;
});
```

## See Also

- `src-tauri/src/lib.rs:384-409` — sidecar spawn that sets `COMATE_DATA_DIR`
- `src-tauri/tauri.conf.json:5` — bundle identifier `com.comate.app`
- `src/server/storage/data-dir.ts:4-9` — `COMATE_DATA_DIR` / `~/.comate`
  resolution
- `src/server/storage/sqlite-store.ts:14-15` — joins storage dir with
  `data.db`
