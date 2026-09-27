---
title: "Deferred Runtime Rebuild on Config Changes - Plan"
type: feat
date: 2026-07-03
topic: deferred-runtime-rebuild-on-config-changes
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
deepened: 2026-07-03
---

# Deferred Runtime Rebuild on Config Changes - Plan

## Goal Capsule

- **Objective:** When workspace-, bot-, or provider-level configuration that is snapshotted at Comate session runtime creation changes, automatically rebuild affected runtimes so the next user prompt uses the new configuration without requiring users to manually restart sessions or processes.
- **Product authority:** The existing runtime cache in `src/server/services/chat-service.ts` is intentional for performance; this feature makes the cache invalidate safely and pre-create its replacement.
- **Open blockers:** None.

## Product Contract

### Summary

Introduce a deferred runtime invalidation and pre-creation mechanism that applies to all cached Comate runtimes, including bot sessions and GUI sessions.
A configuration change marks matching runtimes stale.
If a runtime is actively processing a turn, the system waits until the turn ends, including pending approvals or questions.
It then closes the old runtime and immediately pre-creates a replacement with the latest configuration.
Multiple rapid changes that affect the same runtime are coalesced into a single rebuild.
Provider switches move from the current "close only" behavior into the same deferred rebuild pipeline.

### Problem Frame

Several configuration values are captured when a `SessionRuntime` is created in `ChatService.buildSdkOptions` and cannot be changed on a live runtime.
Examples include bot role policy, bot personas, workspace tool permissions, workspace isolation settings, the sensitive file denylist, and the session provider.
Some changes already trigger an immediate `closeRuntime` today, such as bot policy or persona updates and provider switches.
Other changes, such as workspace-level `wecomToolPermissions`, `wecomBotIsolation`, or `sensitiveFileDenylist`, do not trigger any invalidation.
In all cases an active turn can be interrupted, and users have no manual way to rebuild a runtime.
The result is stale policy, confusing delays, or lost in-flight output.

### Requirements

#### Triggers

R1. **Bot-level triggers.** Changes to a Bot's `rolePolicy`, `persona`, `rolePersonas`, or member list (add, remove, or role change) must schedule a rebuild for every cached runtime whose session belongs to that bot.

R2. **Workspace-level legacy permission triggers.** Changes to `WorkspaceSettings.wecomToolPermissions`, `wecomBotIsolation`, or `sensitiveFileDenylist` must schedule a rebuild for every cached bot runtime that still uses workspace-level policy, including sessions without an explicit `botId`.

R3. **Provider and GUI triggers.** Changes to session-level `providerId` and any provider setting that is snapshotted at GUI runtime creation must schedule a rebuild for the affected runtime or runtimes.
The existing immediate-close provider switch behavior is subsumed by the deferred rebuild pipeline, so provider switches rebuild rather than only close.

#### Rebuild behavior

R4. **Deferred rebuild.** If a target runtime is actively processing a turn, the rebuild must be deferred until the turn ends.
A turn is active while the SDK is streaming an assistant message or while there are pending tool approvals or questions.

R5. **Pending approval indefinite wait.** A runtime waiting for a user approval or question must not be force-closed.
The rebuild waits until the approval or question is resolved, or the runtime is closed through another path.

R6. **Pre-create replacement.** After the old runtime is closed, the system must immediately create a new runtime for the same session with the updated configuration, so the next user prompt incurs no runtime creation latency.

#### Robustness

R7. **Coalescing.** If multiple configuration changes affect the same runtime while it is active or while a rebuild is already pending, they must be coalesced into a single rebuild that applies the latest configuration.

R8. **No user-initiated rebuild.** The feature must not require users to explicitly restart a session, close a tab, or send a special command to pick up configuration changes.

R9. **Failure tolerance.** If closing the old runtime or pre-creating the new one fails, the failure must be logged and must not block subsequent user messages from triggering a normal on-demand rebuild.

### Key Decisions

- **Deferred over immediate close.** Closing an active runtime mid-turn loses in-flight output and can leave users confused; waiting for `assistant_done` or approval resolution is safer.
- **Pre-create over lazy rebuild.** Pre-creating the replacement after the turn ends removes cold-start latency from the next user prompt, at the cost of an extra SDK child process that may idle-close before the next message arrives.
- **Coalescing over per-change rebuilds.** Multiple rapid edits would otherwise churn runtimes; coalescing means intermediate configurations are skipped and only the latest is applied.
- **Pending approvals are never interrupted.** Even if an approval sits unresolved for a long time, the runtime keeps serving that pending state until resolution.
- **Provider switches use the same pipeline.** Moving provider switches from "close only" into "close + pre-create" gives them the same no-wait behavior as other config changes.

