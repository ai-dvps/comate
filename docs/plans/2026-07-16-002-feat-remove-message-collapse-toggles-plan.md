---
title: Remove Message List Text/Result Collapse Toggles - Plan
type: feat
date: 2026-07-16
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Remove Message List Text/Result Collapse Toggles - Plan

## Goal Capsule

- **Objective:** In the session message list, assistant text parts and generic tool-result bodies always render fully, with no "Show more/Show less" or "Show details/Hide details" toggle.
- **Authority:** Existing `ai-elements` component patterns and `CLAUDE.md` front-end conventions.
- **Stop conditions:** Toggles removed from `CompactableText` and `ToolContent`; search-match highlight rings still work; `SubagentBriefStatus`, `StructuredReport`, `ApprovalSurface`, and `StreamingToolInputPreview` remain unchanged.
- **Execution profile:** Lightweight front-end change; no server or Tauri work.

## Product Contract

### Summary

Remove the collapse toggles on assistant text and tool-result bodies in the message list so all content is visible immediately.

### Problem Frame

Assistant text longer than `384px` and every generic tool card body are currently collapsed by default. Users must click to read the full content, which is no longer desired in the message list.

### Requirements

- R1. Assistant text in the message list always renders its full content; no "Show more"/"Show less" toggle appears.
- R2. Generic tool-result card bodies in the message list always render their full content; no "Show details"/"Hide details" toggle appears.
- R3. Search-match highlight rings and current-match styling continue to work for text and tool-result bodies.
- R4. `SubagentBriefStatus`, `StructuredReport`, `ApprovalSurface`, and `StreamingToolInputPreview` keep their existing collapse behavior.

### Scope Boundaries

- **In scope:** `CompactableText`, `CompactableContainer`, `ToolContent`, and the `ChatMessageRenderer` call sites.
- **Deferred to follow-up work:** removing now-unused `chat:showMore`/`chat:showLess` i18n keys; adding a user preference to re-enable collapsing.

## Planning Contract

### Key Technical Decisions

- KTD1. Add an `alwaysExpanded` prop to `CompactableContainer` instead of changing its default behavior, because `SubagentBriefStatus` also consumes it and must stay collapsible.
- KTD2. Simplify `CompactableText` to a stateless wrapper around `<Response>` that keeps search-match ring support, because it has no other consumers.
- KTD3. Remove the `forceExpanded` prop from `ChatMessageRenderer` calls to `CompactableText` and `ToolContent` (content is always expanded now), but keep forwarding `hasSearchMatch` and `isCurrentSearchMatch` for ring styling.

## Implementation Units

### U1. Make assistant text always expanded

- **Goal:** Remove collapse behavior from `CompactableText` so assistant text renders fully.
- **Requirements:** R1, R3.
- **Dependencies:** None.
- **Files:**
  - `src/client/components/ai-elements/compactable-text.tsx`
  - `src/client/components/ChatMessageRenderer.tsx`
  - `src/client/components/ai-elements/compactable-text.test.tsx` (new)
- **Approach:** Remove `useState`, `useEffect`, `ResizeObserver`, the `maxHeight` wrapper, and the toggle button. Keep the outer div with search-match ring classes and the `<Response>` child. Remove `forceExpanded` from the `CompactableText` call in `ChatMessageRenderer`.
- **Patterns to follow:** Existing `cn()` usage and search-match ring classes (`ring-1`, `bg-accent/5`, `ring-accent`, `ring-accent/30`).
- **Test scenarios:**
  - Long assistant text renders in full without a "Show more" button.
  - No toggle button is present in the document.
  - Search-match rings are still applied when `hasSearchMatch` is true.
  - Existing `ChatMessageRenderer` tests continue to pass.
- **Verification:** New component test passes and existing tests are green.

### U2. Make tool-result bodies always expanded

- **Goal:** Remove collapse behavior from generic tool-result card bodies.
- **Requirements:** R2, R3.
- **Dependencies:** None (can be done in parallel with U1).
- **Files:**
  - `src/client/components/ai-elements/compactable-container.tsx`
  - `src/client/components/ai-elements/tool.tsx`
  - `src/client/components/ai-elements/compactable-container.test.tsx` (new)
  - `src/client/components/ai-elements/tool.test.tsx` (update)
- **Approach:** Add an optional `alwaysExpanded` prop to `CompactableContainer`. When true, skip the `ResizeObserver`, omit `maxHeight`, and do not render the toggle. Update `ToolContent` to pass `alwaysExpanded` and remove `compactHeight={0}` and `alwaysShowToggle`. Keep forwarding `hasSearchMatch`/`isCurrentSearchMatch` for styling.
- **Patterns to follow:** Preserve default `CompactableContainer` behavior so `SubagentBriefStatus` is unaffected.
- **Test scenarios:**
  - `CompactableContainer` with `alwaysExpanded` renders children fully and has no toggle.
  - Default `CompactableContainer` still shows the toggle and expands/collapses on click.
  - `ToolContent` renders tool input and output fully with no "Show details"/"Hide details" button.
  - Search-match rings are still applied to `ToolContent`.
- **Verification:** New and updated component tests pass.

### U3. Clean up obsolete props in `ChatMessageRenderer`

- **Goal:** Remove now-unnecessary `forceExpanded` props while preserving search-match ring support.
- **Requirements:** R3.
- **Dependencies:** U1, U2.
- **Files:**
  - `src/client/components/ChatMessageRenderer.tsx`
- **Approach:** Drop `forceExpanded={isCurrentInPart}` from the `CompactableText` and `ToolContent` calls. Continue passing `hasSearchMatch` and `isCurrentSearchMatch`.
- **Patterns to follow:** Keep the existing `getPartSearchRanges` usage and `HighlightText` behavior for other part types.
- **Test scenarios:**
  - Existing `ChatMessageRenderer` search-highlight tests pass.
  - Tool input/output code blocks still receive search-match styling.
- **Verification:** `ChatMessageRenderer` test suite passes.

## Verification Contract

- Run `npm run lint`.
- Run `npm run test:client` to exercise jsdom component tests.
- Manual smoke check (optional): open a session with long assistant text and a tool result and confirm no toggle is shown and all content is visible.

## Definition of Done

- `CompactableText` and `ToolContent` never render collapse toggles in the message list.
- `SubagentBriefStatus`, `StructuredReport`, `ApprovalSurface`, and `StreamingToolInputPreview` still collapse as before.
- All added and updated tests pass; lint passes.
- No dead code from the removed collapse logic remains in the changed files.
