---
title: WeCom HTTP Bridge and CLI
type: feat
status: active
date: 2026-05-22
origin: docs/brainstorms/2026-05-22-wecom-http-bridge-requirements.md
---

# WeCom HTTP Bridge and CLI

## Summary

Add a bot-scoped HTTP endpoint to the existing server for sending proactive WeCom messages, plus a CLI that skills invoke to call it. The CLI discovers bot context from a `.claude/wecom-context.json` file written to the workspace when the bot connects. The endpoint is localhost-trusted with no cryptographic auth.

---

## Problem Frame

The existing WeCom bot integration only supports request-response: a user messages the bot, Claude processes it, and the response returns to that user. There is no way for a skill running inside a Claude Code session to send proactive messages — to the original user with progress updates, or to other people with intermediate results. Skills that need this today would have to import the WeCom SDK directly, coupling them to credentials they should not handle.

---

## Requirements

- R1. When a workspace's WeCom bot connects successfully, the server writes a context file to the workspace directory.
- R2. When the bot disconnects or its configuration changes to disabled, the file is removed.
- R3. The file is located at a predictable path within the workspace so the CLI can discover it by walking upward from the current directory.
- R4. The server exposes an HTTP endpoint for sending WeCom messages.
- R5. The endpoint accepts a bot ID, recipient user ID, message text, and an optional message type (text or markdown).
- R6. The endpoint looks up the workspace and bot credentials using the bot ID, then sends the message via the existing WeCom SDK.
- R7. The endpoint returns a clear success or failure response to the caller.
- R8. The CLI command is `wecom msg send --to-user <id> --message "..."`.
- R9. The CLI discovers the active bot by searching upward from the current working directory for the workspace context file.
- R10. The CLI calls the HTTP endpoint using the bot ID and server URL from the context file.
- R11. The CLI supports sending markdown messages.
- R12. When no context file is found, the CLI exits with a clear error.
- R13. When the HTTP endpoint returns an error, the CLI surfaces that error with a non-zero exit code.

**Origin actors:** A1 (Skill developer), A2 (Running skill / agent), A3 (WeCom recipient)

**Origin flows:** F1 (Workspace file written on bot connect), F2 (Skill sends proactive message), F3 (Workspace file cleaned up on disconnect)

**Origin acceptance examples:** AE1 (Covers R1, R4, R8, R9, R10), AE2 (Covers R2, R12), AE3 (Covers R11)

---

## Scope Boundaries

- Group chat support — 1:1 direct messages only.
- Non-text messages (images, files, voice) — text and markdown only.
- Delivery receipts, read receipts, or message status tracking.
- Message queue, retry logic, or offline buffering beyond basic error handling.
- Authentication tokens or API keys on the HTTP endpoint — relies on localhost / same-host trust.
- Bundling the CLI into the Tauri sidecar binary — the CLI is a separate script in v1.
- Rate limiting on the send endpoint.

### Deferred to Follow-Up Work

- Tauri sidecar integration for the CLI: bundle or expose the CLI within the desktop app distribution.
- Environment-variable fallback for CLI discovery as an alternative to the context file.
- `--to-group` flag for group chat support.

---

## Context & Research

### Relevant Code and Patterns

- `src/server/index.ts` — Express app bootstrap. Server listens on `PORT` (default 3000). `wecomBotService.initialize()` is called after `server.listen()`. Graceful shutdown calls `wecomBotService.disconnectAll()`.
- `src/server/services/wecom-bot-service.ts` — Singleton `WeComBotService` manages websocket connections keyed by `workspaceId`. `sendResponse` calls `conn.client.sendMessage()` with `{ msgtype: 'markdown', markdown: { content: text } }`. Connection status is tracked in a `Map<string, BotConnection>`.
- `src/server/routes/workspaces.ts` — Existing route pattern: `Router({ mergeParams: true })`, `try/catch` with `console.error` + JSON error response.
- `src/server/models/workspace.ts` — `WorkspaceSettings` already has `wecomBotId`, `wecomBotSecret`, `wecomBotEnabled`.
- `src/server/storage/sqlite-store.ts` — `Workspace` records have `folderPath`. Workspace settings are stored as JSON in the `settings` column.
- `scripts/build-sidecar.ts` — Bundles server into a single CJS binary via esbuild + pkg. Native modules (`better-sqlite3`) are external.
- `package.json` — Uses ESM (`"type": "module"`). `tsx` for dev execution. `tsc -p tsconfig.server.json` for server compilation.
- `tsconfig.server.json` — `rootDir: "./src/server"`, `composite: true`. Files outside `src/server/` cannot be imported into the server build.

### Institutional Learnings

