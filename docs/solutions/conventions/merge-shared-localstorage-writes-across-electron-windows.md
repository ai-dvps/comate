---
title: Merge shared localStorage writes across windows — never dump a boot-time snapshot
date: 2026-08-19
category: conventions
module: client-browser-pane
problem_type: convention
component: development_workflow
severity: medium
applies_when:
  - Persisting UI state to localStorage from multiple Electron renderer windows that share one origin
  - A zustand store seeds its initial state from localStorage once at module boot and never re-reads it
  - Writing a per-session or per-entity map key that more than one window can update
tags:
  - localstorage
  - electron
  - multi-window
  - zustand
  - state-persistence
  - merge-on-write
  - browser-pane
  - cross-window-state
---

# Merge shared localStorage writes across windows — never dump a boot-time snapshot

## Context

Comate's chat UI has a collapsible browser pane whose per-session open/collapsed flags persist in localStorage under the key `browser-pane-open-by-session` (`OPEN_BY_SESSION_STORAGE_KEY`, src/client/stores/browser-pane-store.ts:147). The pane can also be detached into an independent OS window. That detached window is a separate Electron `BrowserWindow` (and therefore a separate renderer process with its own JS context and its own instance of the zustand store) running `DetachedBrowserWindowApp` (src/client/components/browser/DetachedBrowserWindowApp.tsx:22-23), which drives the same `useBrowserPaneStore` via `setActiveSession` (DetachedBrowserWindowApp.tsx:49).

Critically, both windows load the same UI origin — `loadUi` serves the identical URL, distinguishing the detached window only by a `?window=detached-browser` query param (electron/main.ts:342-360) — and neither `createMainWindow` (electron/main.ts:460-484) nor `createDetachedBrowserWindow` (electron/main.ts:422-440) sets a `partition` in `webPreferences`. Both renderers therefore share one localStorage origin. (The `partition` references elsewhere in electron/main.ts:856-861 belong to the native WebContentsView browser stack, not to the windows.)

This two-renderer, single-origin arrangement dates from the Tauri → Electron migration, which replaced the iframe viewer with native `WebContentsView`s and carried the pop-out window concept through (session history).

While working on browser-pane auto-open behavior (commit 1c720278, local, unpushed as of this writing), a latent cross-window clobbering bug surfaced: the store read the persisted map exactly once at module boot into `persistedOpenBySessionAtBoot` (src/client/stores/browser-pane-store.ts:275), seeded the in-memory `openBySession` from that snapshot (browser-pane-store.ts:342), and `setPaneOpen` then wrote the whole in-memory map back on every change. Because each renderer's snapshot is frozen at its own boot time, a write from either window silently erased keys the other window had changed since its boot.

## Guidance

**Any localStorage-persisted state in this app is potentially cross-window shared. Writers of shared persisted maps must read-modify-write per key at write time; a boot-time snapshot may seed in-memory state but must never be re-dumped wholesale.**

