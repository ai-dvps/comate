---
date: 2026-06-02
topic: approval-surface-scroll
---

# Approval Surface Scroll Constraints

## Summary

Add max-height with overflow scrolling to approval request content and question content containers in the approval surface, keeping action buttons visible without scrolling through lengthy content.

## Problem Frame

Currently, approval request content (tool input/renderers) and question content (question text, option lists, descriptions) can grow unbounded. When content is lengthy, action buttons are pushed far below the fold, forcing users to scroll to find Allow/Deny/Confirm controls. The question view already applies a height limit when preview panes are present, but the no-preview case and the approval view lack this constraint.

## Requirements

- R1. Approval request content (tool input display, including custom renderers and structured fallback) must be constrained to a maximum height and scroll vertically when content exceeds it.
- R2. Question content (question text, options list, and Other input) must be constrained to a maximum height and scroll vertically when content exceeds it, regardless of whether a preview pane is visible.
- R3. Action buttons (Allow, Deny, Allow Always, Confirm, Next, Back, Chat About This) must remain visible and accessible below the scrollable content area without requiring the user to scroll through content to reach them.

## Success Criteria

- Long approval requests and multi-option questions are scrollable within their containers.
- Users can always see and interact with action buttons without scrolling through content.
- The scroll behavior is consistent across approval requests, questions with previews, and questions without previews.

## Scope Boundaries

- Does not change the existing `max-h-[60vh]` value already applied to the preview-pane layout.
- Does not modify content rendering logic, button behavior, or the stepper navigation flow.
- Does not change the max-height behavior of the Other input textarea (already capped at 160px).
