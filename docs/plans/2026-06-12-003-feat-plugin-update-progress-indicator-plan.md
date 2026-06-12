---
title: "feat: Plugin update progress indicator"
date: 2026-06-12
type: feat
status: active
plan-depth: lightweight
sequence: 003
---

## Summary

Add visual progress feedback to the plugin update button so users know an update is in progress, when it succeeds, and when it fails — replacing the current behavior of a silent disabled button with no outcome confirmation.

## Problem Frame

When a user clicks the update button (RefreshCw icon) on an installed plugin, the button simply disables and fades out. There is no spinner, no success confirmation, and no per-plugin error feedback. The user has no way to tell whether anything is happening, or what the result was. This contrasts with the install flow (ScopePickerModal) which has a full multi-phase state machine with spinner, success checkmark, and error display.

## Scope

### In Scope
- Per-plugin loading state in the store to track which plugin is currently updating
- Spinner animation on the update button during the update operation
- Brief success confirmation after update completes
- Inline error display on update failure

### Out of Scope
- Download progress percentage (the server update is a single POST; no streaming progress)
- Background/scheduled update checks
- Batch update (update all)
- Toast/notification system for updates (inline feedback is sufficient for this settings-page-only feature)

---

## Key Technical Decisions

**KTD1. Per-plugin update state in the store, not a global flag.** The current `isSaving` boolean disables all action buttons across all plugins during any save operation. The update flow needs `updatingPluginId: string | null` in the store so only the updating plugin's button shows a spinner, while other plugins remain interactive.

**KTD2. Follow ScopePickerModal's visual pattern.** Use `Loader2` + `animate-spin` during update, `CheckCircle2` for brief success, and `AlertCircle` for error — matching the existing install flow's icons and styling conventions. No new components or dependencies.

**KTD3. Inline feedback on the button row, not a modal.** The update is a single click with a fast server round-trip. A modal would be over-engineering. Show the spinner on the button itself, then a brief inline success state (checkmark + "Updated to vX.Y.Z") that auto-clears after ~2 seconds.

---

## Implementation Units

### U1. Add per-plugin update state to the plugin store

**Goal:** Track which plugin is currently being updated so the UI can show per-plugin loading state.

**Files:**
- `src/client/stores/plugin-store.ts`

**Approach:** Add `updatingPluginId: string | null` and `updateError: string | null` to the store state. In `updatePlugin()`, set `updatingPluginId` to the target plugin ID at start, clear it on completion, and set `updateError` on failure. Remove the dependency on the global `isSaving` flag for the update flow specifically.

**Patterns to follow:** The existing `updatePlugin` method structure (lines 154-181 in plugin-store.ts).

**Test scenarios:**
- `updatePlugin` sets `updatingPluginId` to the plugin ID during the operation and clears it on success
- `updatePlugin` clears `updatingPluginId` and sets `updateError` on failure
- Consecutive updates correctly update `updatingPluginId` to the new plugin

**Verification:** Store state transitions correctly: `updatingPluginId` is set during update, cleared after; `updateError` is set on failure, cleared on next attempt.

---

### U2. Add spinner, success, and error states to the update button

**Goal:** Replace the silent disabled button with visual feedback during and after the update operation.

**Files:**
- `src/client/components/PluginSettingsPage.tsx`
- `src/client/stores/plugin-store.ts` (consumer changes)

**Approach:**
- During update (`updatingPluginId === plugin.id`): Replace the `RefreshCw` icon with `<Loader2 className="animate-spin" />` and show "Updating..." text next to the button
- On success (brief state): Show `<CheckCircle2>` icon with "Updated to {newVersion}" text, auto-clear after ~2 seconds using a `setTimeout`
- On error (`updateError` is set): Show `<AlertCircle>` icon with the error message inline, with a retry button
- Only the updating plugin's update button is disabled (via `updatingPluginId === plugin.id` check); other plugins' update buttons remain clickable
- Other action buttons (toggle, uninstall) for the same plugin remain disabled during update

**Patterns to follow:**
- `ScopePickerModal.tsx` — multi-phase visual state with Loader2/CheckCircle2/AlertCircle icons
- `PluginMarketplaceTab.tsx` — `RefreshCw` with `animate-spin` for loading
- Tailwind utility classes consistent with the rest of the component

**Test scenarios:**
- Update button shows spinning Loader2 when `updatingPluginId` matches the plugin ID
- Success state shows CheckCircle2 with new version text and auto-clears after ~2 seconds
- Error state shows AlertCircle with error message inline
- Other plugins' update buttons remain clickable during an update
- The same plugin's other action buttons (toggle, uninstall) are disabled during update

**Verification:** Click update → see spinner → see success message with new version → message auto-clears. Click update → if failure, see inline error with retry option.

---

### U3. Clean up update state on unmount

**Goal:** Ensure no stale state persists if the component unmounts during or after an update.

**Files:**
- `src/client/components/PluginSettingsPage.tsx`

**Approach:** Add a `useEffect` cleanup that clears `updatingPluginId` and `updateError` if the component unmounts while an update is in progress. Also clear the success timeout to prevent it from firing after unmount.

**Patterns to follow:** Standard React cleanup pattern with `useEffect` return.

**Test scenarios:**
- Navigating away during an update clears the store state
- Success timeout does not fire after unmount (no React state update on unmounted component warning)

**Verification:** No console warnings about state updates on unmounted components after navigating away during or immediately after an update.

---

## Test Strategy

All testing is component-level with the Zustand store:
- Store state transitions for `updatingPluginId` and `updateError`
- Component rendering for each visual state (spinner, success, error)
- Timeout cleanup on unmount

No server-side changes are needed — the existing `POST /api/plugins/update` endpoint is unchanged.

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Race condition if user clicks update twice rapidly | Low | Button is disabled during update via `updatingPluginId` check |
| Success timeout fires after unmount | Low | useEffect cleanup clears the timeout |
| Stale `updatingPluginId` if server hangs | Low | The `isSaving` timeout behavior already handles this; ensure `updatingPluginId` is cleared in all exit paths |
