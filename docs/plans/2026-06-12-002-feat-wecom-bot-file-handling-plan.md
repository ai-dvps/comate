---
title: "feat: WeCom Bot File and Media Handling"
type: feat
status: completed
date: 2026-06-12
origin: docs/brainstorms/2026-06-12-wecom-bot-file-handling-requirements.md
---

# feat: WeCom Bot File and Media Handling

## Summary

Add file, image, voice, and video message handling to the WeCom bot by registering four new SDK event listeners that download and decrypt media into per-user folders, then forward a file-reference prompt to the sender's existing Claude Code session. The text-message streaming reply machinery is extracted into a shared helper so all five message types (text + 4 media) reuse the same animation, flush, and finalize logic.

---

## Problem Frame

The WeCom bot currently only processes text messages. When team members send documents, screenshots, voice memos, or videos, those uploads are silently ignored. This plan wires the existing SDK media events through the same session-routing path that text messages already use, so the agent can analyze or act on uploaded files.

---

## Requirements

- R1. Listen for `message.file`, `message.image`, `message.voice`, and `message.video` SDK events.
- R2. Download and decrypt each media file using the SDK's `downloadFile(url, aesKey)`.
- R3. Save files into a per-user folder named by plaintext user ID when mapped, else encrypted user ID.
- R4. Append a `yyyy-mm-dd-hh-mm-ss` timestamp before the extension when a file with the same name already exists.
- R5. Express the saved file path relative to the workspace root in the prompt.
- R6. Look up or create the sender's Claude Code session, following the same logic as text messages.
- R7. Construct a prompt: "a file named @\<relative path\> uploaded by \<user id\>, if there is skill can process this file, process it with that skill, if no proper skill find, ask user how to handle it."
- R8. Push the prompt to the agent runtime so the response streams back to WeCom.
- R9. On download/save failure, log the error and reply to the WeCom user with a failure message; do not invoke the session agent.
- R10. Media handling failures must not crash the websocket connection or block subsequent messages.

**Origin actors:** A1 (WeCom User), A2 (Admin / GUI User), A3 (Claude Code Agent)
**Origin flows:** F1 (WeCom user sends a media message)
**Origin acceptance examples:** AE1 (happy path with plaintext ID), AE2 (collision renaming), AE3 (encrypted ID fallback), AE4 (download failure resilience)

---

## Scope Boundaries

- No transcoding, thumbnail generation, or other media pre-processing.
- No content-based duplicate detection or file-hash comparison.
- No file size limits, quota enforcement, or retention policies.
- No agent-to-WeCom file upload in responses.
- No special handling for mixed text-and-media messages beyond treating media events as separate uploads.

---

## Context & Research

### Relevant Code and Patterns

- `src/server/services/wecom-bot-service.ts` — `handleTextMessage` (lines 143–357) contains the full streaming reply setup and session-routing pattern that media handlers must follow.
- `src/server/services/session-runtime.ts` — `pushMessage(content: string)` pushes a user message into the agent's input stream.
- `src/server/services/chat-service.ts` — `getOrCreateRuntime(sessionId, workspaceId, isBotSession, botEventHandler)` returns or creates a runtime with a bot SSE event handler.
- `src/server/storage/sqlite-store.ts` — `getWecomSession`, `setWecomSession`, `getWecomUserMapping` for session and user-ID lookups.
- `src/server/services/wecom-user-resolver.ts` — `resolveOnMessage` for fire-and-forget user-ID resolution.
- WeCom SDK (`@wecom/aibot-node-sdk`) — emits `message.file`, `message.image`, `message.voice`, `message.video` events; provides `client.downloadFile(url, aesKey)` returning `{ buffer, filename }`.
- `src/server/services/wecom-session-renamer.test.ts` — test pattern using `node:test`, mocking `workspaceStore` methods directly.

### Institutional Learnings

- `docs/solutions/conventions/commit-plan-and-brainstorm-files-with-code-changes.md` — commit planning docs alongside code changes on the same branch.

---

## Key Technical Decisions

- **Extract streaming reply into a shared helper:** The streaming reply setup (animation, flush debounce, placeholder management, finalize, SSE event mapping) is ~200 lines. Rather than duplicating it across 4 media handlers, extract it into a factory function. Both `handleTextMessage` and the new `handleMediaMessage` call the factory. A bug in the helper affects all paths, but a fix fixes all paths. *(see origin: docs/brainstorms/2026-06-12-wecom-bot-file-handling-requirements.md — R8)*
- **Single shared `handleMediaMessage` for all 4 media types:** The SDK emits separate events but the handling logic (download → save → session → prompt → stream) is identical regardless of media type. One handler with the frame as parameter avoids code duplication.
- **File storage utility as a separate function:** Download/decrypt, folder creation, collision renaming, and path validation are pure I/O operations with no dependency on the bot service. Extracting into a utility enables focused unit testing.
- **Timestamp in local time, formatted as `yyyy-mm-dd-hh-mm-ss`:** Resolves deferred question from origin. Local time is consistent with how a user would perceive the upload moment.

