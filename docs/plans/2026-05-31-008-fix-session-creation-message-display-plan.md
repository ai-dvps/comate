---
title: Fix session creation blank message area
type: fix
status: completed
date: 2026-05-31
---

# Fix session creation blank message area

## Summary

Align the client store's `createSession` and `addSession` helpers with `setActiveSession` by updating the workspace `domCache` when a newly created session is activated. This ensures the chat panel renders the message list (including the empty-state guide) immediately after creation, without requiring a manual click in the session list.

## Problem Frame

When a user creates a new session via the **New Session** button in `SessionList`, the store correctly sets the new session as active (`activeSessionIds`), but it omits the corresponding `domCache` update. `ChatPanel` renders `MessageList` only for sessions present in `domCache`; since the new session is absent, the message area remains completely blank until the user clicks the session in the sidebar, which triggers `setActiveSession` and populates `domCache`.

## Requirements

- R1. Creating a new session via the client UI must immediately display the message list area (empty-state guide or existing messages).
- R2. Adding a session externally (e.g., from a todo) must also ensure the session is renderable without an extra manual activation step.

## Scope Boundaries

- Does not change `ChatPanel`, `MessageList`, or any rendering logic.
- Does not modify server-side session creation APIs.
- Does not add test infrastructure for the store; verification is manual.
- Subscription lifecycle (SSE connect/disconnect) is out of scope — `setActiveSession` already handles that when explicitly switching sessions.

## Context & Research

### Relevant Code and Patterns

- `src/client/stores/chat-store.ts` — `createSession` (line ~1794) and `addSession` (line ~1818) both update `activeSessionIds` but leave `domCache` untouched.
- `setActiveSession` (line ~1898) performs the canonical DOM-cache update: evicts the oldest entry if over `DOM_CACHE_LIMIT`, moves the session to the most-recent slot, and clears its `unreadCompletions` entry.
- `ChatPanel.tsx` (lines 281–295) maps over `domCache` to decide which `MessageList` instances to render.

## Key Technical Decisions

- **Inline the cache update rather than refactor:** The `domCache` mutation is small (4 lines) and already duplicated between `setActiveSession` and `touchDomCache`. Inlining it in `createSession` and `addSession` keeps the fix minimal and avoids introducing new abstractions for a single invariant.
- **Also clear `unreadCompletions` for the new session:** This matches `setActiveSession` behavior and prevents a newly created session from incorrectly carrying an unread badge.

## Implementation Units

### U1. Populate domCache on session creation

**Goal:** Ensure `createSession` and `addSession` update `domCache` and `unreadCompletions` so the chat panel renders the new session immediately.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Modify: `src/client/stores/chat-store.ts`

**Approach:**
- In `createSession`, after the session is returned from the server, extend the state update to also:
  - Read the current `domCache` for the workspace.
  - Evict the oldest entry if the cache exceeds `DOM_CACHE_LIMIT`.
  - Append the new session ID to the cache.
  - Remove any `unreadCompletions` entry for the new session ID.
- Apply the identical cache/unread logic to `addSession` for consistency.

**Patterns to follow:**
- Mirror the `domCache` update sequence in `setActiveSession` (lines 1912–1921).

**Test scenarios:**
- **Happy path:** Click "New Session" → message area shows the empty-state guide immediately without clicking the session in the list.
- **Happy path (todo-derived):** Create a session from a todo item → the new session is active and its message area is visible immediately.
- **Edge case:** Create multiple sessions rapidly in the same workspace → only the most recent 3 sessions remain in `domCache` (eviction behavior unchanged).

**Verification:**
- Creating a new session renders the empty-state guide instantly.
- Switching between sessions (including the newly created one) continues to work normally.
- No console errors or state desync after session creation.
