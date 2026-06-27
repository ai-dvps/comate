---
date: 2026-06-26
topic: notification-sounds
---

# Notification Sounds for Pending Requests and Task Completion

## Summary

Play a short notification sound when Claude needs the user (a tool approval or `AskUserQuestion`) and when Claude finishes a turn and goes idle. A master on/off toggle in Settings → General controls whether sounds play at all, and a master volume slider (0-100%) controls how loud they are. Two sound flavors — a "needs attention" tone and a gentler "completion" chime — let the user tell by ear what happened.

## Problem Frame

When Claude runs a long task, the user often switches to another window. The only "needs attention" signal today is the macOS dock badge (or Windows taskbar flash) driven by the pending-request count; there is no audio. As a result the user misses the moment Claude is blocked on an approval, is waiting on a question, or has simply finished and gone idle — and Claude stalls until the user happens to look back. A sound closes that gap.

Once sounds exist, a fixed playback volume creates a second problem: at normal system volume the chime may be too loud for quiet environments or too quiet to hear over other audio. A user-controllable volume slider fixes this without forcing the user to mute the feature entirely.

## Key Decisions

- **Keep the master toggle and add a volume slider.** The toggle provides a clear, one-click mute; the slider provides fine-grained loudness control. Both controls live in Settings → General.
- **Single master volume applies to both sounds.** Both the "needs attention" and "completion" sounds use the same volume level. This keeps the control surface small and avoids a settings panel that feels like an audio mixer.
- **Volume slider is disabled when the master toggle is off.** When sounds are disabled, the volume control is grayed out and non-interactive to make the dependency obvious.
- **Default volume is 100%.** Existing users who already have sounds enabled hear the same loudness as before; the new control is strictly additive.
- **Volume persists with app settings.** The volume value is stored alongside `notificationSoundsEnabled` and other app-level preferences.

## Requirements

**Trigger events**

- R1. The client SHALL play the "needs attention" sound when a `pending_approval` or `pending_question` SSE event arrives.
- R2. The client SHALL play the "completion" sound when a turn ends and Claude returns to idle, but only when the turn completed without error.

**Playback control**

- R3. A single global master toggle SHALL enable or disable all notification sounds, exposed in Settings → General alongside the other app-level toggles.
- R4. When the master toggle is off, no notification sounds SHALL play.
- R5. Notification sounds SHALL be enabled by default.
- R6. A volume slider in Settings → General SHALL control the playback volume of all notification sounds, with a continuous range from 0% to 100%.
- R7. The volume slider SHALL apply to both the "needs attention" and "completion" sounds.
- R8. The volume slider SHALL be visually disabled and non-interactive when the master toggle is off.
- R9. Notification sound volume SHALL default to 100%.
- R10. The volume setting SHALL persist across app restarts alongside other app settings.

**Sound differentiation**

- R11. Two distinct sounds SHALL exist: a "needs attention" sound for approvals/questions and a "completion" sound for finished turns. The two SHALL be audibly distinguishable.

**Anti-bombardment**

- R12. The completion sound SHALL play only when the turn's active duration exceeded a minimum threshold (~3 seconds, tunable), so rapid back-and-forth turns stay silent.
- R13. Sound triggers arriving in rapid succession SHALL be coalesced within a short debounce window so multiple back-to-back events do not stack into a burst.

## Acceptance Examples

- AE1. **Toggle off.** Given the master toggle is off, when a `pending_approval` arrives, no sound plays.
- AE2. **Needs attention on approval.** Given sounds are enabled, when a `pending_approval` arrives, the "needs attention" sound plays.
- AE3. **Needs attention on question.** Given sounds are enabled, when a `pending_question` arrives, the "needs attention" sound plays.
- AE4. **Long turn completes.** Given sounds are enabled and a turn streamed for ~10s, when the terminal `result` event arrives without error, the "completion" sound plays.
- AE5. **Short turn stays silent.** Given sounds are enabled and a turn streamed for ~1s, when the `result` event arrives, no completion sound plays (below the duration threshold).
- AE6. **Errored turn.** Given sounds are enabled, when the `result` event arrives with `isError`, no completion sound plays.
- AE7. **Rapid succession coalesced.** Given sounds are enabled, when three `pending_approval` events arrive within the debounce window, only one "needs attention" sound plays.
- AE8. **Reduced volume.** Given sounds are enabled and the volume slider is set to 50%, when a notification sound plays, it plays at half amplitude.
- AE9. **Zero volume.** Given sounds are enabled and the volume slider is set to 0%, when a notification sound would play, no audible sound is produced.
- AE10. **Slider disabled with toggle off.** Given the master toggle is off, the volume slider is grayed out and cannot be moved.

## Success Criteria

- Each sound is short (under ~1s), pleasant, and non-startling at a normal system volume.
- The two flavors are distinguishable by ear without seeing the screen.
- Ordinary rapid back-and-forth never produces a sound burst.
- Volume changes take effect immediately for the next sound and are persisted across restarts.

## Scope Boundaries

- **Deferred for later:** per-event volume control (separate volumes for attention vs completion sounds), per-workspace sound settings, user-selectable or custom sound files, and OS-level toast/desktop notifications.
- **Outside this product's identity:** a distinct sound for errors or abnormal stops.

## Dependencies / Assumptions

- The Tauri system webview supports audio playback (Web Audio API or `HTMLAudioElement`); no native audio plugin is required.
- Sound logic is client-side, reacting to SSE events the client already receives.
- The existing app-settings storage mechanism is available for the new volume field.

## Outstanding Questions

- Exact min-duration threshold and debounce window values (~3s and ~1s proposed) — deferred to planning and tuning.
- Exact slider step size and whether the current value is shown as a percentage label — deferred to planning and UI tuning.

## Sources / Research

- `src/client/stores/chat-store.ts:1358` (`pending_approval`) and `:1396` (`pending_question`) — client SSE handlers; hook points for the needs-attention sound.
- `src/client/stores/chat-store.ts:1582` (`result`) — terminal event where `isStreaming[sessionId]` flips to false marking Claude idle; hook point for the completion sound.
- `src/client/hooks/use-app-settings.ts` and `src/client/components/SettingsPanel.tsx` (General tab) — global boolean-toggle pattern and `localStorage` persistence for app-level settings.
- `src/client/lib/sound-player.ts` — client-side sound playback using `HTMLAudioElement`; the place to apply a volume multiplier.
- `src/client/lib/use-notification-sounds.ts` — hook that decides when to call the player and consults the master toggle.
