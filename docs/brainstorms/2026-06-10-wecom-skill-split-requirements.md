---
date: 2026-06-10
---

# Split WeCom Message Skill into Send and Enqueue Skills

## Problem Frame

The current `send-wecom-message` skill handles three distinct behaviors in a single file:
1. **Normal sends**: `wecom msg send` for messages in the current conversation
2. **Proactive initiation**: `wecom queue enqueue` when A asks to send to B
3. **Proactive execution**: Handling `[Proactive Send]` directives in B's session

The agent in A's session frequently confuses (1) and (2), using `wecom msg send` when it should enqueue. The skill is overloaded — its description is broad ("send a WeCom message, notify someone, or communicate via WeCom") and its workflow asks the agent to classify intent before choosing a command. A focused skill with a tight description should route the agent more reliably.

## Requirements

### R1. Extract proactive initiation into a dedicated skill
Create a new skill `enqueue-wecom-proactive-message` (or similar name) that:
- Has a description focused on queueing messages to other users' sessions
- Contains only the `wecom queue enqueue` workflow
- Includes examples of "send to X", "notify Y", "tell Z" phrasings
- Documents CLI exit codes specific to enqueue (same codes, but scoped to the enqueue command)

### R2. Keep normal sends in the existing skill
Retain `send-wecom-message` for:
- `wecom msg send` in the current conversation
- Markdown detection and drafting guidance
- The `<proactive_send>` directive execution section for B's session
- Normal send examples

### R3. Remove proactive initiation from the existing skill
The `send-wecom-message` skill should no longer contain:
- The `<proactive_send_initiate>` section
- `wecom queue enqueue` examples or references
- Recipient-type decision logic ("if the user names a recipient other than themselves...")

### R4. Generate both skills from source
Both skill markdown files must be generated into `src/server/assets/` as TypeScript exports, mirroring the existing `wecom-skill.ts` pattern. `wecomBotService.writeSkillFiles` must write both skills to the workspace's `.claude/skills/` directory on bot connect.

### R5. Backward compatibility
Existing workspaces with the old combined skill should receive the new split skills on the next bot reconnect. No migration of old skill files is required (they are overwritten on connect).

## Scope Boundaries

### In scope
- Two skill markdown files with focused descriptions and workflows
- Generation pipeline updates to produce both `wecom-skill.ts` and a new `wecom-proactive-skill.ts`
- `wecomBotService` updates to write both skills

### Out of scope
- Changes to the CLI (`wecom msg send` and `wecom queue enqueue` already exist)
- Changes to the queue worker, storage, or HTTP endpoints
- Changes to the agent SDK or skill loading mechanism
- Session-specific skill loading (both skills still load in all sessions)

### Deferred to follow-up work
- Deduplicating shared content (exit codes, quoting rules) via a shared template or include mechanism
- Evaluating whether agent routing improves with the split (observational)

## Key Decisions

- **Two skills, not three**: The proactive execution (`<proactive_send>`) stays in `send-wecom-message` because it uses the same command (`wecom msg send`) and the same session context as normal sends. Extracting it would create a third skill that still loads everywhere.
- **Skill names**: `send-wecom-message` (existing) and `enqueue-wecom-proactive-message` (new). The new name uses "enqueue" to align with the CLI subcommand and distinguish it from direct sends.

## Dependencies / Assumptions

- The agent SDK respects skill descriptions for routing decisions
- `wecomBotService.writeSkillFiles` can write multiple skills per workspace
- `npm run generate:skills` can be extended to generate both skill files
