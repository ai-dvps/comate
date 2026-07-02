---
date: 2026-07-02
topic: dead-loop-detection
title: "Integrate dead-loop detection into Comate as a core server capability"
---

## Summary

Add server-side dead-loop detection to Comate. Repeated Read of unchanged files is resolved by returning a cached result; subagent tool-call loops are detected via SDK polling and stopped, with a hard interrupt fallback. Thresholds are configurable per workspace and the feature is silent by default.

---

## Problem Frame

Comate sessions can enter two failure modes that waste tokens and time. In the first, the main agent repeatedly Reads the same unchanged file, ignoring the SDK's wasted-call signal. In the second, a subagent falls into a tight loop calling the same tool with identical arguments. Currently Comate has no detection or intervention for either pattern. Users must notice and interrupt manually.

---

## Key Decisions

- **Cached-result return for line 1.** Instead of denying a redundant Read, return the previously cached file content as the tool result so the model continues its task.
- **SDK-native detection for line 2.** Poll `listSubagents`/`getSubagentMessages` from the Comate server rather than spawning a detached file-system watcher.
- **Silent by default.** Do not show notifications, toasts, or status indicators; rely on server logs for debugging.
- **Per-workspace configurable thresholds.** Settings live in `WorkspaceSettings` with global defaults, not a dedicated UI panel.
- **Hard interrupt fallback for line 2.** If the main agent does not stop a looping subagent within a timeout, terminate the current query to break the loop. The timeout is configurable.
- **Session-scoped Read cache.** Cached Read results persist within the session and invalidate when the file content changes.

---

## Requirements

### Line 1: Main-agent Read dead loop

- R1. Detect when the main agent issues a Read call with the same file path as a recent Read that produced a wasted-call signal.
- R2. Recognize wasted-call signals including the string `"Wasted call"`, the object `{ type: "file_unchanged" }`, and JSON-stringified variants.
- R3. Cache the last successful Read result per file path within a session.
- R4. When a repeated Read crosses the warning threshold, inject guidance that the file is unchanged.
- R5. When a repeated Read crosses the block threshold, skip the actual Read and return the cached content as the tool result.
- R6. Reset the per-file counter when a Read returns new content or a different file is read.

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
- R15. Run detection for all session sources (gui, wecom, feishu) unless explicitly disabled for the workspace.
- R16. Compose dead-loop detection with existing bot tool-permission policy so that bot sessions retain their existing gates.

---

## Key Flows

- F1. Main-agent Read loop
  - **Trigger:** main agent calls Read on a file it recently read.
  - **Steps:** `PostToolUse` hook sees wasted-call signal and increments a counter; `PreToolUse` hook checks the threshold; if at the warning threshold, inject guidance; if at the block threshold, return the cached content as the tool result.
  - **Outcome:** the model receives the cached file content and continues.
- F2. Subagent tool loop
  - **Trigger:** server poller finds a subagent whose recent `tool_use` blocks repeat the same tool and parameters.
  - **Steps:** alert is recorded; `Stop`/`PostToolUse` hooks inject guidance to call `TaskStopTool`; if the subagent stops, the alert clears; if not, the query is interrupted after the timeout.
  - **Outcome:** the dead loop is broken.

---

## Acceptance Examples

- AE1. Covers R1, R5.
  - **Given:** the main agent has Read `/a/b.txt` three times and each result was `"Wasted call — file unchanged"` with content `"hello"`.
  - **When:** it attempts a fourth Read of `/a/b.txt`.
  - **Then:** the actual Read is skipped and the tool result is `"hello"`.
- AE2. Covers R6.
  - **Given:** the main agent has Read `/a/b.txt` twice with wasted-call results.
  - **When:** it next Reads `/a/c.txt`.
  - **Then:** the counter for `/a/b.txt` resets and the new Read executes normally.
- AE3. Covers R8, R10, R11.
  - **Given:** a background subagent has called `Read { file_path: "/x/y.txt" }` with identical parameters six times in the last twenty `tool_use` blocks.
  - **When:** the poller detects the pattern.
  - **Then:** `additionalContext` guides the main agent to stop the subagent; if the subagent is still looping after the configured timeout, the query is interrupted.

---

## Scope Boundaries

- **Deferred for later:** desktop notifications for active subagent loops; a dedicated dead-loop visualization panel; cross-session pattern analysis to detect loops that span multiple agents.
- **Outside this product's identity:** packaging `cc-break-dead-loop` as a standalone Claude Code plugin distributed through Comate's plugin marketplace.

---

## Dependencies / Assumptions

- The Claude Agent SDK `hooks` option supports `PreToolUse`, `PostToolUse`, `SessionStart`, and `Stop` events.
- The SDK `canUseTool`/`PreToolUse` deny path allows returning a message that becomes the `tool_result`.
- Subagent messages are accessible via `sdkClient.listSubagents` and `sdkClient.getSubagentMessages`.
- Bot sessions' existing `canUseTool` callback can be composed with dead-loop detection without replacing bot policy evaluation.
