---
title: Inject WECOM_USER_ID into Claude Code process for WeCom bot sessions
date: 2026-06-23
type: feat
---

## Summary

Inject `WECOM_USER_ID` into the Claude Code process environment for WeCom bot sessions so the `send-wecom-file` skill can resolve "send <file> to me" without prompting the user for their WeCom user ID.

## Problem Frame

The `send-wecom-file` skill supports sending a workspace file to the current user by reading `WECOM_USER_ID` from the process environment. In a WeCom bot session, the server already knows the user's identity from the incoming WeCom message frame, but that identity is not passed to the spawned Claude Code process. The skill therefore falls back to asking the user for their ID, which is a poor experience inside a bot conversation. Bridging this gap requires setting the env var at the point where the server builds SDK options for a bot session runtime.

## Requirements

- R1. For WeCom bot sessions, the spawned Claude Code process receives `WECOM_USER_ID` set to the plaintext WeCom user ID when the encrypted-to-plaintext mapping is available.
- R2. The injection must not weaken the bot-session env sanitizer; it happens after `sanitizeBotEnv()` has stripped other `WECOM_*` variables.
- R3. Non-WeCom sessions (GUI sessions, Feishu bot sessions) must not receive `WECOM_USER_ID`.
- R4. Add test coverage verifying the env var is set for WeCom bot sessions and absent for non-WeCom bot sessions.

## Key Technical Decisions

- KTD1. **Injection point is inside the bot-session branch of `buildSdkOptions()`**: The existing `isBotSession` block in `ChatService.buildSdkOptions()` already sanitizes the env and resolves a canonical bot user identity. Setting `env.WECOM_USER_ID` immediately after `sanitizeBotEnv()` keeps the change localized and avoids affecting GUI sessions.
- KTD2. **Identity source is the encrypted WeCom ID already flowing through the call chain**: `WeComBotService.handleTextMessage()` passes the encrypted `wecomUserId` to `chatService.pushMessage()` as `botUserId`. In `buildSdkOptions()`, prefer `botUserId`, fall back to `workspaceStore.getWecomUserIdBySession(workspace.id, session.id)`, then resolve plaintext via `workspaceStore.getWecomUserMapping(encryptedId)`.
- KTD3. **No encrypted-ID fallback**: If the plaintext mapping is missing, leave `WECOM_USER_ID` unset. Passing the encrypted ID would fail downstream because the server-side `sendFile` expects a plaintext ID and does its own reverse lookup. The skill degrades to asking the user.
- KTD4. **Scope is limited to bot sessions**: GUI sessions that happen to have `source === 'wecom'` are not covered. Extending the injection to GUI sessions would require moving it outside the `isBotSession` branch and is deferred.

## Implementation Units

### U1. Inject `WECOM_USER_ID` in `ChatService.buildSdkOptions()`

- **Goal:** Set `env.WECOM_USER_ID` to the plaintext WeCom user ID for WeCom bot sessions.
- **Requirements:** R1, R2, R3
- **Files:** `src/server/services/chat-service.ts`
- **Approach:** Inside the `isBotSession` branch, after `env = sanitizeBotEnv(env)`, compute the encrypted WeCom ID from `botUserId ?? workspaceStore.getWecomUserIdBySession(workspace.id, session.id)`. If an encrypted ID exists, look up its plaintext mapping. When plaintext is found, assign `env.WECOM_USER_ID = plaintextUserId`. Do not set the variable if any lookup returns nothing.
- **Patterns to follow:** Keep the change adjacent to the existing `canonicalUserId` resolution and `sanitizeBotEnv()` call. Do not modify `sanitizeBotEnv()` itself; the security boundary it enforces (stripping all `WECOM_*` keys) should remain intact.
- **Test scenarios:**
  - Happy path: WeCom bot session with a stored mapping → `capturedOptions.env.WECOM_USER_ID` equals the plaintext ID.
  - Edge case: WeCom bot session with no stored mapping → `capturedOptions.env.WECOM_USER_ID` is undefined.
  - Edge case: Feishu bot session → `capturedOptions.env.WECOM_USER_ID` is undefined.
  - Edge case: GUI session (non-bot) → `capturedOptions.env.WECOM_USER_ID` is undefined.
