---
title: Session Fast Mode Toggle - Plan
type: feat
date: 2026-07-15
topic: fast-mode-session-toggle
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# Session Fast Mode Toggle - Plan

## Goal Capsule

- **Objective:** Add a session-level fast mode toggle in the chat input toolbar so users can switch the current session to a faster, lower-latency response mode when they care more about speed than full-depth reasoning.
- **Product authority:** The GUI chat user toggles the mode per session.
- **Execution profile:** Code change across client UI, client state, server session handling, provider capability plumbing, and SDK option wiring.
- **Stop conditions:** The toggle is present, session-scoped, persisted, disabled while streaming, capability-gated by provider/model, and the SDK receives `fastMode` on the next runtime creation.
- **Tail ownership:** None; this is a self-contained feature with no follow-up rollout or operational steps.

## Product Contract

### Summary

Add a fast-mode switch to the `PromptInput` toolbar, alongside the Provider and Approval mode selectors. The toggle is scoped to the current session, defaults to off, persists for that session, and is disabled while a response is streaming. When building SDK options, the server passes the session's `fastMode` value (`true` or `false`) to the Claude Agent SDK the next time the session runtime is created or rebuilt.

### Problem Frame

Users sometimes want a quicker reply from Claude even if it means lighter reasoning. Today the only lever is the Provider/model selector, which is not the same as a speed-first mode and does not address the "I want this specific session to run fast" intent. A dedicated, discoverable toggle lets them express that intent without rewriting prompts or changing providers.

### Key Decisions

- **Session-level over per-message.** Following the existing Provider and Approval mode pattern keeps each send lightweight and avoids asking the user to choose mode on every message.
- **Default off over remembering the previous session.** This prevents users from unknowingly staying in a degraded-quality mode across sessions.
- **Disabled while streaming.** The toggle cannot be changed during an active assistant turn, avoiding surprise interrupts and matching the SDK reality that `fastMode` is fixed for a given runtime.
- **Disabled-with-tooltip for unsupported models.** If the active provider/model does not report `supportsFastMode`, the toggle is shown disabled with an explanatory tooltip rather than hidden entirely.
- **Effect on next runtime creation.** Because `fastMode` is set when a session runtime starts, a toggle change is applied the next time the runtime is created or rebuilt; no mid-runtime mutation is required.
- **Provider field for capability gate.** The client learns whether fast mode is supported from a `supportsFastMode` field on the active provider, reusing the existing provider store rather than adding a separate model-info endpoint.

### Requirements

**Toggle UI**

- R1. A fast-mode toggle appears in the regular chat input toolbar, alongside the Provider and Approval mode selectors.
- R2. The toggle uses a clear on/off visual state so the user can tell whether fast mode is active at a glance.
- R3. The toggle is disabled when the session is streaming or restarting.
- R4. When the active provider/model does not support fast mode, the toggle is shown disabled with a tooltip explaining that the current model does not support it.

**State and persistence**

- R5. Fast-mode state is session-scoped: changing it affects only the current session.
- R6. Every new session starts with fast mode off.
- R7. The toggle state persists per session and survives page refresh for that session.
- R8. A draft session that has not yet been promoted to an SDK session still stores the fast-mode preference; it is applied when the runtime is created.

**SDK integration**

- R9. When building SDK options for a session, the server reads the session's fast-mode flag and passes `fastMode: true` when enabled and `fastMode: false` when disabled.
- R10. Fast-mode changes take effect the next time the session runtime is created or rebuilt.

**Internationalization**

- R11. The toggle label, tooltip, and active-state copy are translated in both English and Simplified Chinese.

### Acceptance Examples

- AE1. User opens a session, sees the fast-mode toggle off, enables it, and sends a message. The next runtime for that session is created with `fastMode: true`.
- AE2. User starts a streaming response; the fast-mode toggle becomes disabled. After the turn completes, the toggle becomes enabled again.
- AE3. User switches to a session whose provider/model does not support fast mode; the toggle is disabled and hovering shows an explanatory tooltip.
- AE4. App reloads; sessions that had fast mode enabled still show it enabled.

### Scope Boundaries

- Per-message fast mode override is not in scope.
- Workspace-wide or global fast mode default is not in scope.
- Automatic fast mode selection based on prompt content or task type is not in scope.
- Cost estimation or token-usage comparison for fast vs. normal mode is not in scope.
- Mid-runtime activation or a runtime rebuild triggered directly by the toggle is not in scope.

### Dependencies / Assumptions

