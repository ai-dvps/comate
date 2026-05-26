---
title: WeCom User ID Resolution
type: feat
status: active
date: 2026-05-26
depened: 2026-05-26
origin: docs/brainstorms/2026-05-26-wecom-user-id-resolution-requirements.md
---

# WeCom User ID Resolution

## Summary

Add a hybrid resolver that converts encrypted WeCom user IDs (`openuserid`) to plaintext enterprise IDs. Unseen IDs queue for periodic batch conversion via the WeChat Work enterprise API; consumers can force an immediate single-ID lookup when needed. Two new workspace settings fields (`corpid`, `corpsecret`) enable the API, and resolved mappings persist in SQLite.

---

## Problem Frame

The existing WeCom bot integration stores encrypted user IDs as the canonical session key. This works for routing messages to sessions, but encrypted IDs cannot be used for downstream permission control, file access decisions, or admin visibility. The WeChat Work enterprise API provides a conversion endpoint, but calling it individually per user is inefficient at scale. A batched background resolver with an immediate escape hatch balances API efficiency with latency sensitivity.

---

## Requirements

Carried forward from the origin document. Each implementation unit cites the requirements it advances.

- R1. Workspace settings include a `wecomCorpId` field.
- R2. Workspace settings include a `wecomCorpSecret` field.
- R3. Both fields are optional and independent of existing bot credentials.
- R4. The `corpsecret` is treated with the same sensitivity as the existing bot secret.
- R5. Unseen encrypted user IDs are queued for batch resolution on message arrival.
- R6. The mapping table is checked on every incoming message; hits return the plaintext ID immediately.
- R7. A background process flushes the queue periodically and when a size threshold is reached.
- R8. On flush, the system obtains a valid access token and calls the batch `openuserid_to_userid` API.
- R9. The system exposes an immediate resolution API for urgent consumers.
- R10. The encrypted user ID remains the canonical session key.
- R11. Successful batch mappings are persisted.
- R12. Batch-failed IDs are re-queued with exponential backoff.
- R13. The immediate resolution API checks the mapping table first, then falls back to a single-ID API call.
- R14. Immediate lookup stores the result and removes the ID from the pending queue if present.
- R15. Immediate lookup failures are surfaced to the caller; the ID is not re-queued.
- R16. The access token is cached in memory and refreshed before expiry.
- R17. Expired or absent tokens trigger a `gettoken` fetch using `corpid` + `corpsecret`.
- R18. Token fetch failures are logged and surfaced as workspace-level errors.
- R19. The mapping is keyed by `(workspaceId, encryptedUserId)` and survives restarts.

---

## System-Wide Impact

- **End users:** No direct impact under normal operation. Encrypted IDs remain the session key; plaintext IDs are an internal resolved attribute. If the resolver fails during message handling, the bot service degrades gracefully to the encrypted ID rather than dropping the message.
- **Admins:** Two new fields in workspace settings. No additional UI beyond the settings panel.
- **Developers:** A new singleton service is available for resolving user IDs. Skills that need plaintext IDs can call the immediate resolution API. The API is async and may throw; callers should handle errors and fall back to encrypted IDs when resolution is unavailable.
- **Operations:** One new periodic timer (queue flush). Service initialization and shutdown sequences are extended. The resolver must be disposed during graceful shutdown to clear timers and flush pending IDs. The in-memory queue is volatile — queue loss on restart or hot reload is an accepted trade-off.
- **Failure propagation:**
  - Resolver initialization failure does not block bot service startup. Bot connections proceed independently; resolution is attempted lazily on first message.
  - Runtime resolution failure in `handleTextMessage` degrades to encrypted ID usage. The message is not dropped.
  - Immediate lookup failure in a skill propagates as an error to the skill, which must decide whether to abort or continue with the encrypted ID.
- **Resource risks:**
  - The flush timer keeps the event loop alive. Disposal during shutdown prevents process hang.
  - The queue is bounded (max depth per workspace) to prevent unbounded memory growth.
  - Token refresh uses request deduplication: concurrent callers awaiting the same in-flight refresh prevent redundant `gettoken` calls.

---

## Key Technical Decisions

