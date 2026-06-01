---
title: Dock Badge for Pending Requests
type: feat
status: completed
date: 2026-06-01
origin: docs/brainstorms/2026-06-01-dock-badge-for-pending-requests-requirements.md
---

# Dock Badge for Pending Requests

## Summary

Add a cross-platform dock/taskbar badge driven by the existing `sessionStatus.pendingCount` state. A Rust Tauri command handles platform-specific APIs — macOS numeric badge and dynamic dock visibility, Windows taskbar attention flash — while a React hook watches the Zustand store and syncs the count on every change.

---

## Problem Frame

Comate hides its dock icon when the window is closed to the background (`ActivationPolicy::Accessory`). Users discover pending tool approvals and ask-user questions only by accident, with no external signal. The AI session stalls silently until the user happens to check back.

---

## Requirements

- R1. The badge count equals the sum of unresolved tool approvals and unresolved ask-user questions.
- R2. When a tool approval is resolved (approved or denied), the badge count decreases by one.
- R3. When an ask-user question is answered, the badge count decreases by one.
- R4. The badge count never displays below zero.
- R5. When the badge count transitions from zero to positive while the app window is not focused/visible, the dock/taskbar icon becomes visible.
- R6. When the badge count transitions from positive to zero while the app window is not focused/visible, the dock/taskbar icon returns to its hidden state.
- R7. When the app window is focused/visible, the dock/taskbar icon remains visible regardless of badge count.
- R8. On macOS, the dock icon displays a numeric badge with the pending count.
- R9. On Windows, the taskbar icon displays an equivalent numeric badge or overlay with the pending count.

**Origin actors:** User
**Origin flows:** F1 (Pending approval arrives while app is hidden), F2 (User resolves last pending item while app is hidden)
**Origin acceptance examples:** AE1 (macOS badge on approval), AE2 (Windows badge on multi-pending), AE3 (macOS clear on resolve), AE4 (visible window retains icon)

---

## Scope Boundaries

- Unread chat completions do not affect the badge count.
- Native OS notifications (banners/toasts) are not included.
- Linux is not supported.
- Badge behavior does not change for non-blocking UI states (e.g., loading spinners, streaming responses).
- Rust unit tests are out of scope — the repo has no Rust test infrastructure.

---

## Context & Research

### Relevant Code and Patterns

- `src-tauri/src/lib.rs` — Existing `show_main_window()` sets `ActivationPolicy::Regular`; `CloseRequested` handler hides window and sets `ActivationPolicy::Accessory`. Tray status poller pattern shows how to update OS chrome from Rust.
- `src/client/stores/chat-store.ts` — `sessionStatus: Record<string, { pendingCount: number }>` is updated by a background poll to `/api/workspaces/${workspaceId}/sessions/status`. This is the existing data source for pending work.
- `src/client/components/WorkspaceTabs.tsx` — Already consumes `sessionStatus[s.id]?.pendingCount` to show per-workspace `needsMe` indicators, confirming `pendingCount` aggregates blocking items.
- `src/client/lib/tauri-api.ts` — Uses `invoke('get_api_port')` as the existing Tauri command pattern.
- `src/client/App.tsx` — Root component where the sync hook will mount.

### Institutional Learnings

- Cross-platform Tauri features need runtime platform detection and OS-specific branches (`docs/plans/2026-05-23-003-feat-system-tray-background-mode-plan.md`).
- macOS `ActivationPolicy::Accessory` hides the dock icon; `Regular` restores it.

### External References

- Tauri v2 `setBadgeCount` — macOS/Linux only. Windows uses `requestUserAttention` or `setOverlayIcon`.
- Tauri v2 `requestUserAttention` — cross-platform flash/bounce behavior (`UserAttentionType::Informational` / `Critical`).

---

## Key Technical Decisions

