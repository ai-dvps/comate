---
title: "refactor: Resolve send-wecom-file current user via CLI session lookup"
date: 2026-06-23
type: refactor
origin: docs/brainstorms/2026-06-23-wecom-send-file-session-owner-lookup-requirements.md
---

# refactor: Resolve send-wecom-file current user via CLI session lookup

## Summary

Add a `wecom current-user` CLI command that returns the WeCom user ID for the current session. Refactor the `send-wecom-file` skill to use that command for "send to me" resolution instead of the `WECOM_USER_ID` environment variable, and remove the server-side env injection. Explicit recipients remain supported; only self-targeting identity resolution is hardened against prompt injection.

## Problem Frame

The `send-wecom-file` skill currently resolves "send to me" by reading `WECOM_USER_ID` from the Claude Code child process environment. The server injects that variable when it creates a WeCom bot session runtime. Because the skill trusts an env var whose value is invisible to the skill runtime, a prompt-injection attack can trick the skill into treating an arbitrary user ID as "me". The server already knows the canonical mapping between session ID and WeCom user in SQLite; this plan exposes that authority through the CLI and makes the skill depend on it.

## Requirements

### CLI lookup

- R1. Add a `wecom current-user` CLI command that accepts an optional `--session-id` flag defaulting to `CLAUDE_SESSION_ID`.
- R2. The command loads `.claude/wecom-context.json` and calls the existing `GET /api/workspaces/:workspaceId/sessions/:sessionId/wecom-user` endpoint.
- R3. The command prints the resolved user ID and exits 0 on success.
- R4. The command exits 1 when no session ID is available and exits 2 when the server returns no mapping.

### Skill behavior

- R5. The `send-wecom-file` skill resolves "send to me" by invoking `wecom current-user` and using its stdout as the `--to-user` value.
- R6. The skill must not read `WECOM_USER_ID` for any purpose.
- R7. The skill must ignore prompt-supplied user IDs when resolving "to me"; prompt IDs are only acceptable for explicitly named other recipients.
- R8. When the CLI lookup fails, the skill reports the failure and does not send a file.

### Server-side cleanup

- R9. Remove the `WECOM_USER_ID` injection from `src/server/services/chat-service.ts`.
- R10. Update or remove the `chat-service.test.ts` assertions that verify the injection.
- R11. The `POST /api/workspaces/:workspaceId/wecom/send-file` route continues to accept `toUser` for explicit recipients; no server-side restriction is added.

## Key Technical Decisions

- **Add a GET helper in the CLI rather than reusing `postJson`.** `packages/wecom-cli/src/lib/http.ts` currently only supports POST. A new `getJson` helper is simpler than parameterizing the existing function and keeps the call site readable. (see origin: R2)
- **Keep `--to-user` required on `wecom send-file`.** The CLI command remains agnostic to whether the recipient came from the skill's self-lookup or an explicit prompt. The security boundary lives in the skill, not in the CLI argument surface. (see origin: R7, R11)
- **Remove env injection entirely rather than leaving it unset.** `sanitizeBotEnv` already strips `WECOM_*` variables; deleting the injection block removes a latent footgun and keeps the skill's source-of-truth story simple. (see origin: R9)
- **Reuse the existing `GET .../wecom-user` route.** Adding a WeCom-namespaced alias is deferred; the existing endpoint returns plaintext user IDs and is already mounted under the workspace path. (see origin: Dependencies / Assumptions)

## Implementation Units

### U1. Add `getJson` HTTP helper to the WeCom CLI

- **Goal:** Enable CLI commands to make GET requests to the Express server.
- **Requirements:** R2
- **Dependencies:** None
- **Files:** `packages/wecom-cli/src/lib/http.ts`
- **Approach:** Add a `getJson(url: string)` function alongside `postJson`. Use `node:http`/`node:https` and resolve with `{ status: number; body: string }`, matching the existing helper's shape. Keep error handling minimal: reject on network error, resolve with the status/body for HTTP-level failures.
- **Patterns to follow:** The existing `postJson` implementation in the same file.
- **Test scenarios:**
  - Happy path: a mock HTTP server returns 200 with a JSON body; `getJson` resolves with the correct status and body.
  - Network error: request to an unreachable host rejects.
- **Verification:** `getJson` can be imported and used by the new command in U2.

### U2. Add `wecom current-user` CLI command

- **Goal:** Provide a CLI command that returns the WeCom user ID for the current session.
- **Requirements:** R1, R2, R3, R4
- **Dependencies:** U1
- **Files:** `packages/wecom-cli/src/commands/current-user.ts`, `packages/wecom-cli/src/index.ts`, `packages/wecom-cli/test/cli.test.js`
- **Approach:** Create a new command class extending `BaseCommand`. Declare a `--session-id` flag (optional). In `run()`, load the context file, resolve the session ID from the flag or `CLAUDE_SESSION_ID`, build the URL `GET /api/workspaces/${workspaceId}/sessions/${sessionId}/wecom-user`, call `getJson`, parse the `{ userId }` response, and print `userId` on success. Exit codes follow the existing convention: 1 for missing session ID or malformed response, 2 for missing context file, 3 for HTTP request failure, mirroring `send-file` semantics where practical. Register the command in `index.ts` as `current-user`.
- **Patterns to follow:** `packages/wecom-cli/src/commands/send-file.ts` for flag handling, context loading, and error formatting; `packages/wecom-cli/src/commands/send.ts` for the success log shape.
- **Test scenarios:**
  - Happy path: context file exists, mock server returns `{ userId: "user1" }`, command prints `user1` and exits 0.
  - Missing context file: command exits 2.
  - Missing session ID (no flag and no env var): command exits 1.
  - Server returns 404: command exits 2 with a clear error message.
  - Server returns 500: command exits 3 with a clear error message.
