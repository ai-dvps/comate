---
title: "Integrate dead-loop detection into Comate as a core server capability"
type: feat
date: 2026-07-02
origin: docs/brainstorms/2026-07-02-dead-loop-detection-requirements.md
---

# Integrate dead-loop detection into Comate as a core server capability

## Summary

Add server-side dead-loop detection for two failure modes: main-agent `Read` loops on unchanged files, and subagent tight tool-call loops. Line 1 returns cached file content transparently when a redundant `Read` crosses the block threshold. Line 2 polls subagent transcripts, guides the main agent to stop a looping subagent, and falls back to a hard query interrupt if guidance is ignored. Thresholds live in `WorkspaceSettings` with global defaults and are silent by default.

---

## Problem Frame

Comate sessions can waste tokens and time in two loops. In the first, the main agent repeatedly `Read`s the same unchanged file and ignores the SDK wasted-call signal. In the second, a subagent falls into a tight loop calling the same tool with identical arguments. Today Comate has no detection or intervention for either pattern; users must notice and interrupt manually.

---

## Requirements

### Line 1: Main-agent Read dead loop

- R1. Detect when the main agent issues a `Read` call with the same file path as a recent `Read` that produced a wasted-call signal.
- R2. Recognize wasted-call signals including the string `"Wasted call"`, the object `{ type: "file_unchanged" }`, and JSON-stringified variants.
- R3. Cache the last successful `Read` result per file path within a session.
- R4. When a repeated `Read` crosses the warning threshold, inject guidance that the file is unchanged.
- R5. When a repeated `Read` crosses the block threshold, skip the actual `Read` and return the cached content as the tool result.
- R6. Reset the per-file counter when a `Read` returns new content or a different file is read.

### Line 2: Subagent tool dead loop

- R7. Periodically enumerate subagents for active sessions and fetch their recent messages.
- R8. Detect a dead loop when the trailing window of a subagent's `tool_use` blocks repeats the same tool name and parameter fingerprint at least N times.
- R9. Generate parameter fingerprints by stable serialization with sorted object keys so equivalent inputs match regardless of key order.
- R10. When a subagent dead loop is detected, guide the main agent to call `TaskStopTool` via hook `additionalContext`.
- R11. If the main agent does not stop the subagent within the configured timeout, terminate the current query with an interrupt to break the loop.
- R12. Clear the alert when the subagent stops or the loop pattern disappears.

### Configuration and lifecycle

- R13. Expose dead-loop thresholds in workspace settings with global defaults.
- R14. Allow disabling dead-loop detection per workspace.
- R15. Run detection for all session sources (`gui`, `wecom`, `feishu`) unless explicitly disabled for the workspace.
- R16. Compose dead-loop detection with existing bot tool-permission policy so that bot sessions retain their existing gates.

---

## Key Technical Decisions

- KTD1. **Line-1 blocking returns cached content through a composed `canUseTool` deny.** The SDK `PermissionResult` deny branch carries a `message` that becomes the `tool_result`. This lets the model receive the cached file content as if the `Read` succeeded, without executing the tool. (See origin: `docs/brainstorms/2026-07-02-dead-loop-detection-requirements.md`, Dependencies / Assumptions.)
- KTD2. **Line-1 warning uses the `PreToolUse` hook `additionalContext`.** `canUseTool` allow has no channel for a non-blocking message, so guidance at the warning threshold is injected via `PreToolUse`.
- KTD3. **Line-2 detection uses a `ChatService`-owned global poller.** A single service polling all active sessions is simpler than per-runtime timers: lifecycle matches the service, subagent API access is centralized, and teardown is tied to runtime registration. (See grounding: `src/server/services/chat-service.ts` already manages runtime lifecycle and subagent loading.)
- KTD4. **Detector state is session-scoped and owned by `SessionRuntime`.** Per-file read caches and subagent alert state live on the runtime instance so they are garbage-collected when the runtime stops.
- KTD5. **Dead-loop detection composes with existing `canUseTool` callbacks rather than replacing them.** GUI approval and bot policy gates run after the dead-loop check, so bot path policy, bash whitelist, and skill policy remain intact. (See grounding: `src/server/services/session-runtime.ts:169-173` and `src/server/services/chat-service.ts:1173-1340`.)
- KTD6. **Subagent loop alerts are cleared by the poller, not by a hook.** The poller rescans on every interval; when the repeating pattern disappears or the subagent stops, the alert is removed so a stale interrupt is not triggered.

---