- **Use `sessionStatus.pendingCount` as the single source of truth:** The backend already computes this per-session aggregate. Summing across all sessions gives the global pending count without introducing new frontend state.
- **Centralize platform branching in one Rust command:** Rather than splitting macOS/Windows logic across frontend and backend, a single `update_badge_state` command handles all platform-specific APIs. The frontend only passes a count.
- **Modify `CloseRequested` to respect pending work:** The existing handler unconditionally hides the dock icon on macOS. It must now check the stored badge count and preserve visibility when work remains.
- **Windows uses `requestUserAttention` flash, not persistent badge:** Tauri v2 does not support numeric Windows taskbar badges. `requestUserAttention(Informational)` is the closest cross-platform equivalent — it flashes the taskbar when pending work arrives.

---

## Open Questions

### Resolved During Planning

- **Windows badge implementation:** `requestUserAttention` flash on 0→>0 transition, no persistent numeric badge. Chosen for feasibility within Tauri v2 constraints.
- **React state source:** `sessionStatus.pendingCount` summed across sessions. Confirmed by existing `WorkspaceTabs.tsx` usage.

### Deferred to Implementation

- **macOS `setBadgeCount` bug status:** Tauri issue #13905 reported breakage in v2.7.0. The repo uses v2.11.2 — verify it works during implementation; if still broken, investigate workarounds.
- **Exact `invoke` payload shape:** Tauri command argument naming and TypeScript typing to be finalized when touching the code.

---

## Implementation Units

### U1. Rust backend: badge state command and AppState extension

**Goal:** Add Tauri command to update badge count and manage dock visibility on macOS and Windows.

**Requirements:** R1–R7, R8, R9

**Dependencies:** None

**Files:**
- Modify: `src-tauri/src/lib.rs`

**Approach:**
- Add `badge_count: AtomicU32` to `AppState`.
- Add `update_badge_state(count: u32)` command:
  - **macOS:** Call `app_handle.set_badge_count(count)`. If the main window is not visible and count > 0, set `ActivationPolicy::Regular`; if count == 0, set `ActivationPolicy::Accessory`.
  - **Windows:** If count > 0, call `window.request_user_attention(Some(Informational))` on the main window; if count == 0, call `request_user_attention(None)`.
- Modify `CloseRequested` handler: before setting `ActivationPolicy::Accessory`, read `AppState.badge_count`. Only hide the dock icon when the count is zero.
- Register `update_badge_state` in `.invoke_handler(...)`.

**Patterns to follow:**
- Existing `show_main_window()` and `CloseRequested` activation-policy toggling in `src-tauri/src/lib.rs`.
- Existing tray status poller pattern for reading `AppState` and acting on it.

**Test scenarios:**
- Test expectation: none — Rust test infrastructure does not exist in this repo.

**Verification:**
- `cargo check` / `cargo build` passes with no errors.
- Manual test: invoking `update_badge_state(3)` shows badge "3" on macOS dock.
- Manual test: invoking `update_badge_state(0)` clears the badge.
- Manual test: `CloseRequested` with count > 0 leaves dock icon visible on macOS.

---

### U2. Frontend: badge sync hook

**Goal:** React hook that computes total pending count from `sessionStatus` and syncs it to the Tauri backend.

**Requirements:** R1–R3

**Dependencies:** U1

**Files:**
- Create: `src/client/lib/use-badge-sync.ts`
- Create: `src/client/lib/use-badge-sync.test.ts`
- Modify: `src/client/App.tsx`

**Approach:**
- Create `useBadgeSync` hook.
- Use a `useChatStore` selector to compute `totalPendingCount` by summing `sessionStatus[sid]?.pendingCount ?? 0` across all entries.
- In a `useEffect`, when the count changes and `isTauri()` is true, invoke `update_badge_state` with the current count.
- The effect must run on mount so the initial state is synced (catches existing pending work at app startup).
- Mount the hook in `App.tsx` near other top-level effects.

**Patterns to follow:**
- `tauri-api.ts` for `invoke` usage and `isTauri()` guard.
- `WorkspaceTabs.tsx` for `sessionStatus` consumption pattern.
- Existing `.test.ts` files (`src/client/lib/keyboard.test.ts`, etc.) for `node:test` + `node:assert` test style.

