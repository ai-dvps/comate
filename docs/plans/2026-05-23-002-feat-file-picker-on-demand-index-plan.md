---
date: 2026-05-23
type: feat
status: active
origin: docs/brainstorms/2026-05-23-file-picker-on-demand-index-requirements.md
---

# feat: File Picker On-Demand Ripgrep Index

## Summary

Replace the file picker's eager "walk the whole workspace into memory" data source with on-demand ripgrep queries via `@vscode/ripgrep`. The server exposes a per-query filename-search endpoint that streams `rg --files`-style results scoped to the user's query and ignore rules. The client's `files-store` and `FilePicker` switch from a one-shot full listing to per-keystroke debounced requests with abort-on-supersede. A pure-Node walker (`fdir` + `ignore`) is wired in as a runtime fallback for environments where the ripgrep binary is unavailable. Manual verification scenarios replace tests since this repo has no test harness today.

(see origin: docs/brainstorms/2026-05-23-file-picker-on-demand-index-requirements.md)

---

## Problem Frame

Today, `GET /api/workspaces/:id/files?recursive=true` (src/server/routes/files.ts:31-46) walks the entire workspace folder with no ignore filtering, then the client stores the full list in memory (src/client/stores/files-store.ts) and `FilePicker` renders all entries without virtualization (src/client/components/FilePicker.tsx:245-267). On workspaces with `node_modules`, `.git`, or vendored directories present, the cost stacks at three layers — server walk, response payload, DOM render — and the picker freezes the application.

The brainstorm settled on replacing the upfront index with on-demand ripgrep queries, with `.gitignore`/`.git`/`node_modules` filtering inherited from ripgrep's defaults. This plan defines how that change lands: which endpoints, which packages, how the binary travels through dev / `pkg`-packaged sidecar / Tauri bundle, how the client cancels superseded queries, and how the fallback path behaves when the binary isn't there.

---

## Requirements Traceability

Requirements carried forward from the origin brainstorm (R-IDs preserved):

- **R1–R4** (indexing mechanism): U1, U3
- **R5–R7** (ignore semantics): U3 (inherited from ripgrep defaults); U4 for fallback parity
- **R8–R10** (query lifecycle: debounce / abort / result cap): U2 (server-side cap), U5 (client debounce + abort)
- **R11** (fuzzy ranking): U2
- **R12** (fallback walker): U4
- **R13–R14** (client behavior: per-query fetch, UI unchanged): U5, U6
- **R15–R16** (distribution): U7

Acceptance examples AE1–AE5 are exercised by the verification scenarios on U2, U3, U4, U5, U6.

---

## Key Technical Decisions

- **Use `@vscode/ripgrep`, not a custom ripgrep/fd bundling pipeline.** Same package VSCode uses. The README (microsoft/vscode-ripgrep) confirms binaries ship inside the npm tarball via per-platform optional dependencies — **there is no postinstall network call**. This eliminates the offline-install concern raised in the brainstorm's Dependencies/Assumptions section.
- **Filename-only search.** Use `rg --files` (lists every non-ignored file) piped into a second filter, or `rg --files --iglob '*<pattern>*'`. Server picks one path-finding mode; both honor `.gitignore` natively.
- **Per-keystroke `rg` child with abort-on-supersede.** No long-lived ripgrep daemon. Each query spawns a short-lived child; when a new query arrives, the in-flight child is killed via `child.kill()`.
- **Result cap at 200.** Bounded payload and bounded fuzzy-rank cost. The cap is server-side; client cannot widen it.
- **Fuzzy ranking on the server, post-rg.** `fuzzysort` runs on the top results returned by ripgrep; the client receives an already-ordered list and does no ranking. This keeps the picker's render cheap and centralizes scoring.
- **Fallback walker = `fdir` + `ignore`.** Activates when `rgPath` is missing or the spawn fails. Fallback produces a bounded list using `.gitignore` semantics, runs through the same fuzzy ranker, and degrades gracefully.
- **Tauri binary distribution: copy `rg` into `src-tauri/resources/`** in `scripts/build-sidecar.ts`, mirroring how `claude`, `wecom-send.js`, and `better_sqlite3.node` are staged today (src-tauri/tauri.conf.json declares `resources/` as a bundled directory). At runtime, the pkg-packaged sidecar resolves the binary path via Tauri's resource directory in production and via `@vscode/ripgrep`'s `rgPath` in dev. **Rationale:** the existing project pattern for "Node code spawns a native binary that must travel with the app" is `resources/`, not `externalBin` — `externalBin` is reserved for binaries Tauri's Rust side spawns directly (currently just `sidecar-node`).
- **Replace, don't dual-path.** The current `GET /api/workspaces/:id/files?recursive=true` is removed (along with `walkRecursive` and the `useFilesStore`'s cache-everything mode). The single-level (non-recursive) listing stays — it serves other surfaces (read-file-content, file-tree if added later) untouched.
- **No tests, manual verification scenarios.** This repo has no test harness (no `*.test.ts`, no Vitest/Jest in `package.json`). Each unit's verification is a manual scenario list.

