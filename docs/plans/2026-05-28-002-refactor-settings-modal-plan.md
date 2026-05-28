---
title: Refactor SettingsPanel to large modal exposing title bar
type: refactor
status: active
date: 2026-05-28
origin: docs/brainstorms/2026-05-28-settings-modal-popup-requirements.md
---

# Refactor SettingsPanel to Large Modal Exposing Title Bar

## Summary

Convert the full-screen `SettingsPanel` overlay into a large centered modal that leaves the custom macOS title bar exposed and interactive. The modal follows the existing hand-rolled backdrop pattern used by `CreateWorkspaceModal`, scales to most of the viewport, and preserves all existing settings functionality. Two changes are required: restructure the root container to a modal wrapper with a title-bar-safe transparent strip, and enable vertical scrolling on the shared content area so all tabs behave correctly inside a height-constrained card.

---

## Problem Frame

The settings page was expanded to a full-screen overlay to give dense configuration tabs breathing room. After the macOS title bar overlay integration, this overlay completely covers the custom title bar and its `data-tauri-drag-region` drag handles. When settings is open, users cannot drag the macOS window by the top bar. The only workaround is to close settings first. Converting to a centered modal restores window mobility while preserving the spacious settings experience.

(See origin document for full problem frame and context.)

---

## Requirements

- R1. Settings opens as a centered modal overlay, not a full-screen panel.
- R2. The modal leaves the title bar exposed and interactive so the window remains draggable.
- R3. The modal is significantly wider than the standard compact modal to preserve comfortable form layouts.
- R4. The modal takes up most of the available viewport width and height.
- R5. Clicking the modal backdrop closes settings, subject to the existing unsaved-changes guard.
- R6. The Escape key closes settings, subject to the existing unsaved-changes guard.
- R7. On small viewports, the modal margin reduces or collapses so the content remains usable without excessive crowding.
- R8. Tab content scrolls independently inside the modal when it exceeds the available height.
- R9. The existing header (title + close button), top tabs, and footer (dirty indicator + Cancel/Save) remain in fixed positions within the modal while content scrolls.
- R10. All existing tabs, forms, inputs, and settings functionality remain unchanged.
- R11. The unsaved-changes confirmation dialog renders above the modal backdrop and is not obscured by it.

**Origin acceptance examples:** AE1 (covers R1, R2, R4), AE2 (covers R5, R6, R11), AE3 (covers R8, R9), AE4 (covers R7)

---

## Scope Boundaries

- No changes to tab structure, settings forms, persistence behavior, or validation logic.
- No resizable or draggable modal behavior.
- No changes to the unsaved-changes dialog content or button actions.
- No changes to the title bar overlay itself — this work is scoped to the settings container only.
- No new shared modal utility or abstraction; keep the existing hand-rolled pattern.
- `App.tsx` rendering logic for `SettingsPanel` does not change.

---

## Context & Research

### Relevant Code and Patterns

- `src/client/components/SettingsPanel.tsx` — Current full-screen overlay at `fixed inset-0 z-50 flex flex-col bg-bg`. Contains header, tabs, content area (`flex-1 overflow-hidden`), footer, and unsaved-changes dialog at `z-[60]`.
- `src/client/components/CreateWorkspaceModal.tsx` — Existing modal pattern: `fixed inset-0 z-50 flex items-start justify-center pt-16` with `absolute inset-0 bg-overlay/60 backdrop-blur-sm` backdrop and `relative bg-surface border border-border rounded-xl shadow-2xl` card.
- `src/client/App.tsx` — Renders `SettingsPanel` as an overlay sibling. Header is `h-11 relative z-30` with `data-tauri-drag-region` drag regions.
- `docs/design/ui-ux-design.md` — Defines z-index scale: Overlay 40, Drawer 50, Modal 50, Toast 50.

### Institutional Learnings