---

## Open Questions

### Resolved During Planning

- Timestamp timezone: local time, `yyyy-mm-dd-hh-mm-ss` format (e.g., `2026-06-12-14-30-00`).
- Path validation: yes, the file storage utility should validate that the resolved save path stays within the workspace boundary before writing.

### Deferred to Implementation

- SDK frame body shape for each media type (`FileMessage`, `ImageMessage`, `VoiceMessage`, `VideoMessage`): the implementer should verify the exact field paths for URL and aesKey by inspecting the SDK type definitions at `node_modules/@wecom/aibot-node-sdk`.
- Whether the SDK returns a usable `filename` for all media types or just `file` messages: voice/video may not include a filename, requiring a fallback (e.g., `voice_<timestamp>.mp3`).

---

## Implementation Units

### U1. Extract streaming reply helper from handleTextMessage

**Goal:** Pull the streaming reply setup (animation, flush, placeholder, finalize, SSE event handler) into a reusable factory function so that both text and media handlers can share it.

**Requirements:** R8

**Dependencies:** None

**Files:**
- Create: `src/server/services/wecom-stream-reply.ts`
- Modify: `src/server/services/wecom-bot-service.ts`

**Approach:**
- Create a factory function that accepts a `BotConnection` (for the client reference), the original `frame`, and returns an object with `{ handler, finalizeStream, setPlaceholder }`.
- The returned `handler` is the SSE event handler function with the same `assistant_start`, `text_delta`, `thinking_start`, `tool_use_start`, `tool_result`, `subagent_start`, `subagent_done`, `assistant_done`, `error_note`, `result`, and `interrupted` handling.
- The factory sets up `streamId`, `responseText`, `collecting`, animation intervals, flush debounce, and the finalize logic internally — same behavior as the current inline code.
- Refactor `handleTextMessage` to call the factory instead of setting up the stream reply inline.
- This is a pure refactor — no behavioral change to the text message path.

**Patterns to follow:**
- Current inline streaming setup in `handleTextMessage` (lines 187–353 of `wecom-bot-service.ts`)

**Test scenarios:**
- Test expectation: none — this is a pure refactor of existing behavior. Existing tests for text message handling cover correctness. If no such tests exist, the implementer should add a basic characterization test for the text message path before extracting.

**Verification:**
- Text messages still stream correctly to WeCom with no behavioral change.
- The new module exports a factory function that the media handler can consume.

---

### U2. Add file download and storage utility

**Goal:** Create a utility function that saves a media file buffer into a per-user folder with collision handling, and returns the relative path.

**Requirements:** R3, R4, R5

**Dependencies:** None

**Files:**
- Create: `src/server/services/wecom-file-storage.ts`
- Test: `src/server/services/wecom-file-storage.test.ts`

**Approach:**
- Export a function with signature roughly: `saveMediaFile(workspaceFolderPath: string, userFolderName: string, fileBuffer: Buffer, filename: string): Promise<string>` returning the path relative to `workspaceFolderPath`.
- Internally: resolve the target directory (`path.join(workspaceFolderPath, userFolderName)`), create it with `fsPromises.mkdir({ recursive: true })`, check for name collision, append timestamp if needed, write the file.
- Path validation: verify the resolved directory and file path start with the resolved workspace path before writing. If they don't, throw an error.
- Collision logic: if `filename` exists in the target dir, insert `-yyyy-mm-dd-hh-mm-ss` before the extension. If the base name has no extension, append the timestamp to the end.
- Timestamp: `new Date().toLocaleString('sv-SE')` or manual `yyyy-mm-dd-hh-mm-ss` formatting from local time.
- This utility does **not** call the SDK's `downloadFile` — it only handles saving. The caller is responsible for downloading and passing the buffer.

**Patterns to follow:**
- Path validation pattern in `wecom-bot-service.ts` context file methods (lines 403–407): `path.resolve` + `startsWith` check against workspace base.
- `fsPromises` usage throughout the server services.

