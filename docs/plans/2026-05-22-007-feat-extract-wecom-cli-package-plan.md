---
title: Extract WeCom CLI into standalone npm package @webank/wecom
type: feat
status: active
date: 2026-05-22
origin: docs/brainstorms/2026-05-22-wecom-http-bridge-requirements.md
---

# Extract WeCom CLI into standalone npm package @webank/wecom

## Summary

Extract the existing `src/cli/wecom-send.ts` CLI into a self-contained npm package at `packages/wecom-cli/` named `@webank/wecom`. The new package carries its own build, its own `package.json` with a `bin` entry, and can be published independently. The main project adopts it as a workspace dependency so the existing build pipeline and sidecar packaging continue to work without duplication.

---

## Problem Frame

The CLI currently lives at `src/cli/wecom-send.ts` and is bundled into the GUI application. Skills running inside Claude Code sessions cannot reliably access it because PATH injection into spawned sessions does not propagate. Making the CLI installable via `npm install -g @webank/wecom` gives skills a first-class, always-available command without depending on the GUI server to inject environment variables.

---

## Requirements

- R1. The CLI source code moves from `src/cli/` into a dedicated package directory.
- R2. The new package is named `@webank/wecom` and exposes a `wecom` bin command.
- R3. The new package builds independently and produces a single-file executable.
- R4. The root project uses npm workspaces to reference the new package locally.
- R5. The root `build:cli` script delegates to the package's own build.
- R6. The sidecar build copies the built CLI from the package into `src-tauri/resources/`.
- R7. The server's `resolveWecomCliPath` utility looks for the CLI in the package build output as a fallback.
- R8. The old `src/cli/` directory and root-level CLI build wiring are removed.

**Origin actors:** A1 (Skill developer), A2 (Running skill / agent)
**Origin flows:** F2 (Skill sends proactive message)

---

## Scope Boundaries

- Publishing the package to npm or a private registry — out of scope; the plan makes it publishable-ready but does not automate publishing.
- Rewriting the CLI logic or adding new features — the CLI behavior stays identical.
- Changing the HTTP endpoint or server-side WeCom integration — only CLI packaging changes.

### Deferred to Follow-Up Work

- npm publish workflow (GitHub Actions or manual).
- Version bump automation for the extracted package.

---

## Context & Research

### Relevant Code and Patterns

- `src/cli/wecom-send.ts` — The CLI source to be moved. Uses only Node.js built-ins (`fs`, `path`, `http`, `https`).
- `package.json` — Currently has `"bin": { "wecom": "dist/cli/wecom-send.js" }` and `"build:cli": "esbuild ..."`.
- `scripts/build-sidecar.ts` — Copies `dist/cli/wecom-send.js` into `src-tauri/resources/`.
- `src/server/utils/resolve-wecom-cli.ts` — Resolves the CLI path at runtime; checks `dist/cli/wecom-send.js` among other locations.
- `tsconfig.server.json` — `rootDir: "./src/server"`, so `src/cli/` is outside the server build scope. The CLI is already built separately with esbuild.

### Institutional Learnings

- The CLI is already built with esbuild as a standalone step because it lives outside `tsconfig.server.json`'s `rootDir`.
- The sidecar build copies the CLI from `dist/cli/` into Tauri resources; any path change must be reflected there.

---

## Key Technical Decisions

- **Package location at `packages/wecom-cli/`:** Standard npm workspace convention. Keeps the package co-located with the app while allowing independent versioning and publishing.
- **npm workspaces instead of manual path references:** Workspaces let the root depend on `"@webank/wecom": "workspace:*"` and `npm install` handles linking automatically. Without workspaces, `file:` dependencies are brittle across npm versions.
- **Preserve esbuild bundling in the package:** The CLI's existing esbuild setup (single-file, ESM, Node.js built-ins only) moves into the package's own `build` script. No need to introduce `tsc` for a one-file CLI.
- **Root `build:cli` delegates to the package:** `npm run build -w packages/wecom-cli` (or `npm run --workspace=@webank/wecom build`) keeps the existing developer workflow intact while respecting the package boundary.
- **Server resolution checks package build output as fallback:** `resolveWecomCliPath` gains a strategy that checks `packages/wecom-cli/dist/index.js` so dev-mode server execution (not via sidecar) can still find the CLI.

---

## Open Questions

### Resolved During Planning

