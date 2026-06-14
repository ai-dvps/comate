---
title: Refactor wecom-cli to oclif v4
type: refactor
status: active
date: 2026-06-10
deepened: 2026-06-10
origin: docs/brainstorms/2026-05-22-wecom-http-bridge-requirements.md
---

# Refactor wecom-cli to oclif v4

## Summary

Restructure the `@webank/wecom` CLI (`packages/wecom-cli`) to use oclif v4's Command class framework with declarative flags and the `explicit` command discovery strategy, while preserving the existing CLI contract (commands, flags, exit codes) and the single-file esbuild bundle that the Tauri sidecar build copies.

---

## Problem Frame

The current CLI uses hand-rolled `process.argv` parsing with manual flag extraction, error handling, and usage text. This is unmaintainable as commands grow — adding new flags or commands requires reimplementing parsing, validation, and help text. The codebase has no CLI framework precedent; oclif v4 provides a modern, well-documented foundation with built-in help generation, flag validation, and topic-based command organization.

---

## Requirements

- R1. Preserve the existing CLI interface: `wecom msg send --to-user <id> --message <text> [--msg-type text|markdown]` and `wecom queue enqueue --to-user <id> --message <text>`.
- R2. Preserve existing exit codes: `0` success, `1` invalid arguments or context file error, `2` no WeCom bot context found, `3` HTTP request failed.
- R3. Produce a single bundled `dist/index.js` output so existing sidecar build, server resolution, and install-to-PATH integrations continue to work.
- R4. Add built-in help text (`--help`) for commands and topics.
- R5. Add tests for command parsing, context file handling, and HTTP error paths.

**Origin actors:** A1 (Skill developer), A2 (Running skill / agent)
**Origin flows:** F2 (Skill sends proactive message)

---

## Scope Boundaries

- Changing the HTTP endpoint contract with the server — out of scope; only the CLI framework changes.
- Adding new commands or flags beyond the current `msg send` and `queue enqueue` — out of scope.
- Modifying the context file format, discovery mechanism, or location — out of scope.
- Changing the package name, version strategy, or npm workspace setup — out of scope.

### Deferred to Follow-Up Work

- Additional CLI commands (e.g., `wecom config`, `wecom status`).
- Auto-completion shell hooks.
- Publishing the package to a registry.

---

## Context & Research

### Relevant Code and Patterns

- `packages/wecom-cli/src/index.ts` — Current CLI source with manual argument parsing, two commands (`msg send`, `queue enqueue`), shared context file discovery, and raw `http`/`https` POST logic.
- `packages/wecom-cli/package.json` — ESM package, esbuild bundling to `dist/index.js`, `bin: { wecom: "dist/index.js" }`.
- `scripts/build-sidecar.ts` — Copies `packages/wecom-cli/dist/index.js` to `src-tauri/resources/wecom-send.js`; expects a single-file output.
- `src/server/utils/resolve-wecom-cli.ts` — Four-strategy runtime resolution; all paths target `packages/wecom-cli/dist/index.js` or `wecom-send.js`.
- `src/server/utils/install-wecom-cli.ts` — Copies the resolved CLI path to `~/.local/bin/wecom`; assumes a single executable file.
- `src/server/services/chat-service.ts` — Injects `WECOM_CLI_PATH` into SDK subprocess env.
- `src/server/assets/send-wecom-message.md` — Skill documentation referencing exact flag names and exit codes.
- `src/server/assets/wecom-proactive-skill.ts` — Auto-generated skill referencing `wecom queue enqueue` syntax.

### Institutional Learnings

- The CLI was intentionally kept as a single-file esbuild bundle to avoid complex build steps and to be copyable as a Tauri sidecar resource (see `docs/plans/2026-05-22-007-feat-extract-wecom-cli-package-plan.md`).
- Runtime resolution uses a cascading four-strategy fallback. Any output path change must update `resolve-wecom-cli.ts` and `build-sidecar.ts` together.
- Cross-platform CLI installation uses file copy (not symlink) for reliability.

### External References