- **Verification:** A WeCom bot session runtime's `Options.env` contains `WECOM_USER_ID` matching the expected plaintext user ID; other session types do not.

### U2. Add test coverage in `chat-service.test.ts`

- **Goal:** Verify the env injection behavior and prevent regression.
- **Requirements:** R4
- **Dependencies:** U1
- **Files:** `src/server/services/chat-service.test.ts`
- **Approach:** Extend the existing bot-session test helper to capture `capturedOptions.env.WECOM_USER_ID` and assert against the mocked mapping. Add a dedicated test for the WeCom happy path and reuse existing Feishu/GUI test patterns for the absence cases.
- **Patterns to follow:** Follow the established test conventions: import `../test-utils/test-env.js` first, mock `workspaceStore` methods, restore originals in `afterEach`, and assert on the `Options` object passed to `SessionRuntime.open`.
- **Test scenarios:**
  - Happy path: mock `getWecomUserIdBySession` and `getWecomUserMapping` returning an encrypted/plaintext pair → assert `WECOM_USER_ID` is set to plaintext.
  - Edge case: mock mapping functions returning nothing → assert `WECOM_USER_ID` is unset.
  - Edge case: create a Feishu bot session runtime with `botUserId` set to a Feishu ID and no WeCom mapping → assert `WECOM_USER_ID` is unset.
- **Verification:** New tests pass and existing bot-session tests continue to pass.

## Scope Boundaries

### In scope
- WeCom bot sessions initiated by incoming WeCom messages.
- Setting `WECOM_USER_ID` in the SDK process environment.

### Deferred to follow-up work
- Injecting `WECOM_USER_ID` for WeCom-origin GUI sessions.
- Proactively resolving the plaintext mapping before runtime creation to eliminate the first-message race (e.g., calling `wecomUserResolver.resolveImmediate()` in `handleTextMessage`).
- Adding a Feishu equivalent env var for the Feishu bot session path.

### Outside this product's identity
- Changes to the `send-wecom-file` skill or the `wecom send-file` CLI command.
- Broadening `sanitizeBotEnv()` to allow other `WECOM_*` variables.

## Risks & Dependencies

- **First-message race condition**: `wecomUserResolver.resolveOnMessage()` queues the encrypted ID for batch resolution. If a user's first message arrives before the mapping is stored, `buildSdkOptions()` will find no plaintext mapping and leave `WECOM_USER_ID` unset for the entire 10-minute runtime lifetime. The skill degrades to asking the user. This is acceptable for the initial scope; proactive immediate resolution is deferred.
- **PII exposure**: The plaintext WeCom user ID becomes readable by all tools and Bash commands in the bot session. This is intentional and limited to the user ID; it does not expose bot credentials because `sanitizeBotEnv()` still strips secrets before the injection.
- **Dependency on existing mapping store**: The feature depends on `workspaceStore.getWecomUserMapping()` returning a plaintext ID. If the resolver is disabled or the mapping is missing, the env var is simply not set.

## Sources & Research

- `src/server/services/chat-service.ts` — `ChatService.buildSdkOptions()` constructs the SDK `Options` object including `env`.
- `src/server/services/wecom-bot-service.ts` — `handleTextMessage()` extracts `wecomUserId` and passes it through `chatService.pushMessage()` as `botUserId`.
- `src/server/services/wecom-user-resolver.ts` — `resolveImmediate()` and `resolveOnMessage()` define the mapping resolution behavior.
- `claude-code-plugin/plugins/wecom/skills/send-wecom-file/SKILL.md` — the skill that consumes `WECOM_USER_ID`.
- `src/server/services/wecom-bot-service.ts` (around line 411) — `sendFile()` expects a plaintext `toUser` and does its own reverse lookup to the encrypted ID.
