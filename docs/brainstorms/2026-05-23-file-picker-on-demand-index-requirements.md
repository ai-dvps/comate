---
date: 2026-05-23
topic: file-picker-on-demand-index
---

# File Picker On-Demand Index

## Summary

Replace the file picker's eager "walk the whole workspace into memory" model with on-demand ripgrep queries via `@vscode/ripgrep`, so `@`-mention and the Files button stay responsive on workspaces ranging from a few hundred to ~1M files. Honor `.gitignore` and skip `.git` / `node_modules` by deferring to ripgrep's native ignore handling. Keep filename-only search; full-text search is a separate feature.

---

## Problem Frame

Today, opening the file picker on a large workspace freezes the application. When the user types `@` or clicks the Files button, the client fetches `GET /api/workspaces/:id/files?recursive=true`, which recursively walks the entire workspace folder with no ignore filtering — `.git`, `node_modules`, `dist`, and any other ignored directory are all traversed and serialized into a single JSON response. The client then holds the full list in memory and renders it without virtualization.

On a typical Node project, walking `node_modules` alone can produce tens of thousands of file entries; on a monorepo with vendored dependencies or data directories, the cost climbs into hundreds of thousands or more. The pain shows up at three layers stacked together: the server walk blocks for seconds, the JSON payload bloats the response and the in-memory list, and the picker's flat (non-virtualized) DOM render multiplies the cost again on every keystroke. The cumulative effect is that the picker — a frequently-used, low-friction primitive — becomes the slowest interaction in the app on real workspaces.

The user's intent is broader than a one-off perf fix: the picker should behave correctly on workspaces shaped like Git repositories (respecting `.gitignore`, ignoring junk paths), and the scale ceiling should be high enough to survive monorepos.

---

## Requirements

**Indexing mechanism**
- R1. The file picker MUST source its candidate list by invoking `ripgrep --files` (filename listing mode) on demand, rather than maintaining an in-memory snapshot built from a full recursive walk.
- R2. The ripgrep binary MUST be supplied via the `@vscode/ripgrep` npm package, which downloads a platform-appropriate prebuilt binary at install time and exposes its path through the package's API.
- R3. The system MUST support both query modes ripgrep provides for filename matching: piping `rg --files` into a second `rg <pattern>` filter, OR using a single `rg --files -g '*<pattern>*'` call. The chosen mode is an implementation detail for planning, but the requirement is that filtering happens inside ripgrep, not after materializing the full list in Node.
- R4. The picker MUST NOT maintain a persistent on-disk index or a file watcher in this feature. Each query is a fresh process invocation.

**Ignore semantics**
- R5. The picker MUST respect the workspace's `.gitignore` file when one is present, including nested `.gitignore` files in subdirectories, by relying on ripgrep's native gitignore handling (no separate parsing layer).
- R6. The picker MUST skip `.git`, `node_modules`, and other directories that ripgrep ignores by default, even when no `.gitignore` exists in the workspace.
- R7. Hidden files (dotfiles other than ignored directories) MAY be included; this behavior follows ripgrep's defaults and need not be configurable in this feature.

**Query lifecycle**
- R8. Each keystroke in the filter input MUST be debounced so a burst of rapid input does not spawn one ripgrep child per character.
- R9. When a new query supersedes an in-flight query, the in-flight ripgrep child process MUST be terminated so it does not contend for CPU with the new query.
- R10. The picker MUST cap the number of results returned to the client (e.g., top N matches) so that rendering and network cost stay bounded even when a query matches a large fraction of the workspace.

**Ranking**
- R11. Results MUST be ranked by relevance to the query rather than alphabetical path order — a small fuzzy-ranking pass (e.g., `fuzzysort` or equivalent) is applied to the top-N candidates returned by ripgrep, so that the most likely intended path appears first.

**Fallback**
- R12. When the `@vscode/ripgrep` binary is unavailable at runtime (e.g., postinstall failed, sandboxed environment), the picker MUST degrade to a pure-Node walker that applies `.gitignore` + `.git` / `node_modules` filtering and still returns useful results, even if slower. The picker MUST NOT show an empty list or an error in this case.

**Client-side behavior**
- R13. The client MUST NOT request a full recursive file listing on picker open. The store's existing "fetch all files once and filter locally" pattern is replaced by per-query server calls.
- R14. The file picker's UI surface (icons, keyboard navigation, anchor / popover behavior, `@`-mention integration in `PromptInput`) MUST remain visually and behaviorally unchanged. Only the data source changes.

**Distribution**
- R15. The Tauri production bundle MUST include the ripgrep binary so the desktop app works without requiring users to install ripgrep separately. Either route is acceptable: (a) let Tauri's resource bundling pick up `node_modules/@vscode/ripgrep/bin/`, or (b) stage the binary as a Tauri sidecar alongside the existing `sidecar-node`. The choice belongs to planning.
- R16. The dev workflow (`npm run dev:server` / `npm run dev:client`) MUST work without manual installation steps beyond `npm install`. Postinstall is the only acceptable install-time step.

---

## Acceptance Examples

