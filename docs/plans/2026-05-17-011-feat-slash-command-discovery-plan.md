---
title: 'feat: Slash command discovery in PromptInput'
type: feat
status: completed
date: 2026-05-17
origin: docs/brainstorms/2026-05-17-slash-command-discovery-requirements.md
---

# feat: Slash command discovery in PromptInput

## Summary

Surface a workspace's available slash commands inside `PromptInput` without polluting the user's session history. Two affordances share one underlying command list: typing `/` as the first character of an empty input opens an inline popup (speed path), and a persistent **Commands** button at the top of the input box opens the same list (discovery path). The list is sourced out-of-band of the user's message stream by calling the SDK's `startup()` + `WarmQuery.initializationResult()` control path and immediately closing the warm subprocess — no fake prompts, no session JSONL written. A `chokidar` watcher on `.claude/commands/` and `.claude/skills/` keeps project-side commands fresh without restart.

## Problem Frame

`PromptInput` (`src/client/components/PromptInput.tsx`) has no discovery surface for slash commands today. Users either remember command names from memory or never discover them. The SDK's documented discovery route (the `system_init` message after a `query()` call, per <https://code.claude.com/docs/en/agent-sdk/slash-commands>) writes a user message into the session transcript — pollution for an app like CCG that wants discovery as **application behavior**, not user behavior. The SDK exposes a second path that is not on that docs page but is present in the types and runtime: `startup({ options })` returns a `WarmQuery` that pre-warms the CLI subprocess, runs the initialization handshake, and exposes `initializationResult()` carrying the same merged command list. Calling `WarmQuery.close()` before any prompt fires discards the subprocess without persisting any session state.

This plan integrates that out-of-band path end-to-end: a server-side wrapper that enforces the no-pollution guarantee at the boundary, a per-workspace command cache with a filesystem watcher, a REST endpoint, a client store slice, a reusable `CommandPicker` component, and `PromptInput` integration for both surfaces.

The brainstorm's selected approach (Approach A: warm-up + watcher) is preserved at the level of *what to build*. This plan trades the eager-on-workspace-open trigger for **lazy first-fetch keyed off the first popup open**. The rationale appears in Key Technical Decisions.

---

## Requirements

Carried from `docs/brainstorms/2026-05-17-slash-command-discovery-requirements.md`. Every requirement below is mapped to one or more implementation units.

- R1. `/` at the first character of an empty input opens an inline popup. → U5, U6
- R2. Persistent **Commands** button at the top of the input box opens the same panel. → U5, U6
- R3. Both surfaces share command list and selection behavior. → U5
- R4. List contains every SDK-exposed command (built-ins, project, skills, plugins, personal). → U1, U2, U3
- R5. Aliases display on the same row as the primary name. → U5
- R6. Filter is case-insensitive name-prefix only. → U5
- R7. Empty filter shows full unfiltered list. → U5
- R8. Selection inserts command name + ghost-text argument hint. → U5, U6
- R9. After selection, Enter sends as normal. → U6
- R10. Each row shows name, description, aliases. Argument hint shown only after selection. → U5
- R11. Project commands and skills in `.claude/commands/` and `.claude/skills/` reflect changes on next popup open via filesystem watcher. → U2
- R12. SDK-side commands (built-ins, plugins) refresh on workspace re-open. → U2, U4
- R13. Discovery does not write any user message, system message, or session JSONL. → U1 (verified at the `WarmQuery.close()` boundary)
- R14. SDK warm-up failure falls back to filesystem-only commands with an inline note. → U2, U5

---

## Scope Boundaries

**In scope (this plan)**
- Server-side SDK wrapper for `startup()` + `WarmQuery.initializationResult()`
- Per-workspace command cache and `chokidar` filesystem watcher
- REST endpoint exposing the cached list
- Client store slice with lazy fetch + per-workspace cache
- `CommandPicker` component (popup, filter, keyboard nav, click select)
- `PromptInput` integration (`/`-trigger + Commands button + ghost text)
- Failure fallback to filesystem-only commands

**Out of scope** (carried from origin)
- Inline argument validation or typed argument forms (argument hint is plain ghost text only)
- Recently-used / most-used ranking
- Cross-workspace command search
- Editing or authoring of slash command files (read-only surfacing)
- `/`-trigger anywhere mid-prompt (only at first character of empty input)
- Context-aware suggestions
- Discovery surface for non-slash affordances (agents, models, output styles)

**Deferred to follow-up work**
- Eager warm-up on workspace open (this plan ships lazy first-fetch instead — see Key Technical Decisions)
- SSE-driven push of watcher events to clients (this plan lets the next popup open re-read the cache)
- Mid-session plugin install/refresh (requires server restart in v1)
- Manual refresh action in the picker UI (the `refreshCommands` store action is implemented but not surfaced in v1)

---

## Context & Research

### Relevant Code and Patterns

- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:5483-5493` — `startup({ options }): WarmQuery`. Confirmed in `sdk.mjs` runtime as awaiting `initializationResult()` and returning `{ query, close }`.
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2092` — `Query.initializationResult()` and `:2098` `Query.supportedCommands()` are control requests; no user message is sent.
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2740` — `SDKControlInitializeResponse` carries `commands: SlashCommand[]`, `agents`, `output_style`, `models`, `account`.
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:5406-5424` — `SlashCommand` type: `name`, `description`, `argumentHint`, `aliases?: string[]`.
- `src/server/services/sdk-client.ts` — `SdkClient` wraps `query()` for messaging today. It does **not** wrap `startup()`. U1 extends it.
- `src/server/services/chat-service.ts:237-270` — `buildSdkOptions(workspace, session)` constructs the `Options` object (cwd, env, mcpServers, model). The warm-up path needs the workspace-scoped subset only (no `sessionId`/`resume`). U2 reuses the projection pattern.
- `src/server/services/chat-service.ts:18-21` — Service-with-Map cache pattern (`runtimes`, `creatingRuntimes`). U2 mirrors this for the per-workspace command cache + inflight-promise dedupe.
- `src/server/routes/chat.ts` — `Router({ mergeParams: true })` + async-handler-with-throw conventions; `chatError({ statusCode, code, message })` envelope. U3 follows the same shape.
- `src/server/index.ts` — Server entry, mounts existing routers via `app.use('/api/...', router)`. U3 adds a mount line.
- `src/server/storage/sqlite-store.ts` — Workspace store with `get(id)`. The commands service looks up workspace via this store on first GET.
- `src/client/stores/chat-store.ts:8-9` — Module-level `Map` cache pattern for state that must survive store re-creates. U4's inflight-promise dedupe uses the same idiom.
- `src/client/components/ui/popover.tsx` — Radix Popover passthrough. Already nested inside `PromptInput.tsx:87-139` for the stop-confirmation popover. New `CommandPicker` uses the same primitive.
- `src/client/components/PromptInput.tsx` — Integration target. Already has textarea + bottom-right button cluster. The top-of-input toolbar surface is new; needs minor container restructure.

### Filesystem layout for slash commands

- `<workspace>/.claude/commands/*.md` — project commands. YAML frontmatter: `description`, `argument-hint` (kebab-case in the file, projected to `argumentHint` camelCase in DTOs), `aliases`.
- `<workspace>/.claude/skills/<name>/SKILL.md` — modern skill format. Same frontmatter, plus skill body markdown.
- `~/.claude/commands/*.md` — personal commands. Same format as project.
- Plugin commands and SDK built-ins live inside the SDK CLI and are only discoverable through `startup()`.

### Institutional Learnings

- `docs/solutions/` does not exist. No prior learnings to apply.

---

## Key Technical Decisions

### Lazy first-fetch instead of eager warm-up on workspace open

The brainstorm proposed warming `startup()` during workspace open so the first `/` keystroke shows the full list with zero perceptible delay. Research found **no server-side workspace-open hook exists today**: `workspace-store.openWorkspace` is client-side, and `chatService.listSessions(workspaceId)` is the closest server-side touch but does not warm the SDK.

This plan ships **lazy first-fetch**: the first call to `GET /api/workspaces/:id/commands` triggers `startup()`, populates the cache, and attaches the watcher. Subsequent calls return the cached list within milliseconds.

**Why over eager:** Eager warm-up requires either a new lifecycle endpoint (`POST /api/workspaces/:id/open`) or a cross-cutting concern inside `listSessions`. Both add surface area to ship the same data later. Lazy delivers the user-visible value (a working popup) with the minimum new endpoint; the perceived latency (~100-500ms) is bounded to one popup open per server-process lifetime per workspace. Brainstorm F1 ("popup opens within one frame") becomes true from the second open onward; the first open shows a small loading spinner inside the popup while the fetch is in flight.

If first-open latency proves unacceptable in practice, eager warm-up is a clean follow-up — the cache, watcher, and REST endpoint stay identical.

### `chokidar` for filesystem watching

Node's built-in `fs.watch` is unreliable for rename and delete events on macOS and Linux — the exact events that matter when a slash command file is added or removed. `chokidar` normalizes event semantics across platforms, handles editor atomic-rename patterns (vim, IntelliJ), and is the de-facto standard. Adding the dependency (~1MB transitive) is worth the simplicity in U2.

### Hand-rolled command picker, not `cmdk`

`cmdk` is the popular shadcn combobox primitive, but it's a substantial dependency for a single popup. The popup surface is small: filter input, scrollable list, arrow-key nav, Enter/Escape, click. `PromptInput` already uses `@radix-ui/react-popover` (a peer of cmdk's primitives). Hand-rolling keeps the new component aligned with the existing nested-Popover pattern and avoids importing a second component library.

