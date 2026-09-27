---
date: 2026-06-10
sequence: 004
type: refactor
status: active
---

# Rename Proactive Skill to send-wecom-proactive-msg

## Summary

Rename the `enqueue-wecom-proactive-message` skill to `send-wecom-proactive-msg` and refresh its content to frame the capability as "sending a proactive message to another user's session" rather than "queueing/enqueueing." The queue mechanics are an implementation detail behind the CLI; users of the skill only need to know the message will be delivered to the target user's session.

---

## Problem Frame

The current skill name (`enqueue-wecom-proactive-message`) and content surface implementation details (`wecom queue enqueue`, "queue entry ID") that leak the internal queue infrastructure. The user-facing concept is simpler: "send a proactive message to another user and it will appear in their session." The skill should match this mental model.

---

## Key Technical Decisions

- **Keep the CLI command as `wecom queue enqueue`**: The underlying CLI subcommand stays unchanged — only the skill's framing and naming change.
- **Generated asset file name stays**: `src/server/assets/wecom-proactive-skill.ts` and its export `PROACTIVE_SKILL_MD` remain unchanged to minimize ripple in the bot service import.
- **Directory name follows skill name**: The workspace skill directory is `.claude/skills/send-wecom-proactive-msg/` to match the new skill identity.

---

## Implementation Units

### U1. Rename and refresh the skill markdown source

**Goal:** Rename the markdown source file and update all content to use "send proactive message" framing instead of "queue/enqueue."

**Files:**
- `src/server/assets/enqueue-wecom-proactive-message.md` → `src/server/assets/send-wecom-proactive-msg.md` (rename + modify)

**Approach:**
1. Rename the file
2. Update frontmatter: `name: send-wecom-proactive-msg`, description focused on delivering a message to another user's session
3. Rewrite `<objective>` to describe sending a proactive message to a target user's session (the queue is behind the CLI)
4. Rewrite `<quick_start>` to use "send a proactive message" language
5. Rewrite `<workflow>` steps 1-4 with "send" framing; keep the actual `wecom queue enqueue` command unchanged since that's the CLI contract
6. Rewrite `<examples>` to use "send" / "deliver" language instead of "queue"
7. Keep `<anti_patterns>` exit codes and quoting rules; rename `using_direct_send` to `using_msg_send` or equivalent; update pitfall text to use "send" framing
8. Rewrite `<success_criteria>` to use "send" language; keep the queue entry ID mention since the CLI returns it

**Patterns to follow:** Existing skill structure and tone from `send-wecom-message.md`.

**Test scenarios:**
- Verification: `scripts/generate-wecom-proactive-skill.ts` can read and escape the renamed markdown successfully
- Verification: frontmatter parses correctly

---

### U2. Update generation script and regenerate asset

**Goal:** Point the generation script at the renamed markdown file and regenerate the TypeScript asset.

**Dependencies:** U1

**Files:**
- `scripts/generate-wecom-proactive-skill.ts` (modify)
- `src/server/assets/wecom-proactive-skill.ts` (regenerate)

**Approach:**
1. Update `mdPath` in the script from `enqueue-wecom-proactive-message.md` to `send-wecom-proactive-msg.md`
2. Run `npm run generate:skills` to regenerate the asset
3. Verify the generated file contains the new skill name `send-wecom-proactive-msg`

**Test scenarios:**
- `npm run generate:skills` exits 0
- Generated `src/server/assets/wecom-proactive-skill.ts` exports `PROACTIVE_SKILL_MD` with the new name

---

### U3. Update wecomBotService to deploy under new skill name

**Goal:** Update the bot service to write and remove the skill under its new directory name.

**Dependencies:** U2

**Files:**
- `src/server/services/wecom-bot-service.ts` (modify)

**Approach:**
1. In `writeSkillFiles`: change `enqueue-wecom-proactive-message` directory name to `send-wecom-proactive-msg`
2. In `removeSkillFiles`: change the same directory name for cleanup

**Test scenarios:**
- Server build passes (`npm run build:server`)
- No TypeScript errors from the change

---

### U4. Verify end-to-end

**Goal:** Confirm the full pipeline works with the new name.

**Dependencies:** U3

**Approach:**
1. Run `npm run generate:skills`
2. Run `npm run build:server`
3. Optionally: reconnect a WeCom bot and verify `.claude/skills/send-wecom-proactive-msg/SKILL.md` is written

**Test scenarios:**
- Generate succeeds
- Build passes
- Manual verification: bot reconnect writes skill to new directory

---

## Scope Boundaries

### Out of scope
- Changes to the CLI (`wecom queue enqueue` command stays as-is)
- Changes to the queue worker, storage, or HTTP endpoints
- Changes to the `send-wecom-message` skill
- Changes to the agent SDK or skill loading mechanism
- Renaming the generated TypeScript asset file (`wecom-proactive-skill.ts`) or its export (`PROACTIVE_SKILL_MD`)

---

## Dependencies / Assumptions

- `npm run generate:skills` can chain multiple script invocations
- `wecomBotService.writeSkillFiles` can write to a renamed directory without conflicts
- Existing `.claude/skills/enqueue-wecom-proactive-message/` directories become stale but are not cleaned up automatically (they'll be overwritten by the new directory on reconnect; old directory stays as orphan)

---

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Stale skill directory left in workspaces | High | Low | Old `enqueue-wecom-proactive-message/` directory is harmless; new skill writes to `send-wecom-proactive-msg/`. Both skills may coexist briefly. |
| Build breaks due to renamed import or path | Low | Low | Verify build in U4 before considering complete. |