**Test scenarios:**
- **Happy path:** Given `sessionStatus = { s1: { pendingCount: 2 }, s2: { pendingCount: 1 } }`, total count is `3`.
- **Edge case:** Given empty `sessionStatus`, total count is `0`.
- **Edge case:** Given `sessionStatus = { s1: { pendingCount: 1 }, s2: undefined }`, total count is `1` (gracefully handles missing entries).
- **Edge case:** Given count decreasing from `2` to `0`, invokes with `0`.

**Verification:**
- `npm test` or `node --test src/client/lib/use-badge-sync.test.ts` passes.
- Manual verification: opening Comate with pending sessions shows the dock badge immediately.

---

### U3. Cross-platform verification and edge-case hardening

**Goal:** Validate macOS and Windows behaviors, ensure edge cases around window state transitions are handled.

**Requirements:** R5–R7, R8, R9

**Dependencies:** U1, U2

**Files:**
- Modify: `src/client/lib/use-badge-sync.ts` (if startup edge cases need adjustment)
- Modify: `src-tauri/src/lib.rs` (if window-visibility checks need refinement)

**Approach:**
- **Startup:** Verify that if Comate launches with existing pending sessions, the badge appears immediately (hook mount + initial sync).
- **macOS dock visibility:**
  - Window hidden + pending arrives → dock icon appears, badge shows count.
  - Pending resolved while hidden → dock icon hides, badge clears.
  - Window shown via tray/menu while pending exists → dock stays visible, badge stays.
- **Windows attention:**
  - Pending arrives while window hidden/minimized → taskbar flashes.
  - No re-flash on count increase from 1→2 (only 0→>0 triggers).
- **Reload:** Frontend reload (e.g., during dev) should re-sync badge state on mount.

**Patterns to follow:**
- Existing tray/menu `show_main_window()` paths for window restoration.

**Test scenarios:**
- **Integration:** Startup with existing pending sessions → badge appears immediately.
- **Integration:** Window hidden + pending arrives → dock shows (macOS).
- **Integration:** Pending resolved while hidden → dock hides (macOS).
- **Integration:** Pending arrives on Windows → taskbar flashes once.
- **Edge case:** Frontend hot-reload with pending work → badge re-syncs without duplication.

**Verification:**
- Manual cross-platform testing passes on macOS and Windows.
- No regressions in existing tray behavior or window show/hide logic.

---

## System-Wide Impact

- **Interaction graph:** `CloseRequested` handler now reads `AppState.badge_count` before toggling dock visibility. The `show_main_window()` path is unchanged.
- **Error propagation:** Badge update failures are logged and silently swallowed — the app must not crash or stall if the OS badge API fails.
- **State lifecycle risks:** `AppState.badge_count` must stay in sync with the frontend's computed sum. The hook's mount-time sync handles startup; subsequent SSE-driven `sessionStatus` updates keep it live.
- **Unchanged invariants:** Tray menu behavior, sidecar lifecycle, window minimize/unminimize, and all existing `ActivationPolicy` paths other than `CloseRequested` remain exactly as before.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `setBadgeCount` may still be broken on macOS in Tauri 2.11.2 (issue #13905) | Verify during U1 implementation; if broken, investigate `setBadgeLabel` or native workaround |
| `sessionStatus.pendingCount` may not include ask-user questions | Verify backend endpoint during implementation; if incomplete, fall back to `approvalQueue` length |
| Windows `requestUserAttention` behavior varies by window state | Test on actual Windows hardware; accept OS-defined flash semantics |
| Frontend reload desyncs badge state | Hook mounts with current state and re-syncs automatically |

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-06-01-dock-badge-for-pending-requests-requirements.md](../brainstorms/2026-06-01-dock-badge-for-pending-requests-requirements.md)
- Related code: `src-tauri/src/lib.rs`, `src/client/stores/chat-store.ts`, `src/client/components/WorkspaceTabs.tsx`, `src/client/lib/tauri-api.ts`
- Related plans: `docs/plans/2026-05-23-003-feat-system-tray-background-mode-plan.md`
- External docs: [Tauri v2 Window API](https://v2.tauri.app/reference/javascript/api/namespacewindow/), [Tauri v2 App API](https://v2.tauri.app/es/reference/javascript/api/namespaceapp/)
