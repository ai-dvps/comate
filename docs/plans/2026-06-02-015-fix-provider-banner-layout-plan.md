---
title: "fix: Move no-provider banner below title bar as floated overlay"
type: fix
status: completed
date: 2026-06-02
---

# fix: Move no-provider banner below title bar as floated overlay

## Summary

Move the "No LLM provider configured" error banner from its current position above the title bar to a floated overlay below the title bar, preventing it from pushing the header down and breaking the application layout.

## Problem Frame

When no LLM provider is configured, the app renders a destructive-styled banner above the `<header>` element. Because the banner is in-flow (`flex-shrink-0`), it pushes the entire title bar downward, breaking the expected layout of the application chrome. The banner should instead float over the content area without affecting surrounding layout.

## Requirements

- R1. The provider error banner must render below the title bar, not above it.
- R2. The banner must not affect the layout position of the title bar or main content area (floated / absolute positioning).
- R3. Existing banner behavior is preserved: message text, "Configure Provider" button click opens Settings.
- R4. The banner remains visible and clickable when present.

## Scope Boundaries

- No changes to provider check logic, settings panel, or provider configuration flow.
- No changes to the Claude CLI check screen (full-screen blocking state, separate concern).
- No styling changes to banner colors, padding, or typography beyond positioning.

## Context & Research

### Relevant Code and Patterns

- `src/client/App.tsx` lines 203–214 — the provider error banner rendered as an in-flow `flex-shrink-0` div above the `<header>`.
- `src/client/App.tsx` lines 216–234 — the title bar (`<header>`) with `h-11 flex-shrink-0 border-b`.
- `src/client/App.tsx` lines 237–278 — the main content area (`flex flex-1 overflow-hidden`).
- Existing overlay pattern: `CreateWorkspaceModal` and `SettingsPanel` use `fixed inset-0 z-50` for modal overlays.
- Existing `absolute` positioning patterns in `Sidebar` (resize handle, `z-10`) and `FilePanel` (resize handle).

## Key Technical Decisions

- **Positioning strategy**: `absolute` within the main app container rather than `fixed`. A `fixed` banner would cover the title bar; `absolute` below the header keeps it scoped to the content area while not pushing layout.
- **Container choice**: Wrap the main content area in a `relative` container so the banner can anchor to it. The banner sits inside this wrapper, positioned `top-0 left-0 right-0` with a `z-index` above the content but below modals.

## Implementation Units

### U1. Reposition provider banner below title bar as floated overlay

**Goal:** Move the provider error banner from above the header to below it, using absolute positioning so it overlays content without affecting layout flow.

**Requirements:** R1, R2, R3, R4

**Dependencies:** None

**Files:**
- Modify: `src/client/App.tsx`

**Approach:**
- Remove the banner from its current location above `<header>`.
- Introduce a `relative` wrapper around the main content area (the `div.flex.flex-1.overflow-hidden` block).
- Place the banner inside this wrapper with `absolute top-0 left-0 right-0` and an appropriate `z-index` (e.g., `z-20`, below modals at `z-50` but above content).
- Preserve all existing banner markup, styling classes, and click handlers.
- Ensure the banner's presence does not overlap or obscure interactive elements in a way that breaks usability (it should push content down visually if needed, but not structurally — the current banner is thin and non-intrusive).

**Patterns to follow:**
- Existing `absolute` + `z-*` usage in `Sidebar.tsx` and `FilePanel.tsx` for overlay UI.
- Existing modal z-index hierarchy (`z-50` for `SettingsPanel`, `CreateWorkspaceModal`).

**Test scenarios:**
- Happy path: With no provider configured, banner appears below the title bar, title bar remains at its normal vertical position, and main content area is not shifted downward.
- Edge case: Banner is dismissible/closeable by resolving the provider state (e.g., after adding a provider, the banner disappears and layout remains stable).
- Edge case: Banner does not interfere with `WorkspaceTabs` or `HeaderToolbar` clicks.
- Integration: Clicking "Configure Provider" still opens `SettingsPanel` modal over the banner.

**Verification:**
- Visual inspection: banner sits directly below the `h-11` header, not above it.
- Layout inspection: header's top edge is at `top: 0` of the viewport; banner does not push it down.
- Functional: banner button opens Settings modal as before.

## System-Wide Impact

- **Unchanged invariants:** Provider check logic, settings modal behavior, Claude CLI check screen, all other app layout components.
- **z-index layering:** The banner will sit between the main content and modal overlays. Modals (`z-50`) continue to render above it.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Banner overlaps critical UI in main content area | Banner is thin (`py-2`) and transient; it overlays only the very top of the content area, which is typically the chat panel header or empty space. Accepting this trade-off for layout stability. |

## Sources & References

- Related code: `src/client/App.tsx` (provider banner and app shell layout)