## Implementation Units

### U1. Settings schema and global defaults

- **Goal:** Add `deadLoopDetection` to `WorkspaceSettings`, expose global defaults, and persist per-workspace overrides in the existing SQLite `workspaces.settings` JSON column.
- **Files:**
  - `src/server/models/workspace.ts` — extend `WorkspaceSettings`.
  - `src/server/services/workspace-service.ts` — merge defaults with stored settings when serving workspace config.
  - `src/server/routes/workspaces.ts` — ensure settings updates accept and validate the new shape.
- **Patterns:** Follow the existing `WorkspaceSettings` pattern for optional nested objects; defaults are constants in the service layer, not stored in the database.
- **Test scenarios:**
  - A workspace with no `deadLoopDetection` setting receives the global defaults.
  - A workspace with partial overrides merges correctly (e.g., only `line1.blockThreshold` customized).
  - Invalid values (negative thresholds, non-number window) are rejected by the route validator.

### U2. Read-loop detection engine

- **Goal:** Build the pure logic for tracking per-file `Read` results, classifying wasted-call signals, and deciding warning/block/reset actions.
- **Files:**
  - `src/server/services/dead-loop-detector.ts` — new module exporting `ReadLoopDetector`.
- **Patterns:**
  - Session-scoped instance created by `SessionRuntime`.
  - Wasted-call classification normalizes string and JSON-object signals.
  - Counter and cache keyed by resolved absolute file path; cache stores the last non-wasted or first wasted content.
- **Test scenarios:**
  - Three consecutive wasted `Read`s of the same file with the same content increment the counter to 3; a fourth call triggers the block action and returns cached content.
  - A `Read` with new content resets the counter and updates the cache.
  - A `Read` of a different path leaves the first path's counter untouched.
  - Wasted-call signal variants (`"Wasted call"`, `{ type: "file_unchanged" }`, `{"type":"file_unchanged"}` string) are all recognized.

### U3. Line-1 hook and permission integration

- **Goal:** Wire the read-loop detector into `SessionRuntime` via SDK hooks and a composed `canUseTool` callback.
- **Files:**
  - `src/server/services/session-runtime.ts` — instantiate detector, register `PreToolUse` and `PostToolUse` hooks, wrap `canUseTool`.
  - `src/server/services/sdk-client.ts` — pass `Options.hooks` through `createStreamingQuery`.
  - `src/server/services/chat-service.ts` — pass workspace dead-loop settings into `SessionRuntime` options and compose bot `canUseTool` with the detector.
- **Patterns:**
  - `PostToolUse` updates cache/counters after the SDK returns a `Read` result.
  - `PreToolUse` injects guidance when the counter reaches the warning threshold.
  - The composed `canUseTool` checks the block threshold first; if not blocked, delegates to the original callback (GUI approval or bot policy).
- **Test scenarios:**
  - A GUI session auto-blocks a redundant `Read` and the SSE stream receives the cached content as the tool result.
  - A bot session with a restrictive bash whitelist still has that whitelist enforced after the dead-loop check passes.
  - Warning guidance appears exactly once per threshold crossing, not on every repeated call.

### U4. Subagent loop detection engine

- **Goal:** Build the pure logic for fingerprinting subagent tool calls and detecting repeats in a trailing window.
- **Files:**
  - `src/server/services/dead-loop-detector.ts` — add `SubagentLoopDetector` or equivalent functions.
- **Patterns:**
  - Fingerprint = `tool_name|stable_json(params)` with sorted keys and no whitespace.
  - Window is the last N `tool_use` blocks from the subagent transcript.
  - Detection returns the looping tool name, fingerprint, and repeat count.
- **Test scenarios:**
  - Six identical `Read { file_path: "/x/y.txt" }` calls in a window of 20 are detected as a loop.
  - Five repeats with threshold 5 are detected; four repeats are not.
  - Equivalent objects with different key order produce the same fingerprint.
  - A mixed window with two tools alternating is not flagged.

### U5. Line-2 poller and interrupt integration

- **Goal:** Add a `ChatService`-owned poller that scans active sessions, records subagent loop alerts on their runtimes, and interrupts the query after a timeout.
- **Files:**
  - `src/server/services/chat-service.ts` — add `SubagentLoopPoller`, register active runtimes, schedule interval, handle stop/cleanup.
  - `src/server/services/session-runtime.ts` — expose alert state and an `interrupt()` path that the poller can call safely.