- Bot config lives in `WorkspaceSettings` as optional fields — no schema migration needed.
- `WeComBotService` is initialized after `server.listen()` and disconnected on graceful shutdown.
- Auto-reconnect uses exponential backoff (2s base, 30s max) in the SSE client; bot websocket follows the same pattern.
- The `onEvent` callback on `SseEmitter` fires independently of SSE subscribers — bot sessions consume events without competing for `activeRes`.

### External References

- WeCom AI bot developer documentation at https://developer.work.weixin.qq.com/document/path/101463

---

## Key Technical Decisions

- **Context file at `.claude/wecom-context.json`:** Uses the existing `.claude/` directory convention already present in many projects. Keeps the file namespaced and unlikely to collide with user files.
- **Server URL passed to `WeComBotService` via setter:** The server knows its actual listening port only after `server.listen()` fires. A setter on the singleton avoids constructor-ordering problems.
- **Bot ID lookup in-memory via `WeComBotService`:** Maintains a `Map<botId, workspaceId>` on connect/disconnect. Rejects duplicate bot IDs at connect time. Avoids querying JSON-in-SQLite for every send request.
- **CLI as standalone TypeScript script:** Lives at `src/cli/wecom-send.ts`, uses only Node.js built-ins (`fs`, `path`, `http`), bundled with esbuild for distribution. No server imports needed.
- **Connection state verified before sending:** The endpoint checks `getStatus()` and returns 503 if the bot is disconnected, preventing misleading success responses.
- **Read-only workspace = warning, not fatal:** If the server cannot write the context file, the bot connection still handles request-response. Proactive messaging is unavailable for that workspace.
- **No auth tokens — localhost trust:** The endpoint is reachable only from processes on the same host. This matches the existing server's security posture (no auth middleware).

---

## Open Questions

### Resolved During Planning

- **Authentication model for the endpoint:** Localhost trust only. The requirements doc's R4 "authenticated" is interpreted as "reachable only from same-host processes" given the explicit scope boundary rejecting auth tokens.
- **Server URL written to context file:** `http://localhost:${actualPort}` where `actualPort` comes from `server.address()`. This is sufficient for same-host CLI access.
- **msgType interface:** Explicit `--msg-type markdown|text` flag on the CLI, defaulting to `text`.
- **Context file schema:** `{ botId: string, serverUrl: string }`.
- **Bot ID duplicate handling:** Reject connect for the second workspace with the same bot ID; log an error.

### Deferred to Implementation

- **Exact exit codes for the CLI:** The plan specifies 0 (success), 1 (generic error), 2 (no context file), 3 (HTTP error). The implementer may refine these.
- **CLI search boundary behavior on permission errors:** The plan says "search upward to filesystem root." The implementer should decide whether to handle `EACCES` on intermediate directories gracefully.

---

## Implementation Units

### U1. Server URL plumbing and bot ID indexing

**Goal:** Make the server's listening URL available to `WeComBotService`, and add an in-memory bot ID to workspace lookup with duplicate rejection.

**Requirements:** R6

**Dependencies:** None

**Files:**
- Modify: `src/server/index.ts`
- Modify: `src/server/services/wecom-bot-service.ts`

**Approach:**
- Add a `serverUrl` setter and a `botIdToWorkspaceId` Map to `WeComBotService`.
- In `connect()`, after validating credentials, check if the bot ID is already in the Map. If so, log an error and abort the connection.
- On successful connect, add `(botId, workspaceId)` to the Map.
- In `disconnect()` and `disconnectAll()`, remove entries from the Map.
- In `src/server/index.ts`, after `server.listen()` resolves, call `wecomBotService.setServerUrl(
http://localhost:${actualPort}
)` before `initialize()`.
- Add a `getWorkspaceIdByBotId(botId)` method to `WeComBotService`.

**Patterns to follow:**
- Existing singleton pattern in `WeComBotService`.
- Existing `Map<string, BotConnection>` for connection tracking.

**Test scenarios:**
- Happy path: Server starts, URL is passed, bot connects, lookup returns correct workspace ID.
- Edge case: Two workspaces configured with the same bot ID — second connect is rejected with a logged error.
- Edge case: Bot disconnect removes the entry from the lookup Map.
- Integration: `getWorkspaceIdByBotId` returns undefined for unknown bot IDs.

**Verification:**
- `WeComBotService` can resolve workspace ID from bot ID after connect.
- Duplicate bot IDs are rejected at connect time.

---

### U2. Workspace context file lifecycle

**Goal:** Write the workspace context file when a bot connects, clean it up on disconnect, and handle stale files on startup.

**Requirements:** R1, R2, R3

**Dependencies:** U1

**Files:**
- Modify: `src/server/services/wecom-bot-service.ts`