- The installed Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) exposes a `fastMode?: boolean` option in its `Options` type and `supportsFastMode?: boolean` on model info.
- The session persistence layer can store an additional per-session boolean flag.
- Provider responses expose a `supportsFastMode` boolean so the client can gate the toggle.
- Fast mode is a meaningful speed/latency improvement for the supported provider/model combination.

### Outstanding Questions

- None. The deferred icon/copy questions from the requirements-only version are resolved in the Implementation Units below.

---

## Planning Contract

### Key Technical Decisions

- **KTD1. Store the flag on the existing `sessions` table.** The `sessions` table already carries session-scoped preferences such as `approval_mode` and `provider_id`. Adding a `fast_mode` integer column is the smallest change and lets the flag survive app restarts and SDK session promotion without any migration of SDK-owned session state.
- **KTD2. Compute `supportsFastMode` server-side from provider configuration.** The client will read `supportsFastMode` from the provider object. The server computes it by matching the provider's configured `model` against a maintained capability map. Providers without an explicit model default to `true` because the SDK default model is expected to support fast mode.
- **KTD3. Apply `fastMode` only in `ChatService.buildSdkOptions`.** This is the single place where `Options` is constructed before `SessionRuntime.open`. Passing `fastMode` here respects the runtime lifecycle: changes apply on the next runtime creation/rebuild and never mid-query.
- **KTD4. Mirror the existing approval-mode optimistic-update pattern.** `setSessionFastMode` in `chat-store.ts` updates local state immediately, calls the new route, and reverts on failure. This matches `setSessionApprovalMode` and keeps the UI responsive.

### High-Level Technical Design

The change follows the existing session-preference pattern established by `approvalMode`:

1. **Persistence:** SQLite `sessions` table gains a `fast_mode` column with a default of `0`. `SqliteStore` reads, writes, and maps the column in `createLocalSession`, `updateLocalSession`, and `parseSessionRow`.
2. **Models:** `ChatSession` (server and client) gains `fastMode?: boolean`. `Provider` (server and client) gains `supportsFastMode?: boolean`.
3. **Server API:** A new `POST /api/workspaces/:id/sessions/:sessionId/fast-mode` route validates a boolean `fastMode` body field, persists it with `store.updateLocalSession`, and returns `{ ok: true }`. No runtime mutation is attempted.
4. **SDK plumbing:** `ChatService.buildSdkOptions` injects `fastMode: session.fastMode ?? false` into the SDK `Options` object. The route that creates sessions does not accept a fast-mode override; it always defaults to off.
5. **Provider capability:** A new server utility `src/server/utils/provider-capability.ts` maps model identifiers to a fast-mode capability flag. `parseProviderRow` enriches every provider row with `supportsFastMode`. The client receives the field through the existing `/api/providers` responses.
6. **Client state:** `chat-store.ts` adds `setSessionFastMode`, modeled after `setSessionApprovalMode`, including optimistic update and error revert.
7. **UI:** A new `FastModeToggle` component renders a button in the `PromptInput` toolbar. It derives `supportsFastMode` from the active provider (session provider or default) and disables the button when streaming, restarting, or unsupported. Tooltips are rendered with the existing Radix `Tooltip` primitive.

### Sequencing

The units below are ordered to minimize integration churn: schema and models first, then server API/SDK plumbing, then provider capability, then client state and UI, then tests. Each unit leaves the codebase in a buildable state.

### Assumptions

- The SDK's `Options.fastMode` accepts a plain boolean; no additional env vars are required.
- The runtime lifecycle will not be changed; existing idle-close and rebuild behavior is sufficient for R10.
- The capability map for `supportsFastMode` is maintained in source and does not need to be user-editable.

### Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Unknown model names defaulting to `true` could let users enable fast mode on unsupported models. | Medium | The capability map should explicitly list known unsupported model name fragments; implementer should validate against the installed SDK's `supportedModels()` if exact values are unclear. |
| Adding a column to a production `sessions` table without a migration guard. | Low | Follow the existing `ALTER TABLE ADD COLUMN` guard pattern in `sqlite-store.ts` initialization. |
| Optimistic update revert could clobber a concurrent session edit. | Low | Revert only the `fastMode` field, not the whole session object, mirroring `setSessionApprovalMode`. |

---

## Implementation Units

### U1. Session schema and persistence layer

- **Goal:** Persist a per-session `fastMode` flag in SQLite and surface it on `ChatSession`.
- **Requirements:** R5, R6, R7, R8.
- **Files:**
  - `src/server/storage/sqlite-store.ts`
  - `src/server/models/session.ts`
  - `src/server/storage/sqlite-store.test.ts`
