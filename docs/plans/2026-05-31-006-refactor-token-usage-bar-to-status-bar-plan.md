---
title: Refactor TokenUsageBar into StatusBar container with independent components
type: refactor
status: active
date: 2026-05-31
---

# Refactor TokenUsageBar into StatusBar Container with Independent Components

## Summary

Refactor `TokenUsageBar` into a layout-only `StatusBar` container, extracting folder path, git branch, and token usage into self-contained presentational components. Each child manages its own data and rendering; the parent only handles flex layout.

## Problem Frame

`TokenUsageBar` currently mixes four distinct concerns in one file: workspace path display, git ref polling and display, session token usage calculation, and context fill percentage. It also fetches workspace, session, provider, and chat store data, making it hard to reason about and reuse. The component name no longer matches its actual role as a general status bar.

## Requirements

- R1. Extract folder path display into an independent component.
- R2. Extract git branch display (including polling logic) into an independent component.
- R3. Extract token usage display (including percentage calculation) into an independent component.
- R4. Container handles only layout; no presentation or data logic.

## Scope Boundaries

- No changes to store shapes, data models, or API endpoints.
- No changes to the context percentage calculation logic.
- No new test infrastructure (component tests do not exist).
- No changes to styling tokens or Tailwind config.

### Deferred to Follow-Up Work

- Adding unit or integration tests for the extracted components — blocked by lack of component test infrastructure.

## Context & Research

### Relevant Code and Patterns

- `src/client/components/TokenUsageBar.tsx` — current monolithic component to refactor.
- `src/client/components/ChatPanel.tsx` — sole consumer of `TokenUsageBar`.
- `src/client/components/StatusIndicator.tsx` — small presentational component pattern to follow.
- `src/client/components/ui/` — Tailwind + `lucide-react` icon patterns.

### Institutional Learnings

- None relevant.

## Key Technical Decisions

- **Rename to StatusBar:** The container will be renamed from `TokenUsageBar` to `StatusBar` to match its new role. Only one import site exists (`ChatPanel.tsx`), so blast radius is minimal.
- **Self-contained child components:** Each extracted component fetches its own data from stores or APIs. The container does not act as a data broker, maximizing independence.
- **Sibling file placement:** Extracted components live as sibling files under `src/client/components/` rather than a subdirectory, matching the existing flat component structure.

## Implementation Units

### U1. Create WorkspaceFolderPath component

**Goal:** Extract the folder path display into a pure presentational component.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Create: `src/client/components/WorkspaceFolderPath.tsx`

**Approach:**
- Accept `workspaceId: string` prop.
- Read `workspaceStore` to resolve `folderPath`.
- Render `Folder` icon + truncated path with existing Tailwind classes.
- Return `null` when `folderPath` is absent.

**Patterns to follow:**
- `StatusIndicator.tsx` for default-export pattern and props interface naming.
- Existing Tailwind token usage (`text-text-tertiary`, `truncate`, `max-w-[200px]`).

**Test scenarios:**
- Test expectation: none — no component test infrastructure exists.

**Verification:**
- Component renders the same markup as the original inline block when `folderPath` exists.
- Component renders nothing when `folderPath` is absent.

### U2. Create WorkspaceGitBranch component

**Goal:** Extract the git branch display (including polling logic) into an independent component.

**Requirements:** R2

**Dependencies:** None

**Files:**
- Create: `src/client/components/WorkspaceGitBranch.tsx`

**Approach:**
- Accept `workspaceId: string` prop.
- Encapsulate the existing `useState` + `useEffect` polling logic (`fetchGitRef`, 10s interval, visibility/focus refresh).
- Render `GitBranch` icon + ref with existing Tailwind classes.
- Return `null` when `gitRef` is absent.

**Patterns to follow:**
- `StatusIndicator.tsx` for default-export pattern.
- Preserve existing cleanup behavior (clearInterval, removeEventListener).

**Test scenarios:**
- Test expectation: none — no component test infrastructure exists.

**Verification:**
- Polling interval and event listeners behave identically to the original inline block.
- Component renders nothing when `gitRef` is absent.

### U3. Create SessionTokenUsage component

**Goal:** Extract the token usage and context fill percentage display into an independent component.

**Requirements:** R3

**Dependencies:** None

**Files:**
- Create: `src/client/components/SessionTokenUsage.tsx`

**Approach:**
- Accept `sessionId: string` and `modelUsage?: Record<string, unknown>` props.
- Read `chatStore` (`sessionUsage`, `lastTurnUsage`) and `providerStore` to resolve model and cumulative usage.
- Calculate `totalTokens = cumulativeInput` and `fillPercentage = min(round(totalTokens / contextWindow * 100), 100)`.
- Render session token display (`in <input> / out <output>`) and context fill percentage.
- Render `—` when no cumulative data exists.

**Patterns to follow:**
- `StatusIndicator.tsx` for default-export pattern.
- Preserve existing `fmt` helper behavior.

**Test scenarios:**
- Test expectation: none — no component test infrastructure exists.

**Verification:**
- Percentage calculation matches the current logic exactly.
- Missing-data state renders `—` as before.

### U4. Rename TokenUsageBar to StatusBar and restructure as container

**Goal:** Replace the monolithic component with a layout-only container that composes the three extracted children.

**Requirements:** R4

**Dependencies:** U1, U2, U3

**Files:**
- Create: `src/client/components/StatusBar.tsx`
- Delete: `src/client/components/TokenUsageBar.tsx`
- Modify: `src/client/components/ChatPanel.tsx`

**Approach:**
- Create `StatusBar.tsx` accepting `sessionId`, `workspaceId`, and optional `modelUsage`.
- Import and render `WorkspaceFolderPath`, `WorkspaceGitBranch`, and `SessionTokenUsage` in the original left/right flex layout.
- Remove all store access, useEffect logic, and percentage calculation from the container.
- Update `ChatPanel.tsx` to import `StatusBar` instead of `TokenUsageBar`.

**Patterns to follow:**
- Existing `TokenUsageBar` flex layout (`justify-between`, `gap-3`, `border-t`).

**Test scenarios:**
- Test expectation: none — no component test infrastructure exists.

**Verification:**
- `ChatPanel.tsx` compiles and imports `StatusBar`.
- Visual layout matches the original exactly.
- No runtime errors from deleted `TokenUsageBar.tsx`.

## System-Wide Impact

- **Interaction graph:** `ChatPanel.tsx` is the only consumer; no other callbacks or observers affected.
- **Unchanged invariants:** Store shapes, API endpoints, context percentage calculation, and styling tokens are untouched.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `TokenUsageBar` imported elsewhere unexpectedly | Verified via grep — only `ChatPanel.tsx` imports it. |

## Sources & References

- Related code: `src/client/components/TokenUsageBar.tsx`, `src/client/components/ChatPanel.tsx`, `src/client/components/StatusIndicator.tsx`