- **Patterns:**
  - Poller interval and timeout are configurable per workspace with global defaults.
  - The poller calls `sdkClient.listSubagents` and `sdkClient.getSubagentMessages` for each active session.
  - When a loop is detected, the runtime's `Stop` and `PostToolUse` hooks inject `additionalContext` prompting `TaskStopTool`.
  - If the alert age exceeds the timeout and the subagent is still looping, the poller calls `runtime.interrupt()`.
- **Test scenarios:**
  - A looping subagent causes `additionalContext` to be injected within one poll interval.
  - If the main agent stops the subagent before the timeout, no interrupt occurs.
  - If the subagent is still looping after the timeout, `runtime.interrupt()` is called exactly once.
  - The poller skips sessions whose workspace has disabled dead-loop detection.

### U6. Tests and validation

- **Goal:** Cover the feature with isolated server tests and at least one integration-style test for the full flow.
- **Files:**
  - `src/server/services/dead-loop-detector.test.ts` — unit tests for read-loop and subagent-loop logic.
  - `src/server/services/session-runtime.test.ts` or a new `src/server/services/dead-loop-runtime.test.ts` — hook/canUseTool integration.
  - `src/server/services/chat-service.test.ts` — poller registration and interrupt behavior (use isolated store and mocked SDK client).
- **Patterns:**
  - Every server test imports `test-utils/test-env` first, per project convention.
  - Use `new SqliteStore(':memory:')` or `createIsolatedStore()` and `store.resetData()`.
  - Mock SDK client responses for subagent messages; do not hit the live API.
- **Test scenarios:**
  - End-to-end: a session with three wasted `Read`s blocks the fourth and returns cached content.
  - End-to-end: a subagent loop triggers guidance, then an interrupt after timeout.
  - Settings disabled: a workspace with detection off never blocks or interrupts.

---

## Scope Boundaries

### Deferred for later

- Desktop notifications or toasts for active subagent loops.
- A dedicated dead-loop visualization panel in the GUI.
- Cross-session pattern analysis to detect loops that span multiple agents.

### Outside this product's identity

- Packaging `cc-break-dead-loop` as a standalone Claude Code plugin distributed through Comate's plugin marketplace. The original plugin's behavior is being absorbed into the core server.

---

## Risks & Dependencies

- **SDK hook output semantics.** The plan assumes `canUseTool` deny messages surface as `tool_result` and that `PreToolUse.additionalContext` reaches the model. Verify with a small spike in U3 before committing to the full wiring; if the assumption fails, fall back to `PostToolUse.updatedToolOutput` and accept that the actual `Read` executes once before blocking.
- **Subagent API shape.** `listSubagents` and `getSubagentMessages` must return enough message detail to reconstruct `tool_use` blocks. If the SDK truncates or compacts subagent transcripts, the poller may need to read analytics JSONL as `ChatService.loadSubagentsForSession` does.
- **Interrupt side effects.** Calling `runtime.interrupt()` terminates the main query. Confirm that SSE streams close cleanly and that the runtime transitions to a stopped state without leaking the poller reference.
- **Bot policy composition order.** The dead-loop check must run before bot policy evaluation. If the order is inverted, a bot whose policy would deny `Read` could never reach the cached-result path.

---

## Acceptance Examples

- AE1. **Covers R1, R5.** Given the main agent has `Read` `/a/b.txt` three times and each result was a wasted-call with content `"hello"`, when it attempts a fourth `Read` of `/a/b.txt`, then the actual `Read` is skipped and the tool result is `"hello"`.
- AE2. **Covers R6.** Given the main agent has `Read` `/a/b.txt` twice with wasted-call results, when it next `Read`s `/a/c.txt`, then the counter for `/a/b.txt` resets and the new `Read` executes normally.
- AE3. **Covers R8, R10, R11.** Given a background subagent has called `Read { file_path: "/x/y.txt" }` with identical parameters six times in the last twenty `tool_use` blocks, when the poller detects the pattern, then `additionalContext` guides the main agent to stop the subagent; if the subagent is still looping after the configured timeout, the query is interrupted.

---

## Sources / Research

- Origin requirements: `docs/brainstorms/2026-07-02-dead-loop-detection-requirements.md`
- Grounding research on `SessionRuntime`, `ChatService`, SDK client, workspace/session models, and plugin settings (produced during planning).
- SDK type confirmation: `Options.hooks` supports `PreToolUse`, `PostToolUse`, `SessionStart`, and `Stop`; `PermissionResult` deny branch carries `message` that becomes the `tool_result`.