- **Approach:**
  1. Add `fast_mode INTEGER NOT NULL DEFAULT 0` to the `sessions` table `CREATE TABLE` statement.
  2. Add an `ALTER TABLE sessions ADD COLUMN fast_mode INTEGER NOT NULL DEFAULT 0` migration guard after the existing column guards.
  3. Add `fastMode?: boolean` to the `ChatSession` interface in `src/server/models/session.ts`.
  4. Update `createLocalSession` to insert `fast_mode` as `0`.
  5. Update `updateLocalSession` to accept `fastMode?: boolean` and emit `fast_mode = ?`.
  6. Update `parseSessionRow` to return `fastMode: row.fast_mode === 1`.
- **Test scenarios:**
  - `sqlite-store.test.ts`: creating a session stores `fastMode` as `false`.
  - `sqlite-store.test.ts`: `updateLocalSession({ fastMode: true })` persists and `getLocalSession` returns `fastMode: true`.
  - `sqlite-store.test.ts`: existing database without the column is migrated and returns `fastMode: false`.
- **Verification:** `npm run test:server` passes.

### U2. Server API route and SDK option plumbing

- **Goal:** Let the client change the session flag and ensure the SDK receives it on the next runtime.
- **Requirements:** R5, R7, R9, R10.
- **Files:**
  - `src/server/routes/chat.ts`
  - `src/server/services/chat-service.ts`
  - `src/server/services/chat-service.test.ts`
- **Approach:**
  1. Add `POST /api/workspaces/:id/sessions/:sessionId/fast-mode` in `src/server/routes/chat.ts`. Validate that `fastMode` is a boolean, call `store.updateLocalSession(sessionId, { fastMode })`, and return `{ ok: true }`.
  2. In `ChatService.buildSdkOptions`, after constructing `options`, set `options.fastMode = session.fastMode ?? false`.
  3. Add a diagnostic log line next to the existing option logs: `sidecarLog('[ChatService.buildSdkOptions] fastMode=' + options.fastMode)`.
- **Test scenarios:**
  - `chat-service.test.ts`: capture `SessionRuntime.open` options for a session whose `fastMode` is `true`; assert `options.fastMode === true`.
  - `chat-service.test.ts`: capture options for a session whose `fastMode` is `false`/undefined; assert `options.fastMode === false`.
  - `chat-service.test.ts`: the new route returns `400` for non-boolean `fastMode`.
- **Verification:** `npm run test:server` passes.

### U3. Provider capability field

- **Goal:** Expose `supportsFastMode` on provider responses so the client can gate the toggle.
- **Requirements:** R4.
- **Files:**
  - `src/server/models/provider.ts`
  - `src/server/utils/provider-capability.ts` (new)
  - `src/server/storage/sqlite-store.ts`
  - `src/client/stores/provider-store.ts`
- **Approach:**
  1. Create `src/server/utils/provider-capability.ts` exporting `function providerSupportsFastMode(model?: string): boolean`. The implementation matches `model` (case-insensitive) against known unsupported fragments/aliases and returns `true` when unknown or empty.
  2. Add `supportsFastMode?: boolean` to the `Provider` interface in `src/server/models/provider.ts`.
  3. In `parseProviderRow`, set `supportsFastMode: providerSupportsFastMode(row.model ?? undefined)`.
  4. Add `supportsFastMode?: boolean` to the client `Provider` interface in `src/client/stores/provider-store.ts`.
- **Test scenarios:**
  - `sqlite-store.test.ts`: a provider with a known unsupported model returns `supportsFastMode: false`.
  - `sqlite-store.test.ts`: a provider with a known supported model returns `supportsFastMode: true`.
  - `sqlite-store.test.ts`: a provider with no model returns `supportsFastMode: true`.
- **Verification:** `npm run test:server` passes.

### U4. Client state for fast mode

- **Goal:** Let the UI read and update the session flag with optimistic feedback.
- **Requirements:** R5, R7.
- **Files:**
  - `src/client/stores/chat-store.ts`
  - `src/client/stores/chat-store.test.ts`
- **Approach:**
  1. Add `fastMode?: boolean` to the client `ChatSession` interface.
  2. Add `setSessionFastMode: (workspaceId: string, sessionId: string, fastMode: boolean) => Promise<void>` to the `ChatState` interface.
  3. Implement the action with the same optimistic update/revert pattern as `setSessionApprovalMode`: mutate the matching session's `fastMode`, `POST` to `/api/workspaces/${workspaceId}/sessions/${sessionId}/fast-mode`, and revert on error.
  4. Ensure `createSession` does not send a fast-mode value; the server default is off.