### Key Flows

F1. **Bot policy change while runtime idle**
- **Trigger:** Admin saves a Bot `rolePolicy`.
- **Action:** System finds all cached runtimes whose session belongs to that bot.
- **Immediate close:** Runtime is not processing a turn.
- **Pre-create:** New runtime is built with the updated policy.
- **Next message:** User prompt is pushed to the new runtime.

F2. **Workspace tool permission change while runtime active**
- **Trigger:** Admin updates `wecomToolPermissions`.
- **Action:** System finds all affected legacy bot runtimes.
- **Deferred close:** Runtime is streaming or has a pending approval.
- **Wait:** System waits for `assistant_done` or approval resolution.
- **Rebuild:** Old runtime is closed and a new runtime is pre-created with the updated policy.
- **Next message:** User prompt uses the new runtime.

F3. **Provider switch while runtime active**
- **Trigger:** User or admin changes a session's `providerId`.
- **Action:** System schedules a rebuild for that session's runtime.
- **Wait:** If the runtime is processing a turn, wait until it ends.
- **Rebuild:** Close the old runtime and pre-create a new one with the new provider.
- **Next message:** User prompt is handled by the rebuilt runtime.

F4. **Multiple rapid changes**
- **Trigger:** Two admin edits arrive within seconds for the same bot.
- **Action:** The first edit schedules a deferred rebuild; the second edit updates the target configuration and is coalesced into the same pending rebuild.
- **Result:** Only one close and pre-create happens, applying the latest configuration.

### Scope Boundaries

#### In scope

- Bot-level and workspace-level permission/policy changes that are snapshotted at runtime creation.
- Provider switches and GUI session runtime invalidation for provider and other snapshotted session settings.
- Deferred close, pending-approval indefinite wait, pre-create, and coalescing.

#### Deferred for later

- Force-closing runtimes after a timeout when pending approvals never resolve.
- Audit logging of which runtimes were rebuilt and why.
- Visual UI hints telling admins that a runtime is stale or rebuilding.

#### Outside scope

- Changing configuration values on a live runtime without rebuilding.
- Mid-turn policy enforcement for tool calls already emitted before the change.
- Non-runtime configuration such as client-side UI preferences.

### Dependencies / Assumptions

- `SessionRuntime.isProcessingTurn()` accurately reflects an active turn.
- `ChatService.closeRuntime`, `closeRuntimesForBot`, and `closeRuntimesForWorkspace` remain the primitives for closing cached runtimes.
- `ChatService.getOrCreateRuntime` can safely build a bot or GUI runtime without an inbound message when pre-creating; otherwise pre-creation falls back to on-demand creation.
- The existing `getOrCreateRuntime` reuse path can attach a new event handler to a pre-created runtime when the next message arrives.

### Sources / Research

- Existing bot-level invalidation: `src/server/routes/bots.ts:29-35`, `src/server/services/chat-service.ts:882-903`.
- Existing provider switch invalidation: `src/server/services/chat-service.ts:237-246`, `269-278`.
- Runtime active-turn detection: `src/server/services/session-runtime.ts:640-642`.
- Runtime caching and creation: `src/server/services/chat-service.ts:583-675`.
- Existing tool-permission policy and workspace-level policy: `src/server/services/tool-permission-policy.ts`, `src/server/models/workspace.ts`.

## Planning Contract

### Key Technical Decisions

KTD1. **Track runtime context per cached session.**
`ChatService` already stores the `SessionRuntime`, but it does not remember whether the runtime was created for a bot session or the bot user identity.
Add a `runtimeContexts` map keyed by `sessionId` that records `{ workspaceId, isBotSession?, botUserId? }` whenever `getOrCreateRuntime` creates or reuses a runtime, and clears it in `closeRuntime`.
This lets the scheduler target bot vs. GUI sessions and rebuild bot sessions with the same identity they had.

KTD2. **Use polling to detect turn completion on stale runtimes.**
Rather than adding event hooks into `SessionRuntime`, leverage the existing `isProcessingTurn()` predicate and poll every 500 ms while a rebuild is pending.
This mirrors the existing idle-close deferral pattern in `scheduleIdleClose` and keeps the change inside `ChatService`.
The trade-off is a small, bounded polling cost for sessions that have a pending rebuild; pollers are cleared immediately after rebuild or close.

