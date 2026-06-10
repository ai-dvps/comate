---
date: 2026-06-10
topic: wecom-session-auto-rename
---

# WeCom Session Auto-Rename on User ID Resolution

## Summary

Auto-rename WeCom sessions when encrypted user IDs are resolved to plaintext. Session titles follow `<user> session` or `<user> session #N` per workspace, with dynamic renumbering and preservation of user-customized titles. Includes a one-time backfill for existing resolved sessions.

---

## Problem Frame

Currently, WeCom sessions are created with the encrypted WeCom user ID as the session name. These encrypted IDs are opaque and hard to read (e.g., `wmxxxxxxxxxxxxxxxx`). When the resolver successfully maps an encrypted ID to a plaintext user ID, the session title remains stuck with the encrypted value. This creates a poor experience for workspace admins who see a list of sessions named with unreadable identifiers instead of recognizable usernames.

---

## Actors

- A1. **Workspace admin / GUI user**: Views the session list and relies on session titles to identify conversations.
- A2. **WeCom user**: The end user messaging via WeCom; their plaintext ID is the desired session title.
- A3. **Resolver system**: Batch process that maps encrypted WeCom user IDs to plaintext via the WeCom API.

---

## Key Flows

- F1. **New mapping resolution**
  - **Trigger:** The batch resolver successfully resolves an encrypted WeCom user ID to plaintext and stores the mapping.
  - **Actors:** A3
  - **Steps:**
    1. Resolver stores the mapping in `wecom_user_id_mappings`.
    2. System finds all WeCom sessions for that user in the workspace.
    3. For sessions without user-customized titles, system renames them using the plaintext ID and current per-workspace session count.
    4. If the session count for this user changes, existing sessions are renumbered accordingly.
  - **Outcome:** All eligible WeCom sessions for the user have readable titles.
  - **Covered by:** R1, R2, R3, R4, R5, R6

- F2. **New WeCom session creation**
  - **Trigger:** A WeCom user sends a message and a new session is created for a user who already has sessions.
  - **Actors:** A2, A3
  - **Steps:**
    1. Session is created for the WeCom user.
    2. If the plaintext ID is already known, the session title is set using the current count.
    3. If this changes the session count for the user, existing sessions are renumbered.
  - **Outcome:** New sessions join the numbered sequence; existing sessions are updated if needed.
  - **Covered by:** R1, R2, R3, R5, R6

- F3. **Retroactive backfill**
  - **Trigger:** Deployment of this feature (one-time).
  - **Actors:** A3
  - **Steps:**
    1. System scans all WeCom sessions with resolved mappings.
    2. For sessions that still have their original encrypted-ID name and no custom title, renames them using the plaintext ID and current count.
  - **Outcome:** Existing resolved sessions are brought into the new naming scheme.
  - **Covered by:** R7

---

## Requirements

**Session title format**

- R1. WeCom session titles for a given user in a workspace shall use the format `<plaintext_user_id> session` when the user has exactly one session in that workspace.
- R2. When a user has more than one session in a workspace, each title shall use `<plaintext_user_id> session #<seq_no>`, where `<seq_no>` is a 1-based index ordered by session creation time (oldest = #1).
- R3. If a session's count changes (e.g., a new session is created), all eligible sessions for that user in the workspace shall be renumbered to maintain sequential correctness.

**Eligibility and preservation**

- R4. Sessions with a user-set custom title shall never be auto-renamed.
- R5. Only sessions created via WeCom (`source === 'wecom'`) are eligible for auto-renaming.
- R6. For the backfill and ongoing renames, only sessions whose current stored name matches the original encrypted WeCom user ID are eligible for auto-renaming.

**Backfill**

- R7. On feature deployment, all existing WeCom sessions with already-resolved plaintext mappings shall be evaluated and renamed if eligible per R4, R5, and R6.

---

## Acceptance Examples

- AE1. **Covers R1, R4, R6.** Given a workspace where WeCom user `wm123` has one session with name `wm123` and no custom title, when the resolver maps `wm123` → `john.doe`, then the session is renamed to `john.doe session`.
- AE2. **Covers R2, R3, R5, R6.** Given a workspace where WeCom user `wm123` has two sessions (S1 created Jan 1, S2 created Feb 1) both named `wm123`, when the resolver maps `wm123` → `john.doe`, then S1 is renamed to `john.doe session #1` and S2 is renamed to `john.doe session #2`.
- AE3. **Covers R3, R4.** Given `john.doe` already has session `john.doe session` in a workspace, when a second WeCom session is created for `john.doe`, then the first session is renamed to `john.doe session #1` and the new session is named `john.doe session #2`.
- AE4. **Covers R4.** Given a WeCom session for `john.doe` with a custom title set by the user to `"Project Alpha"`, when the resolver maps the user ID or a new session is created, then the session keeps the title `"Project Alpha"`.
- AE5. **Covers R5, R6.** Given a GUI-created session named `wm123` for the same user, when the resolver maps `wm123` → `john.doe`, then the GUI session is not renamed.
- AE6. **Covers R7.** Given a workspace with 10 existing WeCom sessions that have resolved mappings and still have their original encrypted-ID names, when the feature is deployed, then all 10 sessions are renamed according to R1–R3.

---

## Success Criteria

- Workspace admins can identify WeCom sessions by readable plaintext user IDs instead of encrypted identifiers.
- No user-customized session titles are lost or overwritten by the auto-rename logic.
- Existing sessions with resolved mappings are backfilled without manual intervention.

---

## Scope Boundaries

- GUI-created sessions are not affected by this feature.
- No opt-out toggle for auto-renaming is provided.
- Session deletion does not trigger renumbering of remaining sessions (new session creation or resolution does).
- Unresolved mappings (encrypted IDs with no known plaintext) remain unchanged.

---

## Key Decisions

- **Dynamic renumbering over fixed assignment:** When the session count for a user changes, existing sessions are renumbered. This keeps the numbering intuitive and sequential but means titles can change over time.
- **Preserve custom titles over uniform naming:** Sessions with user-set custom titles are excluded from auto-rename. This respects user intent at the cost of some sessions not following the uniform pattern.
- **Chronological ordering for sequence numbers:** Sessions are numbered by creation time (oldest = #1). This is predictable and stable across renumbers.
- **Backfill only touches default-named sessions:** For safety, the retroactive backfill only renames sessions whose name still matches the encrypted user ID. Any session that was already renamed by other means is treated as user-managed.

---

## Dependencies / Assumptions

- The WeCom user resolver (documented in `2026-05-26-wecom-user-id-resolution-requirements.md`) provides a hook or observable event when mappings are stored.
- `chatService.updateSession()` supports renaming both draft and SDK sessions.
- Session creation time is available and stable for ordering sessions in numbering.
- The session model distinguishes WeCom-origin sessions via a `source` field.

---

## Outstanding Questions

### Resolve Before Planning

- None

### Deferred to Planning

- [Affects R4][Technical] Exact mechanism for detecting a "user-set custom title" across both draft and SDK sessions.
- [Affects R7][Technical] Whether the backfill runs automatically on app startup or requires an explicit migration command.