- **Test scenarios:**
  - `chat-store.test.ts`: calling `setSessionFastMode(true)` immediately sets `session.fastMode` to `true` and issues the expected `fetch` call.
  - `chat-store.test.ts`: when the fetch fails, the store reverts `session.fastMode` to its previous value.
- **Verification:** `npm run test:client` passes for the chat-store test file.

### U5. Fast mode toggle UI

- **Goal:** Render the toggle in the `PromptInput` toolbar with correct disabled and tooltip states.
- **Requirements:** R1, R2, R3, R4, R11.
- **Files:**
  - `src/client/components/FastModeToggle.tsx` (new)
  - `src/client/components/PromptInput.tsx`
  - `src/client/i18n/en/chat.json`
  - `src/client/i18n/zh-CN/chat.json`
- **Approach:**
  1. Create `FastModeToggle` accepting `workspaceId`, `sessionId`, and `disabled?: boolean`.
  2. Read the session from `chat-store`, the active provider (session provider or default) from `provider-store`, and `setSessionFastMode` from `chat-store`.
  3. Resolve `supportsFastMode` from the active provider; if no provider is loaded yet, default to `true`.
  4. Render a button with a `Zap` icon and short label. Active state uses accent color/background; inactive state uses muted text. The button is disabled when `disabled` (streaming/restarting) or `!supportsFastMode`.
  5. Wrap the button in the existing `Tooltip` primitive. Use `title={t('fastMode.unsupportedTooltip')}` when unsupported, `title={t('fastMode.title')}` otherwise.
  6. Insert `<FastModeToggle workspaceId={workspaceId} sessionId={sessionId} disabled={isStreaming || isRestarting} />` between `ProviderSelector` and `ApprovalModeToggle` in `PromptInput`.
  7. Add keys to `chat.json` for both locales: `fastMode.on`, `fastMode.off`, `fastMode.title`, `fastMode.unsupportedTooltip`.
- **Test scenarios:**
  - `PromptInput.browser.test.tsx`: when `isStreaming` is true, the fast-mode button is disabled.
  - `PromptInput.browser.test.tsx`: when the active provider has `supportsFastMode: false`, the button is disabled and the unsupported tooltip is present.
  - `PromptInput.browser.test.tsx`: clicking the button toggles the session's `fastMode` via the mocked store action.
- **Verification:** `npm run test:browser` passes for the PromptInput browser test file.

### U6. Integration and quality gates

- **Goal:** Keep the feature buildable, lint-clean, and documented.
- **Requirements:** R11 (i18n completeness), plus global done criteria.
- **Files:**
  - `CHANGELOG.md`
  - `src/server/index.ts` (if any top-level route ordering changes; none expected)
- **Approach:**
  1. Run `npm run lint` and fix any new errors.
  2. Run the full client and server test suites.
  3. Add a CHANGELOG entry under "Unreleased" describing the new session fast-mode toggle.
- **Verification:**
  - `npm run lint` exits cleanly.
  - `npm run test:server` passes.
  - `npm run test:client` passes.
  - `npm run test:browser` passes.

---

## Verification Contract

| Command | When to run | Expected result |
|--------|-------------|-----------------|
| `npm run lint` | After every unit | No new ESLint/TypeScript errors. |
| `npm run test:server` | After U1, U2, U3, U6 | All `node:test` suites pass; SQLite tests use isolated DB. |
| `npm run test:client` | After U4, U6 | All jsdom Vitest suites pass. |
| `npm run test:browser` | After U5, U6 | Playwright browser tests pass, including updated `PromptInput.browser.test.tsx`. |
| Manual smoke | U6 | Start `npm run dev:server` + `npm run dev:client`, create a session, toggle fast mode, send a message, and confirm the runtime starts and `fastMode` is logged. |

---

## Definition of Done

- [ ] U1–U6 are implemented and the code compiles.
- [ ] `npm run lint` passes with no new warnings.
- [ ] `npm run test:server`, `npm run test:client`, and `npm run test:browser` all pass.
- [ ] `CHANGELOG.md` has an "Unreleased" entry for the fast-mode toggle.
- [ ] No absolute paths, debug logs, or dead experimental code remain in the diff.
- [ ] The plan file at `docs/plans/2026-07-15-001-feat-fast-mode-session-toggle-plan.md` is updated to `implementation-ready` and contains no blocking open questions.
