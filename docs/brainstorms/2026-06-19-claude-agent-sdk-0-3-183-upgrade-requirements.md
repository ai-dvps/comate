---
date: 2026-06-19
topic: claude-agent-sdk-0-3-183-upgrade
---

## Summary

Upgrade the `@anthropic-ai/claude-agent-sdk` dependency from `^0.3.144` to `^0.3.183`, verify that no existing app features break, and produce a ranked adoption roadmap for the new SDK-exposed and binary capabilities that become available in that range.

## Problem Frame

The app is currently pinned to SDK `^0.3.144`. Version `0.3.183` brings the SDK to parity with Claude Code `v2.1.183` and includes several behavioral changes, new message types, and lifecycle APIs. Before bumping the dependency we need a compatibility audit against the app's actual SDK surface, plus a deliberate decision about which new capabilities are worth exposing in the GUI versus deferring.

The app's SDK integration is centralized in `src/server/services/sdk-client.ts` and consumed by `src/server/services/chat-service.ts`. Client-side message handling lives in `src/client/stores/chat-store.ts` and the tool-renderer registry under `src/client/components/tool-renderers/`. Session lifecycle, subagent history, and task/approval surfaces are all wired through stable SDK APIs.

## Requirements

### Compatibility and breaking-change assessment

- R1. Bump `@anthropic-ai/claude-agent-sdk` from `^0.3.144` to `^0.3.183` in `package.json` and regenerate `package-lock.json`.
- R2. Confirm the app does not use APIs removed between `0.3.144` and `0.3.183` (`unstable_v2_createSession`, `unstable_v2_resumeSession`, `unstable_v2_prompt`, `SDKSession`, `SDKSessionOptions`, `TodoWrite` as the primary task system).
- R3. Update any app code that matches SDK `error` values for 529 responses so it recognizes both `'overloaded'` (new in `0.3.150`) and the legacy `'rate_limit'` shape.
- R4. Verify that the move of `@anthropic-ai/sdk` and `@modelcontextprotocol/sdk` to `peerDependencies` in `0.3.143` does not break the build, sidecar bundling, or runtime resolution.
- R5. Verify that background MCP connection behavior (new default in `0.3.142`) does not break session initialization in the GUI; surface `status: "pending"` in `init` if the SDK emits it.
- R6. Run the full test suite and TypeScript build after the version bump; no regressions in chat streaming, approvals, tasks, subagents, or session management.

### Feature adoption roadmap

- R7. Produce a ranked adoption list: **P0** (adopt during upgrade), **P1** (plan next), **P2** (defer until product/design is ready).
- R8. **P0 — Render `tool_use_meta` display metadata:** use the new `tool_use_meta` sidecar on assistant messages (`0.3.179`, enhanced with `icon_url` in `0.3.181`) to show friendly tool names and, when present, the MCP server icon inline next to the tool name in the collapsed tool header. The renderer currently derives tool name from `tool_use` parts; this should be enhanced, not replaced, so legacy messages still render.
- R9. **P0 — Surface credit-required rate limits:** read `errorCode`, `canUserPurchaseCredits`, and `hasChargeableSavedPaymentMethod` from `SDKRateLimitInfo` (`0.3.181`) and show a differentiated message when a rate limit is caused by exhausted credits versus throughput.
- R10. **P0 — Handle `system/model_fallback` messages:** forward the new `system/model_fallback` event (`0.3.174`) through the SSE stream and render it as a persistent inline system notice in the chat transcript so users see when the session falls back due to `overloaded`, `server_error`, `last_resort`, `model_not_found`, or `permission_denied`.
- R11. **P0 — Typed permission-denied reasons:** consume the new `safetyCheck` / `asyncAgent` denial reasons (`0.3.178`) in the approval surface so denied tool requests show a clearer explanation.
- R12. **P1 — Expose `forkSession` in the session list:** add a "Fork" action on sessions that calls `forkSession(sessionId, opts?)` (`0.2.76`) and opens the branched conversation.
- R13. **P1 — Context usage breakdown:** add a debug/usage panel that calls `getContextUsage()` (`0.2.86`) to show how much context window is consumed by the current session.
- R14. **P1 — Enhanced result metadata:** forward `stop_reason`, `terminal_reason`, and `origin` fields on result messages (`0.2.31`, `0.2.91`, `0.2.126`) through the SSE `result` event for better turn-end diagnostics.
- R15. **P1 — Retry visibility:** emit `api_retry` system messages (`0.2.77`, `0.3.150`) through the SSE stream so users see when the CLI is retrying an API call.
- R16. **P2 — Binary-only CLI features:** track but do not implement in this upgrade the following Claude Code binary capabilities, which require new GUI design work: `/goal` command (`2.1.139`), dynamic workflows (`2.1.154`), `claude agents --json` dashboard (`2.1.145`/`2.1.162`/`2.1.169`), `fallbackModel` setting (`2.1.166`), `enforceAvailableModels` policy (`2.1.175`), and `worktree.bgIsolation` setting (`2.1.143`).

## Key Decisions

