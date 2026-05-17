---
date: 2026-05-17
topic: slash-command-discovery
---

# Slash Command Discovery in PromptInput

## Summary

Surface the workspace's available slash commands in the prompt input without polluting the user's session history. Two affordances share one underlying command list: typing `/` as the first character opens an inline popup (speed path), and a persistent **Commands** button at the top of the input box opens the same list (discovery path). The list includes every command the SDK exposes — built-ins (`/clear`, `/usage`, `/help`), project commands in `.claude/commands/*.md`, skills in `.claude/skills/<name>/SKILL.md`, plugins, and personal commands in `~/.claude/commands/*.md`. Discovery is sourced entirely out-of-band of the user's message stream: no fake prompts are sent, no session JSONL is written.

---

## Problem Frame

The official Claude Agent SDK slash-commands docs ([code.claude.com](https://code.claude.com/docs/en/agent-sdk/slash-commands)) describe one discovery path: read `slash_commands: string[]` off the `system/init` message that the SDK emits **after** a user prompt fires a `query()`. Sending that prompt is what produces the init message — so this discovery route necessarily writes a user message into the session transcript. For an application like CCG that wants to expose command discovery as **application behavior** rather than something the user has to do, this is pollution.

A read of the installed SDK type definitions (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`) shows the SDK actually exposes two further routes the docs page doesn't mention:

- `startup({ options })` (sdk.d.ts:5490) pre-warms the CLI subprocess, runs the initialize handshake, and returns a `WarmQuery`. The handshake produces the merged command list internally; `WarmQuery.close()` discards the process without sending any prompt.
- `Query.initializationResult()` and `Query.supportedCommands()` (sdk.d.ts:2092, 2098) are control-request methods on any open streaming-input `Query` that return the same data without firing a user turn.

Both routes deliver the same merged list (built-ins + project + plugins + skills + personal) that the post-prompt `system_init` message would carry. Neither writes a user message; neither persists a session JSONL when the warm-up is closed before any prompt fires.

The current PromptInput at `src/client/components/PromptInput.tsx` has no slash-command discovery surface. There is rendering-side handling for slash-command events that already appear in message history (`src/client/lib/cli-meta.ts`, `src/client/components/ai-elements/muted-system-note.tsx`), but no input-side autocomplete or browse affordance. Users today type slash commands from memory; users who don't remember a command's name or don't know one exists never use it.

---

## Requirements

**Discovery surfaces**

- R1. Typing `/` as the **first character of an empty input** opens an inline popup anchored to the textarea. The popup lists available commands; the user can scroll, type to filter, click, or use arrow keys + Enter to select.
- R2. A persistent **Commands** button is mounted at the **top of the input box** (inside the input's rounded container, above the textarea). Clicking it opens the same list as a panel/dropdown.
- R3. Both surfaces share the same underlying command list and selection behavior; there is no behavioral divergence between the two entry points.

**Source scope**

- R4. The list contains **every command the SDK exposes** for the active workspace:
  - SDK built-ins (`/clear`, `/usage`, `/help`, `/cost`, etc.)
  - Project commands (`.claude/commands/*.md` in the workspace folder)
  - Skills (`.claude/skills/<name>/SKILL.md` in the workspace folder)
  - Plugin-contributed commands
  - Personal commands (`~/.claude/commands/*.md`)
- R5. Aliases that resolve to the same command (e.g., `/cost` → `/usage`) are displayed alongside the primary name on the same row, not as separate rows.

**Filtering & selection**

- R6. As the user types characters after `/`, the popup filters to commands whose **name starts with** the typed string (case-insensitive prefix match). Descriptions are not consulted by the filter.
- R7. When the filter is empty (the user has typed only `/`, or just opened the Commands button), the popup shows the **full unfiltered list** for browsing.
- R8. Selecting a command (click, or arrow-keys + Enter) inserts the command name at the start of the input and closes the popup. If the command has an `argumentHint` (e.g., `<file>`, `<commit-message>`), the hint renders as **ghost text** after the inserted name, fading away as the user types real argument text.
- R9. After selection, the user types arguments (if any) and presses Enter to send, the same as any other prompt.

**Display per row**

- R10. Each row shows the command's name (with leading `/`), its description, and its aliases when present. Arguments hint is shown only after selection (as ghost text), not in the row itself.

**Freshness**

- R11. Changes to project commands (`.claude/commands/*.md`) and skills (`.claude/skills/<name>/SKILL.md`) in the workspace folder are reflected in the popup **immediately** on the next open, via a filesystem watcher. The user does not need to close/reopen the session or restart the app.
- R12. SDK-side commands (built-ins, plugins) refresh on workspace open. They do not need live updates — these change only on SDK version or plugin install, both of which are rare during a working session.

**No session pollution**

- R13. The discovery mechanism does **not** send any user message, does not write any visible system message into the chat transcript, and does not persist a session JSONL file solely for the purpose of discovery.

**Failure resilience**

- R14. If the SDK warm-up fails (subprocess spawn error, network, auth issue), the popup falls back to **filesystem-only commands** (project + skills + personal) and surfaces a small inline note explaining that built-ins are unavailable. The user can still select project commands.

---

## Selected Approach

**Eager SDK warm-up + filesystem watcher** (Approach A from the brainstorm exploration).

When a workspace is opened (or on first access by the discovery surface), the server calls `startup({ options: { cwd: workspace.folderPath, ... } })` from the Claude Agent SDK, awaits `initializationResult()` to obtain the full merged command list, and calls `WarmQuery.close()` to discard the warm-up subprocess. The result is cached server-side per workspace.

A filesystem watcher on the workspace's `.claude/commands/` and `.claude/skills/` directories parses changed files and patches the cached list. The SDK route is re-fetched on workspace re-open (rare).

The client retrieves the cached list from the server via a simple REST endpoint and renders the popup/Commands-button surfaces from it.

**Why this approach over alternatives:**
- Approach B (filesystem-first + opportunistic SDK enrichment) maintains two source-of-truth code paths to merge, and the first popup briefly lacks built-ins — unhelpful given the requirement emphasizes a fast, complete list.
- Approach C (lazy on-demand SDK warm) produces a visible loading state on the user's first popup in each workspace, which fights the speed bias.
- Approach A pays its subprocess-spawn cost during workspace open, which already has other loading affordances, so the cost is invisible to the user.

---

## Scope Boundaries

**In scope**

- Command discovery and surfacing in PromptInput (popup + Commands button)
- Filesystem watcher for live updates to project/skills directories
- SDK warm-up via `startup()` for built-ins, plugins, and merged metadata
- Caching + REST exposure on the server
- Failure fallback to filesystem-only when SDK route fails

**Out of scope**

- Inline argument validation or type-checked argument forms (`argumentHint` is plain ghost text only)
- Recently-used / most-used ranking (could be added later; not in v1)
- Cross-workspace command search or discovery
- Editing or authoring of slash command files (read-only surfacing)
- Triggering the popup on `/` anywhere mid-prompt (only at first character of empty input)
- Smart suggestions based on conversation context (e.g., "you're discussing commits, here's `/commit`")
- Discovery surface for non-slash affordances (agents, models, output styles — these are exposed by similar SDK methods but are separate UX)

---

## Key Flows

**F1. First-time popup on a workspace with no cached commands**
1. User opens a workspace.
2. Server kicks off `startup()` warm-up in the background while the workspace UI renders.
3. User types `/` in the input.
4. Popup opens. Cache is already populated (or completes within the typical UI-render window).
5. Full unfiltered list renders; user begins typing to filter or scrolls to browse.

**F2. Filter and select (speed path)**
1. User types `/com` in the input.
2. Popup filters in real-time: shows `/commit`, `/comment` (any commands whose names start with "com").
3. User presses arrow-down + Enter (or clicks a row).
4. Input becomes `/commit ` with ghost text `<file>` after it.
5. User types `package.json`, presses Enter — message sends.

**F3. Browse via Commands button (discovery path)**
1. User clicks the Commands button at the top of the input box.
2. Same list opens as a panel/dropdown.
3. User scrolls, reads descriptions, finds `/run-tests`, clicks it.
4. Input becomes `/run-tests ` with ghost text `<glob>` after it.
5. User types `**/*.spec.ts`, presses Enter — message sends.

**F4. Live update via filesystem watcher**
1. User has the PromptInput visible in workspace X.
2. In another terminal, the user adds a new file `.claude/commands/new-thing.md` to workspace X.
3. The filesystem watcher detects the new file, parses its frontmatter, patches the server-side cache.
4. The user types `/` in the input; the popup includes `/new-thing` immediately, no restart required.

**F5. SDK warm-up failure fallback**
1. User opens a workspace; the SDK `startup()` subprocess fails (e.g., auth token expired).
2. Server caches the filesystem-only command list (project + skills + personal).
3. User types `/` — popup opens with the filesystem-only list and a small inline note: "Some built-in commands unavailable — check Claude credentials in Settings."
4. User can still select project commands and use them.

---

## Acceptance Examples

**AE1. Popup opens on first `/` keystroke with full list**
- Given: workspace is open and warm-up has completed
- When: user types `/` in an empty input
- Then: popup opens within one frame; full command list visible with names + descriptions; arrow keys cycle through rows; Escape closes the popup

**AE2. Filter narrows results by name prefix only**
- Given: popup is open and unfiltered
- When: user types `comm`
- Then: only commands whose name starts with "comm" (case-insensitive) remain visible; commands whose description happens to contain "comm" are NOT shown

**AE3. Selection inserts name + ghost-text hint**
- Given: popup is open with `/commit` highlighted, and `/commit` has `argumentHint: "<file>"`
- When: user presses Enter
- Then: input contains `/commit `, popup closes, ghost text `<file>` renders after the inserted name; ghost text disappears as the user types real characters

**AE4. New project command appears live without restart**
- Given: workspace is open and popup has been used at least once (cache populated)
- When: a new file `.claude/commands/foo.md` with valid frontmatter is added externally
- Then: within ~1 second, the next `/` keystroke shows `/foo` in the popup; no app restart, no workspace switch

**AE5. No session pollution after using discovery**
- Given: user opens a fresh workspace, opens and closes the popup three times, never selects a command
- When: the user inspects the workspace's SDK session list and the chat transcript
- Then: no new sessions have been created; no system or user messages have been added to any transcript

**AE6. Commands button opens the same list as `/`**
- Given: workspace is open
- When: user clicks the Commands button at the top of the input box
- Then: same panel/dropdown opens as if the user had typed `/`; same rows, same selection behavior, same filter behavior

---

## Dependencies & Assumptions

**Dependencies**

- The installed `@anthropic-ai/claude-agent-sdk` version must export `startup()` and `WarmQuery`. Verified present in current `node_modules` (sdk.d.ts:5490, 5762).
- Filesystem watcher (e.g., `chokidar` or Node's `fs.watch`) for `.claude/commands/` and `.claude/skills/`. May already be available in the server stack; planning will confirm.

**Assumptions**

- `startup({ options: { cwd: <workspace.folderPath> } })` cleanly handles workspaces that have no `.claude/` directory yet (empty list of project commands, still returns built-ins). Verified by reading the SDK implementation but not yet exercised in CCG.
- Plugin-contributed commands surface through `Query.initializationResult().commands` (the SDK merges plugins into the same list). Documented by the SDK; planning step will confirm at integration time.
- A subprocess-spawn cost in the ~100-500ms range during workspace open is acceptable and not user-visible given existing workspace-load UI.
- Aliases are exposed by the SDK (`SlashCommand.aliases?: string[]`, sdk.d.ts:5422). Multiple-name display per row is straightforward.

---

## Outstanding Questions (Deferred to Planning)

These are technical/architectural questions left for `/ce-plan`:

- **Exact placement of the Commands button** at the top of the input box — inside the rounded container as a left-aligned chip vs. an icon-only button in a small toolbar row? Visual design call.
- **Filesystem watcher implementation** — `chokidar` (richer, dependency) vs `fs.watch` (built-in, fewer events). Tradeoff is reliability of rename/delete detection.
- **REST endpoint shape** — `GET /api/workspaces/:id/commands` returning a flat list, or a streaming/SSE channel so live updates push to the client without polling? Likely flat REST + invalidation via existing SSE channel.
- **Plugin command refresh** — if a plugin is installed or updated mid-session, does the cache need to invalidate? May require a manual refresh action.
- **Server-side caching key** — per `workspace.id` or per `workspace.folderPath`? Folder path is more robust if a workspace ID is renamed/migrated.
- **Frontmatter parsing for filesystem-only fallback (R14)** — what fields to parse from `.md` files when the SDK is unavailable. The SDK does its own parsing; for fallback we'd need a lightweight YAML reader.

---

## Sources & References

- **SDK type definitions**: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` — verified `startup()`, `WarmQuery`, `Query.initializationResult()`, `Query.supportedCommands()`, `SlashCommand` type
- **SDK docs**: <https://code.claude.com/docs/en/agent-sdk/slash-commands> — official discovery via `system_init` message (the route this brainstorm bypasses)
- **Existing rendering-side handling**: `src/client/lib/cli-meta.ts`, `src/client/components/ai-elements/muted-system-note.tsx`, `src/client/components/MessageList.tsx`
- **PromptInput integration target**: `src/client/components/PromptInput.tsx`
- **Related prior work**: `docs/plans/2026-05-16-009-feat-streaming-input-mode-prompt-input-plan.md` (PromptInput architecture), `docs/plans/2026-05-17-010-fix-chat-streaming-and-stop-button-state-plan.md` (recent PromptInput updates)