**Test scenarios:**
- Happy path: save a file to a new user folder → file exists at `<workspace>/<userId>/report.pdf`, returns `userId/report.pdf`.
- Happy path: save to folder that already exists → no error, file saved correctly.
- Covers AE3: save with encrypted user ID when no plaintext mapping exists → folder name is the encrypted ID.
- Edge case: filename has no extension → timestamp appended to end (`data` → `data-2026-06-12-14-30-00`).
- Edge case: filename has multiple dots → timestamp inserted before the last dot (`archive.tar.gz` → `archive.tar-2026-06-12-14-30-00.gz`).
- Covers AE2: collision with same filename → new file gets timestamp suffix, original file untouched.
- Error path: path traversal attempt (user ID contains `..`) → throws, no file written.
- Error path: target directory is outside workspace boundary → throws, no file written.

**Verification:**
- All test scenarios pass.
- The function returns a relative path and never writes outside the workspace.

---

### U3. Add media message handlers to WeComBotService

**Goal:** Register `message.file`, `message.image`, `message.voice`, and `message.video` event listeners that download media, save it, look up or create the sender's session, and push the file-reference prompt via the streaming reply helper.

**Requirements:** R1, R2, R6, R7, R8, R9, R10

**Dependencies:** U1, U2

**Files:**
- Modify: `src/server/services/wecom-bot-service.ts`

**Approach:**
- In the `connect` method, after the `message.text` listener, register four new listeners: `client.on('message.file', ...)`, `client.on('message.image', ...)`, `client.on('message.voice', ...)`, `client.on('message.video', ...)`. Each calls `handleMediaMessage(workspaceId, frame)`.
- `handleMediaMessage` method:
  1. Extract `wecomUserId` from `frame.body.from.userid` (same as text handler).
  2. Fire-and-forget `wecomUserResolver.resolveOnMessage` and `trackWorkspaceUser` (same as text).
  3. Determine the media URL and aesKey from the frame body. The SDK frame shape differs per type: `frame.body.file?.url / .aeskey`, `frame.body.image?.url / .aeskey`, `frame.body.voice?.url / .aeskey`, `frame.body.video?.url / .aeskey`. Detect which is present.
  4. Download and decrypt: `conn.client.downloadFile(url, aesKey)`.
  5. Determine user folder name: check `workspaceStore.getWecomUserMapping(wecomUserId)` — use plaintext if found, else encrypted ID.
  6. Save via the file storage utility, passing the workspace `folderPath`, user folder name, buffer, and filename.
  7. Look up or create session (same session logic as `handleTextMessage` lines 156–182: `workspaceStore.getWecomSession`, verify session exists, create if needed, trigger session rename if plaintext available).
  8. Create the streaming reply handler using the factory from U1.
  9. Construct the prompt per R7, using the relative path from step 6 and the user ID from step 5.
  10. Get or create the runtime via `chatService.getOrCreateRuntime(sessionId, workspaceId, true, handler)`.
  11. Push the prompt: `runtime.pushMessage(prompt)`.
- Error handling (R9, R10):
  - Wrap the entire `handleMediaMessage` in a try/catch.
  - On failure: log the error, attempt to reply to the WeCom user with a brief failure message ("⚠️ 文件处理失败，请稍后重试。"), and return. Do not rethrow.
  - The `client.on` listeners use `.catch()` on the async handler, same pattern as the text listener (line 84–86), ensuring the websocket connection is never broken by an unhandled rejection.
- Import the `FileMessage`, `ImageMessage`, `VoiceMessage`, `VideoMessage` types from the SDK for type-safe frame handling.

**Patterns to follow:**
- Event listener registration pattern from `connect` method (line 83–90).
- Session lookup/creation pattern from `handleTextMessage` (lines 156–182).
- Error containment pattern: async handler with `.catch()` on the listener.
- User resolution: fire-and-forget `resolveOnMessage` + `trackWorkspaceUser`.

**Test scenarios:**
- Covers AE1: Given an enabled bot where user "ZhangWei" has a session and plaintext mapping, when "ZhangWei" sends a PDF named `report.pdf`, then the file is saved and the agent receives the prompt with the relative path.
- Happy path: image message → saved as image file, prompt pushed to session.
- Happy path: voice message → saved with fallback filename if SDK doesn't provide one, prompt pushed.
- Happy path: video message → same as above.
- Covers AE4: download failure → error logged, failure reply sent to WeCom user, connection remains open, no session agent invoked.
- Error path: file save failure (e.g., permission denied) → same graceful handling as download failure.
- Error path: session creation failure → error logged, failure reply sent, connection remains open.
- Integration: media message for a user with no prior session → session created, file saved, prompt pushed.

