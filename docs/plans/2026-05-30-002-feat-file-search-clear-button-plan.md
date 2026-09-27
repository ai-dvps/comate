---
title: Add Clear Button to Files Tab Search
type: feat
status: completed
date: 2026-05-30
origin: docs/brainstorms/2026-05-29-file-search-and-resizable-file-panel-requirements.md
---

# Add Clear Button to Files Tab Search

## Summary

Add a one-click clear button to the search input in the Files tab so users can reset the query and return to the folder tree without manually backspacing.

## Requirements

- R1. The Files tab search input displays a clear button when it contains text
- R2. Clicking the clear button empties the search input and restores the folder tree view
- R3. The clear button follows the existing visual pattern used in the chat input area

**Origin actors:** A1 (User)
**Origin flows:** F1 (Search for a file)

## Scope Boundaries

- Keyboard shortcuts (Escape to clear) are not included
- Auto-focus behavior changes are not included
- Search debounce timing is not changed

## Context & Research

### Relevant Code and Patterns

- `src/client/components/FileExplorer.tsx` — Contains the search input (lines 200–209). Already manages `searchQuery` local state and calls `clear()` from `useFiles` when the input is emptied.
- `src/client/components/PromptInput.tsx` (lines 394–402) — Existing clear-button pattern: conditionally rendered `X` icon from `lucide-react`, styled `text-text-tertiary hover:text-text-primary`, with a `title` attribute.
- `src/client/i18n/en/common.json` and `src/client/i18n/zh-CN/common.json` — No existing `"clear"` key in the `common` namespace; the PromptInput uses the `chat` namespace.

### Institutional Learnings

- The `useFiles` hook exposes a `clear()` function that resets search results and is already invoked when the user backspaces the input to empty.

## Key Technical Decisions

- **Reuse `PromptInput` clear-button pattern rather than invent a new style:** Consistency with the chat input's clear affordance keeps the UI predictable.
- **Add `"clear"` to `common` i18n namespace:** FileExplorer already loads the `common` namespace; adding the key there avoids mixing namespaces and keeps the component simple.

## Implementation Units

### U1. Add clear button to FileExplorer search input

**Goal:** Display a one-click clear button inside the Files tab search box that empties the query and returns to the tree view.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Modify: `src/client/components/FileExplorer.tsx`
- Modify: `src/client/i18n/en/common.json`
- Modify: `src/client/i18n/zh-CN/common.json`

**Approach:**
- Import `X` from `lucide-react` in `FileExplorer.tsx`
- Wrap the search input in a `relative` container so the clear button can be absolutely positioned at the right edge
- Conditionally render the clear button when `searchQuery.length > 0`
- On click, call `setSearchQuery('')` and `clear()` to reset state and results
- Style the button to match `PromptInput`: `text-text-tertiary hover:text-text-primary`, small padding, rounded
- Add `title={t('clear')}` for accessibility
- Add `"clear": "Clear"` to `en/common.json` and `"clear": "清除"` to `zh-CN/common.json`

**Patterns to follow:**
- `src/client/components/PromptInput.tsx` — clear button markup, styling, and conditional visibility

**Test scenarios:**
- Happy path: typing text in the search input reveals the clear button; clicking it empties the input and returns the view to the folder tree
- Edge case: the clear button is hidden when the search input is empty
- Edge case: clicking clear while search results are loading aborts the in-flight search and shows the tree
- Integration: after clearing, typing a new query performs a fresh search correctly

**Verification:**
- Clear button appears only when search input has text
- Clicking the button empties the input and restores the folder tree
- No visual regressions in search input or results list
- i18n strings load correctly in both English and Chinese

## System-Wide Impact

- **Unchanged invariants:** Search debounce, AbortController race handling, `useFiles` store behavior, file tree loading, and file click handling are unaffected.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Clear button overlaps with long search text | Position with `right` padding on the input or absolute-position the button inside a relative wrapper; keep the button small (w-3.5 h-3.5) |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-29-file-search-and-resizable-file-panel-requirements.md](docs/brainstorms/2026-05-29-file-search-and-resizable-file-panel-requirements.md)
- Related plan: [docs/plans/2026-05-29-003-feat-file-search-and-resizable-panel-plan.md](docs/plans/2026-05-29-003-feat-file-search-and-resizable-panel-plan.md)
- Related code:
  - `src/client/components/FileExplorer.tsx`
  - `src/client/components/PromptInput.tsx`