- AE1. **Covers R1, R5, R6.** Given a workspace with `.git`, `node_modules`, and a `.gitignore` excluding `dist/`, when the user opens the file picker and types `index`, the results include `src/index.ts` and exclude paths under `.git/`, `node_modules/`, and `dist/`.
- AE2. **Covers R8, R9.** Given the user types `userSer` quickly (six characters in under 200ms), only one ripgrep query reaches completion; any ripgrep child started for an intermediate prefix is terminated before producing results, and the rendered list reflects the final query only.
- AE3. **Covers R10, R11.** Given a query that matches 50,000 paths, the picker displays at most the top N (planning chooses N, e.g., 200) results ordered by fuzzy-match score, with the closest filename match at the top.
- AE4. **Covers R12.** Given a deployment where `@vscode/ripgrep`'s postinstall did not produce a binary, when the user opens the picker and types `index`, results still appear (sourced from the Node fallback walker), and no user-visible error is shown.
- AE5. **Covers R14.** Given the existing `@`-mention flow in `PromptInput`, when the user types `@foo`, the picker opens in the same position, with the same keyboard navigation (Arrow / Enter / Esc / Tab), and selecting a result inserts the path identically to today.

---

## Success Criteria

- Opening the file picker on a 100k-file workspace (post-ignore) returns first results within ~300ms and never blocks the UI for more than 100ms in any single frame.
- On the 1M-file ceiling, queries complete within ~1s under normal load; the app remains responsive (no perceived freeze) during the query.
- `.git` and `node_modules` never appear in picker results on any workspace, regardless of whether `.gitignore` exists.
- A developer cloning the repo and running `npm install && npm run dev` gets the fast picker with no extra setup.
- `ce-plan` can pick up this document without needing to invent which binary distribution path to use, what the fallback is, or what ignore semantics are required.

---

## Scope Boundaries

- Full-text content search across workspace files — separate feature, not part of this work.
- Persistent on-disk index or `chokidar`-based file watcher — explicitly rejected in favor of cheap on-demand queries.
- Changes to the picker's visual design, icons, popover positioning, or keyboard model — the UI stays as-is.
- Custom ignore patterns beyond `.gitignore` (e.g., user-configured per-workspace ignores) — deferred.
- Workspace-scoped result caching across picker opens — not in this feature; each open starts cold. May revisit if measurements show repeated identical queries are common.
- Generalizing ripgrep to other parts of the app (e.g., search-in-files, grep tools) — out of scope here; the abstraction can be lifted later if other surfaces want it.

---

## Key Decisions

- **Use `@vscode/ripgrep` rather than bundling our own ripgrep / fd / fdir sidecar.** It's the same package VSCode itself uses for its "Go to File" picker; the supply chain is well-trodden, the postinstall handles per-platform binaries, and the API exposes `rgPath` directly so the Node server can spawn it without shelling out by name.
- **Filename-only search.** The picker's job is path completion. Filename-only is what unlocks the 1M-file ceiling cheaply; full-text matching would require either a much heavier index or a query pattern that ripgrep can't stream efficiently.
- **No persistent index, no watcher.** Ripgrep on a cold workspace is fast enough that the carrying cost of an index (invalidation, cross-platform watching, storage location, stale state across branches) is not worth the marginal win. Re-evaluate only if measurement shows otherwise.
- **Pure-JS fallback exists but is not the primary path.** Fallback's job is "the picker still works" — not "the picker is fast." It uses `fdir` + the `ignore` package for `.gitignore`-correct walking when ripgrep is unavailable.
- **Per-keystroke spawn with cancel-on-supersede.** Simpler than maintaining a long-lived ripgrep streaming server and avoids stuck processes on input bursts. Debounce + abort is the standard pattern.

---

## Dependencies / Assumptions

- `@vscode/ripgrep` is permissively licensed (MIT) and actively maintained; its postinstall reliably produces a binary on macOS (arm64 + x64) and Windows x64 — the platforms this repo's `build:sidecar` already targets.
- The Tauri shell plugin allows spawning a binary whose path is supplied at runtime (either via `tauri-plugin-shell`'s sidecar mechanism or by allowing the server to spawn a child process directly via Node, since the Node sidecar already runs as a child of the Tauri app).
- The current `files-store` and `FilePicker` component contracts (workspace-scoped store, debounced filter, popover anchoring, `@`-mention integration in `PromptInput`) can absorb a "fetch per query" data source without an API redesign.
- The decision between letting Tauri pick up `node_modules/@vscode/ripgrep/bin/` and staging ripgrep as a second sidecar is a planning-time concern; both are feasible and the brainstorm does not lock it in.
- The `@vscode/ripgrep` postinstall step adds a network call to `npm install` and ~5MB per platform to `node_modules`. CI caching mitigates this in practice; offline-only installs would need a local mirror or a vendored binary, which is out of scope here.

---

## Outstanding Questions

### Resolve Before Planning

- _(none)_

### Deferred to Planning

- [Affects R15][Technical] Should the Tauri production bundle pick up `@vscode/ripgrep`'s binary directly from `node_modules`, or stage it as a Tauri sidecar alongside `sidecar-node`? Hermetic-sidecar pattern vs. less ceremony — planning picks after looking at how the existing `sidecar-node` packaging works.
- [Affects R3][Technical] `rg --files | rg <pattern>` vs `rg --files -g '*<pattern>*'`: which performs better on huge workspaces, and does either materially change cancellation semantics? Planning may benchmark.
- [Affects R10, R11][Technical] What is the right value for the result cap N, and does fuzzy ranking happen in Node or could it be approximated by ripgrep's own scoring? Planning picks based on measurement.
- [Affects R12][Needs research] Confirm `fdir` + `ignore` correctly handles nested `.gitignore` files with negations on the fallback path, or pick a different walker / parser combination.
- [Affects R8, R9][Technical] Server-side debounce + abort vs. client-side debounce + server-side abort-on-new-request — which gives the cleanest cancellation story given the existing express route shape?