KTD3. **Coalesce by session id in a single pending-rebuild map.**
A `pendingRebuilds` map keyed by `sessionId` stores the latest rebuild context.
If a second config change arrives for the same session while a rebuild is already pending, only the map entry is updated; no new timer or extra rebuild is scheduled.
When the turn ends, one rebuild runs against the then-current database state, so intermediate configurations are skipped automatically.

KTD4. **Pre-create by reusing the normal creation path.**
After closing a stale runtime, call `getOrCreateRuntime(sessionId, workspaceId, isBotSession, undefined, botUserId)`.
Passing `undefined` for the bot event handler is safe: there is no active message during pre-creation, and the next `pushMessage` clears and re-attaches the handler for that turn.
The pre-created runtime is subject to the normal idle-close lifecycle; if no message arrives before the grace period, it closes and the next message recreates it on demand.

KTD5. **Leave immediate-close utilities unchanged for destructive paths.**
`closeRuntimesForWorkspace` is still used when a workspace is deleted and must not pre-create anything.
`closeRuntime` clears any pending-rebuild state so that a manual or destructive close does not accidentally trigger a pre-create afterwards.

### High-Level Technical Design

The scheduler lives entirely inside `ChatService`.
Three new private maps sit beside the existing `runtimes` and `idleTimeouts` maps:

- `runtimeContexts` — per-session creation metadata.
- `pendingRebuilds` — sessions waiting for a rebuild plus the latest context.
- `rebuildPollers` — active `setInterval` handles for sessions whose turn is still active.

A public `scheduleRuntimeRebuild(sessionId, context)` method is the single entry point:

1. Look up the runtime. If none is cached, do nothing; the next message will build fresh.
2. Store or overwrite the context in `pendingRebuilds`.
3. If `isProcessingTurn()` is false, call `performRebuild` immediately.
4. Otherwise start a poller that checks `isProcessingTurn()` every 500 ms and triggers `performRebuild` once the turn ends or the runtime disappears.

`performRebuild` clears the pending state, closes the old runtime, and calls `getOrCreateRuntime`.
Errors in either step are logged with `sidecarLog`; the pending state is still cleared so that the next user message can create a runtime normally.

Bulk invalidation helpers route sets of sessions into `scheduleRuntimeRebuild`:

- `scheduleRebuildsForBot(botId)` — all cached sessions whose `ChatSession.botId` matches.
- `scheduleRebuildsForProvider(providerId)` — all cached sessions whose `ChatSession.providerId` matches.
- `scheduleRebuildsForWorkspaceLegacyPolicy(workspaceId)` — all cached bot sessions in the workspace that have no `botId` (the legacy workspace-level policy path).

Route changes:

- `src/server/routes/bots.ts` — `invalidateBotRuntimesIfNeeded` and member routes call `scheduleRebuildsForBot` instead of `closeRuntimesForBot`.
- `src/server/routes/workspaces.ts` — `PUT /api/workspaces/:id` schedules legacy-policy rebuilds when the update touches `wecomToolPermissions`, `wecomBotIsolation`, or `sensitiveFileDenylist`.
- `src/server/routes/providers.ts` — `PUT /api/providers/:id` schedules rebuilds for sessions using that provider when `baseUrl` or `authToken` changes; `DELETE /api/providers/:id` schedules rebuilds for sessions using the deleted provider.
- `src/server/services/chat-service.ts` — `updateSession` schedules a rebuild for `providerId` changes instead of calling `closeRuntime` directly.

### Assumptions / Risks

- **Pending approvals can remain unresolved indefinitely.** The poller never force-closes a runtime while `isProcessingTurn()` is true; if a user never resolves an approval, the runtime remains until idle-close or manual close.
- **Pre-created runtimes consume SDK child processes.** Each pre-create spawns a new SDK process that may idle for up to the 10-minute grace period. This is the cost of removing next-message latency; it is bounded by the number of distinct sessions receiving config changes.
- **Polling is bounded by cached sessions only.** Only sessions with a pending rebuild are polled, and the interval is cleared as soon as the rebuild completes.
- **Event-handler identity is per-message.** Because `getOrCreateRuntime` clears bot event handlers on reuse, a pre-created bot runtime will not leak events to a stale consumer.

## Implementation Units

### U1. Add deferred rebuild scheduler to ChatService

**Goal:** Implement the core state, scheduling, coalescing, and pre-creation logic so that individual config changes can request a safe runtime rebuild.