**Verification:**
- All 4 media event types trigger the handler and produce a file-save + prompt-push.
- On error, the WeCom user receives a reply and the bot stays connected.
- The streaming reply from the agent reaches the WeCom user for successful uploads.

---

### U4. Tests for file storage utility

**Goal:** Unit tests for the file storage utility covering all behavioral requirements.

**Requirements:** R3, R4, R5

**Dependencies:** U2

**Files:**
- Test: `src/server/services/wecom-file-storage.test.ts`

**Approach:**
- Use `node:test` and `node:assert` matching the project convention.
- Create a temp directory for each test, pass it as `workspaceFolderPath`.
- Clean up temp dirs in `afterEach`.

**Patterns to follow:**
- Test structure from `wecom-session-renamer.test.ts`: `describe`, `it`, `beforeEach`/`afterEach` with `node:test`.

**Test scenarios:**
- Save file to new folder → folder created, file exists at expected path.
- Save file to existing folder → file saved, no error.
- Collision with existing file → new file gets timestamp suffix.
- Collision with no-extension file → timestamp appended.
- Path outside workspace → throws error.
- User folder with special characters → handled correctly (no path traversal).
- Covers AE2: second upload of `report.pdf` → saved as `report-<timestamp>.pdf`.
- Covers AE3: encrypted user ID used as folder name → file saved under encrypted ID folder.

**Verification:**
- All test scenarios pass.
- No temp files leaked (cleanup verified).

---

### U5. Tests for media message handling

**Goal:** Integration-level tests for the `handleMediaMessage` method, verifying the full download-save-session-prompt flow and error resilience.

**Requirements:** R1, R9, R10

**Dependencies:** U3

**Files:**
- Test: `src/server/services/wecom-bot-service.test.ts`

**Approach:**
- Mock the SDK client's `downloadFile` to return a buffer and filename.
- Mock `workspaceStore` methods for session and user mapping lookups.
- Mock `chatService.getOrCreateRuntime` to return a fake runtime with a `pushMessage` spy.
- Verify the prompt content pushed to the runtime includes the correct relative path and user ID.

**Patterns to follow:**
- Mocking pattern from `wecom-session-renamer.test.ts`: replace methods on the singleton, restore in `afterEach`.

**Test scenarios:**
- Covers AE1: file message with plaintext user mapping → file saved to plaintext folder, prompt contains correct `@<path>` reference and user ID.
- File message with encrypted user ID only → file saved to encrypted ID folder.
- Image message → handler invoked, file saved, prompt pushed.
- Covers AE4: download failure → error logged, failure reply sent to WeCom, runtime.pushMessage not called.
- File save throws → same graceful handling as download failure.
- Multiple media messages in sequence → all handled, no connection issues.

**Verification:**
- Happy path tests show the correct prompt pushed to the agent.
- Error path tests show the failure reply sent and no crash.

---

## System-Wide Impact

- **Interaction graph:** The `connect` method in `wecom-bot-service.ts` currently registers one event listener (`message.text`). After this change it registers five. The shared streaming reply helper is called by all five paths.
- **Error propagation:** Media handler errors are caught locally and reported to the WeCom user. They do not propagate to the websocket connection layer.
- **State lifecycle risks:** Files written to disk are not cleaned up on agent error — they persist in the user folder. This is acceptable per scope (no retention policies in v1).
- **Unchanged invariants:** The text message handling path remains behaviorally identical after U1's refactor. Session creation, user mapping, and runtime management are not modified — only reused.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| SDK frame shape differs from README examples | Implementer inspects actual SDK type definitions before coding U3. Deferred to implementation. |
| Voice/video messages may not include a filename | Fallback to `<type>_<timestamp>.<ext>` in the storage utility. |
| Large media files cause memory pressure (buffer in memory) | Acceptable for v1 — SDK's `downloadFile` returns a Buffer. Deferred: streaming to disk if needed later. |
| Shared streaming helper refactor breaks text messages | U1 is a pure refactor with no behavioral change. Implementer should verify text messages still work before proceeding to U3. |

---

## Sources & References

- **Origin document:** `docs/brainstorms/2026-06-12-wecom-bot-file-handling-requirements.md`
- WeCom SDK README: `node_modules/@wecom/aibot-node-sdk/README.md`
- Text message handler pattern: `src/server/services/wecom-bot-service.ts`
- Session runtime pushMessage: `src/server/services/session-runtime.ts`
- Test convention: `src/server/services/wecom-session-renamer.test.ts`
