---
date: 2026-05-28
topic: settings-modal-popup
---

# Settings Modal Popup

## Summary

Convert the full-screen SettingsPanel overlay into a large centered modal that exposes the custom macOS title bar and its drag regions. The modal keeps the existing top-tab navigation, all seven tabs, the save/cancel footer, and the unsaved-changes guard. It occupies most of the viewport width and height with a small margin, with tab content scrolling inside.

---

## Problem Frame

The settings page was previously expanded to a full-screen overlay to give dense configuration tabs adequate breathing room. After the macOS title bar overlay integration, this full-screen overlay now completely covers the custom title bar and its `data-tauri-drag-region` drag handles. When the settings page is open, users cannot drag the macOS window by any part of the top bar — the window is effectively stuck in place. The only workaround is to close settings first, then drag. This regresses the native-feeling window behavior that the title bar overlay was designed to achieve.

---

## Requirements

**Modal container**

- R1. Settings opens as a centered modal overlay, not a full-screen panel.
- R2. The modal leaves a visible margin around all edges so the underlying app chrome (including the title bar) remains partially visible and the window is draggable.
- R3. The modal is significantly wider than the standard compact modal (e.g., `CreateWorkspaceModal`) to preserve comfortable form layouts.
- R4. The modal takes up most of the available viewport width and height.
- R5. Clicking the modal backdrop closes settings, subject to the existing unsaved-changes guard.
- R6. The Escape key closes settings, subject to the existing unsaved-changes guard.
- R7. On small viewports, the modal margin reduces or collapses so the content remains usable without excessive crowding.

**Content behavior**

- R8. Tab content scrolls independently inside the modal when it exceeds the available height.
- R9. The existing header (title + close button), top tabs, and footer (dirty indicator + Cancel/Save) remain in fixed positions within the modal while content scrolls.
- R10. All existing tabs, forms, inputs, and settings functionality remain unchanged.

**Layering**

- R11. The unsaved-changes confirmation dialog renders above the modal backdrop and is not obscured by it.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R4.** Given the main app is visible, when the user clicks the settings gear icon, a large centered modal appears with visible margin around it and the title bar remains exposed.
- AE2. **Covers R5, R6, R11.** Given the user has edited a field in settings, when the user clicks the modal backdrop or presses Escape, the unsaved-changes confirmation dialog appears above the modal instead of closing immediately.
- AE3. **Covers R8, R9.** Given the settings modal is open on a vertically constrained window, when the user navigates to the MCP tab and adds several servers, the server list scrolls within the modal and the Save button remains visible at the bottom.
- AE4. **Covers R7.** Given the app window is resized to a small dimension, when the user opens settings, the modal margin shrinks so the modal content does not become unusable.

---

## Success Criteria

- Users can open settings, edit configuration, and still drag the macOS window by the title bar without closing settings first.
- The settings modal feels spacious enough for the seven tabs of dense configuration; forms do not feel cramped.
- Closing settings via backdrop click, Escape key, or the X button all correctly trigger the unsaved-changes guard when appropriate.
- The unsaved-changes dialog is clearly visible and interactable above the modal.

---

## Scope Boundaries

- No changes to tab structure, settings forms, persistence behavior, or validation logic.
- No resizable or draggable modal behavior.
- No changes to the unsaved-changes dialog content or button actions.
- No changes to the title bar overlay itself — this work is scoped to the settings container only.

---

## Key Decisions

- **Large modal over partial overlay or sidebar:** A large centered modal was chosen because it preserves the focused settings experience while leaving the title bar exposed. A sidebar or partial panel would force the remaining content to be visible and potentially distracting.
- **Most of viewport over fixed max-width:** The modal should scale with the window size rather than clamp to a rigid max-width, so users with large monitors get the spacious layout the full-screen design originally aimed for.