- **Separate resolver service over embedding in `WeComBotService`:** Keeps queue management, token caching, and REST API logic decoupled from websocket message handling. The bot service calls the resolver as a dependency.
- **Node.js built-in `fetch` over adding an HTTP client:** The project has no existing REST HTTP client dependency. Node 20+ `fetch` is sufficient for two simple JSON endpoints.
- **In-memory queue + `setInterval` over a background job framework:** No job framework exists in the project. The `setInterval` pattern is already used by `SessionRuntime` (heartbeat) and `WeComBotService` (animation frames).
- **Lazy credential validation:** Credentials are validated on first API call rather than on save. This avoids blocking the settings save path and aligns with the existing bot connection pattern.
- **Queue deduplication before flush:** The queue is modeled as a `Set` (or deduplicated before each flush) so the same unseen ID cannot be sent twice in one batch.
- **Graceful degradation to encrypted ID:** Resolver failures in the message handling path do not block message processing. The bot service continues with the encrypted ID, treating the plaintext ID as an optional enrichment.
- **Bounded resolver call timeout:** Calls to the resolver from `handleTextMessage` carry a bounded timeout (e.g., 3 seconds) with fallback to encrypted ID on timeout. This prevents slow WeChat Work API from degrading the user experience.
- **Request-deduplicated token refresh:** When the cached token expires, concurrent callers share a single in-flight `gettoken` promise rather than each triggering a separate refresh. This defends against the WeChat Work `gettoken` rate limit (2000 calls/day per corp).
- **Logging redaction:** `corpid`, `corpsecret`, `access_token`, `openid`, and `userid` values are never written to logs. Only HTTP status, error codes, queue depth, and timing are logged.

---

## High-Level Technical Design

```
┌─────────────────┐     ┌─────────────────────┐     ┌──────────────────┐
│ WeComBotService │────▶│ WeComUserIdResolver │────▶│ WeChat Work API  │
│ (websocket)     │     │                     │     │ (gettoken +      │
└─────────────────┘     │  - in-memory queue  │     │  batch/openuser  │
                        │  - token cache      │     │  id_to_userid)   │
                        │  - flush timer      │     └──────────────────┘
                        │  - immediate API    │              │
                        └─────────────────────┘              │
                                 │                           │
                                 ▼                           ▼
                        ┌─────────────────────┐     ┌──────────────────┐
                        │   SqliteStore       │     │  Error logging   │
                        │ (mapping table)     │     │  & workspace     │
                        └─────────────────────┘     │  status surfacing│
                                                    └──────────────────┘
```

*This diagram illustrates the intended approach and is directional guidance for review, not implementation specification.*

**Data flow:**
1. `WeComBotService.handleTextMessage` extracts the encrypted user ID and calls `resolver.queue(userId)`.
2. The resolver checks the SQLite mapping table. On miss, it adds the ID to an in-memory deduplicated queue.
3. A `setInterval` timer fires every 30 seconds (or when the queue reaches 100 IDs). On fire, the resolver obtains a cached or fresh access token and calls the batch API.
4. Successful mappings are written to SQLite; failed IDs are re-queued with exponential backoff.
5. A consumer (e.g., a skill) can call `resolver.resolveImmediate(userId)`. The resolver checks SQLite, then falls back to a single-ID API call, stores the result, and removes the ID from the pending queue.

---

## Implementation Units

### U1. Add workspace settings fields for enterprise API credentials

**Goal:** Allow admins to configure `corpid` and `corpsecret` in workspace settings.

**Requirements:** R1, R2, R3, R4

**Dependencies:** None

**Files:**
- `src/server/models/workspace.ts`
- `src/client/components/SettingsPanel.tsx`

**Approach:**
Add `wecomCorpId?: string` and `wecomCorpSecret?: string` to the `WorkspaceSettings` interface. In the settings panel, add two input fields in the existing WeCom Bot tab, following the existing `botId`/`botSecret` pattern. Use the same password visibility toggle for `corpsecret`. Both fields are optional and independent of the bot credentials.

**Patterns to follow:**
- Existing `wecomBotId` / `wecomBotSecret` fields in `WorkspaceSettings`.
- Existing `WeComBotTab` rendering and `handleSave` payload construction in `SettingsPanel.tsx`.

