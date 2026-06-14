---
date: 2026-06-14
topic: session-filter-dropdown-redesign
---

## Summary

Replace the native `<select>` status filter in the session list with a custom popover-based filter control. The new trigger sits next to the search box as a compact icon-plus-chevron button, and the popover lists All / Active / Archived / WIP as rows with status icons, labels, and a selected checkmark.

## Problem Frame

The current filter is a native `<select>` rendered next to the session search box. The browser chrome, default sizing, and generic arrow make it look inconsistent with the rest of the sidebar and undermine the polished feel of adjacent controls like `ProviderSelector`. The user wants the filter to look like a first-class, app-native control rather than a stock HTML element.

## Requirements

- R1. Replace the native `<select>` status filter in `src/client/components/SessionList.tsx` with a custom popover-based filter control.
- R2. The filter trigger sits to the right of the session search box on the same row.
- R3. The trigger is a compact button that shows the Lucide icon for the currently selected status plus a chevron.
- R4. The trigger does not display the selected text label or a tooltip.
- R5. The trigger exposes an accessible name via `aria-label` that communicates the control purpose and the current filter value.
- R6. The popover lists the four options in this order: All, Active, Archived, WIP.
- R7. Each option row displays a status Lucide icon, the translated text label, and a checkmark when it is the active selection.
- R8. Selecting an option updates the filter state, closes the popover, and immediately re-filters the session list.
- R9. The popover opens and closes with a subtle fade/slide animation.
- R10. The popover is fully keyboard operable: Enter or Space opens the popover, Arrow keys move focus between options, Enter or Space selects the focused option, and Escape closes the popover.
- R11. Existing filter semantics and the workspace-switch reset to Active are preserved unchanged.

## Key Decisions

- **Custom popover over native select.** A styled popover matches `ProviderSelector` and other app-native controls, removing browser-styled chrome.
- **Icon-only trigger.** The trigger shows only the selected status icon and a chevron to keep the sidebar narrow. The accessible name carries the current value for screen readers.
- **No popover header or tooltip.** The user explicitly excluded both to keep the surface minimal; option labels inside the popover provide context.
- **Status icons, not colored dots.** Each option uses a distinct Lucide icon to reinforce the status meaning without introducing a separate color language.
- **Animation via Radix Popover.** The existing popover primitive supports subtle enter/exit transitions without adding dependencies.

## Acceptance Examples

- AE1. **Default view**
  - **Given** the user opens a workspace with active and archived sessions,
  - **When** the sidebar loads,
  - **Then** the trigger shows the Active icon, the popover is closed, and archived sessions are hidden.
- AE2. **Open the popover**
  - **Given** the filter is set to Active,
  - **When** the user clicks the trigger,
  - **Then** the popover opens, lists All / Active / Archived / WIP, and the Active row shows a checkmark.
- AE3. **Select a different filter**
  - **Given** the popover is open and the filter is Active,
  - **When** the user clicks the Archived row,
  - **Then** the popover closes, the trigger icon changes to the Archived icon, and the list shows only archived sessions.
- AE4. **Keyboard selection**
  - **Given** the trigger has focus,
  - **When** the user presses Space, ArrowDown to WIP, and Enter,
  - **Then** the popover closes and the session list filters to WIP sessions.
- AE5. **Workspace switch resets the control**
  - **Given** the user has changed the filter to Archived,
  - **When** the user switches to another workspace,
  - **Then** the trigger icon returns to Active and the list shows active sessions.

## Scope Boundaries

- **Deferred for later:** colored status dots, a header inside the popover, a tooltip on the trigger, a segmented button group variant, status badges in the trigger, multi-select filters, or search inside the popover.
- **Outside this product's identity:** changing the status filter semantics (what Active / Archived / WIP / All mean), adding new statuses, or bulk archive/unarchive actions.

## Dependencies / Assumptions

- The existing `Popover` primitive in `src/client/components/ui/popover.tsx` and the `Button` / `cn` utilities are available and can be reused.
- The existing `SessionStatusFilter` type and `matchesSessionStatus` predicate in `src/client/lib/session-filter.ts` remain unchanged; this redesign only changes the control chrome.
- Translated labels for All / Active / Archived / WIP already exist under the `chat` namespace.

## Sources / Research

- Current filter implementation: `src/client/components/SessionList.tsx` and `src/client/components/SessionList.test.tsx`.
- Popover pattern to mirror: `src/client/components/ProviderSelector.tsx`.
- UI primitives: `src/client/components/ui/popover.tsx` and `src/client/components/ui/button.tsx`.
- Filter logic: `src/client/lib/session-filter.ts`.
