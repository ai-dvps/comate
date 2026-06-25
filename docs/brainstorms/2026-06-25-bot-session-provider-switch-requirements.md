---
date: 2026-06-25
topic: bot-session-provider-switch
---

# Bot Session Provider Display and Switching

## Summary

Show each bot session's active provider in its input toolbar and let the operator switch it via the same provider picker the interactive chat uses, so a bot session stuck on a failing provider can be rerouted in place. It reuses the existing switch-restart machinery and applies to both WeCom and Feishu bot sessions.

---

## Problem Frame

Bot sessions (WeCom and Feishu) are driven by inbound end-user messages and today run silently on the global default provider, with no way to see or change it. The provider selector that interactive sessions use is explicitly hidden for bot sessions. When a bot session's provider fails — quota exhausted, rate-limited, endpoint error — the operator has no in-app lever: they cannot tell which provider the session is on, and cannot reroute it without editing configuration or restarting. The end-user stays stuck until the provider recovers on its own. The remedy is to surface the provider on bot sessions and let the operator switch it in place, reusing the runtime-restart machinery that already works for interactive sessions.

---

## Actors

- A1. Operator — the person running the Comate desktop app who monitors bot sessions and switches a failing session's provider.
- A2. Bot end-user — the WeCom or Feishu user whose inbound messages drive the session; their next message after a switch runs on the new provider.
- A3. System — persists the provider change, closes and rebuilds the runtime, and enforces the streaming and restart guards.

---

## Key Decisions

- **Reuse the existing switch machinery over new bot-specific logic.** The server already restarts a session's runtime when its provider changes, regardless of session source. Unhiding the existing selector for bot sessions makes the feature work end-to-end with no new backend work; the restart path has no source guard.
- **Manual switching over automatic fallback.** Recovery is operator-initiated. No failure-detection logic, fallback ordering, or retry policy — the operator notices the failure via the session's existing transcript error notes and acts.
- **In-session picker over an at-a-glance list view.** The selector lives in the open bot session's input toolbar. There is no sidebar "which bot is on which provider" scan; the operator opens a session to see and switch its provider. Accepted as the recovery workflow.
- **All bot sources, not WeCom alone.** Both WeCom and Feishu bot sessions get display and switching, since both are bot sessions with the same hidden-selector gap.
- **Provider selector only, not the approval-mode toggle.** The selector shares its hide-condition with the approval-mode toggle; unhiding applies to the selector only. Approval modes for bots remain governed by the existing tool-permission policy.

---

## Requirements

**Display**

- R1. A bot session shows its currently active provider — its own `providerId`, or the global default when none is set — in the session's input toolbar, and updates live when switched.
- R2. Display and switching apply to both WeCom (`wecom`) and Feishu (`feishu`) bot sessions.

**Switching**

- R3. The operator can open the provider selector on a bot session and choose a different provider.
- R4. Switching persists the new provider to the session and closes any active runtime, so the next inbound bot message rebuilds the runtime with the new provider. The operator does not send a message themselves; recovery takes effect on the end-user's next message.
- R5. The provider selector stays interactive on a bot session even though its message input is read-only.

**Guards**

- R6. Switching is blocked while the bot session's runtime is streaming or restarting, matching the interactive-session guard.

---

## Key Flows

- F1. Operator recovers a failing bot session
  - **Trigger:** A bot session is failing on its current provider (errors, quota, or rate-limit) and the operator wants to reroute it.
  - **Actors:** A1, A3
  - **Steps:** The operator opens the bot session, sees the active provider in the input toolbar, opens the selector, and chooses a working provider. The system persists the change and closes the existing runtime. The next inbound message from the bot end-user rebuilds the runtime with the new provider.
  - **Outcome:** The bot session's subsequent conversation runs on the new provider.
  - **Covered by:** R1, R3, R4

- F2. Switch blocked mid-stream
  - **Trigger:** The operator tries to switch a bot session whose runtime is streaming a response.
  - **Actors:** A1, A3
  - **Steps:** The selector is disabled for the duration of streaming; no provider change can occur until streaming stops.
  - **Outcome:** The in-flight response completes on the original provider.
  - **Covered by:** R6

---

## Acceptance Examples

- AE1. **Covers R1, R3, R4.** Given a bot session using the global default provider that is failing, when the operator opens it and selects Provider B from the input-toolbar selector, the session is bound to Provider B and the next inbound message is processed by a fresh runtime using Provider B.
- AE2. **Covers R6.** Given a bot session whose runtime is streaming a response, when the operator opens the provider selector, it is disabled and no switch can occur until the stream completes.
- AE3. **Covers R5.** Given a bot session whose message input is read-only, when the operator opens it, the provider selector in the input toolbar is interactive and can be opened and used despite the input being disabled.
- AE4. **Covers R2.** Given a Feishu bot session, when the operator opens it, the provider selector is present and functional, identical to a WeCom bot session.

---

## Success Criteria

- An operator can reroute a failing bot session to a working provider without leaving the session or editing configuration, and the end-user's next message runs on the new provider.
- WeCom and Feishu bot sessions show and switch providers identically to each other.
- The change introduces no new backend switching logic — it reuses the existing restart machinery.

---

## Scope Boundaries

- Automatic provider fallback on failure (detection, fallback order, retry policy).
- An at-a-glance provider chip on the session list item.
- A dedicated session-header bar for provider display.
- A "provider failed" indicator or proactive failure alert; recovery relies on the operator viewing the session's existing error notes.
- Per-bot or per-WeCom-user provider defaults or routing configuration.
- Surfacing the approval-mode toggle for bot sessions.

---

## Dependencies / Assumptions

- The server restarts a session's runtime on provider change with no source guard, so bot sessions get the restart for free. Verified in `src/server/services/chat-service.ts` (the provider-change branches in `updateSession`).
- The provider selector's disabled state depends only on streaming and restart state, not on the parent input's disabled state or session source, so it remains interactive on a bot session. Verified.
- The bot session's streaming and restart state is tracked client-side the same way as interactive sessions, so the existing selector guard and spinner behave correctly. Assumed — needs confirmation during planning.
- Recovery depends on the operator noticing failures via existing transcript error notes; no new failure signal is introduced.

---

## Outstanding Questions

### Resolve Before Planning

*(None — all product decisions are resolved.)*

### Deferred to Planning

- [Affects R5] Visual treatment of the provider selector inside an otherwise read-only (disabled) input toolbar — should the surrounding input visually de-emphasize while the selector stays active?
- [Affects R4, R6] Confirm the bot session's client-side streaming and restart state is set identically to interactive sessions, so the selector guard and restart spinner behave correctly.

---

## Sources / Research

- Selector hide-condition (the gate to change): `src/client/components/PromptInput.tsx` — the `!isBotSession` guard wrapping `ProviderSelector` and the approval-mode toggle.
- Provider selector component: `src/client/components/ProviderSelector.tsx`; client store action `setSessionProvider` in `src/client/stores/chat-store.ts`.
- Server-side runtime restart on provider change (session-type-agnostic): `src/server/services/chat-service.ts`, provider-change branches in `updateSession`.
- Session update route accepting `providerId` regardless of source: `src/server/routes/chat.ts`.
- `isBotSession` covers `wecom` and `feishu`: `src/client/lib/session-filter.ts`.
- Related prior brainstorms: `docs/brainstorms/2026-05-30-llm-provider-management-requirements.md`, `docs/brainstorms/2026-05-31-provider-switch-restart-requirements.md`.