**Test scenarios:**
- Given a workspace with no corp credentials, when the admin opens settings, then the corp ID and corp secret fields are empty.
- Given a workspace with corp credentials saved, when the admin opens settings, then the fields are populated and can be edited or cleared.
- When the admin saves settings with only corp ID (no secret), the save succeeds and both fields are persisted independently of bot credentials.

**Verification:**
- Open workspace settings. Observe new fields. Enter values, save, reload — values persist.

---

### U2. Add SQLite mapping table and CRUD methods

**Goal:** Persist encrypted-to-plaintext user ID mappings.

**Requirements:** R6, R11, R19

**Dependencies:** None

**Files:**
- `src/server/storage/sqlite-store.ts`

**Approach:**
Add a `wecom_user_id_mappings` table in the `SqliteStore` constructor using `CREATE TABLE IF NOT EXISTS`, following the exact pattern of `wecom_user_sessions`. Columns: `workspaceId`, `encryptedUserId`, `plaintextUserId`, `createdAt`, `updatedAt`. Primary key on `(workspaceId, encryptedUserId)`.

Add CRUD methods:
- `getWecomUserMapping(workspaceId, encryptedUserId): string | null`
- `setWecomUserMapping(workspaceId, encryptedUserId, plaintextUserId): void`
- `listWecomUserMappings(workspaceId): Array<{ encryptedUserId, plaintextUserId }>`

Use `ON CONFLICT ... DO UPDATE` for upserts, mirroring `setWecomSession`.

**Patterns to follow:**
- Existing `wecom_user_sessions` table and methods in `SqliteStore`.

**Test scenarios:**
- Given no mapping for `(ws1, E123)`, when `getWecomUserMapping` is called, it returns `null`.
- Given a call to `setWecomUserMapping(ws1, E123, U456)`, when `getWecomUserMapping(ws1, E123)` is called, it returns `U456`.
- Given an existing mapping `E123 → U456`, when `setWecomUserMapping(ws1, E123, U789)` is called, the mapping is updated to `U789`.

**Verification:**
- Verify mappings survive server restart.

---

### U3. Create WeComUserIdResolver service

**Goal:** Implement the core resolver logic: token cache, queue, batch flush, and immediate lookup.

**Requirements:** R5, R7, R8, R9, R12, R13, R14, R15, R16, R17, R18

**Dependencies:** U2

**Files:**
- `src/server/services/wecom-user-resolver.ts` (new)

**Approach:**
Create a `WeComUserIdResolver` singleton class.

**Token cache:**
- In-memory `Map<workspaceId, { token: string; expiresAt: number }>`.
- `getToken(workspaceId)` checks cache. If expired or absent, it checks for an in-flight refresh promise and returns it if present (request deduplication). Otherwise, it initiates a `fetch` to `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=ID&corpsecret=SECRET`, parses JSON, stores the token with an expiry buffer (5 minutes before actual expiry), and returns it.
- Token fetch failures are logged with `console.error` (with `corpsecret` and `access_token` redacted) and thrown as errors so callers can defer.
- The `gettoken` endpoint has a rate limit of 2000 calls/day per corp. Request deduplication is the primary defense against exhausting this quota during concurrent access or rapid restarts.

**Queue and batch flush:**
- In-memory `Map<workspaceId, Set<string>>` for queued encrypted IDs (deduplicated naturally).
- `queue(workspaceId, encryptedUserId)` adds to the set if no mapping exists in SQLite and the queue is below the max depth (e.g., 1000 IDs per workspace). If the queue is full, the ID is rejected and logged.
- `startFlushTimer(intervalMs)` sets up a `setInterval` (default 30s). On fire, for each workspace with a non-empty queue, call `flushWorkspace(workspaceId)`.
- `flushWorkspace` obtains a token, collects up to 100 queued IDs, calls `https://qyapi.weixin.qq.com/cgi-bin/batch/openuserid_to_userid?access_token=TOKEN` with `{ open_userid_list: [...] }`, parses the response, stores successful mappings via `SqliteStore`, and removes resolved IDs from the queue.
- Failed IDs in a batch are tracked with retry metadata (attempt count, next retry timestamp). IDs exceeding a max retry count (e.g., 5) are dropped from the queue and logged.

