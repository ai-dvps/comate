---
title: fix: Add tooltip to truncated file paths in FilePicker popup
type: fix
status: completed
date: 2026-06-11
---

# fix: Add tooltip to truncated file paths in FilePicker popup

## Summary

Add a native `title` attribute to file path spans in the `FilePicker` popup so hovering reveals the full path when truncation hides it. This follows existing codebase patterns and requires no new dependencies.

---

## Requirements

- R1. Users can view the complete file path for any truncated entry in the file picker popup.

---

## Scope Boundaries

- Out of scope: Widening the popup, creating a custom tooltip component, or restyling the FilePicker.
- Out of scope: Changes to file search behavior, indexing, or the data returned by the search API.

---

## Context & Research

### Relevant Code and Patterns

- `src/client/components/FilePicker.tsx` — The popup renders each result with `<span className="truncate">{entry.path}</span>` (line 239). The `truncate` Tailwind utility clips overflow with ellipsis inside the fixed `w-[360px]` popover.
- `src/client/components/SessionList.tsx` and `src/client/components/FileExplorer.tsx` — Both use native `title` attributes for hover tooltips (e.g., `title={t('renameSession')}`, `title={t('clear')}`), establishing the project's lightweight tooltip pattern.
- No custom Tooltip primitive exists in `src/client/components/ui/`.

### Institutional Learnings

- None relevant.

### External References

- None required.

---

## Key Technical Decisions

- **Native `title` attribute over custom tooltip**: The codebase already uses `title` for tooltips, and a native attribute is accessible, requires zero dependencies, and avoids introducing a new UI primitive for a single-element fix.

---

## Implementation Units

### U1. Add title attribute to file path rows

**Goal:** Enable users to see the full file path on hover when the displayed path is truncated.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `src/client/components/FilePicker.tsx`

**Approach:**
- Add `title={entry.path}` to the `<span>` that renders the file path inside each result row.

**Patterns to follow:**
- `SessionList.tsx` and `FileExplorer.tsx` — native `title` attribute usage.

**Test scenarios:**
- Test expectation: none — DOM attribute change verified by manual inspection in browser.

**Verification:**
- Open the file picker (type `@` or click the Files button), find or create a result with a long path, hover over the truncated path, and confirm the browser-native tooltip displays the complete path.

---

## Sources & References

- Related code: `src/client/components/FilePicker.tsx`
