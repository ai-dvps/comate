---
date: 2026-06-14
topic: session-archive-feature
---

# Session Archive Feature

## Summary

Add an archive state to chat sessions that hides stale or user-flagged sessions from the sidebar by default. Sessions archive via right-click context menu or automatically after a configurable inactivity threshold (default 14 days, WIP-exempt); an "Archived" tag renders next to the timestamp, a checkbox near the search input toggles archived-session visibility, and any session activity (click, message, approval, stream completion) auto-clears the flag.

---

## Problem Frame

As sessions accumulate across workspaces, the sidebar list becomes dominated by stale conversations the user is no longer actively working in. Every session the user has ever opened competes for the same visual real estate as the handful they actually return to, forcing them to scroll past or mentally filter dormant sessions on every visit. The existing WIP tag lets users mark sessions they want to keep visible; there is no symmetric way to demote sessions they want out of the way without deleting them.

---

## Requirements

**Archive state and lifecycle**

- R1. A session carries an archived state that persists across reloads using the same persistence pattern as other session metadata (e.g., `isDraft`, `isWip`).
- R2. The default sessions list hides archived sessions. They are absent from the rendered list unless the show-archived filter is enabled.
- R3. Any event that updates the session's `lastActivityAt` (clicking the session, sending a message, resolving an approval, finishing a stream) clears the archived state. The session returns to the default list at its naturally sorted position.

**Manual archive**

- R4. Right-clicking a session row opens a context menu containing "Archive" when the session is not archived, and "Unarchive" when it is.
- R5. Selecting the menu item toggles the session's archived state immediately (optimistic client update, then server sync), patterned after the existing WIP toggle.
- R6. Manually archiving a WIP session is allowed. Archive and WIP are independent user-set flags that may coexist; archive does not clear WIP, and unarchive does not restore a cleared WIP. The WIP-only-exemption rule (R8) covers automatic archiving, not manual.

**Automatic archive**

- R7. Sessions whose `lastActivityAt` is older than the user-configurable age threshold are automatically marked archived. The default threshold is 14 days.
- R8. Sessions currently marked WIP are exempt from automatic archiving regardless of age. Manual archiving a WIP session (R6) remains allowed.
- R9. The auto-archive check runs at session list load (fetch or refresh) so the user sees a consistent state on entry, without waiting for a background timer.
- R10. Automatic archiving never deletes sessions or their messages; it only flips the archived flag.

**Visibility filter**

- R11. A "Show archived" checkbox (or equivalent toggle) renders near the session search input.
- R12. The checkbox defaults to unchecked. Checking it includes archived sessions in the list, sorted by `lastActivityAt` alongside non-archived ones.
- R13. The checkbox state resets to unchecked when switching workspaces, mirroring how the search query resets today.

**Visual indicator**

- R14. When a session's archived state is true and the user is viewing archived sessions, an "Archived" tag renders on the session row positioned directly alongside the relative timestamp.
- R15. The Archived tag uses a distinct visual treatment from the existing `draft`, `wip`, and automatic status indicators so all tag classes remain distinguishable at a glance.
- R16. The Archived tag is independent of automatic session states — it may coexist on the same row as streaming, needs-me, or finished-unread indicators without precedence rules or suppression.

**Threshold configuration**

- R17. The auto-archive threshold is a user-configurable integer (days) exposed in app-level settings alongside other personal preferences (e.g., font size, modifier-to-submit).
- R18. The setting defaults to 14 days on first run. Changing the value does not retroactively re-archive or unarchive sessions until the next session list load triggers the auto-archive check.

---

## Key Decisions