**Immediate lookup:**
- `resolveImmediate(workspaceId, encryptedUserId)` checks SQLite first. On miss, obtains a token, calls the batch API with a single ID, stores the mapping, removes the ID from the pending queue if present, and returns the plaintext ID.
- On failure, throws a clear error. The ID is NOT re-queued.
- This API is intended for server-side consumers (skills, permission checks). It is not exposed without authentication or rate limiting. If an HTTP route is added later, it must enforce caller authentication and per-caller rate limits.

**Lifecycle:**
- `initialize()` starts the flush timer.
- `shutdown()` clears the timer, cancels in-flight requests, and flushes any remaining queued IDs with a bounded timeout (e.g., 5 seconds). The resolver is disposed during the server's graceful shutdown sequence.

**Patterns to follow:**
- Singleton class exported as `export const wecomUserResolver = new WeComUserIdResolver()`.
- `console.error` for errors, matching `WeComBotService`.
- Exponential backoff parameters: 2s base, 30s max, matching existing SSE/bot retry patterns.

**Test scenarios:**
- Given a workspace with valid credentials, when `queue` is called with a new ID, the ID is added to the queue and no API call is made immediately.
- Given a workspace whose queue already has 1000 IDs, when `queue` is called with another ID, the ID is rejected and logged.
- Given a queued ID and a valid token, when the flush timer fires, the batch API is called and the mapping is stored.
- Given a cached token expiring in 3 minutes, when a flush triggers, the cached token is reused.
- Given an expired token and two concurrent flush attempts, when both trigger, only one `gettoken` call is made (request deduplication).
- Given a token fetch failure, when a flush triggers, the error is logged (with credentials redacted) and no batch API call is made.
- Given a queued ID, when `resolveImmediate` is called, the ID is resolved via single lookup, stored, and removed from the queue.
- Given an immediate lookup failure, when `resolveImmediate` is called, an error is thrown and the ID is not re-queued.
- Given an active queue with pending IDs, when `shutdown()` is called, the timer is cleared and remaining IDs are flushed within the shutdown timeout.

**Verification:**
- Start the server with corp credentials configured. Send a message from a new WeCom user. Observe the ID is queued. After ~30s, observe the mapping appears in SQLite.
- Call `resolveImmediate` for an unseen ID. Observe the mapping is resolved within the API round-trip time.
- Trigger a hot reload. Observe that the queue is lost but mappings in SQLite survive. New messages re-queue correctly.

---

### U4. Integrate resolver into WeComBotService message handling

**Goal:** Queue unseen user IDs on every incoming WeCom message.

**Requirements:** R5, R6, R10

**Dependencies:** U1, U3

**Files:**
- `src/server/services/wecom-bot-service.ts`

**Approach:**
In `handleTextMessage`, after extracting `wecomUserId` from the frame, call `wecomUserResolver.resolveOnMessage(workspaceId, wecomUserId)` with a bounded timeout (e.g., 3 seconds). This helper checks the mapping table and queues the ID only if no mapping exists. If the resolver call times out or throws, the error is caught and the bot service continues processing with the encrypted ID. The message is never dropped due to resolver failure.

If the workspace does not have `corpid` or `corpsecret` configured, the queue call is a no-op (the resolver silently skips workspaces without credentials).

**Patterns to follow:**
- Existing `handleTextMessage` flow in `WeComBotService`.
- Fire-and-forget error handling with `.catch()`, matching the existing bot message handler pattern.
- No-op behavior when feature is not configured, matching the bot connection pattern.

**Test scenarios:**
- Given a workspace without corp credentials, when a message arrives, the message is handled normally and no resolution is attempted.
- Given a workspace with corp credentials and a new user, when a message arrives, the message is handled immediately and the user ID is queued for resolution.
- Given a workspace with corp credentials and a known user, when a message arrives, the message is handled immediately and no queue/API activity occurs.

**Verification:**
- Send messages from new and known users. Check server logs for queue and resolution activity.

---

### U5. Expose immediate resolution API

**Goal:** Allow consumers (skills, permission checks) to force an immediate single-ID lookup.

**Requirements:** R9, R13, R14, R15

**Dependencies:** U3

**Files:**
- `src/server/services/wecom-user-resolver.ts`
- `src/server/routes/wecom-resolver.ts` (new, optional)

