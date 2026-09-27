---
title: "feat: Notification sound volume slider"
type: feat
date: 2026-06-27
origin: docs/brainstorms/2026-06-26-notification-sounds-requirements.md
---

# Notification Sound Volume Slider

## Summary

Add a master volume slider (0-100%) in Settings → General next to the existing notification-sounds toggle. The slider controls the playback loudness of both the "needs attention" and "completion" sounds, persists with other app settings, and is disabled when the master toggle is off.

## Problem Frame

Notification sounds are now enabled by default, but their fixed playback volume can be too loud in quiet environments or too quiet to hear over other audio. Users currently have only a binary on/off control. A volume slider lets them keep the feature enabled at a comfortable level.

## Requirements

- R6. A volume slider in Settings → General controls the playback volume of all notification sounds, with a continuous range from 0% to 100%.
- R7. The volume slider applies to both the "needs attention" and "completion" sounds.
- R8. The volume slider is visually disabled and non-interactive when the master toggle is off.
- R9. Notification sound volume defaults to 100%.
- R10. The volume setting persists across app restarts alongside other app settings.

## Key Technical Decisions

- **KTD1 — Pass volume into `playSound` as a 0-100 parameter.** The sound player stays stateless; the hook reads the volume from app settings and passes the raw 0-100 value to `playSound`, which converts it to the `HTMLAudioElement` 0-1 scale before playback. This avoids mutable shared state in the player and keeps the unlock/gesture logic unchanged.
- **KTD2 — Store volume as an integer 0-100 in app settings.** The UI slider works in percentages, which matches user expectations and keeps localStorage values readable. Conversion to the audio API scale happens at playback.
- **KTD3 — Disable the slider with the master toggle off, do not hide it.** Graying out the control makes the dependency visible and preserves layout stability; hiding it would make the settings panel jump when the toggle flips.

## Implementation Units

### U1. Extend app settings with notification sound volume

- **Goal:** Add `notificationSoundsVolume` to the app settings interface, loader, default, setter, and hook return value.
- **Requirements:** R9, R10.
- **Dependencies:** none.
- **Files:** `src/client/hooks/use-app-settings.ts`; test file if one exists or is created.
- **Approach:** Mirror the existing `notificationSoundsEnabled` field end-to-end. Add the field to the `AppSettings` interface with default `100`, validate it as a number in `getInitialSettings()` (falling back to `100` for missing or invalid values), persist via `saveSettings()`, and expose `notificationSoundsVolume` plus `setNotificationSoundsVolume` from `useAppSettings`.
- **Patterns to follow:** the `notificationSoundsEnabled` / `autoCheckUpdates` boolean pattern in the same file.
- **Test scenarios:**
  - Happy path: a stored valid volume (e.g. `50`) loads and is returned.
  - Edge: a missing or invalid stored value defaults to `100`.
  - Edge: setting the volume updates the returned state and writes to localStorage.
- **Verification:** `useAppSettings()` returns `100` by default and round-trips custom values through localStorage.

### U2. Apply volume in the sound player

- **Goal:** Make `playSound` accept a volume level and apply it to the audio element before playback.
- **Requirements:** R6, R7.
- **Dependencies:** none.
- **Files:** `src/client/lib/sound-player.ts`; `src/client/lib/sound-player.test.ts`.
- **Approach:** Change `playSound(kind: SoundKind)` to `playSound(kind: SoundKind, volume: number)` where `volume` is 0-100. Clamp or sanitize the value, divide by 100, set `el.volume` on the selected `HTMLAudioElement`, reset `currentTime`, and call `play()`. Keep the autoplay-unlock behavior unchanged; the unlock path remains a muted priming play and does not need a volume argument.
- **Patterns to follow:** the existing `playSound` implementation and test seam (`__unlockSoundPlayer`, `__resetSoundPlayer`, mocked `Audio`). Extend the test's `MockAudio` class with a `volume` property so the new assertions can read what `playSound` set.
- **Test scenarios:**
  - Happy path: `playSound('attention', 50)` sets the mocked element's volume to `0.5` and calls play.
  - Covers AE9: `playSound('attention', 0)` sets volume to `0` and still calls play (the audio is inaudible).
  - Edge: a volume above 100 clamps to 1.0; below 0 clamps to 0.0.
  - Edge: the unlock sequence does not throw when no volume is supplied (it uses `muted`, not `volume`).
