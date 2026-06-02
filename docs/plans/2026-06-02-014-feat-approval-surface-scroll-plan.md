---
title: Add scroll constraints to ApprovalSurface content containers
type: feat
status: completed
date: 2026-06-02
origin: docs/brainstorms/2026-06-02-approval-surface-scroll-requirements.md
---

# Add scroll constraints to ApprovalSurface content containers

## Summary

Apply `max-h-[60vh]` with `overflow-y-auto` to the approval request content and question content areas in `ApprovalSurface`, keeping action buttons visible without scrolling. The preview-pane layout already uses this pattern; this plan extends it to the approval view and the no-preview question view.

## Requirements

- R1. Approval request content must be constrained to a maximum height and scroll vertically when exceeded.
- R2. Question content must be constrained to a maximum height and scroll vertically when exceeded, regardless of whether a preview pane is visible.
- R3. Action buttons must remain visible and accessible below the scrollable content area.

## Scope Boundaries

- Does not change the existing `max-h-[60vh]` value already applied to the preview-pane layout.
- Does not modify content rendering logic, button behavior, or stepper navigation.
- Does not change the max-height behavior of the Other input textarea (already capped at 160px).

## Context & Research

### Relevant Code and Patterns

- `src/client/components/ApprovalSurface.tsx` — the component to modify. `QuestionView` already applies `max-h-[60vh]` with `overflow-y-auto` when preview panes are present (lines 674-675). The approval view and no-preview question view lack this constraint.
- Other scrollable containers in the codebase use `max-h-72`, `max-h-64`, or viewport-relative values (`max-h-[60vh]`, `max-h-[90vh]`) paired with `overflow-y-auto`.

## Key Technical Decisions

- **Use `max-h-[60vh]` for consistency:** The preview-pane layout already uses this value for the combined question + preview area. Using the same value for approval content and no-preview question content keeps the UX predictable and avoids introducing an arbitrary new limit.

## Implementation Units

### U1. Add scroll constraints to ApprovalSurface content areas

**Goal:** Wrap approval request content and question content in scrollable containers with a consistent max-height, ensuring action buttons remain visible.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Modify: `src/client/components/ApprovalSurface.tsx`

**Approach:**
- In `ApprovalView`, wrap the content display area (the `div` containing the renderer or `StructuredFallback`) in a container with `max-h-[60vh] overflow-y-auto`.
- In `QuestionView`, when no preview pane is present, wrap `questionContent` in a container with `max-h-[60vh] overflow-y-auto` to match the preview-pane layout's scroll behavior.
- Keep action button containers outside these scrollable wrappers so they are always visible.

**Patterns to follow:**
- The existing preview-pane layout in `QuestionView` (lines 674-675) already uses `max-h-[60vh]` with `overflow-y-auto`.

**Test scenarios:**
- Test expectation: none — this is a pure CSS/visual layout change with no behavioral logic. Manual UI verification is sufficient.

**Verification:**
- Long approval requests display a vertical scrollbar and the Allow/Deny/Allow Always buttons remain visible without scrolling.
- Long questions without previews display a vertical scrollbar and the Confirm/Next/Back buttons remain visible without scrolling.
- The existing preview-pane question layout continues to behave as before.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-06-02-approval-surface-scroll-requirements.md](docs/brainstorms/2026-06-02-approval-surface-scroll-requirements.md)
- **Related code:** `src/client/components/ApprovalSurface.tsx`
