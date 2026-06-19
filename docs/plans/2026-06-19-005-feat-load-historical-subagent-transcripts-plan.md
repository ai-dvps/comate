---
title: Load historical subagent transcripts into the subagent panel
type: feat
date: 2026-06-19
origin: docs/brainstorms/2026-05-17-subagent-streaming-display-requirements.md
---

# Load historical subagent transcripts into the subagent panel

## Summary

Extend the server `loadMessages` flow to discover and load subagent conversation transcripts that the SDK stores separately from the main session JSONL. Reconstruct each subagent's `SubagentState` server-side, return it from `GET /sessions/:sessionId/messages`, and hydrate the client chat store so the subagent panel renders historical subagent conversations for sessions that are no longer streaming.

---

## Problem Frame

The Claude Agent SDK stores subagent conversations in separate files under `~/.claude/projects/<encoded-cwd>/<sessionId>/subagents/agent-<id>.jsonl`. The main session transcript contains only the parent `Agent` tool_use and its tool_result; it does not contain messages with `parent_tool_use_id`. The app's `loadMessages()` only calls `getSessionMessages()`, so historical sessions load the main transcript but never the subagent transcripts.

Live streaming still works: the SSE emitter routes SDK messages that carry `parent_tool_use_id` to `SubagentEmitter`, which emits `subagent_start` / `subagent_delta` / `subagent_done` events that populate `subagents[sessionId]` in real time. But when a user returns to a completed session, `subagents[sessionId]` is empty and the subagent panel renders nothing.

The SDK exposes two functions for this: `listSubagents(sessionId, options)` and `getSubagentMessages(sessionId, agentId, options)`. The app does not currently use either.

---

## Requirements

- R1. The server shall discover all subagent IDs for a session via `listSubagents`.
- R2. The server shall load each subagent's conversation messages via `getSubagentMessages`.
- R3. The server shall reconstruct each subagent's `SubagentState` (including messages, state, start/end times, tool count, and progress hint) from its raw transcript.
- R4. The server shall return the reconstructed subagent states alongside `messages` and `tasks` from `loadMessages()` and `loadMessagesAfter()`.
- R5. The `GET /sessions/:sessionId/messages` route shall include `subagents` in its JSON response.
- R6. The client `loadMessages` action shall populate `subagents[sessionId]` from the API response when the session is not actively streaming.
- R7. The client shall preserve any live subagent state already accumulated via SSE and shall not overwrite it with historical data while the subagent is still running.
- R8. The subagent brief status and panel shall render historical subagent content without additional UI changes.

---

## Key Technical Decisions

- **KTD1. Use SDK accessors instead of direct JSONL reads.** The SDK provides `listSubagents` and `getSubagentMessages` specifically for this purpose. Direct file reads (as used by analytics) are a fallback for post-compaction coverage, but subagent transcripts are not subject to compaction and the SDK accessors are the stable contract.
- **KTD2. Reconstruct `SubagentState` server-side.** The client already knows how to render `SubagentState`; moving the transcript-to-state conversion to the server keeps the client thin and avoids leaking JSONL parsing details to the browser.
- **KTD3. Historical subagent state merges with, rather than replaces, live state.** On `loadMessages`, if `subagents[sessionId]` already contains a running subagent (from SSE), the historical data for that subagent is skipped. For completed subagents or empty state, the historical state is applied. This prevents clobbering in-flight streaming data.
- **KTD4. Fail open on subagent loading errors.** If `listSubagents` or `getSubagentMessages` throws, the server logs the error and returns an empty `subagents` array so the main transcript still loads and the UI degrades gracefully.

---

## Implementation Units

### U1. Extend `SdkClient` with subagent accessors

**Goal:** Expose `listSubagents` and `getSubagentMessages` through the server SDK wrapper so the chat service can use them.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Modify: `src/server/services/sdk-client.ts`
- Modify: `src/server/services/chat-service.test.ts` (extend `MockSdkClient`)

**Approach:**
- Import `listSubagents` and `getSubagentMessages` from `@anthropic-ai/claude-agent-sdk`.
- Add `listSubagents(sessionId, options)` and `getSubagentMessages(sessionId, agentId, options)` methods that delegate to the SDK functions.
- Re-export the new return/option types.
- In `chat-service.test.ts`, extend the existing `MockSdkClient` to include stub implementations that default to empty arrays.

**Patterns to follow:**
- Existing `SdkClient` wrapper methods (`listSessions`, `getSessionMessages`, etc.).

**Test scenarios:**
- Happy path: `MockSdkClient.listSubagents` returns `['agent-1', 'agent-2']` and `getSubagentMessages` returns an array of `SessionMessage` objects.
- Edge case: `listSubagents` returns `[]`.
- Edge case: `getSubagentMessages` returns `[]`.

**Verification:**
- `npm run build:server` passes with the new methods.

---

### U2. Reconstruct historical subagent state server-side

**Goal:** After loading the main session messages, discover subagents, load their transcripts, and convert each transcript into a `SubagentState` object matching the client shape.