- `docs/plans/2026-05-21-004-feat-workspace-settings-page-plan.md` — Original settings page used `fixed inset-0 z-50` overlay with explicit Save pattern and unsaved-changes dialog.
- `docs/plans/2026-05-24-008-fix-virtualized-message-list-scroll-plan.md` — When a scrollable child inside flex collapses, `absolute inset-0` is more reliable than `h-full` for filling a flex-bounded parent.

---

## Key Technical Decisions

- **Modal wrapper uses a title-bar-safe transparent strip rather than starting below the title bar.** A `fixed inset-0 z-50` wrapper with a top `h-11 pointer-events-none` strip leaves the title bar fully interactive (drag and clicks pass through) while allowing a full-screen backdrop below the title bar. This satisfies both the drag requirement and the backdrop-click-to-close requirement. A wrapper starting at `top-11` would leave the title bar exposed but would remove the backdrop from the top margin area.
- **Content scrolling enabled on the shared content container.** Changing the content area from `flex-1 overflow-hidden` to `flex-1 overflow-y-auto` lets General and Appearance tabs scroll naturally. WorkspaceTabShell already uses `overflow-y-auto` on its sidebar and right pane; because it fills the parent height via `h-full`, it manages internal scrolling without causing the parent to scroll. This is simpler than wrapping each non-workspace tab individually.
- **No new shared modal abstraction.** The codebase has no modal utilities and only three hand-rolled modals. Introducing a shared abstraction would be out of scope for this refactor.

---

## Implementation Units

### U1. Convert SettingsPanel to large modal with backdrop and interactions

**Goal:** Change SettingsPanel from a full-screen overlay to a large centered modal that leaves the title bar exposed and interactive.

**Requirements:** R1, R2, R3, R4, R5, R6, R7, R11

**Dependencies:** None

**Files:**
- Modify: `src/client/components/SettingsPanel.tsx`

**Approach:**
- Replace the root `fixed inset-0 z-50 flex flex-col bg-bg` with a modal wrapper structured as follows:
  - Outer wrapper: `fixed inset-0 z-50 flex flex-col` (full viewport, establishes stacking context)
  - Title bar safe zone: a `h-11 pointer-events-none` div at the top. This strip is transparent and lets clicks pass through to the app header underneath, keeping drag regions interactive.
  - Modal area: `flex-1 flex items-center justify-center p-4 relative`
  - Backdrop: `absolute inset-0 bg-overlay/60 backdrop-blur-sm` with `onClick={handleClose}` — covers the entire modal area below the title bar
  - Card: `relative w-full h-full max-w-6xl bg-surface border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden` — the existing header, tabs, content, footer, and unsaved dialog move inside this card
- Keep the existing `handleClose` logic (dirty check + unsaved dialog) wired to the backdrop click, the X button, and the Escape key handler.
- Keep the unsaved-changes dialog as a `fixed inset-0 z-[60]` sibling rendered inside the outer wrapper. Its current z-index and positioning already place it above the modal.
- Preserve the existing footer with dirty indicator and Cancel/Save buttons.

**Patterns to follow:**
- `CreateWorkspaceModal.tsx` — backdrop blur and card styling
- Existing `SettingsPanel.tsx` — Escape handling, dirty tracking, dialog rendering

**Test scenarios:**
- Happy path: Open settings, a large centered modal appears with visible margin around the card, title bar remains exposed above
- Edge case: Click backdrop with no changes, settings closes immediately
- Edge case: Click backdrop with dirty state, unsaved-changes dialog appears above the modal instead of closing
- Integration: Press Escape with dirty state, unsaved dialog appears; press Escape again, dialog dismisses; press Escape with clean state, settings closes
- Integration: Unsaved dialog is clearly visible, clickable, and above the modal backdrop
- Edge case: Resize window to small dimensions, modal margin shrinks via `p-4` and card fills available space without breaking layout

**Verification:**
- Settings opens as a modal, not full-screen
- macOS title bar is visible and the window can be dragged while settings is open
- Backdrop click, X button, and Escape all correctly trigger the unsaved-changes guard
- Unsaved dialog renders above the modal and is fully interactable

