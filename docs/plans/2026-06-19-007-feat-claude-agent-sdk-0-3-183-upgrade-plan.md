---
title: Upgrade @anthropic-ai/claude-agent-sdk to 0.3.183 and adopt P0/P1 capabilities
type: feat
date: 2026-06-19
origin: docs/brainstorms/2026-06-19-claude-agent-sdk-0-3-183-upgrade-requirements.md
deepened: 2026-06-19
---

# Upgrade @anthropic-ai/claude-agent-sdk to 0.3.183 and adopt P0/P1 capabilities

## Summary

Upgrade the `@anthropic-ai/claude-agent-sdk` dependency from `^0.3.144` to `^0.3.183` and adopt the SDK-exposed capabilities that are now available and aligned with the GUI's existing architecture. The work is organized into five P0 compatibility/adoption units (U1–U5) and four P1 exploratory units (U6–U9). All changes are additive or compatible with existing message flows; no existing chat, approval, task, subagent, or session-management behavior is removed.

## Problem Frame

The app is pinned to SDK `^0.3.144`. Version `0.3.183` brings the SDK to parity with Claude Code `v2.1.183` and introduces new message types (`tool_use_meta`, `system/model_fallback`, `api_retry`), richer rate-limit diagnostics, typed permission-denial reasons, and new session methods (`forkSession`, `getContextUsage`). Before bumping the dependency we must verify compatibility (no removed API usage, correct `overloaded` error handling, peer-dependency resolution, MCP pending status) and then selectively wire the new capabilities into the existing SSE-based message flow.

The SDK integration is centralized in `src/server/services/sdk-client.ts` and consumed by `src/server/services/chat-service.ts`. Server-side message normalization flows through `src/server/services/session-runtime.ts` and `src/server/services/sse-emitter.ts` to the browser, where `src/client/stores/chat-store.ts` and the tool renderer registry (`src/client/components/tool-renderers/`) render the transcript. Session lists and lifecycle live in `src/server/services/chat-service.ts` and the client session store.

## Requirements Traceability

| Origin requirement | Plan unit |
|---|---|
| R1 — Bump SDK to `^0.3.183` and regenerate lockfile | U1 |
| R2 — Confirm no removed API usage (`unstable_v2_*`, `SDKSession`, `TodoWrite` as primary) | U1 |
| R3 — Handle `overloaded` 529 errors alongside legacy `rate_limit` | U1 |
| R4 — Verify peer dependencies `@anthropic-ai/sdk` / `@modelcontextprotocol/sdk` resolution | U1 |
| R5 — Surface MCP `status: "pending"` during init if emitted | U1 |
| R6 — Full test suite and TypeScript build pass | U1 |
| R7 — Produce a ranked P0/P1/P2 adoption roadmap | Requirements Traceability / Scope Boundaries |
| R8 — Render `tool_use_meta` display names and `icon_url` inline | U4 |
| R9 — Surface credit-aware rate limits (`canUserPurchaseCredits`, `hasChargeableSavedPaymentMethod`) | U2 |
| R10 — Forward and render `system/model_fallback` as persistent inline notice | U3 |
| R11 — Consume typed permission-denial reasons (`safetyCheck`, `asyncAgent`) | U5 |
| R12 — Expose `forkSession` in session list | U6 |
| R13 — Context usage breakdown via `getContextUsage()` | U7 |
| R14 — Forward enhanced result metadata (`stop_reason`, `terminal_reason`, `origin`) | U8 |
| R15 — Emit `api_retry` system messages through SSE | U9 |
| R16 — Track binary-only CLI features as P2 (deferred) | Scope Boundaries |

## Key Technical Decisions

KTD 1. **Additive SSE events only, with optional field extension on terminal events.** New SDK capabilities are modeled as new `SseEvent` variants in the shared `src/server/types/message.ts` / `src/client/types/message.ts` union. The `result` event is an exception: it is a terminal event with no downstream message-render state machine, so `stopReason`, `terminalReason`, and `origin` are added as optional fields. This keeps legacy message rendering intact while avoiding a redundant `result_v2` event.

