---
title: fix: Change WeCom bot upload directory to data/<user-id>
type: fix
date: 2026-06-24
origin: docs/brainstorms/2026-06-12-wecom-bot-file-handling-requirements.md
---

# fix: Change WeCom bot upload directory to data/<user-id>

## Summary

Move downloaded WeCom media files from `<workspace>/<user-id>` to `<workspace>/data/<user-id>`. Align the bot tool-permission scope to the same `data/<user-id>` directory so the agent can read and write files it receives.

---

## Problem Frame

The origin requirements doc specified that bot uploads land directly under the workspace root per user. The proactive WeCom send-file feature already validates paths under `data/<user-folder>` as the user-scoped area. Storing received files in the workspace root creates an asymmetry: files the bot is allowed to send live in `data/`, while files it receives live at the root. Moving received files into `data/<user-id>` makes receive/send paths consistent and keeps user data out of the workspace root.

---

## Requirements

- R1. Downloaded WeCom media files are saved under `<workspace>/data/<user-folder>` (updates origin R3).
- R2. The workspace-relative path included in the agent prompt includes the `data/` prefix (updates origin R5).
- R3. Bot tool write/read scope treats `<workspace>/data/<user-folder>` as the user's directory.
- R4. Existing files already saved under the old `<workspace>/<user-folder>` path are not migrated.

---

## Key Technical Decisions

- KTD1. Use a literal `data/` segment under the workspace root for all per-user WeCom file storage. Rationale: matches the existing `wecom-send-file-policy.ts` isolation boundary and keeps the workspace root uncluttered.
- KTD2. Align `bot-path-policy.ts` `userDir` and other-user checks with the same `data/<user-folder>` layout. Rationale: files received by the bot must remain inside the agent's writable zone; otherwise the bot could not edit a file it just saved.
- KTD3. Do not migrate existing files. Rationale: user opted to leave existing uploads in place; new behavior applies to new uploads only.

---

## Implementation Units

### U1. Update origin requirements doc

**Goal:** Keep the requirements doc consistent with the new storage path.

**Requirements:** R1, R2

**Files:** `docs/brainstorms/2026-06-12-wecom-bot-file-handling-requirements.md`

**Approach:** Edit R3 and AE1 (and AE3 if it references the old path) to describe `data/<user-id>` instead of `<user-id>`. Leave other requirements unchanged.

**Test scenarios:** none — documentation update.

**Verification:** The doc no longer describes the old root-level user folder path.

### U2. Update `saveMediaFile` storage path

**Goal:** Save downloaded media under `data/<user-folder>`.

**Requirements:** R1, R2

**Files:** `src/server/services/wecom-file-storage.ts`, `src/server/services/wecom-file-storage.test.ts`

**Approach:** Change `path.join(workspaceFolderPath, userFolderName)` to `path.join(workspaceFolderPath, 'data', userFolderName)`. The existing recursive `mkdir` and path-traversal validation remain unchanged. Update all test assertions that expect the relative path.

**Patterns to follow:** Existing boundary validation in `saveMediaFile` (`path.resolve` + `startsWith`).

**Test scenarios:**
- Happy path: a file named `report.pdf` uploaded by user `user-1` is saved at `data/user-1/report.pdf`.
- Collision: a second `report.pdf` is saved at `data/user-1/report-<timestamp>.pdf`.
- Encrypted user ID fallback: an unmapped user `enc-123` gets `data/enc-123/document.docx`.
- Edge case: path traversal in `userFolderName` or `filename` is still rejected.

**Verification:** `wecom-file-storage.test.ts` passes.

### U3. Update WeCom bot service integration tests

**Goal:** Make file-message integration tests expect the new relative path.

**Requirements:** R1, R2

**Dependencies:** U2

**Files:** `src/server/services/wecom-bot-service.test.ts`

**Approach:** Update saved-file assertions and prompt-string assertions from `<user>/file` to `data/<user>/file`.

**Test scenarios:**
- Plaintext user: `ZhangWei` uploads `report.pdf`; the prompt references `@data/ZhangWei/report.pdf`.
- Encrypted user: `enc-user-1` uploads `photo.png`; the prompt references `@data/enc-user-1/photo.png`.
- Custom file prompt template: `$file_name$` resolves to `data/<user>/file`.

**Verification:** `wecom-bot-service.test.ts` passes.

### U4. Align bot path policy with `data/<user-folder>`

**Goal:** Keep tool-permission boundaries consistent with the new receive path.

**Requirements:** R3

**Files:** `src/server/services/bot-path-policy.ts`, `src/server/services/bot-path-policy.test.ts`

**Approach:** Update `createPathPolicyContext` to set `userDir = path.join(workspaceFolder, 'data', userDirName)`. Update `isInOtherUserDir` and the glob-pattern check to compare against `data/<other-user>` rather than `<other-user>` directly. Add and update tests for the new layout.

**Patterns to follow:** Existing `startsWithDir` and `resolveRealPath` helpers; existing send-file policy `data/<user-folder>` check.

**Test scenarios:**
- Happy path: writing to `data/ZhangWei/notes.txt` is allowed.
- Old path denied: writing to `ZhangWei/notes.txt` is denied as `outside-user-dir-write`.
- Cross-user read: reading `data/Lisi/private.pdf` from `ZhangWei`'s session is denied as `other-user-dir`.
- Glob pattern: a glob like `data/Lisi/*` is denied as `other-user-dir`.

**Verification:** `bot-path-policy.test.ts` passes.

---

## Scope Boundaries

- Existing files saved under `<workspace>/<user-folder>` are left in place. New uploads use `data/<user-folder>`.
- No migration, cleanup, or symlink from the old path.
- No changes to filename collision timestamp format or timezone.
- No changes to supported media types, download/decrypt logic, session routing, or prompt wording beyond the path prefix.
- No changes to `wecom-send-file-policy.ts`; it already validates `data/<user-folder>`.

---

## Risks & Dependencies

- Risk: Existing sessions with files saved under the old path will find those files outside the bot's writable zone after U4. Mitigation: documented scope boundary; users can manually move files into `data/<user-folder>` if needed.
- Risk: `bot-path-policy.ts` is also used for Feishu bot sessions, so moving `userDir` into `data/` affects any Feishu session that relies on a root-level user directory. Mitigation: verify Feishu tests pass after U4; Feishu currently has no file-storage feature, so the change is forward-alignment rather than a breaking behavior.

---

## Sources & Research

- Origin requirements: `docs/brainstorms/2026-06-12-wecom-bot-file-handling-requirements.md` (R3, R5, AE1).
- Existing proactive send-file isolation already expects `data/<user-folder>`: `src/server/services/wecom-send-file-policy.ts`.
- Media save implementation and tests: `src/server/services/wecom-file-storage.ts` and `src/server/services/wecom-file-storage.test.ts`.
- Bot tool-permission implementation and tests: `src/server/services/bot-path-policy.ts` and `src/server/services/bot-path-policy.test.ts`.
- Test isolation convention: `docs/solutions/conventions/use-isolated-test-database-for-comate.md`.
