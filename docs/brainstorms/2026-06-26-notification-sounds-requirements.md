---
date: 2026-06-26
topic: notification-sounds
---

# Notification Sounds for Pending Requests and Task Completion

## Summary

Play a short notification sound when Claude needs the user (a tool approval or `AskUserQuestion`) and when Claude finishes a turn and goes idle. Two sound flavors — a "needs attention" tone and a gentler "completion" chime — let the user tell by ear what happened, all behind a single master on/off toggle in Settings.

## Problem Frame

When Claude runs a long task, the user often switches to another window. The only "needs attention" signal today is the macOS dock badge (or Windows taskbar flash) driven by the pending-request count; there is no audio. As a result the user misses the moment Claude is blocked on an approval, is waiting on a question, or has simply finished and gone idle — and Claude stalls until the user happens to look back. A sound closes that gap.

## Key Decisions

- **Always-play, no focus suppression.** Sounds fire regardless of whether the app window or the triggering session is in focus; the master toggle is the only mute path. Chosen for simplicity over a focus-aware model.
- **Client-side playback.** The client plays sounds in response to SSE events it already receives; no new server transport or event type is required.
- **Two sound flavors.** A "needs attention" tone for approvals/questions and a gentler "completion" chime for finished turns, so the user can distinguish them by ear without looking. No per-event configuration.
- **Completion sound is duration-guarded and error-aware.** Only turns longer than ~3s that end without error chime; short turns and errored turns stay silent. Needs-attention sounds are never duration-gated.
- **Enabled by default.** The feature ships on so its value is realized immediately; users who want quiet flip the master toggle.

## Requirements

**Trigger events**

- R1. The client SHALL play the "needs attention" sound when a `pending_approval` or `pending_question` SSE event arrives.
- R2. The client SHALL play the "completion" sound when a turn ends and Claude returns to idle, but only when the turn completed without error.

**Playback control**

- R3. A single global master toggle SHALL enable or disable all notification sounds, exposed in Settings → General alongside the other app-level toggles.
- R4. When the master toggle is off, no notification sounds SHALL play.
- R5. Notification sounds SHALL be enabled by default.

**Sound differentiation**

- R6. Two distinct sounds SHALL exist: a "needs attention" sound for approvals/questions and a "completion" sound for finished turns. The two SHALL be audibly distinguishable.

**Anti-bombardment**

- R7. The completion sound SHALL play only when the turn's active duration exceeds a minimum threshold (~3 seconds, tunable), so rapid back-and-forth turns stay silent.
- R8. Sound triggers arriving in rapid succession SHALL be coalesced within a short debounce window so multiple back-to-back events do not stack into a burst.

## Acceptance Examples

Behavior here is a single conditional reaction to an event, so conditional examples cover the paths rather than multi-step flows.

- AE1. **Toggle off.** Given the master toggle is off, when a `pending_approval` arrives, no sound plays.
- AE2. **Needs attention on approval.** Given sounds are enabled, when a `pending_approval` arrives, the "needs attention" sound plays.
- AE3. **Needs attention on question.** Given sounds are enabled, when a `pending_question` arrives, the "needs attention" sound plays.
- AE4. **Long turn completes.** Given sounds are enabled and a turn streamed for ~10s, when the terminal `result` event arrives without error, the "completion" sound plays.
- AE5. **Short turn stays silent.** Given sounds are enabled and a turn streamed for ~1s, when the `result` event arrives, no completion sound plays (below the duration threshold).
- AE6. **Errored turn.** Given sounds are enabled, when the `result` event arrives with `isError`, no completion sound plays.
- AE7. **Rapid succession coalesced.** Given sounds are enabled, when three `pending_approval` events arrive within the debounce window, only one "needs attention" sound plays.

## Success Criteria

- Each sound is short (under ~1s), pleasant, and non-startling at a normal system volume.
- The two flavors are distinguishable by ear without seeing the screen.
- Ordinary rapid back-and-forth never produces a sound burst.

## Scope Boundaries

- **Deferred for later:** OS-level toast/desktop notifications (separate from sound; no notification plugin exists today), per-event volume control or a volume slider, and user-selectable or custom sound files (ship two defaults instead).
- **Outside this product's identity:** a distinct sound for errors or abnormal stops, and per-workspace sound settings (global only).

## Dependencies / Assumptions

- The Tauri system webview supports audio playback (Web Audio API or `HTMLAudioElement`); no native audio plugin is required.
- Sound logic is client-side, reacting to SSE events the client already receives.

## Outstanding Questions

- Exact min-duration threshold and debounce window values (~3s and ~1s proposed) — deferred to planning and tuning.

## Sources / Research

- `src/client/stores/chat-store.ts:1358` (`pending_approval`) and `:1396` (`pending_question`) — client SSE handlers; hook points for the needs-attention sound.
- `src/client/stores/chat-store.ts:1582` (`result`) — terminal event where `isStreaming[sessionId]` flips to false marking Claude idle; hook point for the completion sound.
- `src/client/hooks/use-app-settings.ts` and `src/client/components/SettingsPanel.tsx` (General tab) — global boolean-toggle pattern for the master switch.
- No audio/sound code or audio asset files exist in `src/` or `src-tauri/src/`; the capability is built from scratch.
