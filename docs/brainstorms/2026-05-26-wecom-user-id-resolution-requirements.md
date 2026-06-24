---
date: 2026-05-26
topic: wecom-user-id-resolution
---

# WeCom Encrypted User ID Resolution

## Summary

A hybrid resolver that converts encrypted WeCom user IDs (`openuserid`) to plaintext enterprise IDs. Unseen IDs are queued for periodic batch conversion by default; the system also supports an immediate single lookup when a consumer explicitly needs the plaintext ID before the next scheduled flush. Two new workspace settings fields (`corpid`, `corpsecret`) enable the enterprise API, and resolved mappings are persisted for instant reuse.

In addition, the workspace settings WeCom users tab now lets admins manually type a plaintext userId for an existing user when auto-resolution is slow or unavailable, always displays the encrypted `openuserid`, and provides manual controls to reload the list and trigger an immediate flush of pending IDs.

---

## Problem Frame

The existing WeCom bot integration stores encrypted user IDs as the canonical user identifier for session routing. This works for matching messages to sessions, but encrypted IDs cannot be used for downstream permission control, file access decisions, or admin visibility, which require stable plaintext enterprise user IDs.

The WeChat Work enterprise API provides a conversion endpoint (`batch/openuserid_to_userid`), but calling it individually for every new user is inefficient and risks rate limits at the scale this deployment targets (100+ potential users). A batched, queued approach resolves most IDs in the background without blocking message handling, while an immediate lookup escape hatch serves consumers that cannot wait.

Admins also need visibility into the raw encrypted identifier and a way to bridge the gap when automatic resolution is delayed or temporarily failing. Manual entry is intended as a stopgap, not a replacement for the API.

---

## Actors

- A1. WeCom User: Sends messages to the bot; their encrypted ID arrives in the websocket frame.
- A2. WeCom Bot Service: Receives messages, queues unseen IDs, triggers batch resolution, and handles immediate lookups.
- A3. Admin: Configures `corpid` and `corpsecret` in workspace settings; can view the user list, type plaintext IDs, reload the list, and trigger an immediate flush.
- A4. Skill / Permission Consumer: Requests the plaintext user ID for permission checks or session attribution.

---

## Key Flows

- F1. Unseen user sends first message
  - **Trigger:** A WeCom message arrives from an encrypted user ID not yet in the mapping table.
  - **Actors:** A1, A2
  - **Steps:** Bot service receives message. Checks mapping table — miss. Queues encrypted ID for batch flush. Continues processing the message with the encrypted ID as the session key.
  - **Outcome:** The message is handled; the plaintext ID will be available after the next batch flush unless a consumer requests an immediate lookup.
  - **Covered by:** R5, R6, R10

- F2. Batch flush resolves queued IDs
  - **Trigger:** Queue timer fires or queue reaches size threshold.
  - **Actors:** A2
  - **Steps:** Bot service checks access token cache. If expired, fetches new token using `corpid` + `corpsecret`. Calls batch conversion API with queued encrypted IDs. Stores successful mappings. Clears resolved IDs from queue; failed IDs are re-queued with backoff.
  - **Outcome:** Mapping table now contains plaintext IDs for the queued users.
  - **Covered by:** R7, R8, R11, R12

- F3. Known user sends subsequent message
  - **Trigger:** A WeCom message arrives from an encrypted user ID already in the mapping table.
  - **Actors:** A1, A2
  - **Steps:** Bot service receives message. Checks mapping table — hit. Retrieves plaintext ID alongside encrypted ID.
  - **Outcome:** The message is handled with both encrypted and plaintext IDs available.
  - **Covered by:** R6, R10

- F4. Admin configures enterprise API credentials
  - **Trigger:** Admin opens workspace settings and enters `corpid` + `corpsecret`.
  - **Actors:** A3
  - **Steps:** Admin fills in `corpid` and `corpsecret` fields. Saves workspace settings.
  - **Outcome:** The workspace can now resolve user IDs.
  - **Covered by:** R1–R4

- F5. Consumer requests immediate resolution
  - **Trigger:** A running skill or permission check needs the plaintext ID before the next batch flush.
  - **Actors:** A4, A2
  - **Steps:** Consumer calls the immediate resolution API with an encrypted user ID. System checks the mapping table — miss. Fetches or reuses a cached access token. Calls the batch API with a single ID. Stores the mapping. Removes the ID from the pending queue if it was queued. Returns the plaintext ID.
  - **Outcome:** Plaintext ID is available synchronously to the consumer.
  - **Covered by:** R9, R13, R14