**Requirements:** R1, R2, R3, R4

**Dependencies:** U1

**Files:**
- Modify: `src/server/services/chat-service.ts`
- Create: `src/server/services/subagent-loader.ts`
- Modify: `src/server/types/message.ts`

**Approach:**
- Create `subagent-loader.ts` with a pure `reconstructSubagentState(parentToolUseId, sdkMessages)` function.
  - Map each SDK `SessionMessage` to a `SubagentMessage` by extracting `uuid`, `role` (`assistant` or `user`), and converting `content[]` into `SubagentPart[]` (text, thinking, tool_use, tool_result).
  - Derive `state`: if the last message is a `result` entry or the transcript ends without an ongoing turn, mark `completed` or `error` based on `is_error`; otherwise `running`.
  - Derive `startTime` from the first message timestamp and `endTime` from the last message timestamp when completed.
  - Derive `toolCount` by counting `tool_use` parts across all messages.
  - Derive `progressHint` from the most recent non-result assistant text or tool name, falling back to the `description`.
  - Derive `description` from the parent `Agent` tool input when available; otherwise use the agent ID.
- Add `loadSubagentsForSession(sessionId, workspaceId): Promise<SubagentState[]>` to `ChatService`.
  - Call `this.sdkClient.listSubagents(sessionId, { dir: workspace.folderPath })`.
  - For each agent ID, call `this.sdkClient.getSubagentMessages(sessionId, agentId, { dir: workspace.folderPath })`.
  - Map agent ID to its parent `toolUseId`. The subagent meta file in `subagents/agent-<id>.meta.json` contains `toolUseId`; load and parse it when available. If the meta file is missing, fall back to scanning the main session messages for an `Agent` tool_use whose result mentions the agent ID.
  - Call `reconstructSubagentState` for each transcript.
  - Catch and log errors per subagent; return whatever could be loaded.
- Update `loadMessages()` and `loadMessagesAfter()` to call `loadSubagentsForSession` and include `subagents` in the returned object.
- Add a serializable `SubagentState` type to `src/server/types/message.ts` that mirrors the client type.

**Patterns to follow:**
- `message-normalizer.ts` `partsFromSdkContent` for content-block conversion.
- `analytics-transcript-reader.ts` for per-line JSON parsing and malformed-line skipping.

**Test scenarios:**
- Happy path: A session with one subagent transcript containing 5 assistant/user messages returns a single `SubagentState` with 5 messages, correct state, and positive toolCount.
- Happy path: A completed subagent with a final `result` message is marked `completed` (or `error` if `is_error`).
- Edge case: `listSubagents` returns `[]` → empty subagents array.
- Edge case: Subagent transcript contains malformed JSON lines → skip bad lines and reconstruct from the rest.
- Edge case: `getSubagentMessages` throws for one subagent → return the others and log the error.
- Edge case: Meta file missing but main transcript Agent tool_result mentions the agent ID → still map to the correct `parentToolUseId`.

**Verification:**
- New tests in `chat-service.test.ts` pass.
- `npm run build:server` passes.

---

### U3. Extend the load-messages API response

**Goal:** Return the reconstructed subagent states from the existing messages endpoint.

**Requirements:** R5

**Dependencies:** U2

**Files:**
- Modify: `src/server/routes/chat.ts`

**Approach:**
- In `GET /sessions/:sessionId/messages`, destructure `subagents` from `chatService.loadMessages()` and include it in `res.json({ messages, tasks, subagents })`.
- In `GET /sessions/:sessionId/messages/latest`, do the same for the `loadMessagesAfter()` result.

**Patterns to follow:**
- Existing route shape for `messages` and `tasks`.

**Test scenarios:**
- Happy path: Route returns `{ messages, tasks, subagents }` and `subagents` is an array.
- Edge case: `subagents` is `undefined` from service → route returns `[]` or whatever the service provides.

**Verification:**
- Route tests (if any) updated; manual test via API client.

---

### U4. Hydrate client subagents state from load-messages

**Goal:** Populate `subagents[sessionId]` from the server response without breaking live streaming.

**Requirements:** R6, R7

**Dependencies:** U3

**Files:**
- Modify: `src/client/stores/chat-store.ts`
- Modify: `src/client/types/message.ts` (if needed for shared `SubagentState`)

**Approach:**
- Update the `loadMessages` fetch response type to `{ messages?: unknown; tasks?: TaskItem[]; subagents?: unknown }`.
- Add a `sanitizeSubagents(raw)` helper that validates the array and each `SubagentState` object, ensuring `parentToolUseId`, `state`, `messages`, etc. are present and of the right shape. Invalid entries are filtered out.
- In the `loadMessages` action's `set` callback:
  - Determine whether the session is currently streaming subagents (any existing `SubagentState` with `state === 'running'`).
  - Build a merged `subagents` map keyed by `parentToolUseId`.
  - Apply historical subagent state only for parentToolUseIds that are not currently running.
  - Set `state.subagents[sessionId]` to the merged array.