KTD 2. **Shared type files remain byte-identical.** `src/server/types/message.ts` and `src/client/types/message.ts` must remain byte-identical; both files are edited in lockstep and verified with a build-time diff.

KTD 3. **`tool_use` stays the source of truth.** `tool_use_meta` is treated as presentation metadata. Legacy messages without the sidecar continue to render using the tool name from the `tool_use` part.

KTD 4. **Model fallback is a transcript notice, not a toast.** `system/model_fallback` is forwarded as an SSE event and rendered inline as a persistent system message. It is stored as a `ChatMessage` with `role: 'system'` so it survives reload, and the resume path must not round-trip it back to the SDK.

KTD 5. **P1 units build on the same patterns as P0.** `forkSession` and `getContextUsage()` reuse the existing `SdkClient` wrapper and REST route patterns; they do not require new architectural layers.

KTD 6. **Every new `SseEvent` variant has a five-point checklist.** A new variant is not complete until it is added to the server type union, the client type union, `SseEmitter.handle()`, `chat-store.ts`'s `handleSseEvent()` switch, and any renderer that needs it. This prevents silent drops at the server/client boundary.

KTD 7. **P0 and P1 share `SdkClient`.** `forkSession` and `getContextUsage()` are added to `src/server/services/sdk-client.ts`, which U1 already touches for compatibility verification. P1 units should branch from the U1 commit to avoid import-block merge conflicts.

## System-Wide Impact

The `SseEvent` union in `src/server/types/message.ts` and `src/client/types/message.ts` is the single shared contract across the server/client boundary. Every new variant must be handled in five places or it will silently drop: server type union, client type union, `SseEmitter.handle()`, `chat-store.ts`'s `handleSseEvent()` switch, and the relevant renderer.

`tool_use_meta` affects only presentation; it does not change tool identity, input, or approval semantics. `system/model_fallback` and `api_retry` become persistent transcript entries, so the session restore path must render them from history without re-emitting them to the SDK.

`forkSession` and `getContextUsage()` extend the existing `SdkClient` wrapper and `src/server/routes/chat.ts` router. Both routes use the same workspace/session parameter pattern as existing endpoints.

---

## Risks & Dependencies

- **SDK behavioral changes.** Versions between `0.3.144` and `0.3.183` changed 529 error codes, MCP connection defaults, and task tool defaults. The upgrade must be validated with the full test suite before any new features are wired.
- **Peer dependency resolution.** `@anthropic-ai/sdk` and `@modelcontextprotocol/sdk` moved to `peerDependencies` in `0.3.143`. If the bundler or Tauri sidecar cannot resolve them, the build will fail until they are declared explicitly.
- **Client/server type drift.** The `SseEvent` union exists in two files that must remain byte-identical. Adding a variant to one without the other breaks CI.
- **Old client compatibility.** A `rate_limit` event emitted to an older client that does not handle it will be ignored, leaving the stream stalled. The server should emit it on the existing `error` event as well during a deprecation window, or the client should be forced to refresh.
- **Arbitrary icon URLs.** `tool_use_meta.icon_url` may point to any URL. The renderer must either proxy/allowlist the image or rely on a CSP that blocks unexpected origins; otherwise loading the icon is a security risk.

---

## Implementation Units

### U1 — Dependency bump and compatibility fixes

**Goal:** Bump the SDK, verify peer dependencies, broaden 529-error matching, surface MCP pending status, and get the full test/build suite green.

**Files to touch:**
- `package.json`
- `package-lock.json`
- `src/server/services/chat-service.ts` (MCP init status)
- `src/server/services/session-runtime.ts` (SDK error catch block)
- `src/server/services/sdk-client.ts` (type imports if needed)
- `src/client/stores/chat-store.ts` (if client handles SSE errors)
- `scripts/build-sidecar.ts` (verify peer dependency resolution in sidecar bundle)
- `src/server/services/__tests__/chat-service.test.ts`
- `src/server/services/__tests__/session-runtime.test.ts` (or equivalent test files)
- `src/server/services/__tests__/sdk-client.test.ts` (create if it does not exist)