### `fetchInitialization()` returns the parsed response, not the raw `WarmQuery`

The `SdkClient` extension exposes `fetchInitialization(options): Promise<InitializationResponse>` rather than handing callers a `WarmQuery`. The wrapper calls `await query.initializationResult()` and `await query.close()` before returning. Callers do not manage subprocess lifetime; R13 (no session pollution) becomes a property of the wrapper, not of every caller. If a future feature needs the raw `WarmQuery` (e.g., to interleave warm-up with the first real prompt), a second method can expose it then.

### Cache key is `workspace.folderPath`, not `workspace.id`

The cache lives per workspace folder path. Folder path is the natural key — it's what `startup({ options: { cwd } })` receives, and it survives workspace ID renames/migrations. Two workspace IDs pointing at the same folder share the cache, which is correct: their command lists are identical.

### One picker, two anchors

Both the `/`-trigger popup and the Commands button open the **same** `CommandPicker` instance, anchored to different triggers but reading from the same store slice. This trivially satisfies R3 (no behavioral divergence) and concentrates the keyboard-nav/filter logic in one place.

### Watcher rebuild semantics

On a watcher event for project commands or skills, the service re-parses the affected file (or removes its entry on unlink) and patches the cached entry in place. SDK-side commands (built-ins, plugins) are **not** re-fetched on file events — they change only on SDK version bump or plugin install, both of which require server restart in v1.

---

## Implementation Units

### U1. SdkClient: SDK initialization fetcher

**Goal:** Add `SdkClient.fetchInitialization(options): Promise<InitializationResponse>` that wraps `startup({ options })`, awaits `initializationResult()`, calls `close()`, and returns the parsed response. The wrapper is the single boundary where the no-pollution guarantee (R13) is enforced.

**Requirements:** R4, R13.

**Dependencies:** None.

**Files:**
- Modify: `src/server/services/sdk-client.ts`
- Create: `src/server/types/initialization.ts` — `InitializationResponse`, `SlashCommandDto` types (decoupled from the SDK type so the API surface is stable across SDK upgrades).

**Approach:**

- Import `startup` from `@anthropic-ai/claude-agent-sdk`.
- Add `async fetchInitialization(options: Options): Promise<InitializationResponse>`:
  1. `const warm = startup({ options })`.
  2. `const result = await warm.initializationResult()`.
  3. In a `finally`, `await warm.close()` so a thrown initialization error still cleans up the subprocess.
  4. Project `result.commands` into `SlashCommandDto[]` (`name`, `description`, `argumentHint`, `aliases`) and return `{ commands }`.
- Do not surface other initialization fields (agents, output_style, models, account) until a consumer needs them — keep the DTO minimal in v1.

**Patterns to follow:**

- The existing `SdkClient.createQuery(...)` and `createStreamingQuery(...)` methods for SDK-wrapper shape, error propagation, and import style.

**Test scenarios:**

- Happy path: a valid workspace folder containing `.claude/commands/foo.md` returns a response whose `commands` includes `/foo` plus SDK built-ins (`/clear`, `/usage`, `/help` at minimum).
- No-pollution check (R13): after a successful `fetchInitialization` call, the workspace's SDK session directory contains no new JSONL files. Verifiable by listing the directory before and after.
- Cleanup on error: forcing `initializationResult()` to throw (e.g., bad API key in env) still results in `warm.close()` being called. Verifiable by inspecting the process tree after a forced failure.
- Empty workspace: a folder with no `.claude/` directory returns at least the SDK built-ins (the SDK does not error on missing project commands).

**Verification:** `npm run lint` + `npm run build:server`. Manual: an ad-hoc script that calls `SdkClient.fetchInitialization({ cwd: <repo> })` and prints `commands.map(c => c.name).sort()` should print SDK built-ins within ~500ms.

---

### U2. CommandsService: cache, filesystem parser, watcher, failure fallback

**Goal:** Per-workspace cache of the merged command list. Lazily populated on first request. SDK-side commands come from U1. Filesystem-side commands (project, skills, personal) come from a frontmatter parser. A `chokidar` watcher patches the cache on `.claude/commands/` and `.claude/skills/` events. On SDK warm-up failure, the service falls back to filesystem-only and marks the cache entry as partial.

**Requirements:** R4, R11, R12, R13, R14.

**Dependencies:** U1.

**Files:**
- Create: `src/server/services/commands-service.ts`
- Create: `src/server/services/command-fs-parser.ts` — `parseCommandsDir(dir, source)` and `parseSkillsDir(dir, source)` pure functions.
- Create: `src/server/types/commands.ts` — `CachedCommandList = { commands: SlashCommandDto[]; partial: boolean; partialReason?: string; }` and related DTOs.
- Modify: `package.json` — add `chokidar` to `dependencies`.

**Approach:**