- **Package manager choice:** npm workspaces (built into npm 7+). The project already uses npm; no need to introduce pnpm or yarn.
- **Entry point name:** `src/index.ts` inside the package, built to `dist/index.js`. Keeps the package's internal structure conventional.
- **Bin command name:** `wecom` (same as today). The package exposes `"bin": { "wecom": "dist/index.js" }`.

### Deferred to Implementation

- **Exact workspace path for dev-mode resolution:** Whether `resolveWecomCliPath` should check `../../packages/wecom-cli/dist/index.js` relative to the compiled server file, or resolve from `process.cwd()`.

---

## Output Structure

```
packages/wecom-cli/
├── package.json
├── tsconfig.json
└── src/
    └── index.ts          (moved from src/cli/wecom-send.ts)
```

Root changes:
- `package.json` — add `workspaces`, update `bin`/`build:cli`/`build`
- `src/cli/` — removed
- `src/server/utils/resolve-wecom-cli.ts` — add package build output fallback
- `scripts/build-sidecar.ts` — update CLI copy path

---

## Implementation Units

### U1. Create the @webank/wecom package

**Goal:** Set up `packages/wecom-cli/` as a standalone npm package, move the CLI source into it, and configure its build.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Create: `packages/wecom-cli/package.json`
- Create: `packages/wecom-cli/tsconfig.json`
- Create: `packages/wecom-cli/src/index.ts`
- Delete: `src/cli/wecom-send.ts`

**Approach:**
- Create `packages/wecom-cli/package.json` with:
  - `"name": "@webank/wecom"`
  - `"version": "1.0.0"`
  - `"type": "module"`
  - `"bin": { "wecom": "dist/index.js" }`
  - `"main": "dist/index.js"`
  - `"files": ["dist"]`
  - `"scripts": { "build": "esbuild src/index.ts --bundle --platform=node --target=node20 --format=esm --outfile=dist/index.js --banner:js='#!/usr/bin/env node'" }`
  - `devDependencies`: `esbuild`
- Create `packages/wecom-cli/tsconfig.json` — minimal, extends root or standalone, only for editor support (esbuild does the actual build).
- Move `src/cli/wecom-send.ts` to `packages/wecom-cli/src/index.ts` without behavior changes. Keep the shebang.
- Run `npm install` in the package directory (or from root after workspaces are enabled) to install its devDependency.

**Patterns to follow:**
- Existing CLI code in `src/cli/wecom-send.ts`.
- Existing esbuild flags from root `build:cli`.

**Test scenarios:**
- Happy path: `cd packages/wecom-cli && npm run build` produces `dist/index.js`.
- Happy path: `node packages/wecom-cli/dist/index.js msg send --help` runs without errors.
- Integration: The built file still contains the `#!/usr/bin/env node` shebang.

**Verification:**
- `packages/wecom-cli/dist/index.js` exists and is executable.
- `node packages/wecom-cli/dist/index.js msg send --to-user test --message hello` behaves identically to the old CLI.

---

### U2. Enable npm workspaces and wire root dependency

**Goal:** Configure the root project as an npm workspace monorepo and reference the new package.

**Requirements:** R4, R5

**Dependencies:** U1

**Files:**
- Modify: `package.json`

**Approach:**
- Add `"workspaces": ["packages/*"]` to root `package.json`.
- Add `"@webank/wecom": "workspace:*"` to root `dependencies`.
- Update root scripts:
  - `"build:cli": "npm run build -w packages/wecom-cli"`
  - Keep `"build": "tsc -b && vite build && npm run build:cli"` (the `-w` flag builds the workspace).
- Remove the old root-level `"bin": { "wecom": "dist/cli/wecom-send.js" }` entry (the package now owns the bin).
- Run `npm install` from the root so npm links the workspace package into `node_modules/@webank/wecom`.

**Patterns to follow:**
- Standard npm workspaces layout.

**Test scenarios:**
- Happy path: `npm install` succeeds and creates `node_modules/@webank/wecom` symlink.
- Happy path: `npm run build:cli` from root delegates to the package and produces `packages/wecom-cli/dist/index.js`.
- Integration: `npx wecom msg send --help` resolves to the workspace package.

**Verification:**
- `ls -l node_modules/@webank/wecom` points to `packages/wecom-cli`.
- `npm run build:cli` from root succeeds.

---

### U3. Update sidecar build and server resolution

**Goal:** Ensure the sidecar build copies the CLI from the new package location, and the server's runtime resolution finds it there.

**Requirements:** R6, R7

**Dependencies:** U1, U2

