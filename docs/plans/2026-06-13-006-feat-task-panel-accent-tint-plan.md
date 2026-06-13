---
title: "feat: Accent-tint the TaskPanel to distinguish it from the chat column"
type: feat
date: 2026-06-13
---

# feat: Accent-tint the TaskPanel to distinguish it from the chat column

## Summary

The inline TaskPanel (the task-progress bar rendered inside the chat column) currently shares the same `bg-bg` background as the chat area, so only a hairline `border-b` separates them and tasks don't read as a distinct surface. This plan gives the TaskPanel a low-alpha accent tint so it stands out as an active-work surface, drawn from the existing `accent` token so both light and dark themes adapt automatically. The change is background treatment only — no behavior, layout, or content changes.

## Requirements

- R1. The TaskPanel background shall be visually distinct from the chat column background in both its collapsed bar and expanded popup states.
- R2. The tint shall be derived from the existing `accent` color token (via alpha modulation) so it adapts to light and dark themes without hardcoded values.
- R3. The change shall not alter task-panel behavior, layout, or content — background treatment only.

## Key Technical Decisions

- **Accent-tint over neutral elevation.** Chosen over the two alternatives considered during scoping — `bg-surface` (subtle elevation matching Sidebar/SubagentDrawer) and `bg-surface-active` (deeper neutral contrast). A faint warm wash signals "active work happening here" and draws the eye more than a neutral step, which is what the user asked for. Trade-off: it introduces a tinted-panel pattern not used by other panels, so the alpha must stay low enough that text contrast and the progress bar remain readable.
- **Token-based tint via `accent` at low alpha.** Keeps the value theme-aware through the HSL CSS-variable system (`--color-accent`) rather than hardcoding a hex. The codebase already uses alpha-modulated tokens widely (`bg-warning/10`, `bg-accent/20`, `bg-surface-hover/50`), so this follows convention. The exact alpha is an execution-time visual-tuning detail — start around `/8` and adjust by eye.
- **Both states tinted, hover stays coherent.** The collapsed bar and the expanded popup both take the tint for consistency. The collapsed bar's current `hover:bg-surface-hover/50` should move to a slightly stronger accent tint (e.g. `hover:bg-accent/12`) so hover deepens within the accent family instead of dropping back to a neutral surface tone.

## Implementation Units

### U1. Accent-tint the TaskPanel background

- **Goal:** Replace the TaskPanel's `bg-bg` background with a low-alpha accent tint so the panel reads as a distinct active-work surface.
- **Requirements:** R1, R2, R3
- **Dependencies:** none
- **Files:** `src/client/components/TaskPanel.tsx`
- **Approach:** Two containers currently carry `bg-bg` — the outer collapsed-bar wrapper and the expanded popup wrapper. Swap both to a low-alpha accent tint drawn from the `accent` token. Move the collapsed bar's hover background to a slightly stronger accent tint. After the swap, eyeball the progress bar (the unfilled `bg-surface` track and the `bg-accent` fill) and the `bg-warning/10` "in progress" badge against the new tinted base; adjust alpha if either loses contrast.
- **Patterns to follow:** Alpha-modulated semantic tokens are the established pattern — `bg-warning/10` already lives in this same component, and `bg-accent/20` / `bg-surface-hover/50` appear elsewhere. Follow that convention rather than introducing a new CSS variable.
- **Test scenarios:** Test expectation: none — pure styling change with no behavioral logic to assert; visual distinction is verified manually per the Verification checklist below.
- **Verification:**
  - Light mode: collapsed task bar shows a clearly visible warm tint distinct from the cream chat background; expanded popup matches.
  - Dark mode: collapsed and expanded states show a subtle warm tint distinct from the near-black chat background.
  - Hover on the collapsed bar deepens the tint noticeably but stays within the accent family.
  - Progress-bar fill and unfilled track remain clearly distinguishable over the tinted background.
  - The "in progress" badge does not clash with the accent tint.
  - Completed/dimmed rows (`opacity-50`) and failed (`text-destructive`) text remain readable.

## Scope Boundaries

### Deferred to Follow-Up Work

- Repainting other inline surfaces (chat header strip, status bar) for visual hierarchy — out of scope; this plan targets the TaskPanel only.
- The `bg-surface` convention used by Sidebar and SubagentDrawer is untouched.
- A user-facing setting to toggle tint intensity is not pursued.