- **Verification:** the sound-player unit tests pass and the player still unlocks correctly.

### U3. Wire volume through `useNotificationSounds`

- **Goal:** Read the new volume setting and pass it to every `playSound` call.
- **Requirements:** R6, R7.
- **Dependencies:** U1, U2.
- **Files:** `src/client/lib/use-notification-sounds.ts`; `src/client/lib/use-notification-sounds.test.ts`.
- **Approach:** Select `notificationSoundsVolume` from `useAppSettings()` alongside `notificationSoundsEnabled`. Pass the volume to both `playSound('attention', volume)` and `playSound('completion', volume)`. Continue to short-circuit when the toggle is off.
- **Patterns to follow:** the existing toggle-guard pattern in the same hook; the mocked `playSound` in the test file. Update the mock to accept the second `volume` argument.
- **Test scenarios:**
  - Happy path: with sounds enabled and volume at `50`, a pending request plays attention with volume `50`.
  - Edge: with sounds enabled and volume at `0`, a pending request still calls playSound but with volume `0`.
  - Regression: with sounds disabled, no playSound calls occur regardless of volume.
- **Verification:** hook tests cover the volume argument and the toggle-off guard remains intact.

### U4. Add volume slider UI in Settings → General

- **Goal:** Render a 0-100% slider next to the notification-sounds toggle, disabled when the toggle is off, and persist changes immediately.
- **Requirements:** R6, R8.
- **Dependencies:** U1.
- **Files:** `src/client/components/SettingsPanel.tsx`; `src/client/components/SettingsPanel.test.tsx`; `src/client/i18n/en/settings.json`; `src/client/i18n/zh-CN/settings.json`.
- **Approach:** Add `notificationSoundsVolume` and `onNotificationSoundsVolumeChange` props to `GeneralTab`. In the settings panel container, read the value and setter from `useAppSettings()` and pass them down. Render a slider below the existing toggle row using the project's existing form primitives (a native range input or a Radix slider if available). Disable it when `notificationSounds` is false. Add `general.notificationSoundsVolume` label and `general.notificationSoundsVolumeHint` to both locale files, following the existing `notificationSounds` / `notificationSoundsHint` convention. Update `GeneralTab` test props — including the `defaultProps` object in `SettingsPanel.test.tsx` — to include the new fields.
- **Patterns to follow:** the existing `notificationSounds` toggle placement and prop plumbing in `SettingsPanel.tsx`; the `general.*` + `*Hint` i18n convention.
- **Test scenarios:**
  - Happy path: the slider reflects the current volume and moving it calls the change handler.
  - Covers AE10: when the toggle is off, the slider is disabled.
  - Edge: the label and hint render in both locales.
- **Verification:** Settings → General shows the slider, it is active only when sounds are enabled, and volume changes persist after restart.

## Scope Boundaries

**Deferred for later**

- Per-sound volume control (separate volumes for attention vs completion).
- Per-workspace sound settings.
- User-selectable or custom sound files.
- OS-level toast/desktop notifications.

**Outside this product's identity**

- A distinct sound for errors or abnormal stops.

## Risks & Dependencies

- **`HTMLAudioElement.volume` may behave differently across webviews.** The value is clamped to 0-1 and applied before `play()`; no webview capability changes are needed.
- **Slider UX conventions vary.** Use the project's existing range/slider primitive if one exists; otherwise a styled native range input is sufficient for this lightweight change.

## Open Questions

- Exact slider step size and whether to show a percentage label next to the slider — deferred to implementation/UI tuning.

## Sources / Research

- `src/client/hooks/use-app-settings.ts` — existing `notificationSoundsEnabled` persistence pattern.
- `src/client/lib/sound-player.ts` and `src/client/lib/sound-player.test.ts` — player surface to extend.
- `src/client/lib/use-notification-sounds.ts` and `src/client/lib/use-notification-sounds.test.ts` — hook surface to extend.
- `src/client/components/SettingsPanel.tsx` and `src/client/components/SettingsPanel.test.tsx` — toggle placement and `GeneralTab` prop contract.
- `src/client/i18n/en/settings.json` and `src/client/i18n/zh-CN/settings.json` — label/hint convention.
