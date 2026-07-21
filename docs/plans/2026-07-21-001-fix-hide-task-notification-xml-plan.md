---
title: Hide Task Notification XML From Chat Transcript - Plan
type: fix
date: 2026-07-21
topic: hide-task-notification-xml
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# Hide Task Notification XML From Chat Transcript - Plan

## Goal Capsule

- Objective: Suppress the `<task-notification>` XML the SDK injects so it never renders in the chat transcript. Task state stays visible in the Tasks panel; nothing replaces the suppressed bubble.
- Authority: `product_contract_source: ce-brainstorm`. The user chose "hide entirely" over rendering a status card, a foldable chip, or a muted one-line note. The one behavioral fork surfaced (zero trace vs minimal marker) was confirmed as zero trace.
- Execution profile: Lightweight, code. One server-side message-normalization unit (U1) plus a CHANGELOG entry (U2); no client or UI work.
- Stop conditions: a session containing finished background tasks shows no `<task-notification>` XML anywhere in the transcript when its persisted history loads; the Tasks panel still reflects task state; a normal user message that merely mentions the tag in prose is not suppressed; lint clean; server tests pass.
- Tail ownership: this plan ends at the Definition of Done. `ce-work` or `/goal` executes the units in dependency order.

---

## Product Contract

*Product Contract preservation: intent unchanged. One mechanism clarification — see KTD1. The persisted `SessionMessage` returned by `getSessionMessages` does not expose `origin` in its type (it is a live-envelope field on `SDKUserMessage`), so on the historical path the `<task-notification>` text wrapper is the operative detection signal and `origin` is a secondary check only. R3's "origin primary" applies where `origin` exists (the live envelope); the historical implementation relies on the text wrapper per R4.*

### Summary

Drop the `<task-notification>` XML the SDK injects as a synthetic user-role message so it never renders as a chat bubble. The notification is model-context noise; task state already lives in the Tasks panel. Detection rides on the message's text-wrapper shape, with the SDK's `origin` provenance as a secondary confirmation when present.

### Problem Frame

When a background task settles, the bundled CLI injects a `<task-notification>…</task-notification>` block as the text body of a synthetic user-role message — what the model sees, not something meant for the user. The app already handles the *structured* form of this event (a `system` message with `subtype: task_notification`, which feeds the Tasks panel and is dropped from the transcript). But this user-role text form reaches the message normalizer, which never inspects the message's provenance, so the XML passes through verbatim as a user text part and renders as a raw bubble whenever the client loads a session's persisted history. The live stream does not have this problem: its user-message handler processes only tool results and ignores text blocks, so the XML is never emitted as an SSE event and never enters the replay buffer. The leak is therefore confined to historical-message normalization. Other injected tags (`system-reminder`, `command-*`, `local-command-*`) are already intercepted by the existing CLI-meta path; `<task-notification>` is the one family that slipped through, and a dev-only canary already flags it as an unrecognized wrapper shape.

### Requirements

Suppression:

- R1. A `<task-notification>` notification must not appear in the chat transcript on any historical message-load render path — no raw bubble, no XML fragment.
- R2. Suppression is zero-trace: the transcript carries no marker, chip, or muted note in place of the notification. The Tasks panel is the sole surface for task state.

Detection:

- R3. Task-notification user messages are identified by the SDK's native provenance marker (`origin.kind === 'task-notification'`) as the primary signal where that field is present.
- R4. Messages lacking the provenance marker (the persisted `SessionMessage` shape, older CLI builds, replay without origin) are caught when their text body is wholly a `<task-notification>…</task-notification>` wrapper.

Non-regression:

- R5. Suppressing the user-role notification must not affect the structured task lifecycle that feeds the Tasks panel; `task_started`, `task_updated`, `task_progress`, and `task_notification` system messages continue to drive task state.

### Key Decisions

- **Hide entirely, not a muted note.** The app renders other injected tags (e.g. `system-reminder`) as a muted one-line note. For task notifications we suppress totally, because task state already has a dedicated home in the Tasks panel and the user explicitly preferred the cleanest transcript over an in-flow marker.
- **Semantic detection, not XML regex against arbitrary text.** Filtering rides on provenance where available and on the message being wholly a wrapper otherwise — never on a tag embedded in real prose (R4, AE3).
- **Fix the normalization chokepoint, not the live or replay path.** The leak lives in `normalizeSessionMessage`, invoked whenever the client loads persisted history. The live SSE user-message handler ignores text blocks, so the XML is never emitted and never reaches the replay buffer; only the normalization path ever rendered it. The fix lands once, at the normalizer.

### Scope Boundaries

- No card, chip, or foldable rendering of task notifications — rejected in favor of suppression.
- No parsing the notification XML for display — the structured task-lifecycle messages already carry status, summary, and usage to the Tasks panel.
- Other injected tags (`system-reminder`, `command-*`, `local-command-*`) are out of scope — already handled by the existing CLI-meta path; only `<task-notification>` leaks.
- The structured task lifecycle feeding the Tasks panel is unchanged.

### Acceptance Examples