- **Task tools are already the app's primary model.** The SDK switched from `TodoWrite` to Task tools (`TaskCreate`/`TaskUpdate`/`TaskGet`/`TaskList`) as the default in `0.3.142`. The app already parses both (`src/client/stores/chat-store.ts`, `src/client/components/tool-renderers/`), so no behavior change is required; `TodoWrite` handling stays as a compatibility fallback.
- **`deleteSession` is dynamically imported.** The verifier found `deleteSession` is imported dynamically inside `src/server/services/chat-service.ts` rather than at the top level of `src/server/services/sdk-client.ts`. This is acceptable and does not need to be normalized for the upgrade.
- **SDK-exposed features outrank binary-only features.** Capabilities that surface through the existing `SdkClient`/`Query` API (message types, control responses, session methods) are prioritized over features that only exist as CLI commands or settings and would require new UI paradigms.
- **Friendly tool display is a renderer-only change.** `tool_use_meta` should be treated as presentation metadata; the existing `tool_use` part remains the source of truth for tool identity and input.
- **Tool icons render inline.** When `tool_use_meta.icon_url` is present, the icon appears next to the tool name in the collapsed tool header.
- **Model fallback is a persistent inline notice.** `system/model_fallback` events are rendered as a system message in the chat transcript, not as a transient toast or debug-only log.

## Scope Boundaries

### Deferred for later

- GUI design and implementation for binary-only CLI features such as `/goal`, dynamic workflows, the `claude agents` dashboard, and advanced settings like `fallbackModel`.
- Adoption of experimental APIs such as `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` (`0.3.169`) until they stabilize.
- `BrowserQueryOptions.sse` alternative transport (`0.3.169`) — the app uses server-side `query()` and SSE to the browser, so this option is not directly applicable.

### Outside this product's identity

- Features that change the CLI's interactive terminal behavior (e.g., fullscreen TUI improvements, vim mode, mouse wheel settings) are not relevant to this GUI wrapper.
- Provider-specific authentication flows (Bedrock, Vertex, Foundry credential handling) are outside the app's scope unless they break the SDK API contract.

## Dependencies / Assumptions

- The new SDK version ships the native `claude` CLI binary through the same platform-specific optional dependencies the build script already copies (`scripts/build-sidecar.ts`).
- The target runtime environment has access to the npm registry mirror currently used in `package-lock.json` (`registry.npmmirror.com`).
- The test suite covers chat streaming, approvals, tasks, subagents, and session lifecycle sufficiently to catch regressions from the SDK bump.

## Sources / Research

- SDK changelog: `https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md`
- Claude Code binary changelog: `https://code.claude.com/docs/en/changelog`
- Current SDK version and dependency structure: `package.json:28`
- SDK client wrapper and type imports: `src/server/services/sdk-client.ts:1-154`
- Chat service and session lifecycle: `src/server/services/chat-service.ts:1-300`
- Client-side task/approval/subagent handling: `src/client/stores/chat-store.ts`
- Tool renderer registry: `src/client/components/tool-renderers/`
- WeCom bot tool permission categories (includes Task tools): `src/server/services/tool-permission-policy.ts:35-50`
- Native binary bundling: `scripts/build-sidecar.ts:165-183`

## Compatibility matrix: 0.3.144 → 0.3.183

| Version | Change | App impact |
|---------|--------|------------|
| 0.3.145 | `model_not_found` errors and `api_error_status` documented | None; informational |
| 0.3.150 | 529 responses now emit `error: 'overloaded'` instead of `'rate_limit'` | Update error matching if present |
| 0.3.152 | `SessionStart` hooks can return `reloadSkills` and set session title; `MessageDisplay` hook event | Optional P1 adoption |
| 0.3.161 | `ControlResponse` gains `pending_permission_requests`; `applyFlagSettings` live-applies agent changes | Optional P1 adoption |
| 0.3.162 | Native builds default to fast embedded `find`/`grep` in Bash; `refusal` stop reason | None; behavioral |
| 0.3.163 | `stop_task` returns success for gone tasks; Stop/SubagentStop support `additionalContext` | Optional P1 adoption |
| 0.3.166 | Fixed runtime MCP resource tool injection | None; bug fix |
| 0.3.169 | `usage_EXPERIMENTAL` method; `sse` option for browser queries | Defer — experimental |
| 0.3.170 | `claude-fable-5` model and `fable` alias | Add to model allowlist if applicable |
| 0.3.174 | `system/model_fallback` for all fallback triggers | Adopt P0 |
| 0.3.176 | Restored background agent/task state on resume | None; reliability fix |
| 0.3.178 | Typed permission-denial reasons (`safetyCheck`, `asyncAgent`) | Adopt P0 |
| 0.3.179 | `tool_use_meta` sidecar with display names | Adopt P0 |
| 0.3.181 | `icon_url` in `tool_use_meta`; credit fields in `SDKRateLimitInfo` | Adopt P0 |
| 0.3.183 | Parity with Claude Code v2.1.183 | None; baseline |

## Adoption priority summary

| Priority | Items |
|----------|-------|
| P0 | Bump dependency; verify build/tests; handle `overloaded` errors; render `tool_use_meta` names/icons; surface credit-aware rate limits; forward `model_fallback`; use typed permission-denial reasons. |
| P1 | `forkSession` action; `getContextUsage()` panel; enhanced result metadata (`stop_reason`, `terminal_reason`, `origin`); `api_retry` visibility; `SessionStart`/`MessageDisplay` hooks if product wants them. |
| P2 | Binary-only CLI features: `/goal`, dynamic workflows, `claude agents` dashboard, `fallbackModel`, `enforceAvailableModels`, `worktree.bgIsolation`. |

## Outstanding Questions

- **Deferred to planning:** Exact copy and UX for the credit-required rate-limit message (P0).
- **Deferred to planning:** Which P1/P2 items should move up if a future product cycle targets session management or background workflows.