- `CommandsService` holds:
  - `private cache = new Map<string, CachedCommandList>()` keyed by `workspace.folderPath`.
  - `private inflight = new Map<string, Promise<CachedCommandList>>()` for concurrent-call dedupe (mirrors `chat-service.creatingRuntimes`).
  - `private watchers = new Map<string, FSWatcher>()` keyed by `workspace.folderPath`.
- Public `async getCommands(workspace: Workspace): Promise<CachedCommandList>`:
  1. If `cache.has(folderPath)`, return cached.
  2. If `inflight.has(folderPath)`, return that promise.
  3. Otherwise build the populate-promise, insert into `inflight` synchronously (before any `await`), and clear it in `finally`.
- Private `async populate(workspace: Workspace): Promise<CachedCommandList>`:
  1. Build SDK options (the workspace-scoped subset of `chat-service.buildSdkOptions` — no `sessionId`, no `resume`). Extract to a shared helper if duplication exceeds the threshold.
  2. Try `const sdkInit = await sdkClient.fetchInitialization(options)`. On success, take `sdkInit.commands` as the SDK-side list.
  3. On SDK failure, log, set `sdkCommands = []`, and remember `partialReason = "SDK initialization failed: <message>"`.
  4. Parse filesystem-side commands in parallel:
     - `parseCommandsDir(path.join(folderPath, '.claude/commands'), 'project')`
     - `parseSkillsDir(path.join(folderPath, '.claude/skills'), 'skill')` — iterates subdirs looking for `SKILL.md`
     - `parseCommandsDir(path.join(os.homedir(), '.claude/commands'), 'personal')`
  5. Merge with SDK list, deduping by name. SDK's view wins on name conflicts (authoritative metadata for built-ins).
  6. Store `{ commands, partial: sdkCommands.length === 0 && partialReason !== undefined, partialReason }` in the cache.
  7. Attach a `chokidar` watcher on `[folderPath/.claude/commands, folderPath/.claude/skills]` with `ignoreInitial: true`. Handlers:
     - `add` / `change`: re-parse the affected file, replace the entry in the cache.
     - `unlink`: drop the entry from the cache.
     - `unlinkDir`: drop all entries from that source.
- `command-fs-parser.ts` exports `parseCommandsDir(dir, source)`:
  1. `await fs.readdir(dir).catch(() => [])` — empty list on ENOENT.
  2. For each `.md` file: read, extract YAML frontmatter via a lightweight regex (`/^---\n([\s\S]*?)\n---/`), then `^(\w[\w-]*):\s*(.+)$` per line for fields. Project `argument-hint` → `argumentHint`. Accept `aliases` as either a comma-separated string or a YAML list.
  3. Name = file basename (sans `.md`) with leading `/`.
  4. Document the parser's field set and limits in a top-of-file comment (no nested keys, no multi-line strings) so the contract is visible.
- `parseSkillsDir(dir, source)`: iterate subdirectories; for each one containing `SKILL.md`, parse that file with the same logic; command name is the directory name with a leading `/`.
- Add a public `dispose()` method that closes all watchers, callable from a future server-shutdown handler. Document that v1 relies on process exit to clean up if no shutdown handler exists.

**Patterns to follow:**

- `src/server/services/chat-service.ts:18-21` — instance-state `Map` pattern.
- The synchronous-insert-before-await pattern in `chat-service.getOrCreateRuntime` (from plan 010, U1) for concurrent-safety on `inflight`.
- `buildSdkOptions` shape for workspace → Options projection.

**Test scenarios:**

- Happy path: `getCommands(workspace)` on a clean cache fetches SDK + filesystem and returns the merged list with `partial: false`.
- Cache hit: a second call returns the same cached entry without re-fetching.
- Concurrent dedupe: two `getCommands(workspace)` calls fired on the same tick resolve to the same `CachedCommandList`; `populate` runs exactly once. Verifiable via a logging assertion.
- Filesystem-only fallback (R14): with SDK warm-up forced to throw, the returned `CachedCommandList` has `partial: true`, `partialReason` populated, and `commands` contains the filesystem entries only.
- Live add (R11): write `<ws>/.claude/commands/foo.md` while the cache is populated; within ~1 second the cache entry includes `/foo`.
- Live remove: delete `<ws>/.claude/commands/foo.md`; the cache entry drops `/foo`.
- Live edit: change `<ws>/.claude/commands/foo.md`'s description; the cache entry's `/foo.description` reflects the new value.
- Missing project dir: workspaces with no `.claude/` directory parse to an empty filesystem list and the cache still returns SDK-side commands.
- Skill scan: `<ws>/.claude/skills/foo/SKILL.md` is parsed and exposes `/foo` from the skill source.
- SDK error after-cache: SDK failure does not corrupt a pre-existing happy-path cache; subsequent calls return the cached `partial: false` entry.

**Verification:** `npm run lint` + `npm run build:server`. Manual: with the dev server running, add `.claude/commands/test.md` to the active workspace and confirm the new command appears within ~1 second on the next `GET /api/workspaces/:id/commands`.