- F6. Admin manually enters a plaintext userId
  - **Trigger:** Admin opens the WeCom users tab and sees a user whose plaintext ID is still pending or incorrect.
  - **Actors:** A3
  - **Steps:** Admin clicks into the plaintext userId cell, types the value, and saves. The system validates uniqueness within the workspace, stores the mapping, and updates the displayed plaintext ID.
  - **Outcome:** The row now shows the admin-entered plaintext ID. The encrypted ID remains visible. Auto-resolution may overwrite the value later.
  - **Covered by:** R20–R23, R26, R27

- F7. Admin reloads the user list
  - **Trigger:** Admin clicks the reload button in the WeCom users tab.
  - **Actors:** A3
  - **Steps:** UI fetches the latest workspace user list and current mappings from the server.
  - **Outcome:** The list reflects the most recent state, including any mappings resolved since the last auto-poll.
  - **Covered by:** R24

- F8. Admin triggers immediate resolution for pending IDs
  - **Trigger:** Admin clicks the "Resolve pending now" button in the WeCom users tab.
  - **Actors:** A3, A2
  - **Steps:** UI asks the backend to flush queued IDs for the workspace. The resolver obtains a valid access token and calls the batch conversion API. Successful mappings are stored.
  - **Outcome:** Pending plaintext IDs are resolved without waiting for the next scheduled flush.
  - **Covered by:** R25, R9

---

## Requirements

**Workspace settings**

- R1. Workspace settings include a `wecomCorpId` field for the enterprise `corpid`.
- R2. Workspace settings include a `wecomCorpSecret` field for the enterprise `corpsecret`.
- R3. Both fields are optional and independent of the existing bot ID/secret fields.
- R4. The `corpsecret` is treated with the same sensitivity as the existing bot secret.

**Queue and batch resolution**

- R5. When a message arrives from an unseen encrypted user ID, the system queues the ID for batch resolution instead of blocking message processing.
- R6. The system checks the persistent mapping table on every incoming message. If a mapping exists, the plaintext ID is retrieved immediately.
- R7. A background process flushes the queue periodically (time-based) and when the queue reaches a configurable size threshold.
- R8. On flush, the system obtains a valid access token (from cache or by fetching via `gettoken`), then calls the batch `openuserid_to_userid` API.
- R9. The system exposes an immediate resolution API that consumers can call to force a single-ID lookup before the next batch flush.
- R10. The encrypted user ID remains the canonical session key; the plaintext ID is available as a resolved attribute.
- R11. Successful mappings from the batch API are persisted to the store.
- R12. IDs that fail to resolve in a batch are re-queued for the next flush with an exponential backoff to avoid infinite retry loops.

**Immediate lookup**

- R13. The immediate resolution API checks the mapping table first; on miss, it fetches or reuses a cached access token and calls the batch API with a single ID.
- R14. The immediate lookup stores the result and removes the ID from the pending batch queue if it was queued, preventing duplicate work.
- R15. Immediate lookup failures are surfaced to the caller with a clear error; the ID is not re-queued for batch retry to avoid retry loops on permanently invalid IDs.

**Access token management**

- R16. The access token is cached in memory and refreshed before expiry or when absent.
- R17. If the cached token is expired or absent, the system fetches a new token using the workspace's `corpid` and `corpsecret`.
- R18. Token fetch failures are logged and surfaced as workspace-level errors; queued ID resolution and immediate lookups are deferred until a valid token is available.

**Storage**

- R19. The mapping is keyed by `(workspaceId, encryptedUserId)` and stores the plaintext `userId`; mappings survive server restarts.

**Settings user list**

- R20. The WeCom users tab displays the encrypted `openuserid` for every user in the list, in addition to the plaintext userId.
- R21. Each existing user row has an inline editable plaintext userId cell; the admin can type or change the value for users already known to the workspace.
- R22. Inline edits use explicit Save and Cancel controls per row; changes are not committed until the admin confirms.
- R23. Saving a manual plaintext userId rejects duplicates within the same workspace and surfaces a clear validation error.
- R24. The WeCom users tab provides a reload button that fetches the latest user list and mappings on demand.
- R25. The WeCom users tab provides a "Resolve pending now" button that triggers an immediate flush of all pending IDs for the workspace.
- R26. Manual plaintext entries are not authoritative; auto-resolution may overwrite them when the WeCom API returns a different value.
- R27. The plaintext userId cell shows a static placeholder while the plaintext ID is unresolved.

---

## Acceptance Examples

