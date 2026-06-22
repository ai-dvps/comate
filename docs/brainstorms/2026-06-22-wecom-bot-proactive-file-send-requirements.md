---
date: 2026-06-22
topic: wecom-bot-proactive-file-send
---

# WeCom Bot Proactive File Send

## Summary

Add a server API and `wecom` CLI subcommand that let the WeCom bot send a file from the workspace to a WeCom user. The flow uploads the file to WeCom once, caches the returned `media_id` for 71 hours, and reuses it for subsequent sends of the same file. File paths are constrained to the workspace, and files under `data/<user-folder>` can only be sent to the matching user.

---

## Problem Frame

Today the WeCom bot can only send text and markdown messages proactively. Teams want the agent or calling code to be able to generate a file inside the workspace and push it back to the user over the same WeCom channel, without asking the user to switch to the GUI to download it. WeCom requires uploading the file to obtain a short-lived `media_id` before sending, so the implementation must handle upload, caching, and workspace-scoped authorization.

---

## Actors

- A1. WeCom User: The recipient who receives the file message in WeChat Work.
- A2. Calling Code / Agent: The code or skill that invokes the send-file API or CLI, typically running inside a Claude Code session.
- A3. WeCom Bot Service: The server-side service that validates the file path, manages the media cache, uploads to WeCom, and delivers the message.

---

## Key Flows

- F1. Send a file message
  - **Trigger:** Calling code invokes the send-file API or CLI with a target user and a workspace-relative file path.
  - **Actors:** A2, A3, A1
  - **Steps:**
    1. Resolve the file path against the workspace folder and reject anything outside the workspace boundary.
    2. If the resolved path sits under `data/<user-folder>`, verify that `<user-folder>` matches the target user's folder name; otherwise reject and notify the user.
    3. Compute the file's MD5 hash and look up a cached `media_id` for the same workspace, relative path, and MD5 that is younger than 71 hours.
    4. If no valid cache entry exists, upload the file to WeCom's temporary media API and store the returned `media_id` with filename, path, MD5, and upload timestamp.
    5. Send a WeCom `file` message to the target user using the valid `media_id`.
  - **Outcome:** The WeCom user receives the file, or the caller receives a clear error if validation or delivery fails.
  - **Covered by:** R1–R12

---

## Requirements

**API / CLI surface**

- R1. The server exposes `POST /api/workspaces/:workspaceId/wecom/send-file` accepting `sessionId`, `toUser`, and `filePath`.
- R2. The `wecom` CLI exposes a `send-file` subcommand with `--to-user`, `--file-path`, and `--session-id` flags.
- R3. Both entry points reject requests that are missing a session, a target user, or a file path.

**File upload and media caching**

- R4. Before uploading, compute the file's MD5 and query the cache for a matching record keyed by workspace, relative path, and MD5.
- R5. Reuse a cached `media_id` only when its upload timestamp is less than 71 hours old.
- R6. When the cache entry is missing or stale, upload the file to WeCom and persist the returned `media_id`, original filename, relative path, MD5, workspace, and upload timestamp.
- R7. Upload failures are returned to the caller as an error; no message is sent to the WeCom user.

**Security**

- R8. The resolved absolute file path must be inside the workspace folder; otherwise the request is rejected with a permission error.
- R9. If the resolved file path is inside `data/<user-folder>`, allow the send only when `<user-folder>` matches the target WeCom user's folder name under the existing per-user naming convention; otherwise reject the request and send an unauthorized text message to the target user.
- R10. Path validation resolves symlinks and guards against directory-traversal attempts.

**Message delivery**

- R11. After obtaining a valid `media_id`, the bot sends a WeCom `file` message to the target user.
- R12. Send failures are returned to the caller and surfaced to the user with a concise error message.

---

## Acceptance Examples

- AE1. **Covers R1, R4–R6, R8, R11.** Given a workspace file at `docs/report.pdf` and no cached media entry, when calling code sends the file to user `ZhangWei`, then the file is uploaded to WeCom, the `media_id` is cached, and a file message is delivered to `ZhangWei`.
- AE2. **Covers R5.** Given a cached entry for `docs/report.pdf` that is 70 hours old, when send-file is called again for the same path, then the cached `media_id` is reused without re-uploading.
- AE3. **Covers R5.** Given a cached entry for `docs/report.pdf` that is 72 hours old, when send-file is called, then the file is re-uploaded and the cache entry is refreshed.
- AE4. **Covers R9.** Given a file at `data/ZhangWei/private.pdf`, when calling code tries to send it to user `LiSi`, then the send is rejected and `LiSi` receives a text message indicating insufficient permission.
- AE5. **Covers R9.** Given a file at `data/ZhangWei/private.pdf`, when calling code sends it to user `ZhangWei`, then the file message is delivered successfully.

---

## Success Criteria

- Files inside the workspace can be sent to WeCom users through both the API and CLI.
- Uploads are cached and reused within the 71-hour window.
- Files under `data/<user-folder>` are only delivered to the matching user.
- Path escape and unauthorized access attempts fail cleanly with actionable error messages.

---

## Scope Boundaries

- No support for sending files outside the workspace.
- No proactive image, voice, or video sends in this version; file type only.
- No content-based deduplication beyond the MD5 + path match.
- No automatic cleanup of expired cache entries in this version.
- No delivery scheduling; sends are synchronous or fail immediately.

---

## Key Decisions

- **Dedicated send-file API/CLI instead of extending the text send command:** Text and file messages have different lifecycles (upload, caching, path authorization), so keeping them separate avoids a mixed-concern route.
- **71-hour cache TTL:** WeCom's documented 3-day media lifetime is the upper bound; shaving off 1 hour reduces the risk of sending with an expired `media_id`.
- **Reuse the existing per-user folder naming convention for `data/<user-folder>`:** The folder name is the plaintext WeCom user ID when a mapping exists, otherwise the encrypted WeCom user ID, consistent with `src/server/services/wecom-file-storage.ts`.

---

## Dependencies / Assumptions

- The WeCom SDK or HTTP API supports uploading temporary media and sending `file` messages.
- Workspace folder paths and the per-user folder naming convention remain stable during a send request.
- The existing session lookup and user mapping resolution used by the text send route can be reused to identify the caller and recipient.

---

## Outstanding Questions

### Resolve Before Planning

- None.

### Deferred to Planning

- Exact WeCom API endpoint or SDK method for temporary media upload and file message send.
- Whether to enforce file size limits or MIME type checks before upload.
- Cache table schema, indexing strategy, and eviction policy.