**Approach:**
- On `authenticated` event, write `.claude/wecom-context.json` to `workspace.folderPath` with schema `{ botId, serverUrl }`.
- Use `path.resolve` + `startsWith` to validate the target path stays within the workspace (same pattern as `files.ts`).
- If the write fails (e.g., read-only directory), log a warning and continue — the bot still handles inbound messages.
- In `disconnect()`, remove the file if it exists.
- Add a `cleanupStaleContextFiles()` method called during `initialize()` that scans all workspace directories and removes context files for workspaces whose bots are not currently connected.
- Handle SIGKILL/crash staleness: on server startup, `cleanupStaleContextFiles()` removes files for bots that are no longer in the connections Map.

**Patterns to follow:**
- Path validation from `src/server/routes/files.ts`.
- Existing `workspace.folderPath` access pattern.

**Test scenarios:**
- Happy path: Bot connects, `.claude/wecom-context.json` is written with correct botId and serverUrl.
- Happy path: Bot disconnects, the context file is removed.
- Edge case: Workspace directory is read-only — warning logged, connection continues, no file exists.
- Edge case: Server starts with a stale context file from a previous crashed session — cleanup removes it.
- Integration: Changing `folderPath` on a workspace leaves the old file orphaned; this is accepted as a known limitation (see Scope Boundaries).

**Verification:**
- Context file exists after bot connect and is absent after disconnect.
- Stale files are cleaned up on server startup.

---

### U3. HTTP endpoint for proactive messaging

**Goal:** Add a POST endpoint that accepts a bot ID and message details, verifies the bot is connected, sends via the WeCom SDK, and returns structured status.

**Requirements:** R4, R5, R6, R7

**Dependencies:** U1, U2

**Files:**
- Create: `src/server/routes/wecom-bridge.ts`
- Modify: `src/server/index.ts`

**Approach:**
- Create `wecomBridgeRoutes` as an Express Router (no `mergeParams` needed — bot ID is in the POST body).
- Mount at `/api/wecom/send` in `src/server/index.ts`.
- Request body: `{ botId: string, toUser: string, message: string, msgType?: 'text' | 'markdown' }`.
- Validate required fields; return 400 if any are missing.
- Look up workspace ID via `wecomBotService.getWorkspaceIdByBotId()`.
- Return 404 if bot ID is unknown.
- Check `wecomBotService.getStatus(workspaceId)`; return 503 if not `connected`.
- Get the `BotConnection` from the connections Map and call `client.sendMessage()` with the appropriate msgtype.
- Wrap the SDK call in try/catch. On SDK error, return 502 with the error message.
- On success, return 200 with `{ success: true }`.

**Patterns to follow:**
- Existing route error handling: `console.error` + `res.status(...).json({ error: ... })`.
- Existing `files.ts` path validation for security.

**Test scenarios:**
- Happy path: Valid bot ID, connected bot, message sent successfully — returns 200.
- Error path: Unknown bot ID — returns 404.
- Error path: Bot disconnected — returns 503.
- Error path: Missing `toUser` or `message` — returns 400.
- Error path: WeCom SDK throws — returns 502 with error detail.
- Integration: Message sent with `msgType: 'markdown'` uses the correct SDK payload shape.

**Verification:**
- `POST /api/wecom/send` returns appropriate status codes for all test scenarios.
- A connected bot successfully delivers a message to the specified user.

---

### U4. CLI tool

**Goal:** Create a `wecom msg send` CLI that discovers the workspace context file, reads bot credentials, and calls the HTTP endpoint.

**Requirements:** R8, R9, R10, R11, R12, R13

**Dependencies:** U3

**Files:**
- Create: `src/cli/wecom-send.ts`

**Approach:**
- Parse `process.argv` manually (no external dependency needed; the CLI is small).
- Command: `wecom msg send --to-user <id> --message "..." [--msg-type text|markdown]`.
- Search upward from `process.cwd()` for `.claude/wecom-context.json`, stopping at the filesystem root.
- If not found, print error to stderr and exit with code 2.
- Read and parse the JSON file.
- Validate that `botId` and `serverUrl` are present.
- Construct the endpoint URL: `${serverUrl}/api/wecom/send`.
- POST with JSON body `{ botId, toUser, message, msgType }`.
- On HTTP 200, exit 0.
- On HTTP error (4xx/5xx), print the server's error message to stderr and exit with code 3.
- On network error (connection refused, timeout), print error to stderr and exit with code 3.
- Default `msgType` to `'text'`. When `--msg-type markdown` is passed, send `'markdown'`.

**Technical design:**
The CLI is intentionally small and dependency-free (Node.js built-ins only). This avoids bundling issues and keeps startup fast.

**Patterns to follow:**
- Node.js `fs`, `path`, `http` / `https` modules.

**Test scenarios:**
- Happy path: Context file found, valid bot, message sent — exits 0.
- Happy path: Markdown message with `--msg-type markdown` — sends correct msgType.
- Error path: No context file in directory tree — exits 2 with clear message.
- Error path: Context file exists but server returns 404 (unknown bot) — exits 3 with error.
- Error path: Server returns 503 (bot disconnected) — exits 3 with error.
- Error path: Server is not running (connection refused) — exits 3 with error.
- Edge case: Context file has invalid JSON — exits 1 with parse error.