- AE1. **Covers R1, R5, R6, R7, R8, R11.** Given a workspace with `corpid` and `corpsecret` configured, when a message arrives from unseen encrypted user `E123`, then the message is processed immediately, `E123` is queued, and after the next flush the mapping `E123 → U456` is stored.
- AE2. **Covers R6, R10.** Given a workspace where `E123 → U456` is already stored, when a message arrives from `E123`, then the session is found and the plaintext ID `U456` is available without any API call.
- AE3. **Covers R8, R12.** Given a flush with three queued IDs where one resolves and two fail, then the successful mapping is stored and the two failed IDs remain queued for the next flush.
- AE4. **Covers R16, R17.** Given a workspace with a cached token expiring in 3 minutes, when a flush triggers, then the system uses the cached token. If the token had expired, it fetches a new one before calling the batch API.
- AE5. **Covers R9, R13, R14.** Given a new user `E789` whose ID is queued but not yet flushed, when a consumer calls the immediate resolution API for `E789`, then the system resolves the ID via single lookup, stores the mapping, removes `E789` from the pending queue, and returns the plaintext ID within the API round-trip time.
- AE6. **Covers R20–R23, R26, R27.** Given user `E123` with no plaintext ID, when the admin types `U456` into the plaintext cell and saves, then the workspace stores `E123 → U456`, the list shows `U456` and `E123`, and a later successful API resolution may overwrite the mapping with a different value.
- AE7. **Covers R20, R24.** Given the user list is stale after a background flush, when the admin clicks reload, then the list updates to show the newly resolved plaintext IDs.
- AE8. **Covers R25, R9.** Given two pending users `E111` and `E222`, when the admin clicks "Resolve pending now", then the resolver flushes the workspace queue and the list shows the resolved plaintext IDs after reload.

---

## Success Criteria

- New WeCom users can message the bot and have their plaintext ID resolved within one flush interval without blocking message handling.
- Existing users' plaintext IDs are available instantly from the local store.
- Consumers can request immediate resolution when they cannot wait for the next flush.
- The system does not exceed reasonable WeChat Work API rate limits for a 100+ user org.
- Mappings survive server restarts.
- Admins can see the encrypted ID for every user and can manually bridge unresolved plaintext IDs without leaving the settings UI.

---

## Scope Boundaries

- Permission control logic — deferred to a later phase.
- File read/write approval routing — deferred.
- Pre-populating user mappings from an external directory.
- UI changes to session list or admin dashboards beyond the resolved ID being available.
- CorpSecret rotation workflow.
- Multi-corp support per workspace.
- Creating brand-new WeCom user records from manual input; manual input only edits existing users.
- Bulk import or CSV paste of plaintext IDs.
- Per-row "resolve this user" action; only a global flush control is in scope.

---

## Key Decisions

- **Hybrid queue + immediate promotion over pure batch:** Adds a second code path to avoid blocking latency-sensitive consumers, accepting the extra complexity because the permission layer may need it later.
- **In-memory token cache over persistent token storage:** Avoids stale token risk; refetch on restart is cheap.
- **Encrypted ID remains the canonical session key:** Minimizes changes to existing session routing logic.
- **Store corpsecret alongside existing bot secret in workspace settings:** Reuses the existing sensitivity boundary; no separate credential vault in this phase.
- **Immediate lookup is a public resolver API:** Any consumer can request it; no gatekeeper logic in this phase.
- **Manual plaintext input is a stopgap, not authoritative:** Auto-resolution can overwrite admin-entered values, keeping the WeCom API as the eventual source of truth.
- **Encrypted ID is always visible in the settings user list:** Makes the canonical identifier discoverable for debugging and correlation.
- **Explicit Save/Cancel per row rather than auto-save:** Reduces accidental overwrites in a list that auto-refreshes on a timer.
- **Manual reload + global resolver coexist with auto-poll:** Gives admins control without removing the automatic 10-second refresh.

---

## Dependencies / Assumptions

- The WeChat Work `batch/openuserid_to_userid` API supports up to 1000 IDs per call and also works correctly when called with a single ID.
- The `gettoken` API returns an expiration time that can be used for cache invalidation.
- The workspace's `corpid` and `corpsecret` have sufficient permissions to call both APIs.
- The existing SQLite store can accommodate a new mapping table.
- The settings user list surfaces are implemented in `src/client/components/SettingsPanel.tsx`, server routes in `src/server/routes/workspaces.ts`, and storage in `src/server/storage/sqlite-store.ts`.

---

## Outstanding Questions

### Resolve Before Planning

- None

### Deferred to Planning

- [Affects R7][Technical] Exact flush interval and queue size threshold.
- [Affects R12][Technical] Exponential backoff parameters for batch-failed IDs.
- [Affects R1–R4][Technical] Whether to validate credentials eagerly (on save) or lazily (on first flush).
- [Affects R18][Technical] Exact error handling and retry strategy for token fetch failures.
- [Affects R9][Technical] Exact shape of the immediate resolution API (function signature, async/sync, timeout).
- [Affects R21–R23][Technical] Exact inline editing interaction (click-to-edit vs always-visible field) and duplicate-check endpoint shape.
- [Affects R25][Technical] Whether the global resolver button calls the existing immediate-resolution endpoint per ID or a new workspace-scoped flush endpoint.
