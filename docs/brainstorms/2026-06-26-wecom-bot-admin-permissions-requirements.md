---
date: 2026-06-26
topic: wecom-bot-admin-permissions
title: "feat: Full admin permissions for WeCom bot sessions"
---

## Summary

Give WeCom bot admins full runtime privileges in bot sessions: they can call any tool, read or write any file inside the workspace, and invoke any skill. Today only skills have admin-only support; this change extends the admin bypass to tool-permission policy, file-path policy, and proactive file sends.

## Problem Frame

A WeCom bot admin is currently only special for skills. Tool categories, per-tool overrides, the file isolation layer, the workspace denylist, and proactive send-file restrictions all treat admins the same as regular users. That leaves admins unable to perform privileged operations that their role implies — running shell commands, editing shared files, reading another user's data folder, or sending files from outside their own folder.

## Key Decisions

- **Admin identity stays in `wecomBotIsolation.adminUserIds`.** No new configuration surface is added; the existing Isolation settings tab continues to own the admin list.
- **"All files" means everything inside the workspace root.** Admins bypass per-user isolation and the denylist, but the workspace boundary remains.
- **"All skills" means any skill name is allowed.** Admins are not limited to `defaultAllowedSkills` or `adminAllowedSkills`.
- **The proactive send-file API shares the same bypass.** Admins can send files from any workspace folder, not only their own `data/<user>` folder.
- **The bypass applies only to WeCom bot sessions.** GUI sessions and Feishu bot sessions are unchanged.

## Actors

- A1. **WeCom bot admin** — listed in `wecomBotIsolation.adminUserIds`; receives full tool, file, and skill privileges.
- A2. **WeCom bot user** — not listed; subject to the existing policy restrictions.

## Requirements

### Tool permissions

- R1. WeCom bot admins bypass the workspace tool-permission policy for all SDK tools and the Reply capability.
- R2. Admin bypass overrides category defaults, per-tool overrides, and ask posture, returning allow.
- R3. Non-admin bot users continue to be evaluated against the configured policy.

### File access

- R4. WeCom bot admins can read any file or directory inside the workspace, including other users' data folders and denylisted paths.
- R5. WeCom bot admins can write any file inside the workspace, including shared areas and other users' data folders.
- R6. The workspace boundary remains: admins cannot escape the workspace root via absolute paths, parent traversal, or symlinks.

### Skills

- R7. WeCom bot admins can invoke any skill, regardless of whether it appears in `defaultAllowedSkills` or `adminAllowedSkills`.
- R8. Skill-name validation still requires a non-empty normalized skill name.

### Proactive send-file

- R9. The proactive WeCom send-file API bypasses the `data/<user-folder>` isolation check when the caller is an admin.
- R10. Non-admin callers continue to be restricted to their own data folder.

### Configuration / UI

- R11. The Isolation settings tab's admin-user hint is updated to describe the full admin powers (tools, files, skills).
- R12. The admin-user list itself is unchanged; it remains the source of admin identity.

### Scope protection

- R13. Admin bypass applies only to WeCom bot sessions; GUI sessions and Feishu bot sessions are unaffected.

## Key Flows

- F1. **Admin bot session invokes a denied tool**
  - **Trigger:** Admin sends a message that causes Claude to attempt a tool the workspace policy denies for normal users.
  - **Actors:** A1, chat-service, tool-permission evaluator.
  - **Steps:** Runtime resolves `isAdmin=true`; evaluator returns allow; tool executes.
  - **Covered by:** R1, R2, R3.

- F2. **Admin bot session reads another user's file**
  - **Trigger:** Admin asks the bot to read a file in `data/<other-user>/`.
  - **Actors:** A1, chat-service, path policy.
  - **Steps:** Runtime resolves `isAdmin=true`; path policy allows the read even though the path is outside the admin's own user directory.
  - **Covered by:** R4.

- F3. **Admin invokes an unlisted skill**
  - **Trigger:** Admin asks the bot to run a skill not in `defaultAllowedSkills` or `adminAllowedSkills`.
  - **Actors:** A1, skill policy.
  - **Steps:** `evaluateSkill` sees `isAdmin=true` and allows the skill.
  - **Covered by:** R7.

- F4. **Admin proactively sends a file from a shared folder**
  - **Trigger:** Admin uses the send-file API with a file path under a shared workspace folder.
  - **Actors:** A1, send-file route, send-file policy.
  - **Steps:** Route resolves `isAdmin=true`; validation skips `data/<user>` isolation; file is sent.
  - **Covered by:** R9.

## Acceptance Examples

- AE1. **Covers R1, R2, R3.** A workspace policy denies Shell. The admin asks the bot to run `Bash`; the command executes. A non-admin in the same workspace asks the same thing and receives a denial.
- AE2. **Covers R4, R6.** The admin asks the bot to read `data/alice/secret.txt`; the content is returned. The admin asks to read `/etc/passwd`; the request is denied.
- AE3. **Covers R5, R6.** The admin asks the bot to write `shared/config.json`; the file is written. The admin asks to write `../outside.json`; the request is denied.
- AE4. **Covers R7, R8.** The admin asks the bot to invoke `unlisted-skill`; the skill runs. The admin asks to invoke a skill with an empty name; the request is denied.
- AE5. **Covers R9, R10.** The admin calls the send-file API with `docs/report.pdf`; it succeeds. A non-admin calls the same API with `docs/report.pdf`; it is denied because the file is outside their own data folder.

## Scope Boundaries

### In scope

- WeCom bot admin bypass for tool permissions.
- WeCom bot admin bypass for file read/write path policy.
- WeCom bot admin bypass for skill allowlists.
- WeCom bot admin bypass for the proactive send-file API.
- UI hint update in the Isolation settings tab.

### Deferred for later

- Audit log of admin actions.
- Runtime policy invalidation for active bot sessions.
- Feishu bot admin parity.

### Outside scope

- GUI session permissions.
- New admin configuration UI.
- Changes to the workspace denylist definition.
- MCP tool or Skill policy redesign beyond the admin bypass.

## Dependencies / Assumptions

- `wecomBotIsolation.adminUserIds` is authoritative for admin identity.
- The canonical WeCom user ID used at runtime (mapped plaintext or encrypted fallback) matches entries in `adminUserIds`.
- Policy changes still apply to the next bot session, not active ones.

## Outstanding Questions

### Resolve before planning

_None._

### Deferred to planning

_None._

## Sources / Research

- Existing skill admin logic: `src/server/services/bot-skill-policy.ts`
- Tool permission policy: `src/server/services/tool-permission-policy.ts`
- Path policy: `src/server/services/bot-path-policy.ts`
- Send-file policy: `src/server/services/wecom-send-file-policy.ts`
- Runtime integration: `src/server/services/chat-service.ts`
- Proactive send-file route: `src/server/routes/wecom-send-file.ts`
- Admin configuration UI: `src/client/components/IsolationSubTab.tsx`
