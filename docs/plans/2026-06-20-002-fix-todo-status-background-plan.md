---
title: Fix Todo Status Indicator Background Color
type: fix
date: 2026-06-20
origin: docs/brainstorms/2026-05-29-workspace-todos-requirements.md
---

# Fix Todo Status Indicator Background Color

## Summary

Remove the gray background from the todo status indicator button in the sidebar so it sits cleanly against the dark sidebar surface.

## Problem Frame

The workspace todo list renders each todo's status as a clickable icon button. The `pending` status currently applies `bg-text-tertiary/10`, which produces a gray patch behind the icon. Against the sidebar's `surface` background this looks unintentional and off-theme; the colored backgrounds on other statuses also read as noisy rather than informative.

## Requirements

- R1. The todo status indicator button shall have no colored background in any status state.
- R2. The status icon color and hover behavior shall remain unchanged.

## Scope Boundaries

- Does not change status semantics, status options, or status-change interactions.
- Does not modify the status dropdown menu styling beyond what naturally shares the indicator config.
- Does not add new tests for pure visual styling; verification is visual.

## Context & Research

- The status indicator is rendered in `src/client/components/TodoList.tsx`.
- `statusConfig` defines both `color` and `bg` tokens; the button className applies `${status.bg}`.
- Design tokens in `docs/design/ui-ux-design.md` use `surface` / `surface-hover` for sidebar items; the gray `bg-text-tertiary/10` patch clashes with that palette.

## Key Technical Decisions

- **Drop the `bg` token entirely:** Remove the `bg` field from `statusConfig` and its use in the indicator button. This is the smallest change and avoids introducing a new theme color just to mask the gray.
- **Keep icon colors and hover opacity:** The icon color communicates status; the existing `hover:opacity-80` provides affordance without a background patch.

## Implementation Units

### U1. Update TodoList status indicator styling

**Goal:** Remove the off-theme background from the todo status indicator button.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Modify: `src/client/components/TodoList.tsx`

**Approach:**
- Remove the `bg` field from the `statusConfig` record.
- Remove `${status.bg}` from the status indicator button's `className`.
- Leave the icon color, title, and hover opacity transition unchanged.

**Patterns to follow:**
- Existing icon-only controls in the same file, such as the delete button, use hover opacity/tint rather than a permanent background.

**Test scenarios:**
- Happy path: Pending todo renders with the Circle icon and no visible background patch.
- Happy path: Done, discard, and verify todos still show their colored icons without backgrounds.
- Edge case: Status dropdown menu items continue to render with colored icons and unchanged menu background.

**Verification:**
- Visually inspect the todo list in the app; the status indicator should appear as a bare icon with no gray (or colored) halo.
- Confirm hover still dims the icon.

## System-Wide Impact

- No API, state, or behavioral changes.
- Affects only the `TodoList` component's visual presentation.

## Risks & Dependencies

- None.