---

### U3. REST endpoint: `GET /api/workspaces/:id/commands`

**Goal:** Expose the cached command list. Look up workspace by ID, delegate to `CommandsService.getCommands(workspace)`, return JSON. On workspace-not-found return 404 with the existing error envelope.

**Requirements:** R4.

**Dependencies:** U2.

**Files:**
- Create: `src/server/routes/workspace-commands.ts`
- Modify: `src/server/index.ts` — mount the new router.

**Approach:**

- `const router = Router({ mergeParams: true });`
- `router.get('/', async (req, res) => { ... })`:
  1. `const workspace = await workspaceStore.get(req.params.id)`.
  2. If null: throw the project's existing `WORKSPACE_NOT_FOUND` error (404) using the same envelope shape used in `chat.ts`.
  3. `const result = await commandsService.getCommands(workspace)`.
  4. `res.json({ commands: result.commands, partial: result.partial, partialReason: result.partialReason })`.
- In `src/server/index.ts`, add `app.use('/api/workspaces/:id/commands', workspaceCommandsRouter)` next to existing workspace-scoped router mounts.

**Patterns to follow:**

- `src/server/routes/chat.ts` for `Router({ mergeParams: true })`, async-handler-with-throw, and error-envelope conventions.

**Test scenarios:**

- Happy path: `curl /api/workspaces/<valid-id>/commands` returns `{ commands: [...], partial: false }` with HTTP 200.
- Unknown workspace: `curl` with an invalid ID returns HTTP 404 with the envelope.
- Partial state (after U2 fallback triggers): the body has `partial: true` and `partialReason` populated.
- Cache hit: a second `curl` for the same workspace ID returns identical body within milliseconds (no SDK warm-up).

**Verification:** `npm run lint` + `npm run build:server`. Manual: `curl` the endpoint against the dev server for an active workspace; confirm a non-empty `commands` array including SDK built-ins.

---

### U4. Client store: `commands-store` slice

**Goal:** A Zustand store that lazily fetches `GET /api/workspaces/:id/commands` on first request per workspace, caches the result in-memory, exposes a `useCommands(workspaceId)` hook, and provides a `clearCommandsForWorkspace` action for workspace-switch invalidation (R12).

**Requirements:** R4, R11 (next-popup visibility), R12, R14 (surface partial state to UI).

**Dependencies:** U3.

**Files:**
- Create: `src/client/stores/commands-store.ts`

**Approach:**

- State shape:
  ```ts
  type CachedCommandList = {
    commands: SlashCommandDto[];
    partial: boolean;
    partialReason?: string;
  };
  type CommandsState = {
    commandsByWorkspace: Record<string, CachedCommandList | undefined>;
    loadingByWorkspace: Record<string, boolean>;
    errorByWorkspace: Record<string, string | undefined>;
    fetchCommands: (workspaceId: string) => Promise<void>;
    refreshCommands: (workspaceId: string) => Promise<void>;
    clearCommandsForWorkspace: (workspaceId: string) => void;
  };
  ```
- Use a module-level `Map<string, Promise<void>>` for inflight-promise dedupe (mirrors `chat-store.ts:8-9`). Store-level fields cannot be relied on for dedupe because they may not be set synchronously between two concurrent calls.
- `fetchCommands(workspaceId)`:
  1. If `commandsByWorkspace[workspaceId]` is populated, return.
  2. If the inflight Map has an entry for `workspaceId`, return that promise.
  3. Otherwise insert a new promise into the inflight Map, set loading, `fetch('/api/workspaces/${workspaceId}/commands')`, parse JSON into `CachedCommandList`, store, clear loading, and clear the inflight entry in `finally`.
  4. On fetch failure, set `errorByWorkspace[workspaceId]` and clear loading.
- `refreshCommands(workspaceId)`: clears the cache entry then calls `fetchCommands`.
- `clearCommandsForWorkspace(workspaceId)`: drops the cache entry. Called from the workspace-switch path so the next open re-fetches.
- Selector hook `useCommands(workspaceId)` returns `{ commands, loading, error, partial, partialReason, fetch, refresh }` where `fetch` is bound to the current workspace.

**Patterns to follow:**

- `src/client/stores/chat-store.ts:8-9` — module-level `Map` for inflight state.
- The Zustand store-creation idiom used elsewhere in `src/client/stores/`.

**Test scenarios:**

- Happy path: `useCommands('abc')` triggers a fetch, populates the cache, returns `{ commands, loading: false, partial: false }` on resolution.
- Cache hit: a second `useCommands('abc')` from another component returns the cached data without a second network request (verifiable in network panel).
- Concurrent dedupe: two components mounting on the same tick fire `fetchCommands('abc')`; only one HTTP request goes out.
- Workspace switch: `clearCommandsForWorkspace('abc')` then `useCommands('abc')` triggers a fresh fetch.
- Partial response: server returns `partial: true`; the hook surfaces `partial: true` and `partialReason`.
- Network error: fetch fails; `error` is populated; loading clears; the picker's failure UI surfaces the message.