Before (the bug — dump the window's in-memory map over the shared key):

```ts
// read once at module boot; goes stale the moment the other window writes
const persistedOpenBySessionAtBoot = readPersistedOpenBySession()

setPaneOpen: (sessionId, open) => {
  set((state) => ({ openBySession: { ...state.openBySession, [sessionId]: open } }))
  // Clobbers keys the other window changed since THIS window booted.
  writePersistedOpenBySession(get().openBySession)
}
```

After (the fix — merge into the latest persisted map, last writer wins per key; src/client/stores/browser-pane-store.ts:365):

```ts
setPaneOpen: (sessionId, open) => {
  if (selectSessionOpen(get(), sessionId) === open) return
  set((state) => ({
    openBySession: { ...state.openBySession, [sessionId]: open },
    ...(open ? { hasOpened: true } : {}),
  }))
  // Merge into the LATEST persisted map rather than dumping this window's
  // in-memory one: the detached browser window shares this localStorage
  // origin, and its boot-time-stale map would otherwise clobber keys the
  // main window changed since (and vice versa). Last writer wins per key.
  writePersistedOpenBySession({ ...readPersistedOpenBySession(), [sessionId]: open })
}
```

The general rule for any new persisted client state:

1. A boot-time read (`persistedOpenBySessionAtBoot`-style) is fine for seeding initial in-memory state.
2. Every write must be `write({ ...readPersisted(), [key]: value })` — re-read the persisted value at write time and merge the single key being changed.
3. Never persist by serializing the whole in-memory map, unless the key is provably single-window (which, in this app, it is not — see below).
4. The resulting semantics are last-writer-wins **per key**, not per map. If two windows race on the *same* key, the later write wins; keys neither window is currently touching survive.

## Why This Matters

The failure mode is silent cross-window state loss, and it is easy to miss because each window looks correct in isolation:

- The main window and the detached browser window each hold a zustand store whose `openBySession` was snapshotted at that renderer's boot and is never refreshed from localStorage afterward.
- The detached window is not passive: its `_applyBrowserState` auto-opens the pane on `handoff_pending` and on browser (re)birth (`becameLive` / `becameReady`), both of which call `setPaneOpen(sessionId, true)` (src/client/stores/browser-pane-store.ts:506-530). With the old dump-on-write, that single auto-open wrote the detached renderer's entire stale boot-time map back, wiping every open/close choice the user had made in the main window since the detached window launched — and the symmetric bug ran the other direction.
- Nothing throws, nothing logs; the user's per-session pane layout simply reverts to whatever the *other* window remembered. Whole-map last-writer-wins turns one key's write into a rollback of all other keys. Per-key merge confines the race to the key actually being written.

The same hazard applies to any future persisted state: a second renderer on the same origin makes "my in-memory copy" a stale cache of shared storage the moment the other renderer writes.

## When to Apply

Apply this convention whenever any of the following holds:

- You add or modify **any** localStorage-persisted client state in this Electron app — the main window and the detached browser window share one localStorage origin today (no custom session partition on either `BrowserWindow`; same UI URL modulo the `?window=` query), so *all* persisted state is already cross-window shared.
- A second renderer, window, or webview ever loads the same origin — even if the persisted feature seems unrelated to the second window's purpose, both renderers boot the same store modules and can write the same keys.
- The writer is event-driven rather than user-driven (WS handlers, auto-open, background sync): these fire without user intent and make stale-map clobbering happen "spontaneously," which is exactly how the detached store's handoff/birth auto-open triggered this bug.
- Code review: flag any `localStorage.setItem(key, JSON.stringify(entireInMemoryMap))` pattern, and any module-level `const ...AtBoot = readPersisted...()` whose snapshot is later written back.

A boot-time snapshot remains legitimate for *reading* (seeding initial state, deriving flags like `hasOpened` at browser-pane-store.ts:344) — the line is drawn at writing it back.

## Examples

**Fixed instance — the browser pane open map.** `src/client/stores/browser-pane-store.ts`:

- `readPersistedOpenBySession()` / `writePersistedOpenBySession()` (lines 160-175 and 177-183) wrap the `browser-pane-open-by-session` key.
- `persistedOpenBySessionAtBoot` (line 275) seeds `openBySession` (line 342) and `hasOpened` (line 344) — reads only.
- `setPaneOpen` (lines 355-366) now writes `writePersistedOpenBySession({ ...readPersistedOpenBySession(), [sessionId]: open })` (line 365), merging the one changed key into the latest persisted map. The before/after diff is in commit 1c720278 (local, unpushed as of this writing), which replaced `writePersistedOpenBySession(get().openBySession)`.

**Regression test.** `src/client/components/browser/__tests__/browser-pane-store.test.ts:123-138` — "merges into the latest persisted map so a stale writer cannot clobber other keys". The test simulates the two-window race: the store writes `sess-A: true`; the persisted map is then replaced out from under the store (as the other window would) with `{ 'sess-A': false, 'sess-B': true }`; a subsequent `setPaneOpen('sess-C', true)` must produce the merged map `{ 'sess-A': false, 'sess-B': true, 'sess-C': true }` — the other window's `sess-B` key survives, and its newer `sess-A` value is not rolled back by this window's stale in-memory copy.

## Related

- docs/solutions/integration-issues/sse-stream-resume-on-reconnect-2026-05-18.md — defers a client-side localStorage persistence idea (SSE lastEventId across refresh); if implemented, this merge-on-write convention applies to it because the detached browser window shares the same localStorage origin.