**Requirements:** R4, R5, R6, R7, R9.

**Files:**
- `src/server/services/chat-service.ts`
- `src/server/services/chat-service.test.ts`

**Approach:**
1. Add a `RuntimeContext` type `{ workspaceId: string; isBotSession?: boolean; botUserId?: string; }`.
2. Add private maps to `ChatService`:
   - `runtimeContexts: Map<string, RuntimeContext>`
   - `pendingRebuilds: Map<string, RuntimeContext>`
   - `rebuildPollers: Map<string, NodeJS.Timeout>`
3. In `getOrCreateRuntime`, set `this.runtimeContexts.set(sessionId, context)` after the runtime is stored, and remove the entry in `closeRuntime`.
4. Implement `scheduleRuntimeRebuild(sessionId, context)`:
   - No-op if no runtime is cached.
   - Store/overwrite `pendingRebuilds`.
   - If idle, call `performRebuild`.
   - If active, start a poller if one is not already running.
5. Implement `startRebuildPoller(sessionId)` with a 500 ms interval that triggers `performRebuild` when `isProcessingTurn()` becomes false or the runtime disappears.
6. Implement `performRebuild(sessionId, context)`:
   - Clear pending state and poller.
   - `await this.closeRuntime(sessionId)`.
   - `await this.getOrCreateRuntime(sessionId, context.workspaceId, context.isBotSession, undefined, context.botUserId)`.
   - Log errors; never throw to callers.
7. Update `closeRuntime`, `closeAllRuntimes`, and `closeRuntimesForWorkspace` to clear any pending-rebuild state for affected sessions so destructive/manual closes do not pre-create.

**Test scenarios:**
- An idle cached runtime is closed and a replacement is pre-created immediately after scheduling.
- An active runtime (streaming or pending approval) is not closed; the rebuild waits until `isProcessingTurn()` returns false.
- Multiple schedule calls for the same session while active result in a single close-and-pre-create once the turn ends.
- A schedule call that arrives after a replacement has already been pre-created triggers another close-and-pre-create, so the latest config wins.
- If `closeRuntime` throws, the error is logged and subsequent `pushMessage` calls still create a runtime on demand.

### U2. Route bot-level changes through the rebuild scheduler

**Goal:** Replace the existing immediate bot runtime invalidation with deferred rebuilds that respect active turns and pre-create replacements.

**Requirements:** R1.

**Files:**
- `src/server/routes/bots.ts`
- `src/server/services/chat-service.ts`

**Approach:**
1. Keep `closeRuntimesForBot` available for destructive paths, but add `scheduleRebuildsForBot(botId)` to `ChatService`.
2. `scheduleRebuildsForBot` iterates `runtimeContexts`, loads each local session via `workspaceStore.getLocalSession(sessionId)`, and schedules a rebuild when `session.botId === botId`.
3. In `src/server/routes/bots.ts`:
   - `invalidateBotRuntimesIfNeeded(botId, input)` calls `chatService.scheduleRebuildsForBot(botId)`.
   - Member add/role/remove routes call `chatService.scheduleRebuildsForBot(req.params.id)` instead of `closeRuntimesForBot`.

**Test scenarios:**
- Updating a bot's `rolePolicy` schedules a rebuild for every cached runtime whose session has that `botId`.
- Updating a bot's `name` alone does not schedule a rebuild.
- A member role change schedules a rebuild for affected bot sessions.
- Active bot sessions are deferred until the turn ends, then rebuilt.

### U3. Add workspace-level legacy policy invalidation

**Goal:** When workspace-level legacy bot policy fields change, rebuild the cached bot sessions that still rely on workspace-level policy.

**Requirements:** R2.

**Files:**
- `src/server/routes/workspaces.ts`
- `src/server/services/chat-service.ts`

**Approach:**
1. Add `scheduleRebuildsForWorkspaceLegacyPolicy(workspaceId)` to `ChatService`.
2. Iterate `runtimeContexts`. For each cached session:
   - Load the local session.
   - Skip non-bot sessions and sessions with an explicit `botId` (those use bot-level policy).
   - Schedule a rebuild when `session.workspaceId === workspaceId`.
3. In `src/server/routes/workspaces.ts`, after `store.update` in `PUT /api/workspaces/:id`, inspect `input.settings`. If `wecomToolPermissions`, `wecomBotIsolation`, or `sensitiveFileDenylist` is present, call `chatService.scheduleRebuildsForWorkspaceLegacyPolicy(req.params.id)`.

