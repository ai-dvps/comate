---
title: "Provider error toast notification"
status: active
date: 2026-06-02
---

# Provider error toast notification

## Summary

Replace the full-width provider error banner with a compact toast-style notification positioned in the top-right corner of the content area, just below the title bar.

## Problem Frame

The current floated banner spans the full width of the content area and can feel visually heavy and intrusive. A compact toast in the top-right is less disruptive while still being noticeable and actionable.

## Requirements

- R1. The provider error message must display as a compact toast instead of a full-width banner.
- R2. The toast must be positioned in the top-right corner of the content area, below the title bar.
- R3. The toast must not push the title bar or content area down (absolute/floated positioning).
- R4. The toast must preserve the existing message text and "Configure Provider" button behavior.
- R5. The toast styling must use existing surface/shadow patterns (e.g., `bg-surface`, `rounded-lg`, `shadow-lg`, `border`) for visual consistency.

## Scope Boundaries

- No changes to provider check logic or settings panel behavior.
- No changes to the Claude CLI check screen.
- No new toast system or library — this is a one-off styled component.

## Key Decisions

- **Toast shape**: Compact horizontal card with icon + message + action button, sized to content rather than full-width.
- **Positioning**: `absolute top-2 right-2` (or similar offset) inside the main content wrapper, matching the current banner's container approach.
- **Dismissal**: No auto-dismiss timer; remains visible until provider is configured (same behavior as current banner).