**Patterns to follow:**
- Existing `sanitizeMessages()` helper in `chat-store.ts`.
- Existing `loadMessages` state update pattern.

**Test scenarios:**
- Happy path: API returns two completed subagents → `state.subagents[sessionId]` contains both.
- Happy path: API returns a subagent, and live SSE already has a running subagent with the same `parentToolUseId` → live state is preserved.
- Happy path: API returns a subagent, and live SSE has a different running subagent → both appear in state.
- Edge case: API returns malformed subagent objects → invalid ones are filtered, valid ones remain.
- Edge case: API returns no `subagents` field → `state.subagents[sessionId]` is unchanged for inactive sessions.

**Verification:**
- New tests in `chat-store.test.ts` pass.
- `npm run test:client` passes.

---

### U5. Add integration and regression tests

**Goal:** Prevent regression in both the server-side reconstruction and the client-side hydration.

**Requirements:** R1–R8

**Dependencies:** U1–U4

**Files:**
- Modify: `src/server/services/chat-service.test.ts`
- Modify: `src/client/stores/chat-store.test.ts`
- Create: `src/server/services/subagent-loader.test.ts`

**Approach:**
- In `chat-service.test.ts`:
  - Add subagent stubs to `MockSdkClient`.
  - Add a test that verifies `loadMessages()` returns reconstructed `SubagentState[]` when subagents exist.
  - Add a test that verifies errors in subagent loading do not fail the overall `loadMessages()` call.
- In `subagent-loader.test.ts`:
  - Test `reconstructSubagentState` with synthetic SDK messages covering text, thinking, tool_use, tool_result, and result-finalizer cases.
  - Test malformed-line skipping.
- In `chat-store.test.ts`:
  - Test `sanitizeSubagents` validation.
  - Test `loadMessages` hydration and merging with live SSE state.

**Patterns to follow:**
- Existing `analytics-transcript-reader.test.ts` for transcript parsing tests.
- Existing `chat-store.test.ts` patterns for Zustand store tests.

**Test scenarios:**
- Integration: Server loads a session with one Agent tool_use and one subagent transcript → client receives correct `SubagentState` and panel would render it.
- Regression: Existing live SSE subagent streaming still works and is not overwritten by historical load.
- Regression: Non-Agent sessions still return empty `subagents` and load normally.

**Verification:**
- `npm run test:client` passes.
- `npm run build:server` passes.
- Manual verification: open a historical session with a subagent and confirm the panel renders the conversation.

---

## Scope Boundaries

- **Deferred for later:** Subagent resuming / `SendMessage` continuation; the panel remains read-only.
- **Deferred for later:** Virtualized scrolling for very long subagent conversations.
- **Deferred for later:** Workspace-wide subagent aggregation across sessions.
- **Out of scope:** Changing how the main assistant message summarizes subagent results.
- **Out of scope:** Inline expandable subagent detail within the main message stream.
- **Out of scope:** Modifying the SDK's subagent storage format.

---

## System-Wide Impact

- **API contract change:** `GET /sessions/:sessionId/messages` and `GET /sessions/:sessionId/messages/latest` gain a `subagents` field. Older clients ignore unknown fields; newer clients hydrate subagent state.
- **SSE protocol unchanged:** No new event types are added. Live streaming continues to populate `subagents[sessionId]` via `subagent_start` / `subagent_delta` / `subagent_done`.
- **State shape unchanged:** The client `SubagentState` type is not modified; the server produces objects that match it.
- **Performance:** `loadMessages()` now performs N+1 SDK calls (one `listSubagents` plus one `getSubagentMessages` per subagent). Subagent counts per session are typically low (1–5), and the calls are local file reads.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Subagent meta file missing and fallback regex fails | Log the orphan agent ID and skip it; the brief status still renders from the main transcript. |
| Live SSE state overwritten by historical load | Merge logic in U4 only applies historical state for non-running parentToolUseIds. |
| SDK `getSubagentMessages` throws | Per-subagent try/catch in U2; overall `loadMessages` still succeeds. |
| Subagent transcript contains unknown block types | Reconstruction skips unknown blocks (mirrors `partsFromSdkContent`). |
| Large subagent transcripts increase response size | Subagent counts are typically low; defer pagination until measurement shows a problem. |

---

## Sources & Research

- Origin brainstorm: `docs/brainstorms/2026-05-17-subagent-streaming-display-requirements.md`
- Prior subagent streaming plan: `docs/plans/2026-05-29-009-feat-subagent-streaming-display-plan.md`
- Empty tool-result fix plan: `docs/plans/2026-05-30-006-fix-subagent-empty-tool-result-messages-plan.md`
- Analytics transcript reader precedent: `src/server/services/analytics-transcript-reader.ts`
- SSE resilience learning: `docs/solutions/integration-issues/sse-clean-close-retry-2026-05-22.md`
- SDK subagent accessors: `@anthropic-ai/claude-agent-sdk` `listSubagents` / `getSubagentMessages`