- **Manual + auto hybrid over either alone.** Auto handles stale-session cleanup without user effort; manual handles intent for sessions the user wants out of the way regardless of age. Both paths set the same flag so reactivation logic is unified.
- **WIP blocks auto-archive, not manual archive.** WIP expresses user intent to keep a session on their radar; auto-archiving it would defeat that intent. Explicit manual archive is still allowed and does not tamper with the WIP flag — the user's deliberate action and the WIP marker are independent.
- **App-level threshold over workspace-level.** Threshold is a personal list-management preference; tying it to workspace identity would force users to reconfigure it per workspace without clear value.
- **Reactivation follows existing `lastActivityAt` updates.** No new "unarchive on click" code path; any activity that already bumps `lastActivityAt` (including merely clicking the session) clears the flag. This matches the user's description: "once an archived session becomes active again, the tag should be removed."
- **Auto-archive runs at list load, not in the background.** Avoids a separate timer or job, and the user always sees the same state on entry. May cause a brief re-render on first load after crossing the threshold; trade-off accepted for simplicity.

---

## Acceptance Examples

- AE1. **Covers R4, R5.** Given session X is not archived, when the user right-clicks X's row and selects "Archive", X's archived state becomes true and X disappears from the default list.
- AE2. **Covers R7, R8.** Given session Y has had no activity for 20 days and the threshold is 14, when the user loads the session list, Y is archived. Given session Z is WIP and has had no activity for 30 days, when the user loads the list, Z remains unarchived.
- AE3. **Covers R3.** Given session X is archived and the user has enabled "Show archived", when the user clicks X's row, X's archived state becomes false, the Archived tag disappears, and X remains in the default list on next load even after unchecking "Show archived".
- AE4. **Covers R11, R12, R13.** Given the user is viewing workspace A with the show-archived checkbox checked, when the user switches to workspace B, the checkbox is unchecked and archived sessions in B are hidden.
- AE5. **Covers R6.** Given session W is WIP and not archived, when the user right-clicks W's row and selects "Archive", W's archived state becomes true and W's WIP state remains unchanged.
- AE6. **Covers R14, R15, R16.** Given session X is archived and currently streaming, when the user views the session list with "Show archived" checked, X's row shows both the Archived tag beside the timestamp and the automatic streaming indicator in the tag row, with the Archived tag visually distinct from `draft`, `wip`, and automatic status indicators.

---

## Success Criteria

- Users can keep their working session list short without deleting old conversations.
- Both cleanup paths (manual for intent, auto for stale) are available and produce the same end state.
- Reactivation is frictionless: any return to an archived session restores it to the working list.
- A downstream implementer can take this doc and plan implementation without inventing the trigger model, filter behavior, reactivation semantics, or coexistence rules with existing indicators.

---

## Scope Boundaries

- No bulk archive operations (select multiple, archive all).
- No keyboard shortcut for archive toggle in v1.
- No archive count badge on workspace tabs.
- No search-across-archived enhancement: the existing name search already applies to whatever sessions are visible (including archived when the filter is checked). No separate indexed search.
- No expiration or auto-deletion of archived sessions. Archived is reversible; deletion is a separate concern.
- No distinction between "auto-archived" and "manually archived" in the stored state or UI. The flag is binary; the source is forgotten once set.

---

## Dependencies / Assumptions

- The session model can accommodate a new boolean field patterned after `isWip` / `isDraft`.
- The existing `lastActivityAt` map already updates on the reactivation events listed in R3; no new update points are required.
- App settings storage can accommodate one new integer field alongside the existing personal preferences.
- Auto-archive reads the configured threshold from app settings at session list load time.

---

## Outstanding Questions

### Resolve Before Planning

- None.

### Deferred to Planning

- [Affects R11][Design] Exact placement and visual treatment of the "Show archived" checkbox relative to the search input (inline icon-toggle, adjacent checkbox, or below-input chip).
- [Affects R15][Design] Exact color, text, and size of the "Archived" tag — should align with or differentiate from the existing `draft` amber and `wip` purple pills.
- [Affects R7, R9][Technical] Whether auto-archive runs server-side at fetch (so other clients see the same state) or client-side after fetch (simpler but each client flips independently until sync). Manual archive clearly must hit the server; auto-archive has more flexibility.
- [Affects R18][UX] Whether changing the threshold triggers an immediate re-evaluation or waits for the next natural list load.