---

### U2. Enable vertical scrolling for tab content inside bounded modal height

**Goal:** Ensure all tabs scroll correctly when their content exceeds the available modal height.

**Requirements:** R8, R9, R10

**Dependencies:** U1

**Files:**
- Modify: `src/client/components/SettingsPanel.tsx`

**Approach:**
- Change the shared content area from `flex-1 overflow-hidden` to `flex-1 overflow-y-auto`.
- `GeneralTab` and `AppearanceTab` render as plain `p-6 max-w-xl` content with no internal overflow. The shared `overflow-y-auto` will let them scroll when tall.
- `WorkspaceTabShell` renders as `flex h-full` with `overflow-y-auto` on both its sidebar (`w-64`) and right content pane. Because `WorkspaceTabShell` fills the parent height and its children scroll internally, the parent content area should not develop a second scrollbar. Verify during implementation.
- If double scrollbars appear in workspace tabs, fallback to keeping the content area as `overflow-hidden` and wrapping only `GeneralTab` and `AppearanceTab` renders in a `h-full overflow-y-auto` container.
- The header, tabs, and footer remain `flex-shrink-0` outside the scrolling content area, so they stay fixed while content scrolls.

**Patterns to follow:**
- `WorkspaceTabShell` internal scroll pattern — `overflow-y-auto` on nested flex children
- `docs/plans/2026-05-24-008-fix-virtualized-message-list-scroll-plan.md` — `absolute inset-0` preferred over `h-full` for flex-bounded children if height issues arise

**Test scenarios:**
- Happy path: General tab scrolls vertically when content exceeds modal height
- Happy path: Appearance tab scrolls vertically when content exceeds modal height
- Happy path: Workspace tab sidebar and content pane scroll independently without double scrollbars
- Edge case: Switch from a scrolled tab to another tab and back; scroll position should be reasonable (reset or preserved per tab)
- Edge case: Resize window vertically while on a tall tab; scroll area adjusts correctly

**Verification:**
- All tabs scroll smoothly when content is taller than the modal's content area
- No duplicate scrollbars appear in workspace tabs
- Header and footer remain visible at all times while content scrolls

---

## System-Wide Impact

- **Interaction graph:** `App.tsx` does not change; `SettingsPanel` remains a self-contained component consumed via the same `onClose` callback. No other components or modals are affected.
- **Error propagation:** No change to error handling. Existing settings save errors continue to display inline.
- **State lifecycle risks:** None. The modal is purely presentational; all state (form values, dirty tracking, active tab) lives inside `SettingsPanel` and is unchanged.
- **Unchanged invariants:** `CreateWorkspaceModal`, `ConfirmDialog`, `FileDrawer`, and other overlays retain their existing z-index and behavior. The app header remains at `z-30`.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Workspace tabs develop double scrollbars when parent content area becomes `overflow-y-auto` | Verify during U2 implementation. If observed, fallback to wrapping only non-workspace tabs in scrollable containers rather than changing the shared parent. |
| Title bar safe zone (`h-11 pointer-events-none`) might not perfectly align with the actual header height on all platforms | The app header is consistently `h-11` (44px) across platforms. If misalignment occurs, adjust the strip height to match the header exactly. |
| Modal card feels cramped on small window sizes | `p-4` padding and `max-w-6xl` provide proportional sizing. On very small windows, the modal fills nearly the entire viewport below the title bar, which is acceptable per R7. |

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-28-settings-modal-popup-requirements.md](docs/brainstorms/2026-05-28-settings-modal-popup-requirements.md)
- Related code: `src/client/components/SettingsPanel.tsx`, `src/client/components/CreateWorkspaceModal.tsx`, `src/client/App.tsx`
- Related plans: `docs/plans/2026-05-21-004-feat-workspace-settings-page-plan.md`, `docs/plans/2026-05-23-006-feat-macos-title-bar-overlay-plan.md`