---

## High-Level Technical Design

*This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
┌─────────────────────────────────────────────────────────────────────┐
│ Client (FilePicker.tsx + files-store.ts)                           │
│                                                                     │
│  keystroke ──debounce(120ms)──> AbortController                    │
│                                       │                             │
│                                       ▼                             │
│  GET /api/workspaces/:id/files/search?q=<query>&limit=200          │
│                                       │                             │
└───────────────────────────────────────┼─────────────────────────────┘
                                        │
┌───────────────────────────────────────▼─────────────────────────────┐
│ Server (src/server/routes/files.ts + services/file-search.ts)      │
│                                                                     │
│   resolve rgPath (Tauri resources → @vscode/ripgrep → null)        │
│         │                                                           │
│         ├─ available ──> spawn rg --files [--iglob …] (cwd=ws)     │
│         │                stream → top-N collect → fuzzysort rank   │
│         │                on abort: child.kill()                    │
│         │                                                           │
│         └─ missing   ──> fdir + ignore walker (cwd=ws)             │
│                          collect → top-N → fuzzysort rank          │
└─────────────────────────────────────────────────────────────────────┘
```

Endpoint contract:
- `GET /api/workspaces/:id/files/search?q=<string>&limit=<number>`
- Response: `{ query, results: [{ path }], source: 'rg' | 'fallback', truncated: boolean }`
- Empty `q` returns the first N files (alphabetical), so the picker has something to show on open.

---

## Implementation Units

### U1. Add `@vscode/ripgrep`, `fdir`, `fuzzysort`, `ignore` dependencies

**Goal:** Land the four runtime dependencies and confirm the ripgrep binary resolves locally in dev.

**Requirements:** R2 (binary supplied via `@vscode/ripgrep`), R11 (fuzzy ranking), R12 (fallback walker).

**Dependencies:** none.

**Files:**
- `package.json` (add to `dependencies`)
- `package-lock.json` (regenerated)

**Approach:**
- `npm install @vscode/ripgrep fdir fuzzysort ignore --save`
- Confirm `node_modules/@vscode/ripgrep-darwin-arm64/bin/rg` (or platform equivalent) exists after install — `@vscode/ripgrep` ships per-platform binaries via optional dependencies, no postinstall hook required.
- Confirm `require('@vscode/ripgrep').rgPath` resolves to an existing file.

**Patterns to follow:** Existing dependency layout in `package.json` (alphabetical inside `dependencies`).

**Verification scenarios:**
- After `npm install`, `node -e "console.log(require('@vscode/ripgrep').rgPath)"` prints a path under `node_modules/` that exists on disk.
- `node_modules/.bin/` contains no shim — confirms there is no postinstall step that downloads at install time.
- Running `node -e "..."` on a fresh clone (no `node_modules`) followed by `npm install` produces the same path with no network call beyond the npm registry.

---

### U2. Server: introduce `file-search` service and `/files/search` endpoint

**Goal:** Stand up the on-demand query endpoint, with the ripgrep path active and a `TODO: fallback` slot. Rank with `fuzzysort`. Cap results at 200.

**Requirements:** R1, R3, R10, R11.

**Dependencies:** U1.

**Files:**
- `src/server/services/file-search.ts` (new) — query orchestration, rgPath resolution, fuzzysort ranking, abort plumbing
- `src/server/routes/files.ts` (modified) — add `GET /search`, remove the recursive walk path and `walkRecursive`
- `src/server/index.ts` (no change expected; route mounts unchanged)

**Approach:**
- New module exports `searchFiles({ workspaceRoot, query, limit, signal })` returning `{ results: { path: string }[], source: 'rg' | 'fallback', truncated: boolean }`.
- `rgPath` resolution order: (1) `process.env.RG_PATH` (escape hatch / Tauri injects this in production via U7), (2) `require('@vscode/ripgrep').rgPath` if the file exists, (3) `null` → fallback (filled in U4).
- Spawn shape: `child_process.spawn(rgPath, ['--files', '--iglob', `*${escapeGlob(query)}*`], { cwd: workspaceRoot })`. Stream stdout via `readline`; abort on `signal` triggers `child.kill('SIGTERM')`.
- Stop reading once `limit * 5` candidates have been collected (so fuzzysort has headroom but the walk is bounded) — set `truncated: true` when the cap is hit.
- Empty query → `rg --files` with no glob; take first `limit` lines in arrival order (no fuzzy ranking needed).
- For glob escaping, escape `*`, `?`, `[`, `]`, `{`, `}`, `\`. Reject queries with NUL bytes.
- `routes/files.ts`: delete the `if (isRecursive)` block at lines ~67-72 and the `walkRecursive` helper at lines ~31-46; the recursive listing is no longer reachable from the client after U5/U6 ship. Single-level listing (`/`, non-recursive) and `/content` remain unchanged.

**Patterns to follow:**
- Route shape: existing `src/server/routes/files.ts` for `validatePath` reuse and error-response convention (`res.status(400).json({ error: ... })`).
- Module layout: existing `src/server/services/` (e.g., `chat-service.ts`, `message-normalizer.ts`) — ESM, named exports, no class wrappers.

**Verification scenarios:**
- **Covers AE3.** On a workspace with 50k+ matching paths, the endpoint returns ≤200 results with `truncated: true` and the closest filename match (e.g., `src/index.ts` for query `index`) appears in position 1.
- A request with no `q` parameter returns the first 200 files in arrival order with `source: 'rg'`.
- A request whose `signal` aborts mid-stream returns immediately and leaves no zombie `rg` process (verified with `ps aux | grep rg` on macOS).
- Two concurrent requests with different `q` against the same workspace each spawn their own child; both complete.
- A query containing glob metacharacters (`*`, `[`, `{`, `\`) is treated as a literal substring, not a glob — searching for `[ab]` matches files literally named `[ab]`, not `a` or `b`.
- A path outside the workspace (via `?` — defense in depth; this endpoint never accepts a path query) is impossible by construction (the endpoint never accepts a path arg).

---

### U3. Server: ripgrep ignore semantics verification

**Goal:** Confirm `rg --files` respects `.gitignore`, nested `.gitignore`, `.git/`, and `node_modules/` out of the box and document any flags needed.

**Requirements:** R5, R6, R7.

**Dependencies:** U2.

**Files:**
- `src/server/services/file-search.ts` (modified) — finalize the `rg` flag set

**Approach:**
- `rg --files` by default honors `.gitignore`, `.ignore`, and `.git/info/exclude`, and skips hidden directories (including `.git/`) and `node_modules` only when it sees a matching ignore rule. Confirm behavior empirically against a fixture workspace.
- If a workspace has no `.gitignore` at all, `rg --files` will include `node_modules/`. The fix is to either (a) add `--ignore-file` pointing at a baked-in default ignore that excludes `node_modules` and `.git`, or (b) pass `--glob '!node_modules'` and `--glob '!.git'` unconditionally. **Pick (b)** — keeps the rg invocation self-contained and matches the brainstorm's R6 ("regardless of whether `.gitignore` exists").
- Document the final flag set in a comment at the top of the spawn call.

**Patterns to follow:** N/A — this is a configuration / behavioral confirmation step on the new module.

**Verification scenarios:**
- **Covers AE1.** Given a workspace with `.git/`, `node_modules/`, and a `.gitignore` containing `dist/`: a query for `index` returns matches like `src/index.ts` and excludes any path containing `.git/`, `node_modules/`, or `dist/`.
- Given a workspace with **no** `.gitignore`: `.git/` and `node_modules/` are still excluded (because of the unconditional `--glob '!…'` flags).
- Given a workspace with a nested `.gitignore` inside `packages/foo/` excluding `packages/foo/build/`: queries do not return paths under `packages/foo/build/`.
- Given a workspace with negation rules (`!important.log` after `*.log`): `important.log` appears in results, other `.log` files do not.

---

### U4. Server: pure-Node fallback walker

**Goal:** When `rgPath` is unavailable, the endpoint still returns useful results using `fdir` + `ignore`. Same response shape, `source: 'fallback'`.

**Requirements:** R12, R5, R6 (parity with rg path).

**Dependencies:** U2.

**Files:**
- `src/server/services/file-search.ts` (modified) — add `fallbackSearch({ workspaceRoot, query, limit, signal })`
- (no new file — keep the fallback co-located with the primary search for symmetry)

**Approach:**
- Use `fdir` (chainable builder) with `.exclude((name) => name === '.git' || name === 'node_modules')`.
- Compose an `ignore` instance from all `.gitignore` files encountered during the walk: pre-load workspace-root `.gitignore`; for nested ones, pass each path through a per-directory filter. The `ignore` package is the same one ESLint/Prettier use; nested-gitignore composition is a documented use case.
- Stream paths through, stop early once `limit * 5` candidates have been collected. Honor `signal.aborted` between batches.
- Run results through the same `fuzzysort` ranking pass as U2 so the response shape is identical aside from `source: 'fallback'`.
- Activation logic in U2 already calls `fallbackSearch` when `rgPath` is `null`; this unit fills it in.

**Patterns to follow:** Existing async iteration patterns in `src/server/services/` (no class wrappers, named exports, AbortSignal-aware).

**Verification scenarios:**
- **Covers AE4.** With `RG_PATH=/nonexistent/rg` set in the environment, the endpoint returns results with `source: 'fallback'` for the same query that worked under U2, with `.git/` and `node_modules/` excluded.
- Fallback on a workspace with nested `.gitignore` excludes the nested-ignored paths (verifies the `ignore` package handles nested files correctly).
- Aborting a fallback request mid-walk stops further filesystem reads (verified by observing the walker stops emitting after the abort).
- Performance sanity: on a 50k-file workspace, fallback returns first results in under ~2s. (Not a hard SLO — fallback is the degraded path.)

---

### U5. Client: convert `files-store` to per-query fetch with abort

**Goal:** Replace the cache-everything store with a per-query store that issues debounced, abortable requests against the new endpoint.

**Requirements:** R8, R9, R13.

**Dependencies:** U2.

**Files:**
- `src/client/stores/files-store.ts` (significant rewrite)

**Approach:**
- Remove `fetchFiles` / `refreshFiles` and the `filesByWorkspace` cache. Replace with `searchFiles(workspaceId, query)` that:
  - Cancels any in-flight `AbortController` for the same workspace before issuing a new request.
  - Debounces with a 120ms tail timer (clear on new query, fire on idle).
  - Stores results under `resultsByWorkspace[workspaceId]`, plus `loading` and `error` keyed by workspace.
- Preserve the `useFiles(workspaceId)` hook signature minus `fetch`/`refresh` — replace those with `search(query: string)` and `clear()`. (U6 updates the call sites.)
- Treat an `AbortError` rejection as a normal cancellation, not an error to surface.

**Patterns to follow:** Existing zustand store conventions in `src/client/stores/` (named exports, no class wrappers, hook helper at the bottom of the file).

**Verification scenarios:**
- **Covers AE2.** Typing `userSer` quickly (six characters in <200ms) results in exactly one network request being completed; intermediate requests are aborted (verified in DevTools → Network → status `(canceled)`).
- Opening the picker on a 1M-file workspace does not freeze the UI (no `fetchFiles` call on open; the empty-query request returns the first 200 entries within ~1s).
- Closing and reopening the picker without typing issues a fresh empty-query request rather than reusing stale results.
- A request that fails (5xx) sets `error` and surfaces in `FilePicker`'s existing error branch.

---

### U6. Client: rewire `FilePicker` to use per-query results

**Goal:** `FilePicker` no longer filters a cached array; it asks the store to search and renders whatever comes back, preserving the existing UI surface.

**Requirements:** R14, R13.

**Dependencies:** U5.

**Files:**
- `src/client/components/FilePicker.tsx` (modified)
- `src/client/components/PromptInput.tsx` (modified — props passed to `FilePicker` likely unchanged, but verify)

**Approach:**
- Replace `useFiles().files` + local `filter` substring filter with `useFiles().search(filter)`, then render `results` directly. Remove the `useMemo` filter at FilePicker.tsx:109-113 and the local `setFilter` effect that no longer needs to reset to `initialFilter`.
- `initialFilter`: pass through to `search(initialFilter)` on open instead of as a local substring filter seed.
- `refetchOnOpen`: this prop becomes a no-op (the server is now the cache); leave it in the prop shape for now to keep `PromptInput` callsites stable, mark deprecated in a one-line comment, plan to remove in a follow-up.
- Loading/empty/error branches keep their current visual treatment. Add nothing new.
- Keyboard navigation, popover anchor, icon rendering, and `@`-mention integration in `PromptInput` are untouched.

**Patterns to follow:** Existing `FilePicker.tsx` and `PromptInput.tsx` structure; mirror their effect-cleanup and keyboard-handler shapes.

**Verification scenarios:**
- **Covers AE5.** Typing `@foo` in the prompt opens the picker at the same anchor as today, with Arrow / Enter / Esc / Tab behaving identically, and selecting a result inserts the path identically.
- The Files button opens the picker with empty-query results (first 200 files), same visual.
- On a 1M-file workspace, typing into the filter does not freeze the UI; results refresh smoothly.
- Loading state appears for queries that take >100ms (debounce window covers shorter ones).
- After picker close, the next open issues a fresh empty-query request, not stale results.

---

### U7. Distribution: bundle `rg` for sidecar and Tauri builds

**Goal:** Ensure the ripgrep binary travels with the production app and is resolvable by the pkg-packaged sidecar.

**Requirements:** R15, R16.

**Dependencies:** U2 (the resolution order it defines is what U7 plugs into).

**Files:**
- `scripts/build-sidecar.ts` (modified — add a "Copy ripgrep binary" step)
- `src-tauri/src/lib.rs` (modified — pass the resolved `rg` path to the sidecar via env var)
- (no `src-tauri/tauri.conf.json` change expected — `resources/` is already a bundled directory)

**Approach:**
- In `scripts/build-sidecar.ts`, after the existing "Copy Claude Code binary" step, add a "Copy ripgrep binary" step:
  - Resolve `rgPath` via `require('@vscode/ripgrep')` in the script's Node context.
  - Copy the binary to `src-tauri/resources/rg` (or `rg.exe` on Windows). Same shape as the `claude` copy step.
- In `src-tauri/src/lib.rs`, when constructing the sidecar command, resolve the bundled `rg` resource path via Tauri's `resource_dir()` API and pass it to the sidecar as `RG_PATH=<absolute path>` in the environment. U2's resolution order picks this up.
- Dev mode (`npm run dev:server`) reads `@vscode/ripgrep`'s `rgPath` directly from `node_modules` — no env var needed, no Tauri wrapper involved.

**Patterns to follow:**
- Existing copy step for `claude` and `better_sqlite3.node` in `scripts/build-sidecar.ts` (cross-platform binary name, source from `node_modules`, dest in `src-tauri/resources/`).
- Existing sidecar env-var passing pattern in `src-tauri/src/lib.rs` (whatever shape is used today for env injection — verify before changing).

**Verification scenarios:**
- After `npm run release` (or `npm run tauri:build`), the produced `.app`/`.dmg`/`.msi` bundle contains `rg` in its resources directory (verified by `ls Contents/Resources/` on macOS).
- Launching the packaged app on a fresh machine (no Homebrew ripgrep installed) and opening the file picker returns `source: 'rg'` results (verified via dev tools network panel).
- Removing `node_modules/@vscode/ripgrep` (simulating a missing dev install) and running `npm run dev` still works for the picker — falls back to `source: 'fallback'`. Both prod and dev paths covered.

---

## System-Wide Impact

| Surface | Change |
|---|---|
| `src/server/routes/files.ts` | `?recursive=true` path removed; new `GET /search` added. Single-level listing and `/content` unchanged. |
| `src/server/services/file-search.ts` | New module; owns ripgrep spawning, fallback walker, and ranking. |
| `src/server/index.ts` | No route-mount change. |
| `src/client/stores/files-store.ts` | Cache-everything replaced with per-query store; `fetch`/`refresh` → `search`/`clear`. |
| `src/client/components/FilePicker.tsx` | Local substring filter removed; renders server results directly. |
| `src/client/components/PromptInput.tsx` | Prop pass-through unchanged; `refetchOnOpen` becomes a deprecated no-op. |
| `scripts/build-sidecar.ts` | New copy step for `rg` binary. |
| `src-tauri/src/lib.rs` | Injects `RG_PATH` env var into the sidecar process. |
| `package.json` | Adds `@vscode/ripgrep`, `fdir`, `fuzzysort`, `ignore`. |

**Out of scope for this plan (would touch the same surfaces but deferred):**
- Full-text content search (would extend `/files/search` to a second mode).
- File watcher / persistent index.
- Generalizing ripgrep to other tools (search-in-files).
- Per-workspace custom ignore patterns.
- Removing the deprecated `refetchOnOpen` prop (follow-up cleanup).

---

## Scope Boundaries

- Full-text search across file contents — separate feature.
- Persistent on-disk index or `chokidar` file watcher — explicitly rejected in the brainstorm; not revisited here.
- Picker UI redesign (icons, layout, popover behavior) — unchanged.
- Custom per-workspace ignore patterns beyond `.gitignore` — deferred.
- Workspace-scoped result caching across opens — not in v1.
- Generalizing ripgrep to other surfaces — out of scope here.

### Deferred to Follow-Up Work

- Remove the deprecated `refetchOnOpen` prop from `FilePicker` and its callers in `PromptInput` once nothing relies on it. Kept temporarily to minimize churn in U6.
- Add `vitest` + the first batch of unit tests for `file-search.ts`. The repo has no test harness today; introducing one is a separate change.

---

## Dependencies / Assumptions

- `@vscode/ripgrep` ships per-platform binaries via `optionalDependencies` (microsoft/vscode-ripgrep README confirms this). No postinstall network call, no offline-install concern, no manual install step.
- The pkg-packaged sidecar (`scripts/build-sidecar.ts`) bundles JS but cannot bundle a native binary into the executable — binaries must travel via `src-tauri/resources/`, matching the existing pattern for `claude` and `better_sqlite3.node`.
- Tauri's resource resolution exposes the bundled `rg` path to the sidecar process via env var (the sidecar already accepts injected env vars in `src-tauri/src/lib.rs` per the existing pattern; verify exact API at implementation time).
- `fdir` + `ignore` together cover `.gitignore` semantics correctly including nested files and negations (verify on the U4 verification step; the `ignore` package is the de-facto JS implementation of git's ignore spec and is used by ESLint and Prettier).
- The picker's existing UI contract — `@`-mention trigger in `PromptInput`, popover anchor, keyboard model — survives the data-source swap without UX changes (R14 is preserved by U6).

---

## Outstanding Questions

### Resolve Before Implementation

- _(none — all blocking questions resolved during planning)_

### Deferred to Implementation

- [Affects U2][Technical] Decide between `rg --files | rg <pattern>` (two-stage filter, simpler ranking) and `rg --files --iglob '*<pattern>*'` (single process, less Node-side coordination) based on a quick benchmark at implementation time. Plan currently writes for the second; U2's verification scenarios cover both behavioral outcomes.
- [Affects U7][Technical] Confirm the exact Tauri env-injection API used today by `src-tauri/src/lib.rs` and match it for `RG_PATH`. If env injection from Rust isn't already wired, the simpler alternative is for the sidecar to resolve the resource path itself via the `sidecar-node` process's known location relative to `Contents/Resources/`.
- [Affects U4][Needs research] Spot-check `fdir` + `ignore` against a workspace with a deeply nested `.gitignore` containing negations during U4 implementation. If the combination is incorrect, swap to `globby` (which uses `ignore` internally and handles nested gitignore composition out of the box) at the cost of a slightly heavier dependency.
- [Affects U2, U5][Technical] Decide whether to expose `truncated: boolean` in the picker UI ("showing top 200 of N matches") or treat it silently. Lean toward silent for v1; revisit if users ask.