**Verification:**
- The CLI can be run as `npx tsx src/cli/wecom-send.ts msg send --to-user U123 --message "hello"`.
- All error paths produce non-zero exit codes and clear stderr messages.

---

### U5. Package integration and build wiring

**Goal:** Wire the CLI into package.json and ensure it compiles with the server build.

**Requirements:** None directly — infrastructure

**Dependencies:** U4

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.server.json` (if needed)

**Approach:**
- Add a `bin` entry in `package.json`:
  ```json
  "bin": {
    "wecom-send": "dist/cli/wecom-send.js"
  }
  ```
- Ensure `src/cli/wecom-send.ts` is compiled by the build. Since `tsconfig.server.json` has `rootDir: "./src/server"`, files in `src/cli/` are outside its scope. Options:
  1. Move CLI to `src/server/cli/wecom-send.ts` so it's compiled by the server tsconfig.
  2. Add a separate `tsconfig.cli.json`.
  3. Use esbuild directly for the CLI.
- **Decision:** Use esbuild to bundle `src/cli/wecom-send.ts` into `dist/cli/wecom-send.js` as a separate build step. This keeps the CLI outside the server composite project, avoids tsconfig changes, and produces a single-file output.
- Add a script to `package.json`: `"build:cli": "esbuild src/cli/wecom-send.ts --bundle --platform=node --target=node20 --format=esm --outfile=dist/cli/wecom-send.js --banner:js='#!/usr/bin/env node'"`.
- Include `build:cli` in the main `build` script or document it separately.

**Patterns to follow:**
- Existing `scripts/build-sidecar.ts` uses esbuild with similar flags.

**Test scenarios:**
- Integration: `npm run build:cli` produces `dist/cli/wecom-send.js`.
- Integration: `node dist/cli/wecom-send.js msg send --help` runs without errors.
- Integration: The bin entry resolves correctly after `npm link` or global install.

**Verification:**
- `npm run build:cli` succeeds and produces the expected output file.
- The CLI binary is executable and responds to `--help`.

---

## System-Wide Impact

- **Interaction graph:** `WeComBotService` gains file I/O and a bot ID index. A new route module `wecom-bridge.ts` calls into `WeComBotService`. The server startup sequence gains a `setServerUrl` call before `initialize()`.
- **Error propagation:** File write failures are logged as warnings and do not crash the server. HTTP endpoint errors follow the existing `console.error` + JSON response pattern. CLI errors surface to the invoking skill via stderr and exit codes.
- **State lifecycle risks:** Stale context files can persist after crashes (SIGKILL). Mitigated by startup cleanup in `initialize()`. If `folderPath` changes after connect, the old file is orphaned — accepted as a known limitation.
- **API surface parity:** No changes to existing client-facing APIs. The new `/api/wecom/send` endpoint is additive.
- **Integration coverage:** Cross-layer scenarios that unit tests alone will not prove:
  - CLI finds context file → calls endpoint → server resolves bot ID → sends via WeCom SDK.
  - Bot disconnects → file is removed → subsequent CLI calls fail with "no active bot."
  - Server restart with stale context file → cleanup removes it → CLI fails correctly.
- **Unchanged invariants:**
  - Existing WeCom bot request-response flow is unchanged.
  - Workspace settings persistence format is unchanged.
  - SSE streaming protocol and event types are unchanged.
  - GUI session creation and messaging behavior is unchanged.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Bot ID collision across workspaces | Reject duplicate at connect time; log clear error |
| Stale context files after server crash | Startup cleanup in `initialize()` |
| Workspace directory not writable | Log warning; bot still handles inbound messages |
| Server binds to non-localhost interface | Endpoint has no auth; document localhost-only assumption |
| CLI bundling complexity for Tauri sidecar | Deferred to follow-up; v1 CLI is a separate script |

---

## Documentation / Operational Notes

- The CLI is accessible via `npx wecom-send` after build, or `npx tsx src/cli/wecom-send.ts` in development.
- Bot sessions still have full tool auto-approval (carried from existing WeCom bot integration). Skills sending messages via the bridge inherit this permission model.
- The endpoint is localhost-only by design. If the server is exposed beyond localhost, this endpoint becomes a security concern.

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-22-wecom-http-bridge-requirements.md](docs/brainstorms/2026-05-22-wecom-http-bridge-requirements.md)
- Related code: `src/server/services/wecom-bot-service.ts`, `src/server/index.ts`, `src/server/routes/workspaces.ts`
- Related plan: `docs/plans/2026-05-21-005-feat-wecom-bot-integration-plan.md`