- [oclif v4 ESM docs](https://oclif.io/docs/esm/)
- [oclif Command Discovery Strategies](https://oclif.io/docs/command_discovery_strategies/)
- [oclif/plugin-test-esbuild-single](https://github.com/oclif/plugin-test-esbuild-single) — Experimental esbuild bundling example using `explicit` strategy.

---

## Key Technical Decisions

- **oclif v4 instead of commander.js or manual parsing:** oclif v4 provides declarative flags, topic-based commands, built-in help generation, and structured error handling out of the box. commander.js is lighter (~220KB) but would still require manual help text, topic routing, and exit-code plumbing. For a codebase with no CLI precedent, oclif's conventions reduce future maintenance. The tradeoff is oclif's larger bundle size and stricter runtime expectations (see fallback decision below).
- **oclif v4 with `explicit` command discovery strategy:** The default `pattern` strategy uses filesystem globbing and breaks when bundled into a single file. The `single` strategy only supports one command. The `explicit` strategy exports a `COMMANDS` map from the entry point, which esbuild can inline into the bundle. This is the only oclif-supported approach compatible with single-file bundling.
- **Keep esbuild bundling:** The existing esbuild setup is preserved. The entry point (`src/index.ts`) imports command classes, exports them in `COMMANDS`, and calls oclif's entry API with `loadOptions.pjson` pointing to inlined package metadata. This avoids runtime `package.json` reads if oclif honors the inlined data.
- **Fallback decision tree for single-file constraint:** If oclif's entry API still requires a physical `package.json` at runtime after inlining `pjson`, the fallback is:
  - **Option A (timeboxed, 2 hours):** Investigate overriding oclif's `Config` or `Plugin` to bypass disk reads entirely while keeping a single `dist/index.js`.
  - **Option B (if A fails):** Relax to "single entry point + co-located `package.json`." Update `build-sidecar.ts`, `resolve-wecom-cli.ts`, and `install-wecom-cli.ts` to handle both files. This is a known, safe fallback.
  - **Option C (plan-level abort):** Revert to hand-rolled parsing if oclif cannot be made to work with the bundling constraint.
- **Custom exit codes via base command class:** oclif's default exit codes (2 for validation errors) conflict with the existing contract (2 = no context file). A base command class overrides `catch()` to map oclif errors: flag/arg validation errors remap from 2 → 1; domain errors (missing context, HTTP failure) keep their existing codes (2, 3). An exit-code parity matrix is verified in U7.
- **ESM-first:** The package remains `"type": "module"`. oclif v4 has native ESM support. No `.js` extension changes are needed for bin entries since the existing `"bin": { "wecom": "dist/index.js" }` already uses `.js`.
- **Node.js built-in test runner:** The repo already uses `node:test` and `node:assert` in server tests. CLI tests follow the same pattern. `process.exit` assertions use child-process spawning (not mocking) to match how skills invoke the CLI.

---

## Open Questions

### Resolved During Planning

- **oclif version:** v4 (user confirmed).
- **Command discovery strategy:** `explicit` — the only strategy compatible with esbuild bundling.
- **Build tool:** Keep esbuild; no migration to tsc or oclif pack.

### Deferred to Implementation

- **Does oclif's entry API with inlined `pjson` fully work without a physical `package.json` on disk?** The oclif docs state `package.json` is required at runtime, but `loadOptions.pjson` exists to bypass this. This must be validated at execution time during U5/U7. The fallback decision tree (Option A → B → C) is documented in Key Technical Decisions.
- **Exact oclif error-handling hook shape:** The override mechanism (`catch()` vs custom `ExitError` classes) depends on oclif v4's actual API and should be settled when touching the code.

---

## Output Structure

```
packages/wecom-cli/
├── src/
│   ├── index.ts        # Bundle entry: exports COMMANDS, calls execute with inline pjson
│   ├── commands/
│   │   ├── base.ts     # Base command with shared context loading and exit code handling
│   │   ├── msg/
│   │   │   └── send.ts # msg send command
│   │   └── queue/
│   │       └── enqueue.ts # queue enqueue command
│   └── lib/
│       ├── context.ts  # Context file discovery and reading
│       └── http.ts     # postJson utility
├── test/
│   └── cli.test.ts     # Command parsing and error path tests
├── package.json
└── tsconfig.json
```

---

## Implementation Units

### U1. Add oclif v4 and configure explicit strategy

**Goal:** Install oclif v4 and configure the `explicit` command discovery strategy in `package.json`. No bin stubs are needed — the existing integration chain invokes `dist/index.js` directly.

**Requirements:** R3, R4

**Dependencies:** None

**Files:**
- Modify: `packages/wecom-cli/package.json`
- Modify: `packages/wecom-cli/tsconfig.json`

**Approach:**
- Add `@oclif/core` to `dependencies` (runtime required).
- Add `oclif` config block to `package.json`:
  ```json
  {
    "oclif": {
      "commands": {
        "strategy": "explicit",
        "target": "./dist/index.js",
        "identifier": "COMMANDS"
      }
    }
  }
  ```
- Keep the existing `"bin": { "wecom": "dist/index.js" }` entry.
- Update `tsconfig.json` if needed for oclif's type expectations (e.g., `moduleResolution: "node16"` or `"bundler"`).
- Update workspace and root `package-lock.json` when adding the dependency.

**Patterns to follow:**
- oclif v4 ESM examples from official docs.

**Test scenarios:**
- Happy path: `npm install` succeeds and `@oclif/core` is resolvable.
- Happy path: `oclif` config block in `package.json` is valid and readable by oclif tooling.

**Verification:**
- `npm ls @oclif/core` in `packages/wecom-cli` shows the installed version.
- `package.json` contains the `oclif` config block with `strategy: explicit`.

---

### U2. Extract shared utilities and create base command class

**Goal:** Move framework-agnostic logic (context file discovery, HTTP client) into shared modules and create an oclif base command class that preserves exit code semantics.

**Requirements:** R2, R3

**Dependencies:** U1

**Files:**
- Create: `packages/wecom-cli/src/lib/context.ts`
- Create: `packages/wecom-cli/src/lib/http.ts`
- Create: `packages/wecom-cli/src/commands/base.ts`
- Create: `packages/wecom-cli/src/index.ts` (stub with empty `COMMANDS` map so the package is buildable after this unit)
- Delete: `packages/wecom-cli/src/index.ts` (legacy, replaced by stub)

**Approach:**
- `src/lib/context.ts` — Extract `findContextFile()`, `readContextFile()`, `ContextFile` interface. Keep the upward directory walk and validation logic unchanged.
- `src/lib/http.ts` — Extract `postJson()` with raw `http`/`https` usage. Keep retry-less behavior.
- `src/commands/base.ts` — Extend oclif's `Command`:
  - Add a `loadContext()` method that wraps `findContextFile` + `readContextFile`.
  - If no context file is found, call `this.exit(2)` (matching existing behavior).
  - If context file is invalid, call `this.exit(1)`.
  - Override `catch()` to remap oclif's default exit codes where they conflict with the existing contract (e.g., oclif validation errors currently exit 2, which collides with "no context file"; remap validation errors to exit 1).
- `src/index.ts` (stub) — Create a minimal buildable entry point that exports an empty `COMMANDS` map and calls `execute()`. This lets the package build and validate after every unit.

**Technical design:**
> *Directional guidance, not implementation specification.*
> The base command's `catch()` should distinguish oclif's built-in `CLIError` types from domain errors. Flag/arg validation errors should result in exit code 1 (and print usage). Domain errors (missing context, HTTP failure) use their specific codes.

**Patterns to follow:**
- Existing error handling in `src/index.ts` (per-error console.error messages).

**Test scenarios:**
- Happy path: `loadContext()` returns a valid `ContextFile` when a context file exists in the CWD tree.
- Edge case: `loadContext()` exits with code 2 when no context file is found.
- Error path: `loadContext()` exits with code 1 when context file exists but has invalid JSON or missing required fields.
- Error path: `loadContext()` exits with code 1 when context file exists but is unreadable (permission denied or is a directory).
- Error path: Flag validation error exits with code 1 (not oclif's default 2).

**Verification:**
- Unit tests for `context.ts` and `base.ts` pass.
- `npm run build` in `packages/wecom-cli` succeeds with the stub entry point.

---

### U3. Migrate `msg send` command to oclif

**Goal:** Convert the `msg send` command from manual argument parsing to an oclif Command class.

**Requirements:** R1, R2, R4

**Dependencies:** U2

**Files:**
- Create: `packages/wecom-cli/src/commands/msg/send.ts`

**Approach:**
- Create `MsgSend` command class extending the base command.
- Command ID: `msg:send` (oclif topic syntax).
- Flags:
  - `--to-user` (string, required)
  - `--message` (string, required)
  - `--msg-type` (option: `['text', 'markdown']`, default: `'text'`)
- `run()` method:
  1. Call `this.loadContext()`.
  2. POST to `{serverUrl}/api/wecom/send` with `{botId, toUser, message, msgType}`.
  3. On HTTP 200, exit 0.
  4. On HTTP failure, print error and exit 3.
- Keep the same JSON parse error handling for the response body.

**Patterns to follow:**
- Existing `runMsgSend()` logic in `src/index.ts`.
- oclif v4 flag definitions using `Flags.string()` and `Flags.option()`.

**Test scenarios:**
- Happy path: `wecom msg send --to-user U123 --message "hello"` parses correctly and POSTs `{botId: 'test-bot', toUser: 'U123', message: 'hello', msgType: 'text'}`.
- Happy path: `--msg-type markdown` is accepted and forwarded as `msgType: 'markdown'`.
- Error path: Missing `--to-user` → stderr contains "required flag to-user", stdout contains usage table, exit code 1.
- Error path: Missing `--message` → stderr contains "required flag message", stdout contains usage table, exit code 1.
- Error path: Invalid `--msg-type` → stderr contains usage table, exit code 1.
- Error path: HTTP 500 with body `{"error":"db timeout"}` → stderr contains "Failed to send message: db timeout", exit code 3.
- Edge case: HTTP 500 with body `Internal Server Error` → stderr contains "Failed to send message: HTTP 500: Internal Server Error", exit code 3.

**Verification:**
- `node packages/wecom-cli/dist/index.js msg send --help` shows correct flag documentation.
- The command behaves identically to the legacy implementation for all success and error paths.

---

### U4. Migrate `queue enqueue` command to oclif

**Goal:** Convert the `queue enqueue` command from manual argument parsing to an oclif Command class.

**Requirements:** R1, R2, R4

**Dependencies:** U2

**Files:**
- Create: `packages/wecom-cli/src/commands/queue/enqueue.ts`

**Approach:**
- Create `QueueEnqueue` command class extending the base command.
- Command ID: `queue:enqueue`.
- Flags:
  - `--to-user` (string, required)
  - `--message` (string, required)
- `run()` method:
  1. Call `this.loadContext()`.
  2. Validate `workspaceId` exists in context (exit 1 if missing).
  3. POST to `{serverUrl}/api/workspaces/{workspaceId}/wecom-queue` with `{toUser, message}`.
  4. On HTTP 202, parse `{id, status}` and log the queued message ID; exit 0.
  5. On HTTP 400, handle `recipient_not_resolved` and `recipient_no_session` with specific error messages; exit 3.
  6. On other HTTP failures, exit 3.

**Patterns to follow:**
- Existing `runQueueEnqueue()` logic in `src/index.ts`.
- Same oclif flag patterns as U3.

**Test scenarios:**
- Happy path: `wecom queue enqueue --to-user U123 --message "hello"` parses correctly and POSTs `{toUser: 'U123', message: 'hello'}` to the workspace-scoped endpoint.
- Happy path: HTTP 202 with body `{"id":"q-1","status":"pending"}` logs `Queued proactive message (id=q-1, status=pending)` and exits 0.
- Error path: Missing `--to-user` → stderr contains "required flag to-user", stdout contains usage table, exit code 1.
- Error path: Missing `--message` → stderr contains "required flag message", stdout contains usage table, exit code 1.
- Error path: Context file missing `workspaceId` → stderr contains "missing workspaceId", exit code 1.
- Error path: HTTP 400 with `{"error":"recipient_not_resolved"}` → stderr contains "recipient user ID has not been decrypted yet", exit code 3.
- Error path: HTTP 400 with `{"error":"recipient_no_session"}` → stderr contains "recipient has no active session", exit code 3.
- Error path: HTTP 400 with `{"error":"rate_limited","message":"Too many requests"}` → stderr contains "Failed to enqueue: Too many requests", exit code 3.
- Error path: HTTP 500 exits 3.

**Verification:**
- `node packages/wecom-cli/dist/index.js queue enqueue --help` shows correct flag documentation.
- The command behaves identically to the legacy implementation.

---

### U5. Finalize bundled entry point

**Goal:** Replace the stub `src/index.ts` with the final oclif entry point that imports commands, exports the `COMMANDS` map, and calls `execute()` with inlined package metadata for single-file execution.

**Requirements:** R3, R4

**Dependencies:** U3, U4

**Files:**
- Modify: `packages/wecom-cli/src/index.ts`

**Approach:**
- Import `MsgSend` and `QueueEnqueue` command classes.
- Export `COMMANDS` map matching the `explicit` strategy contract:
  ```typescript
  export const COMMANDS: Record<string, Command.Class> = {
    'msg:send': MsgSend,
    'queue:enqueue': QueueEnqueue,
  };
  ```
- Import `package.json` via JSON import: `import pjson from '../package.json' with { type: 'json' };` (Node 20 `with` syntax; esbuild inlines this as an object literal).
- Call oclif's entry API (`execute` or `run` from `@oclif/core`) with `loadOptions` providing the inlined `pjson` and `root`.
- Keep `#!/usr/bin/env node` in the source for dev runs; also use esbuild `--banner:js` to prepend it to the bundle so the file is directly executable.
- Preserve top-level error handling so unexpected exceptions exit 1.

**Technical design:**
> *Directional guidance, not implementation specification.*
> The entry point inlines `package.json` so the bundled file does not depend on a physical `package.json` at runtime. The exact oclif v4 API for programmatic entry should be confirmed during implementation (reference `plugin-test-esbuild-single`). If `execute()` with `loadOptions.pjson` still attempts disk reads, use the fallback decision tree documented in Key Technical Decisions.

**Patterns to follow:**
- oclif `explicit` strategy example from `plugin-test-esbuild-single`.

**Test scenarios:**
- Happy path: `npm run build` produces `dist/index.js` with the `COMMANDS` export preserved (verify `export const COMMANDS` is in the bundle or that esbuild `keepNames` is configured).
- Happy path: `node dist/index.js --help` lists `msg` and `queue` topics and exits 0.
- Happy path: `node dist/index.js msg --help` lists the `send` subcommand and exits 0.
- Happy path: `node dist/index.js --version` prints the package version and exits 0.
- Integration: `node dist/index.js msg send --help` works when `dist/index.js` is copied to a temp directory with no `package.json` or `node_modules` nearby.
- Integration: `npm link` in `packages/wecom-cli`, then `wecom --help` from a shell prints the help banner and exits 0.

**Verification:**
- `packages/wecom-cli/dist/index.js` exists, has the shebang, and is executable.
- The bundled file runs standalone from a temp directory.
- `npx wecom --help` works after `npm install` from the root workspace.

---

### U6. Add CLI tests

**Goal:** Add test coverage for command parsing, context file handling, and HTTP error paths.

**Requirements:** R5

**Dependencies:** U2, U3, U4

**Files:**
- Create: `packages/wecom-cli/test/cli.test.ts`
- Modify: `packages/wecom-cli/package.json` (add test script)

**Approach:**
- Use Node.js built-in test runner (`node:test`, `node:assert`) consistent with server tests.
- Test command class parsing directly (instantiate `MsgSend` / `QueueEnqueue` with mock `argv` and stubbed `run()` / HTTP methods).
- Test `context.ts` utilities with a temporary directory tree.
- Test `base.ts` error handling with mocked context file states.
- Add a test script to `package.json`: `"test": "node --test test/**/*.test.ts"` (or via `tsx` if TypeScript execution is needed).

**Patterns to follow:**
- `src/server/routes/wecom-queue.test.ts` — uses `node:test` with `beforeEach`/`afterEach` and mock store methods.

**Test scenarios:**
- Happy path: `MsgSend` parses all required flags correctly (stub `postJson`, assert stub receives `{botId: 'test-bot', toUser: 'U123', message: 'hello', msgType: 'text'}`).
- Happy path: `QueueEnqueue` parses all required flags correctly.
- Edge case: Missing required flags triggers oclif validation and exits 1 (test via child process spawn to capture exit code).
- Edge case: `findContextFile` walks up the directory tree and finds `.claude/wecom-context.json`.
- Edge case: `findContextFile` returns null when no context file exists.
- Error path: Invalid context file JSON → `readContextFile` throws with message containing "Invalid context file format".
- Error path: Context file missing `botId` or `serverUrl` → `readContextFile` throws with message containing "missing botId or serverUrl".
- Error path: Context file is a directory (or unreadable) → `readContextFile` throws; base command exits 1.
- Integration: Base command `loadContext()` exits 2 when context file is missing (test via child process spawn).

**Verification:**
- `npm test` in `packages/wecom-cli` passes.

---

### U7. Verify build output and integration compatibility

**Goal:** Ensure the esbuild bundle works standalone and all downstream integrations (sidecar build, server resolution, install-to-PATH, skill docs) remain functional.

**Requirements:** R1, R2, R3

**Dependencies:** U5, U6

**Files:**
- Modify: `packages/wecom-cli/package.json` (verify build script)
- Verify: `scripts/build-sidecar.ts`
- Verify: `src/server/utils/resolve-wecom-cli.ts`
- Verify: `src/server/utils/install-wecom-cli.ts`
- Verify: `src/server/assets/send-wecom-message.md`
- Verify: `src/server/assets/wecom-proactive-skill.ts`

**Approach:**
- Run `npm run build` in `packages/wecom-cli` and verify `dist/index.js` is produced.
- Test the bundled file in isolation: copy to a temp directory and run `msg send --help`.
- If oclif requires a physical `package.json` at runtime, update:
  - `scripts/build-sidecar.ts` to also copy `package.json` into `src-tauri/resources/` (or into a `wecom-cli/` subdirectory).
  - `src/server/utils/resolve-wecom-cli.ts` to look for the directory or updated entry point.
  - `src/server/utils/install-wecom-cli.ts` to copy both files (or the directory).
- If the single-file constraint holds, no integration changes are needed.
- Verify skill documentation still matches CLI behavior and exit codes.

**Execution note:** Start with characterization coverage — run the legacy CLI and the refactored CLI against the same inputs and compare outputs/exit codes before declaring the refactor complete.

**Test scenarios:**
- Integration: `cd packages/wecom-cli && npm run build` produces `dist/index.js` with shebang and executable bit.
- Integration: `npm run build:sidecar` copies `packages/wecom-cli/dist/index.js` to `src-tauri/resources/wecom-send.js` without error.
- Integration: The copied `wecom-send.js` runs standalone when invoked directly.
- Integration: `resolveWecomCliPath()` Strategy 1 finds `packages/wecom-cli/dist/index.js` in dev mode.
- Integration: `resolveWecomCliPath()` Strategy 3 finds `wecom-send.js` next to the executable in pkg-bundled sidecar mode.
- Integration: Characterization parity — for each of the 8 legacy test cases (2 happy paths + 6 error paths), the refactored CLI produces the same exit code and semantically equivalent stderr as the legacy CLI when invoked via `WECOM_CLI_PATH` (allow for oclif help formatting differences).
- Integration: Self-containment — after `installWecomCli()`, run the installed binary from a temp directory with no `node_modules` or `package.json` nearby; assert `wecom msg send --help` succeeds and exit code is 0.
- Integration: Windows parity — verify bundled CLI works on Windows when invoked directly, via `WECOM_CLI_PATH`, and installed to PATH.
- Integration: `npx wecom --help` works from the root workspace.

**Verification:**
- All legacy CLI behaviors are preserved.
- No changes are required in `scripts/build-sidecar.ts`, `resolve-wecom-cli.ts`, or `install-wecom-cli.ts` — OR all necessary changes are made and tested.

---

## System-Wide Impact

- **Interaction graph:** The wecom CLI is invoked by skills via `WECOM_CLI_PATH` and by users directly. The server resolves and optionally installs the CLI. The sidecar build packages it for Tauri. The `package.json` `"bin"` entry (`wecom: dist/index.js`) remains the only entry point; no new `bin/run.js` or `bin/dev.js` stubs are introduced.
- **Error propagation:** Exit codes are preserved so skill error handling continues to work. oclif validation errors remap from 2 → 1 to avoid colliding with "no context file" semantics.
- **State lifecycle risks:**
  - The old `src/index.ts` is fully replaced; no stale source state.
  - `src-tauri/resources/wecom-send.js` is a copied artifact. Developers must run `build:cli` then `build:sidecar` to avoid stale sidecar bundles.
  - Adding `@oclif/core` requires updating both the workspace and root `package-lock.json`.
  - Users with an existing `~/.local/bin/wecom` install may need to re-run the installer if Option B (co-located `package.json`) is triggered.
- **API surface parity:**
  - The CLI flag interface is unchanged.
  - The HTTP endpoints are unchanged.
  - `--version` is a new benign surface (oclif provides it by default). No skill references it.
  - Parse-error stderr format changes from hand-rolled messages to oclif-formatted output; skills only depend on exit codes, not stderr content.
- **Integration coverage:**
  - End-to-end path (dev): `npm run build:cli` → `packages/wecom-cli/dist/index.js` → `resolveWecomCliPath()` Strategy 1/2 → skill invocation via `WECOM_CLI_PATH`.
  - End-to-end path (sidecar): `npm run build:sidecar` → copies `dist/index.js` to `src-tauri/resources/wecom-send.js` → `resolveWecomCliPath()` Strategy 3/4 → skill invocation.
  - The wecom CLI remains **external to the `pkg` snapshot**; it is a sidecar file executed by the system Node.js runtime, not bundled into the pkg binary.
- **Platform parity:**
  - Windows: `wecom.exe` naming, backslash paths in `loadOptions.root`, and shebang handling (ignored on Windows) must be verified.
  - Non-TTY `--help` output should not emit ANSI codes to avoid polluting skill logs.
- **Unchanged invariants:**
  - HTTP endpoints `/api/wecom/send` and `/api/workspaces/{id}/wecom-queue` are unchanged.
  - Context file `.claude/wecom-context.json` format and lifecycle are unchanged.
  - The `wecom` bin name and `WECOM_CLI_PATH` env var are unchanged.
  - Skill documentation examples remain valid.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| oclif's entry API with inline `pjson` still requires a physical `package.json` on disk, breaking the single-file sidecar contract | Validate during U5/U7 with standalone execution from a temp directory. Fallback decision tree: Option A (Config override, 2-hour timebox) → Option B (co-locate `package.json`, update `build-sidecar.ts`, `resolve-wecom-cli.ts`, and `install-wecom-cli.ts`) → Option C (revert to hand-rolled parsing). |
| oclif's default exit codes conflict with the existing contract (e.g., validation errors exit 2) | Base command class remaps validation errors from 2 → 1. Exit-code parity matrix verified in U7 characterization tests. |
| esbuild bundles oclif in a way that drops or renames the `COMMANDS` export | Configure esbuild to preserve the named export (`keepNames` or equivalent). Verify `export const COMMANDS` survives in the bundle output. |
| esbuild bundles oclif with dynamic imports or file system assumptions | Use `explicit` strategy (no filesystem command discovery). Test the bundle in isolation in U7. |
| Skill documentation or generated skill files reference exact CLI syntax that inadvertently changes | Audit `send-wecom-message.md` and `wecom-proactive-skill.ts` in U7. No planned syntax changes. |
| Stale `wecom-send.js` in Tauri resources after CLI build | Run full build chain (`build:cli` then `build:sidecar`). U7 verifies the copied file matches the fresh bundle. |

---

## Documentation / Operational Notes

- After this change, `packages/wecom-cli` gains a `test` script. CI or local test runs should include it.
- The CLI now supports `--help` on all commands and topics. Skill documentation may optionally reference this.

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-22-wecom-http-bridge-requirements.md](docs/brainstorms/2026-05-22-wecom-http-bridge-requirements.md)
- Related plan: [docs/plans/2026-05-22-007-feat-extract-wecom-cli-package-plan.md](docs/plans/2026-05-22-007-feat-extract-wecom-cli-package-plan.md)
- Related plan: [docs/plans/2026-05-22-008-feat-install-wecom-cli-to-path-plan.md](docs/plans/2026-05-22-008-feat-install-wecom-cli-to-path-plan.md)
- Related code: `packages/wecom-cli/src/index.ts`, `scripts/build-sidecar.ts`, `src/server/utils/resolve-wecom-cli.ts`, `src/server/utils/install-wecom-cli.ts`
- External docs: [oclif v4 ESM](https://oclif.io/docs/esm/), [oclif Command Discovery](https://oclif.io/docs/command_discovery_strategies/)
