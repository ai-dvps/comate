---
date: 2026-06-20
topic: subagent-brief-status-metrics
---

# Subagent Brief Status Metrics

## Summary

Make elapsed duration and called-tool count always visible on the brief subagent status card by surfacing them in a compact sub-header below the agent label. Remove the duplicate metrics row from the collapsible body so the same information appears exactly once.

## Problem Frame

`SubagentDrawer` already shows elapsed duration and tool count in its header, but `SubagentBriefStatus` only reveals them inside the collapsible body — and only when the body has content. Users who do not expand the brief status cannot tell how long a subagent has been running or how many tools it has used. Meanwhile, when the body is expanded, the same two values appear again in a meta row, creating redundant duplication.

## Requirements

- R1. `SubagentBriefStatus` must display the subagent's elapsed duration in a sub-header directly below the agent label.
- R2. `SubagentBriefStatus` must display the number of tools the subagent has called in the same sub-header.
- R3. The metrics must update in real time while the subagent is running and must remain accurate after the subagent completes.
- R4. The duplicate elapsed-duration / tool-count meta row inside the collapsible body must be removed.
- R5. The sub-header must be visible even when the collapsible body has no content and is not rendered.
- R6. The sub-header text must use compact, secondary styling so it does not compete with the agent label or status badge.

## Acceptance Examples

- AE1. **Covers R1, R2, R5.** Given a running `Agent` tool invocation with no description, prompt, or result, the brief status card shows the agent label followed by a sub-header reading "0s • 0 tools" and renders no collapsible body.
- AE2. **Covers R1, R2, R3, R4, R6.** Given a running subagent with a description, the card shows a muted sub-header with live duration and tool count. Expanding the body reveals the description, prompt, and/or result, but no longer shows a separate elapsed-time / tool-count meta row.

## Scope Boundaries

- `SubagentDrawer` is out of scope — it already displays these metrics and requires no change.
- New metrics such as token count or cost are out of scope.
- The progress hint remains inside the collapsible body and is not moved to the sub-header.
- Subagent data model, SSE event shape, lifecycle, and panel behavior are out of scope.

## Key Decisions

- **Sub-header below the agent label instead of inline with the badge.** Rationale: the top row is already occupied by the agent label, status badge, and open button; adding metrics there would crowd the header on narrow viewports.
- **Remove the duplicate meta row from the collapsible body.** Rationale: surfacing the metrics in the sub-header makes them visible at all times, so keeping the body row would duplicate the same information.

## Dependencies / Assumptions

- `SubagentState` continues to expose `startTime`, `endTime`, and `toolCount`.
- The existing `formatDuration` helper and `toolCount` i18n keys in `src/client/i18n/{en,zh-CN}/chat.json` are reused.