**Verification:** `npm run lint` + `npm run build`. Manual: open the app, open the popup, confirm exactly one network request hits `/api/workspaces/<id>/commands` per workspace per session; second open hits no network.

---

### U5. CommandPicker component

**Goal:** Reusable popup component that renders the cached command list with a filter input, scrollable list, keyboard navigation, click selection, and an empty state. Built on Radix Popover. Returns the selected command (name + argumentHint) via callback. Renders the partial-state inline note when `partial: true`.

**Requirements:** R1, R2 (anchored to either trigger), R3, R5, R6, R7, R8 (returns argumentHint), R10, R14.

**Dependencies:** U4.

**Files:**
- Create: `src/client/components/CommandPicker.tsx`

**Approach:**

- Props:
  ```ts
  type CommandPickerProps = {
    workspaceId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSelect: (command: SlashCommandDto) => void;
    trigger: React.ReactNode;
    side?: 'top' | 'bottom';
    align?: 'start' | 'center' | 'end';
    initialFilter?: string;
  };
  ```
- Internal state:
  - `filter: string`
  - `activeIndex: number`
- Lifecycle:
  - On `open` flipping to `true`, call `useCommands(workspaceId).fetch(workspaceId)` (no-op if cached).
  - Focus the filter input on open.
  - Reset `filter` and `activeIndex=0` on close.
- Rendering (inside `PopoverContent`):
  1. Loading spinner if `loading && !commands`.
  2. Error message if `error` and no commands.
  3. Inline note ("Some built-in commands unavailable — check Claude credentials in Settings.") if `partial: true` (R14).
  4. Filter input (text), focused on open.
  5. Scrollable list of rows. Each row:
     - Primary name: `<span className="text-text-primary">/{name}</span>`.
     - Aliases inline (R5): `<span className="text-text-tertiary">/{alias1} /{alias2}</span>`.
     - Description below (R10), one line, truncated with ellipsis.
  6. Empty state: "No commands match `<filter>`".
- Filter logic (R6, R7):
  - `const filtered = filter === '' ? commands : commands.filter(c => c.name.toLowerCase().startsWith(filter.toLowerCase()));`
  - Filter consults `name` only — descriptions and aliases are displayed but not filtered.
- Keyboard handlers on the filter input:
  - `ArrowDown` / `ArrowUp`: cycle `activeIndex` through `filtered`, wrap at ends.
  - `Enter`: call `onSelect(filtered[activeIndex])` and `onOpenChange(false)`.
  - `Escape`: `onOpenChange(false)`.
  - `Tab`: close popup (let focus return to parent textarea).
- Click handler on a row: same as Enter — `onSelect(command)` and close.

**Patterns to follow:**

- `src/client/components/ui/popover.tsx` — Radix Popover wrappers.
- The popover inside `src/client/components/PromptInput.tsx:87-139` — surface styling (rounded, border, shadow), `z-50`.
- Existing Tailwind classes: `text-text-primary`, `text-text-tertiary`, `bg-surface`, `border-border`.

**Test scenarios:**

- Open with full list (R7): `open=true` on a cached workspace renders the full list with the filter empty and focus on the filter input.
- Filter narrows by name prefix only (R6): typing `comm` shows only commands whose name starts with `comm`. A command whose description contains "comm" but name does not is hidden.
- Aliases display (R5): a command with `aliases: ['/cost']` shows the alias inline on the same row as `/usage`.
- Keyboard nav: ArrowDown highlights the next row; ArrowUp the previous; wrap at boundaries; Enter fires `onSelect` with the highlighted row.
- Empty state: a filter that matches nothing renders "No commands match `<filter>`".
- Partial-state note (R14): when `useCommands` returns `partial: true`, the inline note renders at the top; the user can still click filesystem-only rows.
- Reset on close: open, type filter, close; reopen → filter is empty, activeIndex=0.
- Click selection: clicking a row fires `onSelect` and closes.
- Initial-filter pre-population: passing `initialFilter='com'` opens with that filter active (used by U6 when `/com` was typed before the picker opened).

**Verification:** `npm run lint` + `npm run build`. End-to-end exercise comes from U6's integration.

---

### U6. PromptInput integration

**Goal:** Wire the `/`-trigger popup, the Commands button at the top of the input box, and the ghost-text argument hint into `PromptInput.tsx`. Both surfaces use the same `CommandPicker` driver, sharing all state.

**Requirements:** R1, R2, R3, R8, R9.

**Dependencies:** U5.

**Files:**
- Modify: `src/client/components/PromptInput.tsx`
- Add a `workspaceId` prop to `PromptInput` (or read from the `ChatPanel` parent if it already has the workspace in scope).