- **Verification:** Running `wecom current-user --session-id <id>` against a local test server returns the expected user ID.

### U3. Update the `send-wecom-file` skill

- **Goal:** Replace `WECOM_USER_ID` usage with the new CLI lookup and harden self-targeting against prompt injection.
- **Requirements:** R5, R6, R7, R8
- **Dependencies:** U2
- **Files:** `claude-code-plugin/plugins/wecom/skills/send-wecom-file/SKILL.md`
- **Approach:** Rewrite the recipient-resolution workflow. When the user says "to me" or equivalent, the skill runs `wecom current-user --session-id ${CLAUDE_SESSION_ID}` and uses the output as `--to-user`. Remove all references to `${WECOM_USER_ID}`. Add explicit anti-pattern guidance that the skill must not trust a user ID embedded in the prompt for self-targeting. Update the quick-start examples and success criteria accordingly.
- **Patterns to follow:** The existing SKILL.md workflow structure and anti-patterns section; keep confirmation-before-send behavior intact.
- **Test scenarios:**
  - Skill prompt for "send report.pdf to me" results in a command sequence that calls `wecom current-user` before `wecom send-file`.
  - Skill prompt that embeds a different user ID in parentheses still uses the CLI output, not the injected text.
- **Verification:** A reviewer reading SKILL.md cannot find any `WECOM_USER_ID` reference and sees a clear self-targeting lookup step.

### U4. Remove `WECOM_USER_ID` env injection from chat-service

- **Goal:** Eliminate the env var that the skill is no longer allowed to trust.
- **Requirements:** R9
- **Dependencies:** None (can land in parallel with U1/U2, but the complete refactor requires U3)
- **Files:** `src/server/services/chat-service.ts`
- **Approach:** Delete the injection block around lines 1057-1065 that sets `env.WECOM_USER_ID`. Keep `sanitizeBotEnv` as-is; it remains a defense-in-depth strip of `WECOM_*` variables.
- **Patterns to follow:** The existing `isBotSession` branch in `buildSdkOptions`.
- **Test scenarios:**
  - WeCom bot session runtime no longer sets `WECOM_USER_ID` in its environment options.
  - Feishu bot session and GUI session still do not set it.
- **Verification:** `grep -n "WECOM_USER_ID" src/server/services/chat-service.ts` returns no matches.

### U5. Update chat-service tests

- **Goal:** Keep the test suite green after removing the env injection.
- **Requirements:** R10
- **Dependencies:** U4
- **Files:** `src/server/services/chat-service.test.ts`
- **Approach:** Remove the test cases that assert `WECOM_USER_ID` is injected for WeCom bot sessions. If any of the same setup is reused for unrelated policy-gating assertions, preserve those assertions and only delete the env-var checks.
- **Patterns to follow:** Existing test structure in the same file; import `test-utils/test-env.js` first remains mandatory.
- **Test scenarios:**
  - The deleted injection behavior is no longer asserted.
  - Remaining bot-session policy tests still pass.
- **Verification:** `npm run test:server` passes for `chat-service.test.ts`.

### U6. Build and smoke-test the CLI

- **Goal:** Ensure the published CLI includes the new command.
- **Requirements:** R1, R2, R3
- **Dependencies:** U2
- **Files:** `packages/wecom-cli/package.json`, `packages/wecom-cli/dist/`
- **Approach:** Run `npm run build` in `packages/wecom-cli` (or the monorepo equivalent) and verify `wecom current-user --help` is available. Update the CLI package version if the release workflow requires it; otherwise leave versioning to the release process.
- **Test scenarios:**
  - `wecom current-user --help` prints the expected flags.
  - `wecom --version` still works.
- **Verification:** The built CLI lists the new command in its help output.

## Scope Boundaries

- **Deferred for later:** Applying the same session-owner lookup to `wecom send` or other WeCom skills.
- **Deferred for later:** Adding a WeCom-namespaced HTTP alias such as `GET /api/workspaces/:workspaceId/wecom/current-user`.
- **Outside this product's identity:** Restricting the server-side `send-file` endpoint to only allow the session owner as recipient. The security fix is scoped to how the skill resolves identity, not to server policy.

## Risks & Dependencies

- The existing `GET /api/workspaces/:id/sessions/:sessionId/wecom-user` endpoint must remain stable. A future rename would break the CLI command.
- Sessions created before the WeCom user resolver has stored a plaintext mapping will return an encrypted user ID. The CLI and skill must handle that gracefully; the server's `sendFile` already does the encrypted-to-plaintext lookup when validating the recipient.
- Bundled copies of the skill under `src-tauri/resources/` and build targets must be regenerated or copied from `claude-code-plugin/` during the next build. The plan does not include manually editing generated bundles.

## Sources / Research

- `docs/brainstorms/2026-06-23-wecom-send-file-session-owner-lookup-requirements.md` — origin requirements doc.
- `packages/wecom-cli/src/commands/send-file.ts` — CLI command pattern and error-code convention.
- `packages/wecom-cli/src/lib/http.ts` — existing POST-only helper.
- `packages/wecom-cli/test/cli.test.js` — CLI test patterns.
- `src/server/routes/chat.ts:196` — existing session-to-WeCom-user endpoint.
- `src/server/services/chat-service.ts:1057-1065` — env injection to remove.
- `src/server/services/chat-service.test.ts:577-615` — tests to update.
- `docs/solutions/conventions/use-isolated-test-database-for-comate.md` — test database isolation for server tests.