**Test scenarios:**
- Updating `wecomToolPermissions` triggers a rebuild for a cached legacy bot session (no `botId`).
- The same update does not trigger a rebuild for a cached GUI session or a cached modern bot session with a `botId`.
- A workspace rename alone does not trigger a rebuild.

### U4. Move provider switches into the rebuild pipeline

**Goal:** Provider changes use the same deferred-rebuild semantics as bot and workspace policy changes, and provider setting changes also invalidate affected sessions.

**Requirements:** R3.

**Files:**
- `src/server/services/chat-service.ts`
- `src/server/routes/providers.ts`

**Approach:**
1. In `ChatService.updateSession`, replace the two direct `closeRuntime` blocks for `providerId` changes with a single `this.scheduleRuntimeRebuild(id, this.runtimeContexts.get(id))` call when the runtime is cached.
   - If no runtime is cached, no scheduling is needed because the next message will read the new provider.
   - Using the stored context preserves `isBotSession` and `botUserId`, so bot sessions are rebuilt as bot sessions.
2. Add `scheduleRebuildsForProvider(providerId)` to `ChatService` that iterates `runtimeContexts`, loads each local session, and schedules a rebuild when `session.providerId === providerId`.
3. In `src/server/routes/providers.ts`:
   - `PUT /api/providers/:id`: after a successful `store.updateProvider`, if any snapshotted field changed (`baseUrl`, `authToken`, `model`, `defaultOpusModel`, `defaultSonnetModel`, `defaultHaikuModel`, `subagentModel`, `effortLevel`, or `customEnvVars`), call `chatService.scheduleRebuildsForProvider(id)`.
   - `DELETE /api/providers/:id`: after a successful deletion, call `chatService.scheduleRebuildsForProvider(id)`.

**Test scenarios:**
- Changing a session's `providerId` schedules a rebuild for that session's cached runtime.
- If the runtime is active, the rebuild waits until the turn ends.
- Updating `baseUrl`, `authToken`, `model`, or any other snapshotted provider field schedules rebuilds for all cached sessions whose `providerId` matches.
- Updating only a provider's `name` does not schedule a rebuild.

## Verification Contract

Run the repo-specific quality gates after all units land:

- `npm run lint` — must pass with no new warnings in touched files.
- `npm run test:server` — must pass, especially `src/server/services/chat-service.test.ts`.
- `npm run test:server -- src/server/routes/bots.test.ts src/server/routes/workspaces.test.ts` if existing route tests cover the changed endpoints; add/update tests where behavior changed.

Manual smoke checks (local dev):
1. Start a GUI session, change its `providerId`, and confirm the next message runs against a rebuilt runtime (logs show close + open).
2. Start a bot session, change its bot `rolePolicy`, and confirm the next message uses the new policy.
3. Trigger a tool approval in a bot session, change bot policy, and confirm the runtime is not closed until the approval is resolved.

## Definition of Done

### Global

- All modified files are repo-relative and use the existing import conventions (`.js` extensions for server files, project aliases for client files).
- `npm run lint` passes.
- `npm run test:server` passes.
- `CHANGELOG.md` is updated with a user-facing entry following Keep a Changelog format.
- No polling intervals or rebuild timers leak after `closeRuntime`, `closeAllRuntimes`, or `closeRuntimesForWorkspace`.

### Per unit

- **U1:** `ChatService` exposes `scheduleRuntimeRebuild`, `scheduleRebuildsForBot`, `scheduleRebuildsForProvider`, and `scheduleRebuildsForWorkspaceLegacyPolicy`; pending rebuilds coalesce; idle runtimes rebuild immediately; active runtimes wait indefinitely for the turn to end; pre-creation uses the normal `getOrCreateRuntime` path.
- **U2:** `src/server/routes/bots.ts` no longer calls `closeRuntimesForBot` for policy or member changes; bot sessions pick up policy changes on the next turn without manual intervention.
- **U3:** `PUT /api/workspaces/:id` schedules legacy-policy rebuilds only when the relevant settings fields change; modern bot sessions and GUI sessions are not churned.
- **U4:** Provider switches rebuild instead of only close; provider `baseUrl`/`authToken` changes invalidate all sessions using that provider; GUI and bot sessions are both covered.

### Cleanup

- Any experimental or dead-end approaches (e.g., alternative event-based turn detection if tried) are removed before the work is declared done.
- The plan file remains the single source of truth; implementation code matches the decisions recorded here.