**Approach:**

- New state in `PromptInput`:
  ```ts
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSource, setPickerSource] = useState<'slash' | 'button'>('slash');
  const [pickerInitialFilter, setPickerInitialFilter] = useState<string>('');
  const [argumentHint, setArgumentHint] = useState<string | null>(null);
  const [lastInsertedCommand, setLastInsertedCommand] = useState<string | null>(null);
  ```
- `/` detection in `onChange`:
  - Compute `prev` (the previous input value, kept in a ref to avoid stale state).
  - If `prev === ''` and the new value starts with `/`, set `pickerOpen=true`, `pickerSource='slash'`, `pickerInitialFilter=value.slice(1)`.
  - If picker is open and the user types more characters after `/`, update the picker's filter via `pickerInitialFilter=value.slice(1)` (the picker should accept the prop and reset its filter when it changes while open, or expose a controlled-filter mode).
  - If the user deletes back to empty, close the picker.
- Commands button:
  - New top-toolbar row inside the rounded input container, above the textarea.
  - `<button onClick={() => { setPickerSource('button'); setPickerInitialFilter(''); setPickerOpen(true); }}>` containing a lucide icon (e.g., `Command` or `SlashSquare`) and the text "Commands".
  - When `pickerSource='button'`, anchor the picker on the button (`side='bottom'` or `side='top'` depending on space; default `bottom`).
  - The button is `disabled` whenever the textarea is `disabled` (during streaming/interrupting), with `cursor-not-allowed` styling.
- Container restructure:
  - Today: `<div ...rounded><textarea /><button cluster bottom-right /></div>`.
  - New: `<div ...rounded><div top-toolbar><CommandsButton /></div><textarea /><button cluster bottom-right /></div>`.
  - Preserve `focus-within` border-color change behavior.
- `handleCommandSelect(command)`:
  1. Set `input` to `/${command.name} ` (trailing space).
  2. If `command.argumentHint`, set `argumentHint` state to the hint string.
  3. Set `lastInsertedCommand` to `/${command.name} ` so the ghost-text guard knows when to clear.
  4. Close picker, refocus textarea, position cursor at end.
- Ghost-text rendering (R8):
  - When `argumentHint` is set and `input === lastInsertedCommand`, render a non-interactive `<span className="absolute pointer-events-none text-text-tertiary">{argumentHint}</span>` overlaying the textarea, positioned at the cursor location (use a simple measurement: textarea content width up to the inserted command + small gap).
  - Simpler v1 alternative: render the hint as text after the inserted command using a `display: inline` overlay only when `input === lastInsertedCommand`. As soon as `input !== lastInsertedCommand` (user typed any character beyond the inserted command), clear `argumentHint`.
- Send-on-Enter (R9): unchanged. When the picker is open, the picker's keyboard handler intercepts Enter for selection.

**Patterns to follow:**

- Existing `Popover` usage at `PromptInput.tsx:87-139` for trigger/content layout and z-index.
- Existing className idioms (`bg-surface`, `border-border`, rounded surface, focus-within).
- Existing lucide-react imports.

**Test scenarios:**

