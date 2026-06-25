---
title: "feat: Show and switch LLM provider on bot sessions"
type: feat
date: 2026-06-25
origin: docs/brainstorms/2026-06-25-bot-session-provider-switch-requirements.md
---

# Show and switch LLM provider on bot sessions

## Summary

Render the existing `ProviderSelector` inside the bot-session view so an operator can see a bot session's active provider and switch it in place to recover from a failing provider. Reuses the existing switch-restart machinery with no backend work; applies to both WeCom and Feishu bot sessions.

---

## Problem Frame

Bot sessions run silently on the global default provider with no way to see or change it — the provider selector is rendered only in the non-bot toolbar row, which the bot-session layout never mounts. When a bot session's provider fails (quota, rate-limit, endpoint error), the operator has no in-app lever and the end-user stays stuck until the provider recovers. See origin for the full problem frame.

---

## Requirements

Carried from the origin requirements doc.

**Display**

- R1. A bot session shows its active provider — its own `providerId`, or the global default when none is set — and updates live when switched.
- R2. Display and switching apply to both WeCom (`wecom`) and Feishu (`feishu`) bot sessions.

**Switching**

- R3. The operator can open the provider selector on a bot session and choose a different provider.
- R4. Switching persists the new provider to the session and closes any active runtime, so the next inbound bot message rebuilds the runtime with the new provider. (Server-side; already implemented and session-type-agnostic — no new backend work.)
- R5. The provider selector stays interactive on a bot session even though its message input is read-only.

**Guards**

- R6. Switching is blocked while the bot session's runtime is streaming or restarting.

---

## Key Technical Decisions

- **Place the selector inside the bot-session branch, not by removing a gate.** `PromptInput` has two branches in one ternary: the bot branch (`src/client/components/PromptInput.tsx:797-840`, a header row with bot name/user on the left and a refresh button on the right) and the non-bot branch (the input box with the toolbar row containing the existing selector at `:924-929`). The selector never renders for bot sessions because the whole non-bot branch is skipped. The fix is to mount the selector in the bot branch's right-side control cluster (`:822`), beside the refresh button. Dropping `!isBotSession` from the existing condition alone would not surface it to bot sessions.
- **Reuse `ProviderSelector`, plus a small responsive tweak.** It is self-contained — it selects its own session, providers, and `isRestartingRuntime` flag from the stores (`src/client/components/ProviderSelector.tsx:29-46`). The only wiring needed is `workspaceId`, `sessionId`, and `disabled`. Add a narrow-width rule: hide the selector's name span below the `sm` breakpoint (avatar + chevron only), mirroring the row's existing `hidden sm:block` refresh-status text. Implement as a responsive class inside `ProviderSelector` or a compact prop on the bot branch — the behavior is fixed, the mechanism is the implementer's choice.
- **Keep the selector's `disabled` on `isStreaming || isRestarting`, not on the bot-session `disabled` prop.** This keeps it interactive despite the read-only input (R5) while still blocking during streaming or restart (R6). The bot branch already has interactive controls (the refresh button), so an active selector fits the row.
- **Keep the selector visually prominent in the bot header.** Its default accent styling (`bg-accent/10`, `text-accent`) is intentional: provider status is the operator's primary in-session signal for recovery, so the selector reads as the most prominent control on the header row while the refresh button stays subordinate. No muted variant for the bot branch.
- **Do not surface `ApprovalModeToggle` for bot sessions.** Bot approval is governed externally by the tool-permission policy and isolation settings; the operator must not relax it. This matches the origin scope boundary.
- **No i18n changes.** The existing `provider.*` keys (`src/client/i18n/en/chat.json`, `src/client/i18n/zh-CN/chat.json`) are session-generic ("Select LLM provider for this session"); reuse needs no new strings.

---

## Acceptance Examples

Carried from the origin.

- AE1. **Covers R1, R3, R4.** A bot session failing on the default provider: operator selects Provider B; the session binds to B and the next inbound message runs on a fresh runtime using B.
- AE2. **Covers R6.** A bot session whose runtime is streaming: the selector is disabled until the stream completes.
- AE3. **Covers R5.** A bot session with a read-only input: the selector in the header row is interactive and usable.
- AE4. **Covers R2.** A Feishu bot session shows and switches providers identically to a WeCom bot session.

---

## Implementation Units

### U1. Mount provider selector in the bot-session branch

- **Goal:** Show the active provider on a bot session and let the operator switch it, by mounting the existing `ProviderSelector` in the bot-session header row.
- **Requirements:** R1, R2, R3, R5, R6 (R4 is server-side and already satisfied).
- **Dependencies:** None — the runtime-restart-on-provider-change path and `setSessionProvider` already work for bot sessions (verified, see Sources).
- **Files:**
  - `src/client/components/PromptInput.tsx` — modify
  - `src/client/components/PromptInput.browser.test.tsx` — modify (extend existing bot-session tests)
  - `CHANGELOG.md` — add entry (user-facing)
