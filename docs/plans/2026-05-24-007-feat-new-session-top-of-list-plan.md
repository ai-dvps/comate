---
title: feat: Display newly created sessions at the top of the session list
type: feat
status: completed
date: 2026-05-24
---

# feat: Display newly created sessions at the top of the session list

## Summary

Change the client-side session store so that when a user creates a new session, it is prepended to the workspace's session array instead of appended. This causes the new session to appear at the top of the `SessionList` immediately after creation, matching common UX expectations.

## Requirements

- R1. When a new session is created in the UI, it must appear at the top of the session list for that workspace.
- R2. Existing session order from `fetchSessions` must remain unchanged (only the optimistic local insertion changes).

## Scope Boundaries

- Server-side session listing order in `chatService.listSessions` is out of scope.
- Sorting by timestamp or other criteria is out of scope.

## Context & Research

### Relevant Code and Patterns

- `src/client/stores/chat-store.ts` — `createSession` appends the new session: `[...(state.sessions[workspaceId] || []), session]`
- `src/client/components/SessionList.tsx` — renders `sessions.map(...)` in array order

## Key Technical Decisions

- Prepend in `createSession` only: The change is limited to the optimistic local insertion. `fetchSessions` still overwrites with server order, so no server-side changes are needed.

## Implementation Units

### U1. Prepend new session in chat store

**Goal:** Make newly created sessions appear at the top of the list.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Modify: `src/client/stores/chat-store.ts`

**Approach:**
- In the `createSession` method, change the session array update from append to prepend.

**Patterns to follow:**
- Keep the same immutable spread pattern already used in the store.

**Test scenarios:**
- Happy path: Create a session when other sessions exist — new session appears first in the list.
- Edge case: Create a session when no sessions exist — session appears as the only item.

**Verification:**
- Creating a new session in the UI places it at the top of the sidebar session list.
- Refreshing the page preserves the server-returned order.
