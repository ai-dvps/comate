---
date: 2026-05-26
topic: session-work-in-progress-tag
---

# Session Work in Progress Tag

## Summary

Add a manually-toggled "Work in progress" text badge that renders alongside the relative timestamp on session rows in the sidebar. Users set and clear the flag via a right-click context menu; the badge persists until explicitly removed and carries no functional side effects.

---

## Problem Frame

Users run many parallel sessions across workspaces and need a lightweight way to flag which ones they are actively thinking about or plan to return to. Today there is no user-controlled marker — the only session row indicators are automatic states (streaming, needs-me, finished-unread) and the `draft` badge, none of which capture the user's own intent to keep a session on their mental radar. Without a self-set marker, users rely on memory or external notes to remember which sessions are still active from their perspective, which breaks down as session count grows.

---

## Requirements

**Toggle interaction**

- R1. Right-clicking a session row in `src/client/components/SessionList.tsx` opens a context menu with a "Mark as Work in progress" option when the session is not WIP, and "Clear Work in progress" when it is.
- R2. Selecting the menu item toggles the session's WIP state immediately.
- R3. WIP state persists across reloads using the same persistence pattern as other session metadata (e.g., `isDraft`).

**Visual display**

- R4. When a session's WIP state is true, a text badge renders on the session row positioned directly alongside the relative timestamp (the `xxx min ago` area).
- R5. The WIP badge uses a distinct visual treatment from the existing `draft` pill and automatic status indicators so the three classes of tag remain distinguishable at a glance.
- R6. The WIP badge is independent of automatic session states — it may coexist on the same row as streaming, needs-me, or finished-unread indicators without precedence rules or suppression.

---

## Acceptance Examples

- AE1. **Covers R1, R2.** Given session X is not WIP, when the user right-clicks X's row and selects "Mark as Work in progress", X's WIP state becomes true and the badge appears.
- AE2. **Covers R4, R6.** Given session X is WIP and currently streaming, when the user views the session list, X's row shows both the WIP badge beside the timestamp and the automatic streaming indicator in the tag row.
- AE3. **Covers R1, R2.** Given session X is WIP, when the user right-clicks X's row and selects "Clear Work in progress", the badge disappears and X's WIP state becomes false.

---

## Success Criteria

- A user can mark any session as Work in progress and see a persistent visual reminder every time they view the sidebar.
- The badge is visually distinct from `draft` and automatic status indicators so users do not confuse user-intent markers with system-state markers.
- A downstream implementer can take this doc and `ce-plan` it without inventing the toggle mechanism, the badge placement, the persistence expectation, or the coexistence rules with existing indicators.

---

## Scope Boundaries

- No auto-clear behavior — WIP does not clear when streaming finishes, approvals resolve, or any other automatic condition changes.
- No functional effects — WIP does not pin sessions to the top, change sort order, prevent deletion, or trigger any other behavior change.
- No workspace-tab aggregation — WIP counts do not appear on workspace tabs.
- No keyboard shortcut for toggling WIP in v1.
- No bulk WIP operations (mark all, clear all).
- No integration with the existing automatic status indicator precedence rules — WIP is a separate visual layer.

---

## Key Decisions

- **Manual toggle over auto-detect:** The user wants explicit control over which sessions are flagged, not a heuristic that guesses based on streaming or pending approvals.
- **Visual-only over functional:** Keeping WIP as a pure marker avoids carrying cost (no sort logic, no pin logic, no state-machine interactions) while still solving the memory problem.
- **Timestamp placement over tag-row placement:** The user explicitly requested the badge beside the relative timestamp, separating user-intent markers from the system-state tag row that already holds `draft`, `wecom`, and automatic indicators.

---

## Dependencies / Assumptions

- Session model can accommodate a new boolean field patterned after the existing `isDraft` field on `ChatSession`.
- No context menu currently exists on session rows; this feature introduces one (verified by codebase search).
- WIP state syncs to the server and persists like other session metadata.

---

## Outstanding Questions

### Resolve Before Planning

- None.

### Deferred to Planning

- [Affects R5][Design] Exact color, text, and size of the WIP badge pill — should align with or differentiate from the existing `draft` amber badge.
- [Affects R3][Technical] Whether WIP state syncs server-side immediately or uses optimistic client-side update first; exact persistence shape (new column/field) and sync mechanism.
