---
title: WeCom Resolver Diagnostic Logging & Status
status: active
date: 2026-05-27
type: feat
---

# WeCom Resolver Diagnostic Logging & Status

## Summary

Add comprehensive diagnostic logging to `WeComUserIdResolver` and expose a lightweight status endpoint so operators can observe why user IDs remain in "pending resolution" state.

## Problem Frame

The workspace settings UI shows WeCom users with a "pending resolution" badge, but there is no visibility into whether the resolver is actually running, whether the queue is being flushed, or whether API calls are failing. This makes it impossible to debug credential issues, rate limits, or queue stagnation without attaching a debugger.

## Requirements

- R1. Every access token fetch (cache hit, cache miss, fetch success, fetch failure) is logged with workspace identification and redacted credentials.
- R2. Every batch API call logs the number of IDs sent, success count, failure count, and elapsed time.
- R3. Queue operations log the workspace, encrypted user ID, and resulting queue depth.
- R4. Flush timer activity logs start time, end time, workspaces processed, and any errors.
- R5. Immediate resolution attempts log start, outcome, and elapsed time.
- R6. A `GET` endpoint exposes the resolver's live state: queue depth per workspace, last flush timestamp, in-flight token refresh count, and total mappings count.
- R7. All logging uses the existing `console.error` / `console.warn` / `console.log` patterns; no new logging framework is introduced.

## Scope Boundaries

- No changes to resolution logic, retry policy, or token cache behaviour.
- No changes to the UI in this phase; the status endpoint is for API consumers and server log reading.
- No persistent log storage or log rotation; logs go to stdout/stderr only.

## Key Technical Decisions

- **Keep using `console.*` over a structured logger:** The project has no logging abstraction and `WeComBotService` already uses `console.error` / `console.warn`. Adding a logger dependency for one service is premature.
- **In-memory status state over persistent metrics:** The status endpoint reads from the resolver's existing in-memory Maps (`queue`, `tokenCache`, `tokenRefreshInFlight`). This is zero-additional-state and always consistent with the resolver's actual view.
- **Log redaction continues:** `access_token`, `corpid`, `corpsecret`, `openid`, and `userid` values are never emitted even in diagnostic logs.

## Implementation Units

### U1. Add diagnostic logging to WeComUserIdResolver

**Goal:** Instrument all resolver operations with informative, redacted logs.

**Files:**
- `src/server/services/wecom-user-resolver.ts`

**Approach:**
Add `console.log` / `console.warn` / `console.error` calls at these points:

1. `initialize()` — log `"[WeComUserIdResolver] Initialized, flush interval=${FLUSH_INTERVAL_MS}ms"`.
2. `shutdown()` — log `"[WeComUserIdResolver] Shutting down..."` and `"Shutdown flush complete | timed out"`.
3. `resolveOnMessage()` — log `"[WeComUserIdResolver] Message from workspace=${workspaceId} user=${encryptedUserId} cached=${!!existing}"`.
4. `trackWorkspaceUser()` — log `"[WeComUserIdResolver] Tracked workspace=${workspaceId} user=${encryptedUserId}"`.
5. `queueId()` — log `"[WeComUserIdResolver] Queued workspace=${workspaceId} user=${encryptedUserId} depth=${wsQueue.size}"`. If depth limit reached, log warning with depth.
6. `flushAll()` — log `"[WeComUserIdResolver] Flush started, workspaces=${this.queue.size}"` and `"Flush finished"`.
7. `flushWorkspace()` — log start with workspace ID and ready ID count; log end with success/failure counts and elapsed ms; log credential-missing case.
8. `getToken()` — log cache hit (`"Token cache hit workspace=${workspaceId}"`) or miss (`"Token cache miss workspace=${workspaceId}"`).
9. `fetchToken()` — log `"Fetching token workspace=${workspaceId}"` on start and `"Token fetched workspace=${workspaceId} expiresIn=${expiresIn}s"` on success. On failure, log error with redacted message.
10. `resolveImmediate()` — log start, cache hit outcome, API call outcome, and elapsed ms.
11. `callBatchApi()` — log `"Batch API call ids=${encryptedUserIds.length}"` and result summary.

All user ID values in logs must be truncated to first 8 chars + "..." to avoid leaking full encrypted IDs in logs while still making them distinguishable.

**Test scenarios:**
- Given a workspace with valid credentials, when a message arrives from a new user, then the log contains the queue action with depth=1.
- Given a workspace with a cached token, when `flushWorkspace` triggers, then the log contains "Token cache hit" and no "Fetching token" line.
- Given a workspace with an expired token, when `flushWorkspace` triggers, then the log contains "Token cache miss" followed by "Fetching token" and "Token fetched".
- Given a batch call with 3 IDs where 2 succeed and 1 fails, then the log contains the counts and the failed ID (truncated).

**Verification:**
- Start the server, send a WeCom message, observe resolver logs in stdout.

### U2. Expose resolver status API endpoint

**Goal:** Allow external consumers (CLI, future UI panel, health checks) to read the resolver's live state.

**Files:**
- `src/server/services/wecom-user-resolver.ts`
- `src/server/routes/workspaces.ts`

**Approach:**
Add a `getStatus()` method to `WeComUserIdResolver` that returns:

```typescript
{
  initialized: boolean;
  queueSize: number;
  workspaceQueues: Array<{
    workspaceId: string;
    depth: number;
    oldestQueuedAt?: number; // not tracked today, omit
  }>;
  tokenCacheSize: number;
  inFlightRefreshes: number;
  lastFlushAt?: number;
}
```

Track `lastFlushAt` as a private field updated at the end of `flushAll()`.

Add route `GET /api/workspaces/:id/wecom/resolver-status` in `workspaces.ts` that returns:

```typescript
{
  initialized: boolean;
  queueDepth: number;
  inFlightTokenRefresh: boolean;
  lastFlushAt?: string; // ISO timestamp
}
```

This is scoped to a single workspace so the settings page can poll it.

**Test scenarios:**
- Given an initialized resolver with 2 queued IDs for workspace W1, when `GET /api/workspaces/W1/wecom/resolver-status` is called, then `queueDepth=2` and `initialized=true`.
- Given a resolver with no queued IDs, when the endpoint is called, then `queueDepth=0`.

**Verification:**
- Call the endpoint via curl and verify the counts match the observed logs.

## Deferred to Follow-Up Work

- Surface resolver status in the settings UI (e.g., "Resolver idle | X pending | last flush Y seconds ago"). Needs design decision on where to place it.
- Add `diagLog` integration for resolver events to feed into the existing SSE diagnostic stream.
