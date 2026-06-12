---
title: Skills Page — vercel-labs/skills Vendoring for Direct Skill Install
type: feat
status: completed
date: 2026-06-12
origin: docs/brainstorms/2026-06-12-skills-page-requirements.md
---

# Skills Page — vercel-labs/skills Vendoring for Direct Skill Install

## Summary

Build a top-level Skills page in Comate, sibling to the Plugins page, that lets users search skills.sh, install individual SKILL.md bundles from URLs/repos through a multi-select picker, and manage installed skills (list/remove/update). The backend vendors a curated subset of vercel-labs/skills TypeScript source via git subtree and exposes it through an adapter layer that strips telemetry and hardcodes Claude Code paths.

---

## Problem Frame

Comate's Plugin Manager models Claude Code plugins — heavyweight packages that bundle skills, commands, hooks, MCP servers, and agents via marketplaces. But users often want a lighter operation: install a single SKILL.md bundle from a URL or known repo without registering a marketplace or pulling commands/hooks they didn't ask for. The vercel-labs/skills ecosystem is the de facto standard for this (`SKILL.md` + YAML frontmatter, hosted in git repos, installable via `npx skills add`). Today this requires dropping to a terminal. The origin requirements doc (above) defines the WHAT; this plan defines HOW to vendor and integrate.

---

## Requirements

Traceability to origin R-IDs in parentheses.

- R1. Skills page is reachable from a new toolbar button alongside Plugins. (origin R1)
- R2. URL input accepts GitHub shorthand, full GitHub URLs, GitHub tree URLs, git URLs, GitLab URLs, local paths. (origin R2)
- R3. Keyword search queries skills.sh via vendored `searchSkillsAPI` and renders result cards. (origin R3)
- R4. Resolved source shows every discovered skill as multi-select picker, none pre-checked. (origin R4)
- R5. Install modal scope picker: Project + Global only, none pre-selected, Install disabled until scope chosen. (origin R5)
- R6. Copy is the only install method in v1. (origin R6)
- R7. Install flow has choosing → installing → result phases; failure shows Retry/Cancel with no partial state. (origin R7)
- R8. Already-installed skill in chosen scope shows Reinstall/Cancel instead of Install. (origin R8)
- R9. Installed list shows skills from project + global lock files with scope badges. (origin R9)
- R10. Each entry exposes Remove (with confirm) and Update actions. (origin R10)
- R11. "Update all" action runs update flow for every installed skill. (origin R11)
- R12. Installed skills recorded in `skills-lock.json` (project) and `~/.agents/.skill-lock.json` (global) in upstream format. (origin R12)
- R13. Vendor minimal upstream subset; do not modify vendored files. (origin R13)
- R14. No calls to `add-skill.vercel.sh` from Comate. (origin R14)
- R15. MIT license attribution preserved in `LICENSES/`. (origin R15)

**Origin actors:** A1 (End user), A2 (skills.sh registry), A3 (Source repository), A4 (Vendored vercel-labs/skills source)
**Origin flows:** F1 (Search + install), F2 (Install from URL), F3 (Remove), F4 (Update one), F5 (Update all)
**Origin acceptance examples:** AE1 (multi-source install flow), AE2 (network failure retry), AE3 (already-installed reinstall), AE4 (lock-file reads existing CLI skills), AE5 (search results), AE6 (copy not symlink)

---

## Scope Boundaries

- Multi-agent targeting (Cursor/Codex/etc.) — Claude Code paths only.
- Symlink as install method — copy only.
- Browse/scroll skills.sh catalog — keyword search only.
- Cross-visibility with Plugin Manager — each surface shows only its own.
- Skills carrying `.claude-plugin/marketplace.json` with skill entries — those are plugins, stay in Plugin Manager.
- Per-skill version pinning to tag/branch — always latest commit on default branch.
- "Run `skills use`" prompt generator — install/manage only.
- Pushing fixes upstream to vercel-labs/skills — Comate maintains a private vendored copy.
- File-collision detection between Skills page and Plugin Manager installs in `.claude/skills/`.
- Auto-migration of existing CLI-installed symlinks — coexist, label as legacy.

### Deferred to Follow-Up Work