- F1 (`/` opens popup): empty input → type `/` → popup opens anchored above the textarea; full list visible.
- F2 (filter + select): empty input → type `/com` → popup filters to commands whose names start with `com`; ArrowDown + Enter inserts the highlighted command; ghost text renders for argumentHint.
- F3 (button opens same picker): click the top Commands button → same popup opens; same rows and behavior.
- F4 (live filesystem update): with the popup having been opened once, add `.claude/commands/new-thing.md` to the workspace externally; the next `/` keystroke shows `/new-thing`. (Composite test: relies on U2 watcher + U4 cache-bust behavior, which today only re-fetches on workspace switch — for F4 the next popup open re-reads the server cache, so this requires U4's `refreshCommands` to be called on watcher-driven cache changes OR for the picker to re-fetch on each open. **In v1, the picker re-fetches on each open if the cache is older than a configurable threshold (default: no caching across opens — re-fetch every time the picker opens). This makes F4 trivially correct at the cost of one HTTP request per popup open.**)
- F5 (failure fallback): with SDK warm-up failing, the popup shows the partial-state inline note and the filesystem-only command list; selecting still works.
- `/` mid-prompt does NOT trigger (out of scope per origin): typing `/` after other characters does not open the popup.
- Backspace-to-empty: `/co` → `/` → `` closes the picker when the textarea becomes empty.
- Streaming/disabled state: Commands button is disabled when textarea is disabled; clicking it does nothing.
- Send after selection (R9): pick command, type argument, Enter sends.
- Outside click: clicking outside the popup closes it (Radix default).

**Verification:** `npm run lint` + `npm run build`. Manual: exercise all five origin flows (F1-F5) in the dev server, including the live filesystem update from F4. Confirm AE1-AE6 from the origin requirements doc.

**Note on F4 re-fetch policy:** the brainstorm's R11 says "reflected immediately on the next open" via the watcher. The simplest correct implementation is for `CommandPicker` to call `refreshCommands(workspaceId)` on every open. The server-side cache + watcher still amortizes SDK warm-up (the server only calls `startup()` once); only the parsed filesystem list is re-emitted. This makes F4 trivial. If profiling reveals the per-open re-fetch is costly, we can add SSE push for watcher events in a follow-up.

---

## System-Wide Impact

- **New server surface:** `GET /api/workspaces/:id/commands`. No changes to existing routes, SSE channels, or session lifecycle. The commands service is fully isolated from `chat-service`.
- **New dependency:** `chokidar` (server runtime). Adds ~1MB of transitive deps; widely used.
- **No SDK breaking changes:** Uses `startup()` and `WarmQuery.close()` which are present in `sdk.d.ts`. If a future SDK release removes or renames them, U1 is the single point of repair.
- **Client state surface:** New Zustand store (`commands-store`). Does not interact with `chat-store` or `workspace-store` internally; `PromptInput` reads from both.
- **PromptInput structural change:** Adds a new top-toolbar row inside the rounded input container. Existing bottom-right button cluster, focus behavior, and disabled state semantics are preserved.
- **Filesystem watcher lifetime:** One `chokidar` watcher per workspace stays alive for the server process lifetime. `CommandsService.dispose()` exists for future server-shutdown handling; v1 relies on process exit to release file descriptors.
- **Performance:** Subprocess-spawn cost (~100-500ms) is paid on the first popup open per workspace per server-process lifetime. Subsequent opens are cache hits.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `startup()` semantics differ across SDK versions or drop the no-prompt control path | U1 isolates the call; CI build catches missing exports. Verified present at planning time. |
| `chokidar` watcher misses events on network filesystems or very large directories | Use polling=false default for local FS speed; document the limitation; network-FS workspaces are out of scope. |
| Filesystem-only fallback parser drifts from SDK's frontmatter interpretation | Document the parser's field set and limits in `command-fs-parser.ts` (no nested keys, no multi-line strings). Re-verify if the SDK adds a new frontmatter field. |
| First-popup latency visible on cold cache | Picker shows a loading spinner while the fetch is in flight. Acceptable for v1; eager warm-up is a deferred follow-up. |
| Watcher file-descriptor leak if `dispose()` not wired on server shutdown | Add `dispose()` method on `CommandsService`. If no server shutdown handler exists in v1, defer to v2 — process exit cleans up FDs. |
| Two workspaces opened on the same folder path race on first-fetch | Client-side dedupe via the inflight Map (U4); server-side dedupe via the per-folderPath inflight Map (U2). |
| SDK's alias and a separately-declared filesystem command collide on name | U2 step 5: SDK's view wins. Document in a comment near the merge logic. |
| Per-popup-open re-fetch (F4 implementation policy) creates HTTP overhead | The server cache + watcher amortizes the SDK warm-up; only the parsed filesystem list is re-emitted. Profile in dev; revisit with SSE push if measured cost is high. |

**Dependencies (new):**
- `chokidar` (server).

**Dependencies (existing, verified):**
- `@anthropic-ai/claude-agent-sdk` exporting `startup()` + `WarmQuery` (sdk.d.ts:5483-5773).
- `@radix-ui/react-popover`, `zustand`, `react`, `lucide-react` (client) — already in use.

---

## Sources & References

- **Origin requirements doc:** [docs/brainstorms/2026-05-17-slash-command-discovery-requirements.md](../brainstorms/2026-05-17-slash-command-discovery-requirements.md) — R1-R14, F1-F5, AE1-AE6.
- **SDK types:** `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (verified `startup`, `WarmQuery`, `Query.initializationResult`, `SlashCommand`).
- **SDK runtime:** `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` (verified `supportedCommands` and `initializationResult` implementations).
- **Official discovery docs** (the route this plan bypasses): <https://code.claude.com/docs/en/agent-sdk/slash-commands>
- **Existing patterns:**
  - `src/server/services/chat-service.ts:18-21` — service-with-Map cache; `:237-270` — `buildSdkOptions` projection.
  - `src/server/services/sdk-client.ts` — SDK wrapper extension point.
  - `src/server/routes/chat.ts` — Express router + error envelope conventions.
  - `src/server/index.ts` — router mount site.
  - `src/client/stores/chat-store.ts:8-9` — module-level `Map` for inflight state.
  - `src/client/components/ui/popover.tsx` — Radix Popover passthrough.
  - `src/client/components/PromptInput.tsx:87-139` — existing nested Popover usage (stop confirmation).
- **Predecessor plan style:** [docs/plans/2026-05-17-010-fix-chat-streaming-and-stop-button-state-plan.md](2026-05-17-010-fix-chat-streaming-and-stop-button-state-plan.md).