**Decisions:**
- `deleteSession` remains a dynamic import in `chat-service.ts`; no normalization is required.
- `TodoWrite` handling remains as a compatibility fallback; the app already handles Task tools.
- The app currently has no dedicated `rate_limit` event type. Add defensive recognition of both `'overloaded'` and `'rate_limit'` values in the SDK error catch path so future 529 responses are surfaced correctly.

**Implementation notes:**
1. Update `package.json` line 28 to `"@anthropic-ai/claude-agent-sdk": "^0.3.183"`.
2. Run `npm install` to regenerate `package-lock.json` and pull the new platform-specific optional dependencies. Verify that optional platform-specific dependencies are marked `optional: true` and that `npm ci` works on the target CI platform.
3. In `session-runtime.ts`, update the SDK error catch block so that any 529/overloaded response is surfaced through the SSE stream as a generic `error` event. The dedicated `rate_limit` SSE event variant is introduced in U2.
4. Inspect `scripts/build-sidecar.ts` to confirm the Tauri sidecar bundler resolves the SDK's peer dependencies (`@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`). If it does not, add them to `dependencies` preemptively.
5. If `query()` or session init emits `status: "pending"` for background MCP connections, ensure the SSE stream forwards it as a `system` or `status` event rather than treating it as a failure.
6. Verify that `@anthropic-ai/sdk` and `@modelcontextprotocol/sdk` resolve correctly after the move to `peerDependencies`; if not, add them explicitly to `dependencies` or `devDependencies` as required by the bundler.
7. Run `npm run build` and `npm run test` (or the repo's equivalent) and fix any TypeScript errors caused by type renames or new required fields.

**Test scenarios:**
- `npm run build` passes with zero TypeScript errors.
- `npm run test` passes with no regressions in chat streaming, approvals, tasks, subagents, or session management.
- A mock SDK 529 response with `error: 'overloaded'` is surfaced through the SSE stream.
- A mock SDK 529 response with legacy `error: 'rate_limit'` is handled identically.
- Session initialization succeeds when the SDK emits `status: "pending"` for MCP setup.

**Dependencies:** None; this is the first unit and gates all others.

---

### U2 — Credit-aware rate limits

**Goal:** Read `errorCode`, `canUserPurchaseCredits`, and `hasChargeableSavedPaymentMethod` from `SDKRateLimitInfo` (`0.3.181`) and show a differentiated message when a rate limit is caused by exhausted credits versus throughput.

**Files to touch:**
- `src/server/services/session-runtime.ts`
- `src/server/services/sse-emitter.ts`
- `src/server/types/message.ts`
- `src/client/types/message.ts`
- `src/client/stores/chat-store.ts`
- `src/client/components/chat/` (existing error/rate-limit message component)

**Decisions:**
- Add a new `rate_limit` SSE event shape that carries the credit fields.
- For one release, also emit a generic `error` SSE event with a human-readable rate-limit message so clients that do not yet recognize `rate_limit` still surface the failure instead of silently dropping the event. The credit/payment fields are included only on the dedicated `rate_limit` event.
- The renderer distinguishes three cases: (1) credit-exhausted + saved payment method, (2) credit-exhausted + no payment method, (3) throughput rate limit. Copy text is deferred to product/design.

**Implementation notes:**
1. Update `SdkClient` or `SessionRuntime` to capture the full `SDKRateLimitInfo` object when a rate-limit error occurs.
2. Add the `rate_limit` variant to the `SseEvent` union in both shared type files before any other P0 unit adds its own variant, to avoid merge conflicts on the union.
3. Emit a new SSE event, e.g. `{ type: 'rate_limit', errorCode, canUserPurchaseCredits, hasChargeableSavedPaymentMethod, retryAfter? }`.
4. For backward compatibility, also emit the generic `error` event shape with a human-readable message for one release. Do not include credit/payment fields on the `error` event.
5. In `chat-store.ts`, handle the new event by inserting a system message into the transcript.
6. Render the message with the appropriate copy and CTA based on the credit flags.

**Test scenarios:**
- A throughput rate limit renders the existing generic message.
- A credit-exhausted rate limit with a saved payment method prompts the user to purchase credits.
- A credit-exhausted rate limit without a saved payment method explains that credits are required and offers a way to add payment.
- Legacy `rate_limit` events without credit fields still render correctly.

**Dependencies:** U1.

---

### U3 — `system/model_fallback` persistent inline notices

**Goal:** Forward the new `system/model_fallback` event (`0.3.174`) through the SSE stream and render it as a persistent inline system notice in the chat transcript.

**Files to touch:**
- `src/server/services/session-runtime.ts`
- `src/server/services/sse-emitter.ts`
- `src/server/types/message.ts`
- `src/client/types/message.ts`
- `src/client/stores/chat-store.ts`
- `src/client/components/chat/` (new or existing system-notice renderer)

**Decisions:**
- Model the fallback reason (`overloaded`, `server_error`, `last_resort`, `model_not_found`, `permission_denied`) as a field on the SSE event so the renderer can choose copy/icon without parsing raw SDK text.
- The notice is persistent: it becomes part of the transcript history and is reloaded on session restore. It is stored as a `ChatMessage` with `role: 'system'` and a marker (e.g. `source: 'sdk_event'`, `subType: 'model_fallback'`) so the resume path can filter it out before reconstructing prompt context for the SDK.

**Implementation notes:**
1. Detect `system/model_fallback` messages in the SDK message stream.
2. Add the `model_fallback` variant to the `SseEvent` union in both shared type files.
3. Emit a new SSE event, e.g. `{ type: 'model_fallback', reason, originalModel?, fallbackModel? }`.
4. In `chat-store.ts`, append a system message with the fallback details and a non-round-trippable marker.
5. Render the notice with an icon and human-readable reason; fallback model name is shown if available.
6. Verify that session resume loads the persisted system message from history but filters it out before sending history back to the SDK.

**Test scenarios:**
- A `system/model_fallback` with reason `overloaded` renders a persistent inline notice.
- Each supported reason (`server_error`, `last_resort`, `model_not_found`, `permission_denied`) renders distinct, readable copy.
- The notice survives page reload and is visible when loading session history.
- Messages without `system/model_fallback` are unaffected.

**Dependencies:** U1.

---

### U4 — `tool_use_meta` display names and inline icons

**Goal:** Use the new `tool_use_meta` sidecar on assistant messages (`0.3.179`, enhanced with `icon_url` in `0.3.181`) to show friendly tool names and, when present, the MCP server icon inline next to the tool name in the collapsed tool header.

**Files to touch:**
- `src/server/services/sse-emitter.ts` (attach meta during streaming)
- `src/server/services/message-normalizer.ts` (attach meta when loading historical messages)
- `src/server/types/message.ts`
- `src/client/types/message.ts`
- `src/client/stores/chat-store.ts`
- `src/client/components/tool-renderers/` (tool header component)

**Decisions:**
- The existing `tool_use` part remains the canonical identity and input source. `tool_use_meta` is only used for display name and icon.
- If `tool_use_meta.display_name` is absent, fall back to the `tool_use.name` value.
- If `tool_use_meta.icon_url` is present, render it as a small inline image next to the display name. The renderer must not load arbitrary URLs directly in the DOM. Prefer a same-origin proxy endpoint that fetches and serves the icon; alternatively, enforce a strict CSP `img-src` policy that blocks unexpected origins. Provide a broken-image fallback for unreachable or invalid icons.

**Implementation notes:**
1. When processing streaming assistant messages in `SseEmitter`, extract `tool_use_meta` and attach it to the corresponding `tool_use` part before SSE emission.
2. When loading historical messages in `message-normalizer.ts`, apply the same pairing so restored sessions show friendly names and icons.
3. Extend the `MessagePart` union or `ToolUsePart` type to carry optional `meta?: { displayName?: string; iconUrl?: string }`.
4. In the tool renderer header, prefer `meta.displayName` over `toolName`; render `meta.iconUrl` inline when available.
5. Ensure legacy messages without `tool_use_meta` render unchanged.

**Test scenarios:**
- A tool with `tool_use_meta.display_name` shows the friendly name in the collapsed header.
- A tool with `tool_use_meta.icon_url` shows the icon inline next to the name.
- A tool with both friendly name and icon shows both correctly.
- Legacy messages without `tool_use_meta` still render using the raw tool name.
- Invalid/missing icon URLs do not crash the renderer.

**Dependencies:** U1.

---

### U5 — Typed permission-denial reasons

**Goal:** Consume the new `safetyCheck` and `asyncAgent` denial reasons (`0.3.178`) in the approval surface so denied tool requests show a clearer explanation.

**Files to touch:**
- `src/server/services/session-runtime.ts`
- `src/server/services/sse-emitter.ts`
- `src/server/types/message.ts`
- `src/client/types/message.ts`
- `src/client/stores/chat-store.ts`
- `src/client/components/ApprovalSurface.tsx`

**Decisions:**
- Extend the `PermissionUpdate` / `PermissionResult` flow to carry a typed `denialReason` field when a request is denied.
- The `pending_approval` SSE event carries the denial reason so the GUI can render it without extra round trips.
- The approval surface maps `safetyCheck` and `asyncAgent` to distinct copy strings; unknown reasons fall back to a generic denial message.
- Typed denial reasons are surfaced only in the GUI approval surface. Bot/WeCom sessions continue to receive the existing generic denial message to avoid leaking policy details through an untrusted channel.

**Implementation notes:**
1. Update the `canUseTool` callback in `session-runtime.ts` to read the new denial reason fields from the SDK's `PermissionResult` / `PermissionUpdate` shape.
2. Add `denialReason?: 'safetyCheck' | 'asyncAgent' | string` to the `pending_approval` SSE event type and to the `PendingApproval` interface in `chat-store.ts`.
3. Update `ApprovalSurface.tsx` to accept the typed reason and render reason-specific copy above the allow/deny buttons.
4. Keep the existing `onDeny` behavior unchanged when no typed reason is present.

**Test scenarios:**
- A `safetyCheck` denial shows the safety-check explanation.
- An `asyncAgent` denial shows the async-agent explanation.
- A denial with an unknown reason shows the generic fallback.
- Approved requests are unaffected.

**Dependencies:** U1.

---

### U6 — `forkSession` action in session list

**Goal:** Add a "Fork" action on sessions that calls `forkSession(sessionId, opts?)` and opens the branched conversation.

**Files to touch:**
- `src/server/services/sdk-client.ts`
- `src/server/services/chat-service.ts`
- `src/server/routes/chat.ts` (existing session-scoped routes)
- `src/client/services/session-api.ts` (or equivalent client API layer)
- `src/client/components/session-list/` (session list item / actions)
- `src/client/stores/session-store.ts`

**Decisions:**
- The server exposes a single REST endpoint under `src/server/routes/chat.ts` that wraps `forkSession` and returns the new session ID, following the existing `/api/workspaces/:id/sessions/:sessionId/...` pattern with `mergeParams: true`.
- The endpoint reuses the same workspace/session authorization checks as the existing message-stream and session-list endpoints.
- The client action opens the forked session in the same window/tab, preserving the current navigation pattern.
- Optional `opts` (title, etc.) are omitted initially; the SDK default is used. Any future `opts` must be validated against a strict schema before being passed to the SDK.
- On success, the client refetches the session list to keep ordering consistent with the server.

**Implementation notes:**
1. Add `forkSession` to the named imports in `sdk-client.ts` and expose a wrapper method on `SdkClient`.
2. Add a `forkSession` method to `chat-service.ts` that delegates to the SDK client.
3. Add a POST route (e.g. `/api/workspaces/:id/sessions/:sessionId/fork`) to `src/server/routes/chat.ts` that returns `{ sessionId }`.
4. Add a client API call and wire it to a "Fork" menu item or button in the session list.
5. On success, navigate to the new session.

**Test scenarios:**
- Forking a session creates a new session and navigates to it.
- The forked session has the same message history as the original up to the fork point.
- Forking fails gracefully with an error message if the SDK throws.
- The original session remains accessible after forking.

**Dependencies:** U1.

---

### U7 — Context usage breakdown panel

**Goal:** Add a debug/usage panel that calls `getContextUsage()` and shows how much context window is consumed by the current session.

**Files to touch:**
- `src/server/services/sdk-client.ts`
- `src/server/services/chat-service.ts`
- `src/server/routes/chat.ts` (existing session-scoped routes)
- `src/client/services/session-api.ts`
- `src/client/components/session/` (new or existing debug panel)
- `src/client/stores/session-store.ts`

**Decisions:**
- The panel is initially a debug/usage affordance, not a primary UI element; place it in an existing info/debug panel or behind a toggle.
- The server endpoint caches or computes context usage on demand; no polling is required for the first version.
- The endpoint follows the existing `/api/workspaces/:id/sessions/:sessionId/...` route pattern in `src/server/routes/chat.ts` and reuses the same session authorization check as the message stream.
- The endpoint returns only aggregate usage numbers, not message content.

**Implementation notes:**
1. Add `getContextUsage` to the SDK imports and expose it through `SdkClient`.
2. Add a REST endpoint (e.g. `GET /api/workspaces/:id/sessions/:sessionId/context-usage`) to `src/server/routes/chat.ts` that returns the SDK result.
3. Render a simple progress bar or numeric readout of used vs. total context tokens/percentage.
4. Handle the case where the SDK returns no data or the session is not active.

**Test scenarios:**
- The panel displays context usage for an active session.
- The panel handles missing/empty usage data gracefully.
- The endpoint returns a 404 or empty response for non-existent sessions.

**Dependencies:** U1.

---

### U8 — Enhanced result metadata

**Goal:** Forward `stop_reason`, `terminal_reason`, and `origin` fields on result messages (`0.2.31`, `0.2.91`, `0.2.126`) through the SSE `result` event for better turn-end diagnostics.

**Files to touch:**
- `src/server/services/session-runtime.ts`
- `src/server/services/sse-emitter.ts`
- `src/server/types/message.ts`
- `src/client/types/message.ts`
- `src/client/stores/chat-store.ts`
- `src/client/components/chat/` (result message / debug detail renderer)

**Decisions:**
- The `result` SSE event is extended with optional `stopReason`, `terminalReason`, and `origin` fields. This is allowed under KTD 1 because `result` is terminal for the message-render state machine. Clients that ignore the fields are unaffected.
- The client store may continue to use `result` for usage accounting; the new fields are stored on the turn for display but do not change accounting logic.

**Implementation notes:**
1. When the SDK emits a result message, copy the new metadata fields into the SSE `result` event payload.
2. In `chat-store.ts`, store the metadata on the turn so it can be rendered.
3. Render the metadata subtly (e.g. small gray text or a debug expandable) so it does not dominate the transcript.

**Test scenarios:**
- A result message carries `stopReason`, `terminalReason`, and `origin` when the SDK provides them.
- Legacy result events without the new fields continue to work.
- Usage accounting that depends on the `result` event is unaffected.

**Dependencies:** U1.

---

### U9 — `api_retry` visibility

**Goal:** Emit `api_retry` system messages (`0.2.77`, `0.3.150`) through the SSE stream so users see when the CLI is retrying an API call.

**Files to touch:**
- `src/server/services/session-runtime.ts`
- `src/server/services/sse-emitter.ts`
- `src/server/types/message.ts`
- `src/client/types/message.ts`
- `src/client/stores/chat-store.ts`
- `src/client/components/chat/` (system-notice renderer)

**Decisions:**
- `api_retry` is emitted as a new SSE event. It is rendered inline as a lightweight, non-toast system notice, consistent with other system notices such as `server_restarted`.
- The notice is stored as a transcript entry so it survives reconnects. If rapid retries produce noisy duplicate notices, collapse consecutive notices with the same reason within a short window.

**Implementation notes:**
1. Detect `api_retry` system messages and emit a new SSE event, e.g. `{ type: 'api_retry', attempt?, reason? }`.
2. In `chat-store.ts`, append an inline system notice for retries.
3. Render retry notices subtly (e.g. small gray text) so they do not dominate the transcript.

**Test scenarios:**
- An `api_retry` event renders an inline retry notice.
- Multiple rapid retries do not duplicate notices in a confusing way.
- Legacy message streams without `api_retry` are unaffected.

**Dependencies:** U1.

## Scope Boundaries

### Deferred for later

- GUI design and implementation for binary-only CLI features: `/goal` command (`2.1.139`), dynamic workflows (`2.1.154`), `claude agents --json` dashboard (`2.1.145`/`2.1.162`/`2.1.169`), `fallbackModel` setting (`2.1.166`), `enforceAvailableModels` policy (`2.1.175`), and `worktree.bgIsolation` setting (`2.1.143`).
- `SessionStart` hook support (`0.3.152`) and `MessageDisplay` hook events — product has not requested hook integration and the app's existing hooks are workspace-level, not SDK hooks.
- `ControlResponse.pending_permission_requests` and `applyFlagSettings` live application (`0.3.161`) — optional P1 surface, not required for the upgrade.
- `stop_task` additional context (`0.3.163`) — optional P1 surface.
- Experimental APIs such as `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` (`0.3.169`) until they stabilize.
- `BrowserQueryOptions.sse` alternative transport (`0.3.169`) — the app uses server-side `query()` and SSE to the browser, so this option is not directly applicable.
- Provider-specific authentication flows (Bedrock, Vertex, Foundry) and fullscreen TUI improvements are outside the app's scope.

### Outside this product's identity

- Changes to the CLI's interactive terminal behavior (e.g., vim mode, mouse wheel settings).
- Provider credential handling beyond the existing provider model configuration.

## Open Questions

### Resolved during planning

- **Icon URL policy:** The renderer must validate/proxy `icon_url` or rely on an existing CSP. This is now captured in U4 and Risks.

### Deferred to implementation

1. **Credit-required rate-limit copy:** Exact copy and CTA for the three credit/throughput cases in U2 are deferred to product/design.
2. **`model_fallback` detail level:** Should the fallback notice include the original and fallback model names, or only the reason? The event shape supports both; UI can choose.
3. **`tool_use_meta` arrival shape:** Confirm whether `tool_use_meta` is embedded in the assistant message, arrives as a separate SDK system message, or is present only on historical messages loaded via `getSessionMessages`. Also confirm the correlation key (index, `toolUseId`, or name) that links the meta to the correct `tool_use` block.
4. **Typed permission-denial SDK shape:** Confirm the exact field names and types in SDK 0.3.183's `PermissionResult` / `PermissionUpdate` for denials (e.g. `denialReason`, `reason`, enum values).
5. **`forkSession` / `getContextUsage` signatures:** Confirm the exact argument and return types in SDK 0.3.183 before wiring the REST routes.
6. **P1 prioritization:** Which P1 units (if any) should move up if a future product cycle targets session management or background workflows?

## Sources & Research

- Requirements document: `docs/brainstorms/2026-06-19-claude-agent-sdk-0-3-183-upgrade-requirements.md`
- Grounding dossier: `/tmp/compound-engineering/ce-brainstorm/sdk-upgrade-grounding.md`
- SDK changelog: `https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md`
- Claude Code binary changelog: `https://code.claude.com/docs/en/changelog`
- SDK client wrapper: `src/server/services/sdk-client.ts`
- Chat service and session lifecycle: `src/server/services/chat-service.ts`
- Session runtime and message stream: `src/server/services/session-runtime.ts`
- SSE normalization: `src/server/services/sse-emitter.ts`
- Shared message types: `src/server/types/message.ts`, `src/client/types/message.ts`
- Client message handling: `src/client/stores/chat-store.ts`
- Tool renderer registry: `src/client/components/tool-renderers/`
- Approval surface: `src/client/components/ApprovalSurface.tsx`
- Native binary bundling: `scripts/build-sidecar.ts`