- AE1. **Given** a persisted user-role message carrying the task-notification provenance marker, **when** the session history loads, **then** no bubble renders for it. **Covers R1, R3.**
- AE2. **Given** a persisted user-role message with no provenance marker, whose entire text body is a `<task-notification>` wrapper, **when** the session history loads, **then** no bubble renders for it. **Covers R1, R4.**
- AE3. **Given** a normal user-typed message whose prose mentions `<task-notification>` inline but is not wholly that wrapper, **when** the session history loads, **then** the message renders normally and is not suppressed. **Covers R4.**
- AE4. **Given** a session where background tasks have completed, **when** viewed, **then** the Tasks panel still shows each task's status and the suppression introduced no panel regressions. **Covers R5.**

### Dependencies / Assumptions

- The bundled CLI emits the `<task-notification>` XML as user-role text and stamps `origin.kind === 'task-notification'` on the live envelope (verified against the SDK binary and `sdk.d.ts`). Whether `origin` survives into the persisted `SessionMessage` is treated as optional; the text wrapper is the reliable fallback.
- The live SSE path's behavior — ignoring user-role text blocks — is assumed stable. If a future SDK change starts emitting these on the live path, the normalization-only fix would need extending; low risk.

### Sources / Research

- `src/server/services/message-normalizer.ts` — `normalizeSessionMessage` is the leak: it derives role from `sessionMessage.type` and never inspects provenance, so the user-role XML becomes a `text` part. `scanSdkMessagesForTasks` (same file) already consumes the structured `task_notification` subtype for the Tasks panel, independent of the leaking text.
- `src/server/services/chat-service.ts:706,749` — the two callers (`loadMessages`, `loadMessagesAfter`) both filter on the normalizer's return, so a `null` return drops the message on every history-load path.
- `src/server/services/sse-emitter.ts` — `handleUser` processes only `tool_result` blocks and ignores `text`, so the live stream never emits the XML and it never enters the replay buffer; the `system` `task_notification` subtype is handled separately (~line 195).
- `src/client/lib/cli-meta.ts` — existing tag-interception path (`detectCliMeta`) covers `system-reminder`, `command-*`, `local-command-*`; `<task-notification>` is not in the set. `canonicalUserText` + `isWrapperShape` is the conceptual precedent for "reduce user text, test wrapper shape" to mirror server-side. The dev canary in `src/client/components/MessageList.tsx` already warns "unrecognized wrapper shape" for exactly this input.
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` — `SDKMessageOrigin` union includes `kind: 'task-notification'` (≈ line 3935); `SDKUserMessage.origin` carries it (≈ line 4449); the persisted `SessionMessage` type (≈ line 4581) does not include `origin`; the structured `SDKTaskNotificationMessage` (≈ line 4324) is the separate system-message form already handled.
- Prior plans: `docs/plans/2026-05-16-008-feat-cli-meta-message-rendering-plan.md` (the CLI-meta machinery this falls outside of), `docs/plans/2026-05-19-005-feat-task-todo-panel-plan.md` and `2026-05-19-006-fix-task-panel-sdk-0-3-x-plan.md` (the Tasks panel fed by structured task subtypes).

---

## Planning Contract

### Key Technical Decisions

- **KTD1: Detection is text-wrapper-based on the historical path.** The persisted `SessionMessage` from `getSessionMessages` does not expose `origin` in its type — `origin` is a live-envelope field on `SDKUserMessage`. The CLI binary's own worker-result guidance is to "distinguish them by the `<task-notification>` opening tag." So the reliable signal on the historical path is the message body being wholly a `<task-notification>…</task-notification>` wrapper; an `origin?.kind === 'task-notification'` check is included as a secondary signal when the field happens to be present, but the fix must not depend on it. This reconciles R3 (origin, where it exists) with R4 (text wrapper, the historical fallback) without changing product intent.
- **KTD2: Suppress at `normalizeSessionMessage`, role-gated to `user`.** The check fires only for role `user` (the injected form's role), so assistant or system text mentioning the tag is never dropped. Returning `null` drops the message from both callers (`chat-service.ts:706,749`), which is the single chokepoint covering initial load and incremental history loads.
- **KTD3: Whole-wrapper match, not substring.** To honor AE3, suppression requires the message's reduced user text to be wholly the wrapper — trimmed, starts with `<task-notification` and ends with `</task-notification>` — never a tag embedded in real prose. Multi-block messages are reduced by joining their text blocks (mirroring the client's `canonicalUserText`); a wrapper plus any extra text is not suppressed.

### Assumptions

- `origin` may or may not survive into the persisted `SessionMessage`; the implementation treats it as optional. Execution-time confirmation (inspect one real record) is nice-to-have, not blocking — the text fallback covers all cases.
- The live SSE path continues to ignore user-role text blocks; no change is needed or wanted there. (Verified in research.)
- `scanSdkMessagesForTasks` reads system messages independently of the user-role suppression, so the Tasks panel is unaffected. (Verified — separate code path in the same file.)

### Sequencing

U1 (detection + tests) is the entirety of the behavior change; U2 (CHANGELOG) follows once U1 lands. No parallelizable split — the change is one function.

---

## Implementation Units

### U1. Suppress `<task-notification>` user messages in the normalizer

- **Goal:** Drop injected task-notification user-role messages from normalized history so they never render as chat bubbles.
- **Requirements:** R1, R2, R3, R4; R5 via non-regression.
- **Dependencies:** none.
- **Files:**
  - modify `src/server/services/message-normalizer.ts`
  - test `src/server/services/message-normalizer.test.ts`
- **Approach:** Add a task-notification detection check inside `normalizeSessionMessage`, role-gated to `user`, that returns `null` to drop the message. Reduce the message's text to a single trimmed string — handling `message.content` as either a bare string or an array of text blocks the way the surrounding code already reads content — and treat the message as a task-notification when (a) the untyped envelope carries `origin?.kind === 'task-notification'`, or (b) the reduced text is wholly a `<task-notification>…</task-notification>` wrapper (trimmed, starts with `<task-notification` and ends with `</task-notification>`). Place the check after role resolution and before parts are built so the dropped message short-circuits cleanly through the existing `null` path the callers already filter. Do not modify `scanSdkMessagesForTasks` — it reads system messages on a separate path and must keep feeding the Tasks panel.
- **Patterns to follow:** The file already reads untyped envelope fields via `Record<string, unknown>` casts (e.g. `toolUseResult`, `tool_use_meta`); follow that pattern for `origin`. Mirror the "reduce user text, test wrapper shape" logic from `src/client/lib/cli-meta.ts` (`canonicalUserText` + `isWrapperShape`) server-side rather than importing across the client/server boundary.
- **Execution note:** Extend the co-located `node:test` suite with characterization cases around the detection before finalizing the logic; the normalizer already has this coverage shape.
- **Test scenarios:**
  - Covers AE1. A user `SessionMessage` carrying `origin.kind === 'task-notification'` (cast onto the object) with a `<task-notification>` text body → `normalizeSessionMessage` returns `null`.
  - Covers AE2. A user `SessionMessage` with no `origin`, content a single text block wholly `<task-notification>…</task-notification>` → returns `null`.
  - Covers AE3. A user `SessionMessage` whose text mentions `<task-notification>` inline but is not wholly the wrapper (e.g. "see <task-notification> below") → returns a normal `ChatMessage`, not `null`.
  - Trim: wrapper text with leading/trailing blank lines or surrounding whitespace → still `null`.
  - Multi-block all-text: a content array of text blocks that join to the wrapper → `null`; a content array with the wrapper plus an extra non-wrapper text block → not suppressed.
  - String content: a user message whose `message.content` is a bare string `<task-notification>…</task-notification>` → `null`.
  - Role gating: an assistant or system message whose text is wholly the wrapper → not suppressed by this check (returns through the existing path).
  - Covers AE4 / R5 non-regression: over a mixed message list, a system `task_notification` message still contributes its status via `scanSdkMessagesForTasks` while a co-resident user-role `<task-notification>` message is dropped by `normalizeSessionMessage`.
- **Verification:** `npm run test:server` passes (includes `message-normalizer.test.ts`); `npm run lint` clean; manual smoke — load a session containing a finished background task and confirm no `<task-notification>` bubble renders and the Tasks panel still shows the task.

### U2. CHANGELOG entry

- **Goal:** Record the user-visible transcript change per repo convention.
- **Requirements:** process — CLAUDE.md "Update CHANGELOG.md for user-facing changes."
- **Dependencies:** U1.
- **Files:**
  - modify `CHANGELOG.md`
- **Approach:** Add a Keep a Changelog entry under Fixed: injected `<task-notification>` XML no longer appears in the chat transcript; task state remains available in the Tasks panel.
- **Test expectation:** none — documentation change.
- **Verification:** entry present and matches the existing CHANGELOG format.

---

## Verification Contract

- `npm run test:server` — runs the `node:test` suite (excludes `src/server/vendor/`), including `src/server/services/message-normalizer.test.ts`. Primary proof for U1.
- `npm run lint` — ESLint over `.ts`/`.tsx`; must be clean per CLAUDE.md.
- Manual smoke — open a workspace session that contains a completed background task; confirm (a) no `<task-notification>` bubble in the transcript, (b) the Tasks panel still lists the task with the correct status, (c) a user message that references the tag in prose still renders.
- No client test changes are required: there is no client code change. The dev canary in `src/client/components/MessageList.tsx` should cease firing for this wrapper shape once the server stops emitting the message.

---

## Definition of Done

- Global: `<task-notification>` user messages are dropped on both history-load paths (`loadMessages`, `loadMessagesAfter`); the structured task lifecycle still feeds the Tasks panel; other user messages — including ones that mention the tag in prose — render unchanged; `npm run lint` clean; `npm run test:server` passes; CHANGELOG updated.
- U1: detection covers the origin-present, text-wrapper-only, bare-string-content, and multi-block-all-text cases; AE1–AE4 satisfied; role-gated so non-user messages are untouched; `scanSdkMessagesForTasks` behavior unchanged.
- U2: CHANGELOG entry added under Fixed in the existing format.
- Cleanup: no dead-end or experimental code left in the diff.
