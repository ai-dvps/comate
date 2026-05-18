---
title: Fix SSE event replay broken by lastEventId deletion on session switch
type: fix
status: completed
date: 2026-05-18
---

# Fix SSE event replay broken by lastEventId deletion on session switch

## Summary

A regression from the SSE connection pool fix: `setActiveSession` deletes `lastEventId` for the previous session when switching away. When the user switches back, the new SSE subscription has no `Last-Event-ID` header, so the server does not replay events that arrived in the interim. Streaming appears frozen until the next approval or stream end.

## Problem

`src/client/stores/chat-store.ts:976` — `lastEventId.delete(prevSessionId)` inside `setActiveSession` discards the resume cursor.

`subscribeToSession` uses `lastEventId.get(sessionId)` to set the `Last-Event-ID` header. When undefined, the server's `subscribe(res, lastEventId)` receives no replay anchor and only emits new events.

## Fix

Remove `lastEventId.delete(prevSessionId)` from `setActiveSession`. Preserve the event ID so re-subscription replays missed events from the ring buffer.

## Scope

- One-line change in `src/client/stores/chat-store.ts`.
- No server changes.
- No UI changes.

## Verification

1. Send a prompt to session A.
2. Switch to session B while A is still streaming.
3. Switch back to session A — missed events should replay immediately and streaming should continue.