- Telemetry audit tooling (CI check that `add-skill.vercel.sh` doesn't appear in sidecar bundle): future hardening PR.
- Per-skill changelog viewer (show diff between installed and upstream commits): future iteration.
- Skill deprecation warnings (if upstream marks a skill deprecated): future iteration.

---

## Context & Research

### Relevant Code and Patterns

**Server (mirror exactly):**
- `src/server/routes/plugins.ts` — route shape: validate → resolve `workspacePath` → service → JSON; status codes 400/404/409/422/500
- `src/server/services/plugin-settings-service.ts` — singleton service class pattern, scope-aware methods
- `src/server/services/marketplace-service.ts` — singleton, fetch from registries with timeout
- `src/server/utils/claude-settings.ts` (lines 273-301) — atomic write via temp file + rename + backup
- `src/server/utils/plugin-downloader.ts` — DO NOT reuse; `validateManifest` requires `plugin.json`, which skills lack
- `src/server/storage/sqlite-store.ts` — singleton `store`, `get(id).folderPath` for workspace resolution
- `src/server/index.ts:88` — route mount point pattern (`app.use('/api/<resource>', routes)`)

**Client (mirror exactly):**
- `src/client/components/SessionList.tsx:303-346` — toolbar button + overlay mount (where the new Skills button goes)
- `src/client/components/PluginSettingsPage.tsx` — full-screen overlay structure (`fixed top-11 inset-x-0 bottom-0 z-50`)
- `src/client/components/PluginMarketplaceTab.tsx` — search input with 300ms debounce, clear button, result cards
- `src/client/components/ScopePickerModal.tsx` — phase machine (`choosing → installing → result`), radio-card scope picker
- `src/client/components/ConfirmDialog.tsx` — confirm modal pattern
- `src/client/stores/plugin-store.ts` — Zustand pattern with `i18next.t('settings:plugins.<key>', '<fallback>')`
- `src/client/stores/workspace-store.ts` — `activeWorkspaceId` selector

**Build:**
- `scripts/build-sidecar.ts` — esbuild bundles everything reachable from `src/server/index.ts`; `import.meta.url` shims are regex-patched (lines 132-150); test `npm run build:sidecar` early with vendored code

**Existing state on disk:**
- `skills-lock.json` (repo root) — version 1, 3 entries (vercel-labs/agent-skills)
- `~/.agents/.skill-lock.json` — version 3 schema
- `.claude/skills/<name>/` are symlinks into `.agents/skills/<name>/` (legacy CLI install)

### Institutional Learnings

- `docs/solutions/conventions/commit-plan-and-brainstorm-files-with-code-changes.md` — stage this plan + the brainstorm doc in the same commit as the implementation; mark plan status `completed`
- All other dimensions (vendoring, plugin-manager internals, telemetry stripping, sidecar bundling, workspace FS access, lock-file format, i18n, generic HTTP retry) are greenfield — mine the Plugin Manager source directly as the closest thing to institutional memory

### External References

- `vercel-labs/skills` README: https://github.com/vercel-labs/skills
- skills.sh search API: `${SKILLS_API_URL || 'https://skills.sh'}/api/search?q=<query>&limit=10` → `{ skills: [{ id, name, source, installs }] }`
- Atomic write pattern (POSIX rename): https://man7.org/linux/man-pages/man2/rename.2.html

---

## Key Technical Decisions

- **Git subtree under `src/server/vendor/vercel-skills/`**: native git workflow, preserves upstream history as squashed commits, sync via `git subtree pull --prefix=src/server/vendor/vercel-skills https://github.com/vercel-labs/skills.git main --squash`. Chosen over submodule (avoids clone complexity + double-copy) and manual copy (automates conflict detection).
- **Adapter pattern over vendored-file modification**: our `src/server/services/skills/*.ts` imports pure upstream modules and reimplements clack-wrapped ones (notably `searchSkillsAPI` from `find.ts`). Vendored files stay untouched so subtree pulls never conflict. Telemetry stripping happens at the adapter boundary by simply not importing `telemetry.ts` and not calling `track()`.
- **Two independent lock-file schemas** (matching upstream): project `<workspace>/skills-lock.json` (version 1) and global `~/.agents/.skill-lock.json` (version 3). Global uses dot-prefix because it's per-user hidden state; project has no dot because it's meant to be committed.
- **`skillFolderHash` replaced with local SHA-256**: upstream computes this via GitHub Trees API (`execSync` call). For Comate, compute from local installed files — same update detection semantics (re-install on Update click compares local vs upstream commit, not hash-vs-hash), no GitHub API network call from the install path.
- **Hardcoded Claude Code paths instead of vendoring `agents.ts`/`detect-agent.ts`**: `.claude/skills/` (project), `~/.claude/skills/` (global). Drops 70+ agent definitions.
- **Copy, not symlink**: avoids broken-link surprises if cache moves, Git pollution in workspace, Windows quirks.
- **Coexist with existing symlinks, no migration**: Skills page reads lock files as-is. Pre-existing CLI-installed skills render with a `symlinked (legacy)` badge; new installs are copies. No silent filesystem mutation.
- **`PluginRedirectPlaceholder` updated to point at the new Skills page**: workspace-settings Skills tab currently redirects to Plugin Manager. After this plan, it redirects to the top-level Skills page.
- **No `Workspace.skills` DB column usage**: legacy field unrelated to skills-lock.json source-of-truth model.

---

## Open Questions

### Resolved During Planning

- **Where do skills button + page mount?** SessionList footer (lines 303-346), mirroring Plugin Manager exactly. Not HeaderToolbar.
- **Vendoring sync workflow?** Git subtree.
- **Existing symlink migration?** Coexist, label as `symlinked (legacy)`, no automatic rewrite.
- **Global lock file path?** `~/.agents/.skill-lock.json` (matches upstream; not `~/.claude/`).
- **Lock file format?** Two independent schemas — project version 1, global version 3. Read/write both via a single utility with two code paths.
- **`searchSkillsAPI` signature?** Returns `Promise<SearchSkill[]>` where `SearchSkill = { name, slug, source, installs }`. Endpoint: `/api/search?q=<query>&limit=10`.

### Deferred to Implementation

- **Exact module-by-module vendor map** (which upstream files import cleanly vs need adapter shim): determine by reading deps of each candidate module during U2; build-time check that `add-skill.vercel.sh` and `@clack/prompts` don't appear in the bundled sidecar.
- **`import.meta.url` shape in vendored code**: if the sidecar build regex at `scripts/build-sidecar.ts:132-150` doesn't catch a new shim shape, extend it; the script's sanity check throws on unpatched shims with a clear error.
- **Install progress streaming vs simple spinner**: the origin's R7 is satisfied by a simple spinner with status text; defer real-time streaming to a follow-up if UX testing shows it's needed.
- **Update behavior with local edits**: when user clicks Update on a skill they manually edited, overwrite cleanly from upstream (matches `npx skills update` semantics). Surface a one-line warning in the confirm dialog.
- **Sync cadence and breaking-change drift**: first sync after 6 months will reveal how often upstream breaks the adapter; capture as a `docs/solutions/` learning at that point.

---

## Output Structure

```
src/server/
  vendor/
    vercel-skills/                 # git subtree, READ-ONLY after pull
      src/                          # upstream TypeScript source (untouched)
        local-lock.ts
        skill-lock.ts
        find.ts
        skills.ts
        source-parser.ts
        frontmatter.ts
        sanitize.ts
        types.ts
        constants.ts
        ...
      LICENSE                       # MIT, carried from upstream
      package.json                  # upstream manifest (not installed)
      README.md                     # upstream README
  services/
    skills/                         # adapter layer (our code)
      claude-code-paths.ts          # hardcoded paths, drops agents.ts
      search.ts                     # searchSkillsAPI reimplementation (no telemetry)
      source-resolver.ts            # URL/source parsing, wraps source-parser.ts
      installer.ts                  # install logic, hardcoded to claude-code
      index.ts                      # public re-exports
    skills-service.ts               # business logic (install/list/remove/update)
    skills-service.test.ts
  routes/
    skills.ts                       # /api/skills/* endpoints
  utils/
    skills-lock.ts                  # atomic read/write for both lock schemas
    skills-lock.test.ts
src/client/
  components/
    SkillsPage.tsx                  # full-screen overlay (installed + search tabs)
    SkillInstallModal.tsx           # multi-select picker + 2-scope picker + phase machine
    SkillInstallModal.test.tsx      # if client test infra exists; otherwise manual
  stores/
    skills-store.ts                 # Zustand
LICENSES/
  vercel-skills-MIT.txt             # attribution (if not already present)
src/client/i18n/
  en/settings.json                  # add `skills` block under `settings`
  zh-CN/settings.json               # mirrored `skills` block
```

The `vendor/vercel-skills/` subtree contains the entire upstream repo for license/sync hygiene; we only import from a curated subset of `src/` modules via the adapter layer.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```mermaid
flowchart TB
  subgraph client["Client (React 18 + Zustand)"]
    Button["Skills button<br/>SessionList:303-346"]
    Page["SkillsPage<br/>(Installed + Search tabs)"]
    Modal["SkillInstallModal<br/>(multi-select + scope picker)"]
    Store["skills-store"]
  end

  subgraph server["Server (Express sidecar)"]
    Route["/api/skills/*<br/>routes/skills.ts"]
    Svc["SkillsService<br/>services/skills-service.ts"]
    Lock["skills-lock utility<br/>utils/skills-lock.ts"]
    Adapter["skills adapter<br/>services/skills/*"]
  end

  subgraph vendored["Vendored (git subtree — read-only)"]
    Upstream["vendor/vercel-skills/src/<br/>local-lock.ts, skill-lock.ts,<br/>skills.ts, source-parser.ts,<br/>find.ts (for spec reference),<br/>frontmatter.ts, sanitize.ts"]
  end

  subgraph fs["Filesystem"]
    ProjLock["<workspace>/skills-lock.json<br/>version 1"]
    GlobLock["~/.agents/.skill-lock.json<br/>version 3"]
    InstallTarget [".claude/skills/<br/>~/.claude/skills/"]
  end

  External["skills.sh<br/>/api/search"]
  PluginTab["workspace-settings<br/>Skills tab redirect"]

  Button --> Page
  PluginTab -.->|redirect| Page
  Page <--> Store
  Modal <--> Store
  Store <-->|fetch JSON| Route
  Route --> Svc
  Svc --> Lock
  Svc --> Adapter
  Adapter -->|import pure modules| Upstream
  Adapter -->|fetch /api/search| External
  Lock <-->|atomic read/write| ProjLock
  Lock <-->|atomic read/write| GlobLock
  Svc -->|copy files| InstallTarget
```

**Key boundary:** vendored files (subtree) are never modified by us. The adapter layer at `services/skills/*.ts` is our code — it imports pure upstream modules (those without `@clack/prompts`, `picocolors`, `telemetry.ts`, or `detect-agent.ts` deps) and reimplements the rest (`searchSkillsAPI`, the agent-aware `installer`). This means telemetry calls and clack prompts remain visible in the vendored source code but are never executed because the modules that call them are never imported.

**Data flow for install (F1/F2):**
1. Client pastes URL or clicks Install on search result → POST `/api/skills/resolve` returns discovered skill list
2. Client shows multi-select picker → user picks N skills + scope → POST `/api/skills/install`
3. Service clones/fetches source via `git.ts` (vendored) → walks SKILL.md container paths via `skills.ts` (vendored) → copies selected skill directories to scope target → updates lock file atomically
4. Response: success → entry added to Installed list; failure → 422 with error, no filesystem mutation

---

## Implementation Units

### U1. Vendor vercel-labs/skills source as git subtree

**Goal:** Pull the upstream repo into `src/server/vendor/vercel-skills/` for license hygiene and future sync.

**Requirements:** R13, R15

**Dependencies:** None

**Files:**
- Create: `src/server/vendor/vercel-skills/` (entire upstream tree via git subtree)
- Create: `LICENSES/vercel-skills-MIT.txt` (if upstream LICENSE not already covered)

**Approach:**
- `git subtree add --prefix=src/server/vendor/vercel-skills https://github.com/vercel-labs/skills.git main --squash`
- Verify upstream `LICENSE` (MIT) is preserved at `src/server/vendor/vercel-skills/LICENSE`
- Add a `src/server/vendor/vercel-skills/README-COMATE.md` noting: pinned commit, vendored subset policy, sync command, attribution
- Verify `npm run build:sidecar` still succeeds (vendored code isn't imported yet, so the subtree is just files on disk)

**Patterns to follow:**
- Existing `LICENSES/` directory conventions

**Test scenarios:**
- Test expectation: none — pure file-introduction commit. Verification is `git log --oneline src/server/vendor/vercel-skills/` shows subtree merge, and `npm run build:sidecar` succeeds without errors.

**Verification:**
- `src/server/vendor/vercel-skills/src/local-lock.ts`, `skill-lock.ts`, `find.ts`, `skills.ts`, `source-parser.ts` all exist
- `git subtree pull --prefix=src/server/vendor/vercel-skills https://github.com/vercel-labs/skills.git main --squash` reports "Already up to date." against the just-added commit (proves the sync workflow works — note: `--dry-run` is not a supported `git subtree` flag)

---

### U2. Adapter layer (curated upstream subset + telemetry-stripped reimplementations)

**Goal:** Create `src/server/services/skills/*.ts` that imports pure upstream modules and reimplements the rest, exposing a clean TS API surface for the service layer.

**Requirements:** R13, R14

**Dependencies:** U1

**Files:**
- Create: `src/server/services/skills/claude-code-paths.ts` — hardcoded `{ project: '.claude/skills/', global: '~/.claude/skills/' }` constants, drops `agents.ts`/`detect-agent.ts`
- Create: `src/server/services/skills/search.ts` — reimplementation of `searchSkillsAPI(query): Promise<SearchSkill[]>` calling skills.sh `/api/search` directly, no `track()` telemetry call, no `readline` import
- Create: `src/server/services/skills/source-resolver.ts` — wraps `vendor/vercel-skills/src/source-parser.ts`; verify it imports cleanly (no clack deps)
- Create: `src/server/services/skills/installer.ts` — wraps the install logic from `vendor/vercel-skills/src/installer.ts` but hardcodes claude-code agent path, drops agent-detection
- Create: `src/server/services/skills/index.ts` — public re-exports
- Test: `src/server/services/skills/search.test.ts`

**Approach:**
- For each upstream module needed, run `grep -E "^import" src/server/vendor/vercel-skills/src/<module>.ts`. If the dep list includes `@clack/prompts`, `picocolors`, `telemetry.ts`, `detect-agent.ts`, or `agents.ts` — that module gets reimplemented in the adapter, not imported. Otherwise it's imported directly.
- Expected importable-as-is: `local-lock.ts` (only fs/path/crypto deps), `skills.ts` (deps on frontmatter/sanitize/types/plugin-manifest — verify plugin-manifest has no clack deps), `frontmatter.ts`, `sanitize.ts`, `types.ts`, `constants.ts`, `source-parser.ts` (verify)
- Expected reimplementation: `searchSkillsAPI` (find.ts has clack/readline deps), `installer` logic (installer.ts imports agents.ts), `skill-lock.ts` partial (strip picocolors and `execSync` GitHub tree SHA call)
- Build-time check: after U2 lands, `npm run build:sidecar` and grep the bundled output for `add-skill.vercel.sh` — must be zero matches

**Execution note:** Start with the simplest possible adapter (just `searchSkillsAPI` reimplementation), verify build, then iteratively add modules. Building incrementally catches `import.meta.url` issues early.

**Patterns to follow:**
- Singleton export pattern from `services/marketplace-service.ts`
- Function signature for `searchSkillsAPI` mirrors upstream `find.ts` exactly (same return type `SearchSkill[]`) so future sync is mechanical

**Test scenarios:**
- Happy path: `searchSkillsAPI('typescript')` with mocked `global.fetch` returns array of `SearchSkill` objects sorted by installs
- Happy path: `source-resolver.parse('vercel-labs/agent-skills')` returns the same parsed shape upstream produces
- Error path: `searchSkillsAPI` when `fetch` throws returns `[]` (matches upstream catch-and-return-empty semantics)
- Edge case: `searchSkillsAPI('')` returns `[]` without calling fetch
- Integration: bundled sidecar output (from `npm run build:sidecar`) contains zero occurrences of `add-skill.vercel.sh`

**Verification:**
- `grep -r "add-skill.vercel.sh" dist/sidecar/` returns nothing
- `grep -r "@clack/prompts" dist/sidecar/` returns nothing
- All adapter modules export typed functions matching upstream signatures

---

### U3. Atomic skills-lock utility (both schemas)

**Goal:** Single utility that reads and writes both lock files atomically, mirroring the existing `claude-settings.ts:273-301` pattern.

**Requirements:** R12

**Dependencies:** U1

**Files:**
- Create: `src/server/utils/skills-lock.ts`
- Test: `src/server/utils/skills-lock.test.ts`

**Approach:**
- Two read functions: `readProjectLock(workspacePath): Promise<LocalSkillLockFile>` (version 1 schema) and `readGlobalLock(): Promise<SkillLockFile>` (version 3 schema). Use upstream's `readLocalLock` and `readSkillLock` from vendored modules where possible; wrap if signatures don't fit.
- Two write functions: `writeProjectLock(workspacePath, lock)` and `writeGlobalLock(lock)`. Both use temp-file + rename + backup pattern from `claude-settings.ts:273-301` — write `${path}.tmp`, rename original to `${path}.bak`, rename tmp to final, delete backup on success, restore backup on failure.
- Sorting: project lock sorts skills alphabetically when written (matches upstream's merge-friendly behavior). Global lock preserves insertion order (matches upstream).
- No file locking — atomicity relies on `renameSync` POSIX semantics.

**Patterns to follow:**
- `src/server/utils/claude-settings.ts:273-301` (atomic write helper)
- `src/server/utils/claude-settings.ts:36-58` (HOME/USERPROFILE resolution for global path)

**Execution note:** Test-first. Write the atomic-rename test before implementing, because if rename atomicity is wrong, every subsequent unit inherits the bug.

**Test scenarios:**
- Happy path: `writeProjectLock(tmpDir, { version: 1, skills: { b: {...}, a: {...} } })` then `readProjectLock(tmpDir)` returns skills sorted alphabetically (`a` before `b`)
- Happy path: `writeGlobalLock({...})` writes to `~/.agents/.skill-lock.json` (with HOME override to temp dir)
- Edge case: `readProjectLock(tmpDir)` when file doesn't exist returns `{ version: 1, skills: {} }`
- Edge case: `readProjectLock(tmpDir)` when file is corrupt JSON returns empty default, does not throw
- Error path: write fails (e.g., disk full simulated via mocked `writeFileSync` throwing) → backup file is restored, original content unchanged
- Integration: concurrent writes from two processes (use `child_process.spawnSync` in test) → last writer wins, file is never empty or corrupt

**Verification:**
- All test scenarios pass
- `npm run lint` clean
- Code review confirms atomic-rename pattern matches `claude-settings.ts:273-301`

---

### U4. SkillsService (business logic)

**Goal:** Server-side business logic for install/list/remove/update operations, orchestrated through the adapter layer and lock utility.

**Requirements:** R2, R4, R6, R7, R8, R9, R10, R11, R12

**Dependencies:** U2, U3

**Files:**
- Create: `src/server/services/skills-service.ts`
- Test: `src/server/services/skills-service.test.ts`

**Approach:**
- Singleton `SkillsService` class with methods:
  - `search(query: string): Promise<SearchSkill[]>` — delegates to adapter
  - `resolveSource(source: string): Promise<DiscoveredSkill[]>` — parse source, walk SKILL.md container paths via vendored `skills.ts`, return list
  - `listInstalled(workspacePath?: string): Promise<InstalledSkill[]>` — read both lock files, merge with scope badges, detect symlinked-legacy state
  - `install({ source, skills, scope, workspacePath }): Promise<InstallResult>` — fetch source, copy selected skills to scope target, write lock entry, return success/failure
  - `remove({ skillName, scope, workspacePath }): Promise<boolean>` — delete files, remove lock entry
  - `update({ skillName, scope, workspacePath }): Promise<UpdateResult>` — re-fetch source, re-copy, refresh lock entry with new commit hash
  - `updateAll(workspacePath?: string): Promise<UpdateResult[]>` — iterate over installed, call `update` per skill
- `isSymlinkedLegacy(skillPath)` helper: returns true if the installed skill directory is a symlink (vs real copy). Used to render the `symlinked (legacy)` badge.
- "Already installed in chosen scope" detection: check both lock files for the skill name in the target scope before allowing install; if found, surface to caller for R8 handling.

**Execution note:** Build install/remove/update against the existing repo state (3 vercel-labs skills already in lock file) so test fixtures can use real data.

**Patterns to follow:**
- `src/server/services/plugin-settings-service.ts` — class shape, singleton export, scope-aware methods
- `src/server/utils/sidecar-logger.ts` — `sidecarLog('[SkillsService] ...')` for diagnostics

**Test scenarios:**
- Happy path (Covers F2): `install({ source: 'vercel-labs/agent-skills', skills: ['web-design-guidelines'], scope: 'project', workspacePath: tmpDir })` creates `<tmpDir>/.claude/skills/web-design-guidelines/SKILL.md` as a real file (not symlink) and writes lock entry
- Happy path (Covers AE4): given existing `skills-lock.json` from CLI use, `listInstalled(tmpDir)` returns 3 skills with `Project` scope badge
- Edge case (Covers AE3): install a skill already in chosen scope returns `{ status: 'already-installed' }` without filesystem mutation
- Error path (Covers AE2): install when git clone fails (mock `simpleGit.clone` to reject) returns `{ status: 'error', error: 'Failed to download: ...' }` and leaves no partial files in `.claude/skills/`
- Edge case: `listInstalled` on skill whose directory is a symlink marks it `isLegacySymlink: true`
- Happy path (Covers F3): `remove({ skillName: 'web-design-guidelines', scope: 'project', workspacePath: tmpDir })` deletes directory and removes lock entry
- Happy path (Covers F4): `update({ skillName, scope, workspacePath })` re-fetches source and overwrites local files; lock entry's `updatedAt` refreshed
- Edge case: `update` on a `symlinked (legacy)` skill refuses with `{ status: 'error', error: 'Cannot update symlinked legacy skill via Skills page. Use npx skills update.' }`
- Integration: full install → list → remove cycle leaves no trace in `.claude/skills/` or lock file

**Verification:**
- All test scenarios pass
- Test coverage hits every public method
- Lint clean

---

### U5. Server route `/api/skills`

**Goal:** Express route group exposing SkillsService via REST, mounted at `/api/skills`.

**Requirements:** R1 (entry-point wiring server-side), all R2-R11 indirectly

**Dependencies:** U4

**Files:**
- Create: `src/server/routes/skills.ts`
- Modify: `src/server/index.ts` (add `app.use('/api/skills', skillRoutes)` near line 88)

**Approach:**
- Endpoints (mirror `plugins.ts` shape):
  - `GET /api/skills/installed?workspaceId=` — listInstalled
  - `GET /api/skills/search?q=` — search
  - `POST /api/skills/resolve` — body `{ source }`, returns discovered skills
  - `POST /api/skills/install` — body `{ source, skills[], scope, workspaceId? }`
  - `POST /api/skills/uninstall` — body `{ skillName, scope, workspaceId? }`
  - `POST /api/skills/update` — body `{ skillName, scope, workspaceId? }`
  - `POST /api/skills/update-all` — body `{ workspaceId? }`
- Status codes: 200 (success), 400 (bad input), 404 (workspace not found), 409 (already installed), 422 (download failed), 500 (catch-all)
- `assertSkillScope(scope)` helper validates `'project' | 'global'` (no `local`)
- Resolve `workspacePath` via `workspaceStore.get(workspaceId).folderPath` only when needed
- Each handler logs via `sidecarLog('[Skills API] ...')`

**Patterns to follow:**
- `src/server/routes/plugins.ts` (exact structure: try/catch, validation, status codes, sidecarLog)
- Mount pattern from `src/server/index.ts:88`

**Execution note:** Implement against an existing `workspaceId` from the local DB so curl-testing works against real fixtures.

**Test scenarios:**
- Happy path: `GET /api/skills/installed?workspaceId=<existing>` returns 200 with `{ skills: [...] }`
- Happy path: `POST /api/skills/install` with valid body returns 201 with `{ skill: {...} }`
- Error path: `POST /api/skills/install` with missing `source` returns 400
- Error path: `POST /api/skills/install` with invalid `scope` returns 400
- Edge case: `POST /api/skills/install` when skill already exists returns 409
- Error path: `POST /api/skills/install` when download fails returns 422 with error message
- Integration: `GET /api/skills/installed` after install returns the newly installed skill
- Integration: route is mounted at `/api/skills` (curl-test against running server)

**Verification:**
- All test scenarios pass via curl against a running sidecar
- `npm run lint` clean
- Route appears in `src/server/index.ts` mount list

---

### U6. SkillsPage component + SessionList button

**Goal:** Full-screen overlay component for the Skills surface, plus the toolbar button to open it.

**Requirements:** R1, R9

**Dependencies:** U5 (server route must exist for store to call), U8 (store)

**Files:**
- Create: `src/client/components/SkillsPage.tsx`
- Modify: `src/client/components/SessionList.tsx` — add sibling button near line 303-312, add overlay mount near line 340-346
- Modify: `src/client/i18n/en/settings.json` — add `skills` block under `settings`
- Modify: `src/client/i18n/zh-CN/settings.json` — mirrored `skills` block

**Approach:**
- Page structure mirrors `PluginSettingsPage.tsx`: full-screen overlay `fixed top-11 inset-x-0 bottom-0 z-50`, inner rounded card, backdrop blur, close button.
- Two tabs: `installed` (default) and `search`. Pill-button tab strip with `bg-accent/10 text-accent` for active.
- Installed tab: list of skill cards with scope badge, `symlinked (legacy)` tag if applicable, Remove and Update action buttons.
- Search tab: search input (300ms debounce, mirrors `PluginMarketplaceTab.tsx:99-109,244-261`), result cards with Install button.
- Empty states: "No skills installed yet" with link to Search tab; "No results" for empty search.
- Inline error pill + retry button pattern from `PluginSettingsPage.tsx:249-263`.
- Skills toolbar button in `SessionList.tsx`: lucide `BookOpen` (or `Sparkles`) icon, sibling to existing Plugins button, opens overlay via `setShowSkillsPage(true)`.

**Patterns to follow:**
- `src/client/components/PluginSettingsPage.tsx` (full-screen overlay structure, tab strip)
- `src/client/components/PluginMarketplaceTab.tsx` (search input with debounce, result cards)
- `src/client/components/SessionList.tsx:303-346` (toolbar button + overlay mount pattern)

**Test scenarios:**
- Test expectation: none — Comate has no client-side test infrastructure. Manual verification only.

**Verification:**
- Skills button renders in SessionList footer next to Plugins button
- Clicking Skills button opens full-screen overlay
- Tabs switch correctly
- Installed list populates from `/api/skills/installed`
- Search returns results after 300ms debounce
- All visible strings use `t('settings:skills.<key>', '<fallback>')` pattern
- i18n keys exist in both `en` and `zh-CN` settings.json
- Lint clean

---

### U7. SkillInstallModal (multi-select picker + 2-scope picker + phase machine)

**Goal:** Modal that resolves a source, shows multi-select picker, captures scope, runs install with phase machine and error/retry.

**Requirements:** R4, R5, R6, R7, R8

**Dependencies:** U5, U8

**Files:**
- Create: `src/client/components/SkillInstallModal.tsx`
- Modify: `src/client/i18n/en/settings.json` — add modal-specific strings to `skills` block
- Modify: `src/client/i18n/zh-CN/settings.json` — mirrored

**Approach:**
- Props: `{ source: string, workspaceId: string, onClose: () => void, onInstalled: () => void }`. Open from either: (a) SkillsPage search tab clicking Install on a result, (b) SkillsPage installed tab "Add from URL" button.
- On open: call `POST /api/skills/resolve` with source. Loading state → discovered skills list.
- Multi-select picker: checklist UI (none pre-checked), mirrors radio-card visual from `ScopePickerModal.tsx:140-163` but allows multiple selections.
- Scope picker: 2 radio cards (Project, Global), none pre-selected. Drop `local` from the `ScopePickerModal` pattern.
- Phase machine: `choosing` → `installing` → `result`. Reset on `isOpen` change.
- Install button disabled until at least one skill AND scope are selected.
- On install click: `POST /api/skills/install`. Transition to `installing` phase. On 201 → `result` (success auto-close after 1200ms, mirrors ScopePickerModal:44-52). On 409 → show "Already installed" inline with Reinstall/Cancel (R8). On 422 → show error + Retry/Cancel (R7).
- Reinstall path: re-call install with `force: true` flag (server-side overwrite semantics).

**Patterns to follow:**
- `src/client/components/ScopePickerModal.tsx` (phase machine, radio cards, auto-close timing)
- `src/client/components/ConfirmDialog.tsx` (centered modal z-index `[60]`)

**Test scenarios:**
- Test expectation: none — no client test infrastructure. Manual verification per AE1, AE2, AE3 scenarios.

**Verification:**
- (Covers AE1) Pasting `vercel-labs/agent-skills` shows 3 unchecked skills, Install disabled until one skill + scope selected
- (Covers AE2) Network failure mid-install shows error + Retry/Cancel; Cancel leaves no partial state
- (Covers AE3) Pre-existing skill in chosen scope shows "Already installed" with Reinstall/Cancel
- Modal closes on backdrop click, Esc key, and close button
- Lint clean, i18n keys present in both languages

---

### U8. skills-store (Zustand)

**Goal:** Client-side state management for skills data, mirroring `plugin-store.ts`.

**Requirements:** R1, R3, R9 (indirectly — provides data to UI)

**Dependencies:** U5

**Files:**
- Create: `src/client/stores/skills-store.ts`

**Approach:**
- `useSkillsStore` Zustand store with state: `{ installed: InstalledSkill[], searchResults: SearchSkill[], isSearching: boolean, isSaving: boolean, error: string | null, failedUpdateSkillName: string | null, updateError: string | null }`
- Actions: `fetchInstalled(workspaceId)`, `search(query)`, `install({ source, skills, scope, workspaceId })`, `uninstall({ skillName, scope, workspaceId })`, `update({ skillName, scope, workspaceId })`, `updateAll(workspaceId)`, `clearError()`, `clearUpdateError()`
- Each action: `set({ isSaving: true, error: null })` → `fetch` → on non-OK set error and return false → on OK update state and return true
- Optimistic update for `uninstall` (remove from `installed` immediately, revert on failure)
- Inline per-row error display: `failedUpdateSkillName` + `updateError` pair (mirrors plugin-store:207-244)
- `API_BASE = '/api/skills'` constant

**Patterns to follow:**
- `src/client/stores/plugin-store.ts` (exact shape, error-handling conventions, optimistic-update pattern)

**Test scenarios:**
- Test expectation: none — no client test infrastructure.

**Verification:**
- Store exports `useSkillsStore` with all documented actions
- All fetch errors surface as localized strings via `i18next.t('settings:skills.<key>', '<fallback>')`
- Lint clean

---

### U9. PluginRedirectPlaceholder update + commit housekeeping

**Goal:** Update workspace-settings Skills tab to redirect to the new Skills page; commit brainstorm, plan, and code together per the institutional learning.

**Requirements:** R1 (full coverage of the entry-point story)

**Dependencies:** U6, U7, U8

**Files:**
- Modify: `src/client/components/SettingsPanel.tsx` (around line 937-939) — Skills tab redirect target changes from Plugin Manager to Skills page (or open the Skills page overlay directly)
- Modify: existing `PluginRedirectPlaceholder` usage for Skills (find and update)

**Approach:**
- Locate the workspace-settings Skills tab (research indicates it's at `SettingsPanel.tsx:937-939` showing a `PluginRedirectPlaceholder`).
- Change the redirect target: instead of pointing users to Plugin Manager, either (a) open the new top-level Skills page directly via callback prop, or (b) keep the placeholder pattern but update text + click target to open Skills page.
- Verify the MCP and Hooks tabs are not affected.
- Final commit: stage `docs/brainstorms/2026-06-12-skills-page-requirements.md`, `docs/plans/2026-06-12-004-feat-skills-page-vercel-vendoring-plan.md` (this file), and all implementation files together. Mark plan frontmatter `status: completed` after merge.

**Patterns to follow:**
- Existing `PluginRedirectPlaceholder` component API
- Conventional commit: `feat(skills): add Skills page with vendored vercel-labs/skills source`

**Test scenarios:**
- Test expectation: none — UI redirect verification.

**Verification:**
- Clicking Skills tab in workspace settings opens the new Skills page (or its overlay)
- MCP and Hooks tabs unchanged
- Brainstorm, plan, and all implementation files committed together
- Plan frontmatter status updated

---

## System-Wide Impact

- **Interaction graph:** Skills page adds a new toolbar button in `SessionList.tsx`, a new route group in `src/server/index.ts`, a new vendor subtree at `src/server/vendor/vercel-skills/` (build-time only — vendored code reaches the bundle only via the adapter layer's imports), and a new redirect target from `SettingsPanel.tsx`. No changes to Plugin Manager code paths.
- **Error propagation:** Server-side errors flow through standard Express try/catch with status codes (400/404/409/422/500). Client-side errors surface via the store's `error` state and inline retry UI. Atomic lock-file writes guarantee no partial state on disk-side failure.
- **State lifecycle risks:** (a) Two lock files written independently — if install succeeds but lock write fails, files exist without lock entry (orphan). Mitigation: write lock first, then copy files, then re-write lock with success timestamp; if file copy fails, roll back lock entry. (b) Subtree pull conflicts — mitigated by adapter pattern (vendored files untouched). (c) Concurrent skills.sh calls — debounced client-side; server is stateless for search.
- **API surface parity:** Skills page intentionally does NOT share the Plugin Manager's API surface (`/api/plugins/*`). Two fully separate route groups. No middleware changes.
- **Integration coverage:** (a) Vendored code bundling — `npm run build:sidecar` must succeed and produce no `add-skill.vercel.sh` strings in output. (b) Existing CLI-installed skills (3 in repo, N in `~/.agents/.skill-lock.json`) must render correctly in the Installed list with `symlinked (legacy)` badge. (c) End-to-end install → list → update → remove cycle.
- **Unchanged invariants:** Plugin Manager behavior, settings file schemas (`~/.claude/settings.json` etc.), workspace model, chat/session pipeline, WeCom integration. The Skills page is purely additive server-side and adds one new toolbar button client-side.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Upstream breaking changes break adapter | Adapter pattern contains blast radius; vendored files never modified; subtree pull surfaces conflicts at sync time |
| `import.meta.url` shim shape in vendored code breaks sidecar build | Test `npm run build:sidecar` early in U2; extend regex at `scripts/build-sidecar.ts:132-150` if sanity check fails (it throws with clear error) |
| Telemetry leaks through transitive imports | Build-time grep for `add-skill.vercel.sh` in `dist/sidecar/`; gate U2 completion on zero matches |
| Orphan skill files if lock write fails after file copy | Write lock entry first; copy files; update lock timestamp; roll back lock on copy failure |
| User confusion: two surfaces (Plugin Manager + Skills) writing to `.claude/skills/` | Document the boundary in user-facing copy; v1 ships without de-dup detection (accepted trade-off per origin) |
| Existing CLI symlinks break when Skills page writes copies alongside | Coexist policy: page never touches symlinks; legacy badge surfaces the distinction |
| `simpleGit` clone fails on certain git URLs (SSH, private repos) | Surface as 422 error with clear message; document supported URL formats in UI help text |
| skills.sh rate limiting or downtime | `searchSkillsAPI` already returns `[]` on failure (matches upstream); UI shows "Search unavailable" empty state |

---

## Documentation / Operational Notes

- **README.md update:** add Skills page to the Features list, alongside Plugin Manager
- **`docs/brainstorms/` and `docs/plans/`:** brainstorm + this plan committed alongside code per `docs/solutions/conventions/commit-plan-and-brainstorm-files-with-code-changes.md`
- **`src/server/vendor/vercel-skills/README-COMATE.md`:** document pinned commit, vendored subset, sync command, attribution — required for future maintainers
- **No feature flag:** ships enabled by default; skills page is purely additive
- **No database migration:** no schema changes; `Workspace.skills` column remains untouched (legacy, unrelated)
- **No monitoring changes:** server logs via existing `sidecarLog` pattern
- **Rollback:** revert the implementing commit; vendored subtree is self-contained and removes cleanly

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-06-12-skills-page-requirements.md](docs/brainstorms/2026-06-12-skills-page-requirements.md)
- **Upstream vendored source:** https://github.com/vercel-labs/skills (cloned to `/tmp/vercel-skills` for inspection; vendored at `src/server/vendor/vercel-skills/` via git subtree in U1)
- **Plugin Manager (architectural sibling):** `src/server/routes/plugins.ts`, `src/server/services/plugin-settings-service.ts`, `src/server/services/marketplace-service.ts`, `src/client/components/PluginSettingsPage.tsx`
- **Atomic write pattern:** `src/server/utils/claude-settings.ts:273-301`
- **Sidecar build pipeline:** `scripts/build-sidecar.ts`
- **Institutional learning:** `docs/solutions/conventions/commit-plan-and-brainstorm-files-with-code-changes.md`
- **External API:** skills.sh `/api/search` endpoint (discovered from `src/find.ts:24-58` of upstream)