**Approach:**
The `WeComUserIdResolver.resolveImmediate` method is the primary API. It is available to any server-side consumer by importing the resolver singleton.

If remote consumers (e.g., skills running in a separate process) need access, add a minimal Express route at `POST /api/wecom/resolve-user` that accepts `{ workspaceId, encryptedUserId }` and returns `{ plaintextUserId }` or an error. Follow the existing route pattern in `src/server/routes/wecom-bridge.ts`.

**Patterns to follow:**
- Existing Express route patterns in `src/server/routes/`.
- JSON error responses matching `wecom-bridge.ts`.

**Test scenarios:**
- Given a workspace with valid credentials and an unseen ID, when `resolveImmediate` is called, the plaintext ID is returned.
- Given a workspace with invalid credentials, when `resolveImmediate` is called, an error is thrown with a clear message.
- Given a workspace without corp credentials, when `resolveImmediate` is called, an error is thrown indicating missing configuration.
- (If HTTP route is added) Given valid request body, when `POST /api/wecom/resolve-user` is called, the response contains the plaintext ID.

**Verification:**
- Call `resolveImmediate` programmatically or via HTTP route. Verify synchronous resolution for unseen IDs.

---

## Scope Boundaries

- Permission control logic — deferred to a later phase.
- File read/write approval routing — deferred.
- Pre-populating user mappings from an external directory.
- UI changes to session list or admin dashboards beyond the resolved ID being available.
- CorpSecret rotation workflow.
- Multi-corp support per workspace.
- Adding automated tests — the project has no test infrastructure; verification is manual.

---

## Deferred to Follow-Up Work

- **HTTP route for remote consumers:** The immediate resolution API defaults to an internal service method. An Express route can be added if skills running outside the server process need access.
- **Session name update after resolution:** Sessions are currently named with the encrypted user ID. A follow-up could rename sessions to the plaintext ID once resolved, or store the plaintext ID as session metadata.
- **Admin visibility into resolution status:** A settings panel indicator showing "X users resolved / Y pending" could be added later.

---

## Deferred Implementation Notes

- Exact `fetch` timeout value for WeChat Work API calls — settle during implementation based on observed latency.
- Exact diagnostic log format — follow existing `console.error` / `console.warn` patterns; no structured logging framework exists.
- Whether to add a `diagLog` integration for the resolver — only if debugging proves difficult.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| WeChat Work API rate limits | Medium | High | Batch calls, deduplicated queue, 30s flush interval. Request-deduplicated token refresh. Monitor queue depth. |
| Access token expiry mid-flush | Low | Medium | Check token before each flush; refresh if within 5-minute buffer. |
| Queue loss on server restart | High | Low | Accepted trade-off. Only persisted mappings survive. Unseen users re-queue on next message. |
| Invalid corp credentials blocking resolution | Medium | Medium | Lazy validation surfaces error on first flush, not on save. Clear error logging with credentials redacted. |
| Partial batch failure | Medium | Low | Retry individual failed IDs with exponential backoff. Drop after max attempts. |
| Credential leakage in logs | Medium | High | Redact `corpid`, `corpsecret`, `access_token`, `openid`, and `userid` from all log output. Log only status codes, error codes, queue depth, and timing. |
| Queue flooding / memory exhaustion | Low | High | Enforce max queue depth per workspace (e.g., 1000). Reject new items with logging when limit is reached. |
| Concurrent token refresh hitting rate limit | Medium | Medium | Request deduplication for `gettoken`: concurrent callers await a single in-flight promise. |
| Resolver timeout blocking message handling | Medium | Medium | Bounded timeout (3s) on resolver calls in `handleTextMessage` with fallback to encrypted ID. |
| Unauthenticated access to immediate resolution API | Low | High | Immediate resolution is an internal service method only. Any future HTTP route must enforce authentication and per-caller rate limits. |

---

## Output Structure

```
src/server/
  services/
    wecom-user-resolver.ts      (new)
  routes/
    wecom-resolver.ts           (new, optional)
  models/
    workspace.ts                (modify)
  storage/
    sqlite-store.ts             (modify)
src/client/
  components/
    SettingsPanel.tsx           (modify)
```
