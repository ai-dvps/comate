---
date: 2026-06-12
topic: wecom-bot-file-handling
---

# WeCom Bot File and Media Handling

## Summary

Extend the WeCom bot message handler to accept all media types (`file`, `image`, `voice`, `video`), download each upload into a per-user folder inside the workspace, and forward a file-reference prompt to the sender's existing Claude Code session so the agent can process it or ask the user how to proceed.

---

## Problem Frame

The WeCom bot currently handles only text messages. Team members increasingly share screenshots, documents, voice messages, and videos with the bot, but those uploads are ignored. Admins want these files routed into the same persistent Claude Code sessions as text messages so the assistant can analyze, summarize, or act on them without requiring the user to switch to the GUI.

---

## Actors

- A1. WeCom User: Sends media messages to the bot from WeChat Work.
- A2. Admin / GUI User: Configures the bot and may view or continue bot-created sessions in the GUI.
- A3. Claude Code Agent: Receives the file-reference prompt inside the sender's session and decides how to handle the upload.

---

## Key Flows

- F1. WeCom user sends a media message
  - **Trigger:** A WeCom user sends a file, image, voice, or video message to the bot.
  - **Actors:** A1, A3
  - **Steps:**
    1. Bot receives the media message via websocket.
    2. Bot determines the target user folder name (plaintext user ID if mapped, otherwise encrypted user ID).
    3. Bot downloads and decrypts the file using the SDK's download method.
    4. Bot saves the file into the user folder, appending a timestamp if the filename already exists.
    5. Bot looks up or creates the sender's Claude Code session for the workspace.
    6. Bot constructs a prompt referencing the saved file path and pushes it to the session agent.
    7. The agent's response streams back to the WeCom user through the existing reply path.
  - **Outcome:** The WeCom user sees the agent's response to their upload in chat.
  - **Covered by:** R1–R8

---

## Requirements

**Media message handling**

- R1. The WeCom bot service listens for `message.file`, `message.image`, `message.voice`, and `message.video` events in addition to `message.text`.
- R2. For each media message, the bot downloads the file using the SDK's file-download capability and the per-message decryption key provided in the frame.

**File storage**

- R3. Downloaded files are saved inside the sender's workspace under `data/<user-folder>`, where `<user-folder>` is named with the plaintext WeCom user ID when a mapping exists; otherwise the encrypted WeCom user ID is used.
- R4. If a file with the same name already exists in the target folder, the new file is renamed by appending a timestamp in `yyyy-mm-dd-hh-mm-ss` format before the file extension.
- R5. The saved path included in the prompt is expressed relative to the workspace root.

**Session routing and prompt**

- R6. After saving the file, the bot looks up the Claude Code session associated with the sender for that workspace, creating one if none exists, following the same logic used for text messages.
- R7. The bot constructs a prompt of the form: "a file named @<relative path> uploaded by <user id>, if there is skill can process this file, process it with that skill, if no proper skill find, ask user how to handle it."
- R8. The prompt is sent to the agent in the sender's session using the same runtime message path as text messages, so the agent's response streams back to WeCom.

**Error handling and resilience**

- R9. If file download or save fails, the failure is logged and the sender receives a WeCom message indicating the upload could not be processed; the session agent is not invoked.
- R10. File handling failures must not crash the websocket connection or prevent subsequent messages from being processed.

---

## Acceptance Examples

- AE1. **Covers R1–R3, R6–R8.** Given an enabled bot where user `ZhangWei` already has a session and a plaintext mapping, when `ZhangWei` sends a PDF named `report.pdf`, then the file is saved to `<workspace>/data/ZhangWei/report.pdf` and the agent in `ZhangWei`'s session receives a prompt referencing `@data/ZhangWei/report.pdf`.
- AE2. **Covers R4.** Given `ZhangWei` already has `report.pdf` in their folder, when `ZhangWei` sends another `report.pdf`, then the new file is saved with a timestamp suffix such as `report-2026-06-12-14-30-00.pdf`.
- AE3. **Covers R3.** Given a user whose plaintext ID is not yet mapped, when they send `image.png`, then the file is saved to `<workspace>/data/<encrypted-user-id>/image.png` and the prompt references that path.
- AE4. **Covers R9–R10.** Given a download failure, when a user sends a file, then the bot logs the error, replies with a failure message, and remains connected for the next message.

---

## Success Criteria

- WeCom users can send any supported media type and have it routed to their Claude Code session.
- Files are organized per user and filename collisions are handled without overwriting existing files.
- The agent receives a clear prompt that references the file and instructs it to process the file or ask the user how to proceed.
- Download or save failures are graceful and do not break the bot connection for subsequent messages.

---

## Scope Boundaries

- No transcoding, thumbnail generation, or other media pre-processing before routing.
- No content-based duplicate detection or file-hash comparison.
- No file size limits, quota enforcement, or retention policies.
- No agent-to-WeCom file upload in responses.
- No special handling for mixed text-and-media messages beyond treating media events as separate uploads.

---

## Key Decisions

- **Folder named by plaintext user ID with encrypted fallback:** This aligns with the existing WeCom user-mapping behavior and keeps files organized by sender without requiring a new identification scheme.
- **Timestamp suffix on filename collisions:** Preserves every upload without overwriting existing files and without prompting the user.
- **Skill routing embedded in the prompt:** Avoids building a separate skill-dispatch layer; the agent decides whether it can process the file based on the path and available skills.

---

## Dependencies / Assumptions

- The WeCom SDK continues to provide a per-message download/decrypt method that returns the file buffer and filename.
- The existing session lookup and creation logic for text messages can be reused for media messages.
- The agent runtime accepts messages pushed via the same path used for text messages.
- Workspace folder paths remain stable during a media message's lifetime.

---

## Outstanding Questions

### Resolve Before Planning

- None

### Deferred to Planning

- [Affects R4][Technical] Exact timestamp source and timezone for the collision suffix.
- [Affects R3, R5][Technical] Whether to validate that the target file path stays within the workspace boundary before writing.
- [Affects R2][Needs research] SDK-specific shape of the `message.file`, `message.image`, `message.voice`, and `message.video` frames and the exact download call signature.