**Files:**
- Modify: `scripts/build-sidecar.ts`
- Modify: `src/server/utils/resolve-wecom-cli.ts`

**Approach:**
- In `build-sidecar.ts`, update the wecom CLI source path from `join(rootDir, 'dist', 'cli', 'wecom-send.js')` to `join(rootDir, 'packages', 'wecom-cli', 'dist', 'index.js')`.
- In `resolve-wecom-cli.ts`, add a new strategy that checks `path.join(projectRoot, 'packages', 'wecom-cli', 'dist', 'index.js')`.
- Also add a CWD-relative fallback: `path.resolve('packages/wecom-cli/dist/index.js')`.

**Patterns to follow:**
- Existing multi-strategy fallback pattern in `resolve-wecom-cli.ts`.

**Test scenarios:**
- Happy path: `npm run build:sidecar` copies the CLI from `packages/wecom-cli/dist/index.js` to `src-tauri/resources/`.
- Happy path: `resolveWecomCliPath()` finds the CLI at the package build output in dev mode.
- Edge case: Package has not been built — resolution falls through to older strategies or returns undefined.

**Verification:**
- `npm run build:sidecar` completes without errors and `src-tauri/resources/wecom-send.js` is updated.
- `resolveWecomCliPath()` logs show the new strategy being checked.

---

### U4. Clean up old CLI artifacts

**Goal:** Remove stale references to the old `src/cli/` path and ensure no build output remains.

**Requirements:** R8

**Dependencies:** U1, U2, U3

**Files:**
- Delete: `src/cli/` directory (already done in U1, but verify)
- Delete: `dist/cli/` directory if it exists
- Modify: `.gitignore` if `dist/cli/` was explicitly ignored

**Approach:**
- Verify `src/cli/` is fully removed (no stale references in imports anywhere).
- Delete `dist/cli/` from the filesystem.
- Check if any CI/config files reference `dist/cli/` or `src/cli/` and update them.

**Patterns to follow:**
- Existing cleanup conventions in the repo.

**Test scenarios:**
- Integration: `grep -r "src/cli"` and `grep -r "dist/cli"` across the repo return no matches except in git history.

**Verification:**
- The old CLI paths no longer exist in the working tree.
- `npm run build` from root completes successfully.

---

## System-Wide Impact

- **Interaction graph:** The root `package.json` gains a workspaces field and a workspace dependency. `scripts/build-sidecar.ts` reads from a new path. `resolve-wecom-cli.ts` checks an additional location.
- **Error propagation:** No change — the CLI's error behavior is identical.
- **State lifecycle risks:** Old `dist/cli/` artifacts may persist locally until manually deleted (handled in U4).
- **API surface parity:** The CLI interface (`wecom msg send ...`) is unchanged.
- **Integration coverage:** End-to-end path: `npm run build:cli` → `packages/wecom-cli/dist/index.js` exists → `npm run build:sidecar` → `src-tauri/resources/wecom-send.js` exists → Tauri app bundles it.
- **Unchanged invariants:**
  - The HTTP endpoint `/api/wecom/send` is unchanged.
  - The context file `.claude/wecom-context.json` format and lifecycle are unchanged.
  - The WeCom bot connection and request-response flow are unchanged.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| npm workspaces change hoisting behavior and break existing imports | Test `npm install` and `npm run dev` after enabling workspaces. npm 7+ workspaces are backward-compatible for single-package repos. |
| Sidecar build copies stale CLI if package build is forgotten | `build:sidecar` should fail or warn if `packages/wecom-cli/dist/index.js` is missing. |
| Root `bin` entry removal breaks existing workflows | The package's `bin` entry replaces it; `npx wecom` still works from the root after `npm install`. |

---

## Documentation / Operational Notes

- After this change, the CLI is built via `npm run build:cli` from root (which delegates to the workspace).
- To build only the CLI package: `npm run build -w packages/wecom-cli`.
- To install the CLI globally for testing: `npm link packages/wecom-cli` or `npm install -g ./packages/wecom-cli`.

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-22-wecom-http-bridge-requirements.md](docs/brainstorms/2026-05-22-wecom-http-bridge-requirements.md)
- Related plan: [docs/plans/2026-05-22-006-feat-wecom-http-bridge-plan.md](docs/plans/2026-05-22-006-feat-wecom-http-bridge-plan.md)
- Related code: `src/cli/wecom-send.ts`, `scripts/build-sidecar.ts`, `src/server/utils/resolve-wecom-cli.ts`