- **Approach:** In the `isBotSession` branch, add `<ProviderSelector workspaceId={workspaceId} sessionId={sessionId} disabled={isStreaming || isRestarting} />` into the right-side control cluster at `PromptInput.tsx:822`, beside the refresh button. `workspaceId`, `sessionId`, `isStreaming`, and `isRestarting` are all already in scope in `PromptInput`. Do not add `ApprovalModeToggle`. Leave the non-bot branch's selector mount untouched. Hide the selector's name span below the `sm` breakpoint (avatar + chevron only) so the right cluster stays compact at narrow widths, mirroring the refresh-status text's `hidden sm:block`.
- **Patterns to follow:** The non-bot branch's `ProviderSelector` mount at `PromptInput.tsx:924-929` (identical props); the bot branch's existing refresh-button control cluster for placement and styling.
- **Test scenarios:** Mirror the existing bot-session tests at `PromptInput.browser.test.tsx:147-179`, which today assert only the absence of a textbox.
  - **Happy path (Covers AE4):** Render a WeCom bot session (`isBotSession`, `source: 'wecom'`) and a Feishu bot session; assert the provider selector is present in both.
  - **Interactivity (Covers AE3, R5):** Render a bot session that is not streaming or restarting; assert the selector is interactive (not disabled) despite the read-only input.
  - **Streaming guard (Covers AE2, R6):** Render a bot session with `isStreaming` true, then with `isRestarting` true; assert the selector is disabled in both cases.
  - **Switch behavior (Covers AE1, R3):** Selecting a provider on a bot session calls `setSessionProvider` with the session id and chosen provider id.
  - **Negative / scope boundary:** Assert `ApprovalModeToggle` is still absent for bot sessions.
  - **Regression:** Assert the selector still renders and behaves unchanged in a non-bot (interactive) session.
  - Test-mechanic note: the existing suite stubs `ProviderSelector` as `<div data-testid="provider-selector" />` and `ApprovalModeToggle` similarly, and the chat-store mock omits `sessions`/`setSessionProvider`. The presence/absence and disabled assertions can use the stub + testid approach. The switch-behavior and interactivity assertions need the real `ProviderSelector` plus a `provider-store` mock (it selects `providers`, the default provider, and `fetchProviders`) and the chat-store mock extended with `sessions` and `setSessionProvider`; pick the level per scenario.
- **Verification:** `npm run lint` passes; the extended browser tests pass; manually open a WeCom and a Feishu bot session and confirm the selector appears beside the refresh button, switches the provider, and the next inbound message runs on the new provider.

---

## Scope Boundaries

Carried from the origin; the approval-mode toggle exclusion is reinforced by the tool-permission policy rationale.

- Automatic provider fallback on failure (detection, fallback order, retry policy).
- An at-a-glance provider chip on the session list item.
- A dedicated session-header bar for provider display.
- A "provider failed" indicator or proactive failure alert.
- Per-bot or per-WeCom-user provider defaults or routing configuration.
- Surfacing the approval-mode toggle for bot sessions.

### Deferred to Follow-Up Work

- If a bot-session-specific restart or state quirk surfaces during implementation, capture it under `docs/solutions/` — the knowledge base currently has no entry for provider switching or bot-session UI state (learnings search came back empty).

---

## Risks & Dependencies

- **Load-bearing assumption (low risk):** the bot-session branch must propagate `isStreaming` and `isRestarting` to the selector the same way the non-bot branch does. Structurally confirmed — both are in scope in `PromptInput` and the selector reads `isRestartingRuntime` from the store itself — and enforced by the streaming-guard test scenario. Note: `isRestartingRuntime` clears via the session's SSE subscription (`src/client/stores/chat-store.ts`), so the restarting spinner presumes the bot session is the currently-subscribed session — identical to the non-bot path, not a new constraint.
- **Dependency:** reuses the existing runtime-restart-on-provider-change path (`src/server/services/chat-service.ts`, session-type-agnostic) and `setSessionProvider` (`src/client/stores/chat-store.ts`); no changes to either.

---

## Sources / Research

- Selector mount and the bot/non-bot ternary: `src/client/components/PromptInput.tsx:797-840` (bot branch), `:822` (target control cluster), `:924-929` (non-bot selector mount to mirror).
- `ProviderSelector` is self-contained: `src/client/components/ProviderSelector.tsx:29-46` (selects own session, providers, restart flag).
- Server-side restart on provider change, no source guard: `src/server/services/chat-service.ts:219-226` and `:251-259`.
- Session update route accepts `providerId` regardless of source: `src/server/routes/chat.ts:59-96`.
- `isBotSession` covers `wecom` and `feishu`: `src/client/lib/session-filter.ts`.
- Test file to mirror: `src/client/components/PromptInput.browser.test.tsx` (existing bot-session tests at `:147-179`; chat-store hoisted mock at `:21-73`; selector/toggle stubs at `:112-118`).
- i18n keys reused as-is: `src/client/i18n/en/chat.json` and `src/client/i18n/zh-CN/chat.json`, `provider.*` block.
