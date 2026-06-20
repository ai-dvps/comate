---
title: feat: Surface elapsed time and tool count in subagent brief status
type: feat
date: 2026-06-20
origin: docs/brainstorms/2026-06-20-subagent-brief-status-metrics-requirements.md
---

# feat: Surface elapsed time and tool count in subagent brief status

## Summary

Move the elapsed-duration and called-tool-count metrics in `SubagentBriefStatus` from the collapsible body to a compact sub-header below the agent label, so they are visible without expansion. Remove the duplicate metrics row from the collapsible body.

## Problem Frame

`SubagentDrawer` already shows elapsed duration and tool count in its header, but `SubagentBriefStatus` only reveals them inside the collapsible body — and only when the body has content. Users who do not expand the brief status cannot tell how long a subagent has been running or how many tools it has used. When the body is expanded, the same two values appear again, creating redundant duplication.

## Requirements

- R1. `SubagentBriefStatus` must display the subagent's elapsed duration in a sub-header directly below the agent label.
- R2. `SubagentBriefStatus` must display the number of tools the subagent has called in the same sub-header.
- R3. The metrics must update in real time while the subagent is running and must remain accurate after the subagent completes.
- R4. The duplicate elapsed-duration / tool-count meta row inside the collapsible body must be removed.
- R5. The sub-header must be visible even when the collapsible body has no content and is not rendered.
- R6. The sub-header text must use compact, secondary styling so it does not compete with the agent label or status badge.

## Key Technical Decisions

- **Sub-header below the agent label.** The top row already holds the agent label, status badge, and open button; adding metrics there would crowd the header on narrow viewports (see origin doc).
- **Remove the duplicate body row rather than keeping both.** Once metrics are always visible, the collapsible-body meta row adds no value.
- **Reuse existing timing and i18n utilities.** `useElapsed` (defined in `SubagentBriefStatus.tsx`) and `formatDuration` from `src/client/lib/time.ts` handle live duration; `toolCount` i18n keys handle pluralization.

## Implementation Units

### U1. Add elapsed-time and tool-count sub-header to SubagentBriefStatus

- **Goal:** Make duration and tool count always visible below the agent label.
- **Requirements:** R1, R2, R3, R5, R6
- **Files:** `src/client/components/SubagentBriefStatus.tsx`
- **Approach:** Inside the header section, render a new compact sub-header under the agent-label row. Use the existing `useElapsed(subagent.startTime, isRunning)` hook for live duration and `t('toolCount', { count: subagent.toolCount })` for the tool count. Style with `text-xs text-text-secondary`, using a muted separator (`text-text-tertiary`) between duration and tool count.
- **Patterns to follow:** The drawer header in `src/client/components/SubagentDrawer.tsx` shows the same two values with a wrench icon; the brief-status version should be more compact and omit the icon to avoid visual noise.
- **Test scenarios:**
  - Running subagent shows an updating elapsed duration and the current tool count.
  - Completed subagent shows the final duration and tool count.
  - Metrics are present even when there is no description, prompt, or result.
- **Verification:** Manual inspection of a running/completed subagent card confirms the sub-header is visible and updates.

### U2. Remove duplicate metrics row from collapsible body

- **Goal:** Eliminate redundant elapsed-time / tool-count display inside the expanded body.
- **Requirements:** R4
- **Files:** `src/client/components/SubagentBriefStatus.tsx`
- **Approach:** Remove the meta row div that currently sits at the bottom of the collapsible body content. Keep the description, prompt, result, and progress hint unchanged.
- **Test scenarios:**
  - Expanded body no longer renders a separate elapsed-time / tool-count row.
  - Progress hint, when present, still renders in the body.
- **Verification:** Expanding a subagent card with content shows description/prompt/result but no duplicate metrics row.

### U3. Add unit tests for SubagentBriefStatus

- **Goal:** Cover the new always-visible metrics behavior and the removed body duplication.
- **Requirements:** R1, R2, R3, R4, R5, R6
- **Dependencies:** U1, U2
- **Files:** `src/client/components/SubagentBriefStatus.test.tsx`
- **Approach:** Create a co-located Vitest + `@testing-library/react` test file. Mock `react-i18next` and `useChatStore` so tests can render `SubagentBriefStatus` with controlled `SubagentState` values. Use Vitest's fake timers to verify that elapsed time advances while running.
- **Patterns to follow:** `src/client/components/ChatMessageRenderer.test.tsx` for Vitest + `@testing-library/react` conventions, including `vi.mock('react-i18next', ...)`.
- **Test scenarios:**
  - Covers AE1. Running subagent with no content renders the sub-header with elapsed time and tool count and does not render a collapsible body.
  - Covers AE2. Running subagent with a description renders the sub-header and, when expanded, shows the description without a duplicate metrics row.
  - Completed subagent renders the final elapsed time and tool count.
  - Elapsed time increments on each timer tick while the subagent is running.
- **Verification:** `npm run test:client` passes for the new test file.

## Scope Boundaries

- `SubagentDrawer` is unchanged — it already displays these metrics.
- New metrics such as token count or cost are out of scope.
- The progress hint remains inside the collapsible body and is not moved to the sub-header.
- Subagent data model, SSE event shape, lifecycle, and panel behavior are out of scope.

## Sources / Research

- `src/client/components/SubagentBriefStatus.tsx` — component to modify; contains the existing `useElapsed` hook.
- `src/client/components/SubagentDrawer.tsx` — reference for how the drawer already surfaces duration and tool count.
- `src/client/lib/time.ts` — `formatDuration` helper.
- `src/client/i18n/{en,zh-CN}/chat.json` — existing `toolCount_one` / `toolCount_other` i18n keys.
- `src/client/components/ChatMessageRenderer.test.tsx` — testing conventions for Vitest + `@testing-library/react` with mocked i18n.
- `docs/solutions/conventions/commit-plan-and-brainstorm-files-with-code-changes.md` — plan files should be committed alongside code changes.
