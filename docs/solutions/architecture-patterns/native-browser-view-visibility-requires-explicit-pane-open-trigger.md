---
title: Native WebContentsView visibility requires an explicit browser_state to pane-open trigger
date: 2026-08-19
category: architecture-patterns
module: client-browser-pane
problem_type: architecture_pattern
component: development_workflow
severity: medium
applies_when:
  - An Electron shell hosts a native WebContentsView that only becomes visible after the renderer pane mounts and reports its layout rect
  - A server-pushed state event (browser_state) is the only signal that agent-driven background work has started
  - Empty-state UI copy promises the panel opens automatically when the agent works on a task
  - Channel hydration can replay an already-live state, so auto-open logic must distinguish birth transitions from replays and respect persisted per-session UI state
tags:
  - electron
  - webcontentsview
  - browser-pane
  - state-machine
  - hydration
  - ipc
  - auto-open
  - visibility
---

# Native WebContentsView visibility requires an explicit browser_state to pane-open trigger

## Context

Comate's embedded browser spans three processes with a strict division of labor:

- **Server (Express sidecar)** owns the browser *lifecycle*. `browser-service.ts` keeps a per-session registry entry whose control state (`agent_in_control | handoff_pending | user_in_control | session_lost`) is minted as `agent_in_control` with `handle: null` the moment a spawn begins (`src/server/services/browser-service.ts:655-659`), and only later adopts the live handle — `adoptHandle` sets the state and emits the `browser_state` event carrying `port: handle.port` once the session is truly ready (`src/server/services/browser-service.ts:1278-1315`). The WebSocket channel's hydration pushes the current state to fresh subscribers, taking `state` from `getControlState` (which reads the registry entry regardless of handle) but `port` from `getSession(...)?.port` (which returns `undefined` until a handle exists) — so a mid-spawn session hydrates as `agent_in_control` **without** a port (`src/server/websocket/browser-state-channel.ts:124-135`).
- **Shell (Electron main)** owns the native `WebContentsView`. `createView` creates the view *unattached and hidden* — `attachedHost: null`, `visible: false`, `view.setVisible(false)` (`electron/browser-view-manager.ts:437-474`; module doc lines 7-9: "views are created unattached (U7) and attach to the main window's contentView once the panel reports its rect"). `applyLayout` attaches and shows the view only when a rect has been reported for the session's host **and** `rect.width > 0 && rect.height > 0` (`electron/browser-view-manager.ts:377-418`). Popups and the agent-mode input shield inherit the same bounds/visibility decisions (`electron/browser-view-manager.ts:369`, `399-407`).
- **Renderer (React)** owns the *pane*. The visible surface mounts only through a per-session open flag: `BrowserPane` mounts the body only after `hasOpened` has been set by a first `setPaneOpen(sessionId, true)` (`src/client/components/browser/BrowserPane.tsx:83-93`, `src/client/stores/browser-pane-store.ts:355-366`), and an `App.tsx` effect watches `selectSessionOpen(state, activeWorkspaceSessionId)` for a false→true flip to open the browser context tab and expand the right panel (`src/client/App.tsx:422-451`). Once mounted and visible, the viewer reports its rect via `useBrowserViewRectReport` (`src/client/components/browser/BrowserViewer.tsx:65`) → `reportBrowserViewRect` (`src/client/lib/browser-view-bridge.ts:58-68, 113-154`) → IPC `comate:browser-view-report-rect` (`electron/preload.ts:150-152`) → the shell's `setViewBoundsFromHost` (`electron/browser-view-manager.ts:586-594`).

The original design deliberately treated the collapsed pane as a resting state: collapsing keeps the browser alive so re-expanding shows the same live page, and `handoff_pending` was the state machine's only "a human must look at this now" state — so handoff was the sole auto-expand trigger (session history: the pane's keep-alive design and the human-gate philosophy in the original `feat/embedded-controlled-browser` sessions, ~1 month before the fix; no session records birth auto-open being considered and rejected — it was oversight by construction, not a deliberate exclusion).

The bug that surfaced the missing contract: an MCP-driven browser birth (`agent_in_control`) never surfaced the native view. The pane store's `_applyBrowserState` auto-expanded only on `handoff_pending`; the birth transition had no trigger, so the React pane never mounted, no rect was ever reported, and the shell's view — correctly, per its own rules — stayed unattached and invisible. The agent's browser worked fine over CDP; the user simply never saw it. Meanwhile the shipped empty-state copy already promised "One opens automatically when Claude works on a web task." (`src/client/i18n/en/browser.json:9`) — the product copy had outrun the wiring. Fixed in commit 1c720278 (local, unpushed as of this writing).

## Guidance

**Visibility flows in exactly one direction: pane-mount → rect-report → shell attach/show.** The shell will never show a view on its own — that is a deliberate property of the design (an unattached view has no compositor surface; rect-less views stay hidden so popups and shields inherit the same discipline). Therefore **every "browser should appear when X" expectation must be wired explicitly as a `browser_state` → pane-open trigger in the renderer.** Server-side lifecycle events are necessary but never sufficient for UI visibility.

When adding such a trigger, decide the transition taxonomy deliberately. The fix in `_applyBrowserState` (`src/client/stores/browser-pane-store.ts:487-531`) distinguishes five cases, each handled its own way:

1. **Birth (hydrated non-live → live)** — auto-open. A `none`/`session_lost` → `agent_in_control` transition observed *after* the channel's hydration is a genuine (re)birth: the first MCP tool call's spawn, or a crash rebuild on the next tool call. This is the empty-state copy's promise; open the pane.
2. **Mid-spawn ready (first known port)** — auto-open. Hydration can catch a session already in `agent_in_control` but *without* a port (the registry entry exists, the handle does not yet). That hydration must not open the pane by itself — but the subsequent ready emit arrives as a live→live transition, indistinguishable from a takeover/handback unless you also track ports. Treat "event carries a port and the previous known port was `null`" as a birth signal too.
3. **Hydration replay of an already-live browser** — do *not* auto-open. The first event a subscriber sees is the channel's hydration, not a transition. If the browser is already live at that moment, the user already knows about it; the persisted per-session open state (`openBySession`, localStorage-backed) decides. Requiring `previous.hydrated` before any auto-open encodes exactly this.
4. **Live→live transitions (takeover/handback)** — never re-open. If the user explicitly closed the pane while the agent kept driving, a `user_in_control` → `agent_in_control` cycle must not fight that choice. (`handoff_pending` is the one exception: it still auto-expands for the header badge, as it did before the fix.)
5. **Background sessions** — never auto-open. All auto-open logic is gated on `sessionId === get().activeSessionId`; a browser coming alive on a non-active session leaves every pane flag untouched (background sessions' browsers keep running server-side, untouched).

Note the supporting detail that makes case 2 necessary: the *same* semantic event ("the browser just became ready") can arrive as two different wire shapes depending on when the client subscribed — a non-live→live transition, or a live→live transition that happens to carry the first port. Trigger design must reason about the channel's hydration semantics, not just the state machine.

## Why This Matters

- **In this architecture, server-side lifecycle events never surface UI by themselves.** The three-hop chain (React mount → rect report → shell attach) means a perfectly healthy browser can be fully operational over CDP while completely invisible. There is no fallback that shows the view "just in case."
- **The failure mode is silent.** No error is raised anywhere: the shell is correct to keep an unreported-rect view hidden, the server is correct to emit `agent_in_control`, the renderer is correct to keep a closed pane closed. The only symptom is a user staring at an empty panel while the agent browses. Silent UX failures of this shape are found by users, not by tests — unless the transition matrix is explicitly tested.
- **Copy and product promises can outrun wiring.** The empty-state text promised auto-open behavior that did not exist. When UI copy makes a behavioral promise ("X opens automatically when…"), that promise is a contract the state machine must implement — treat such copy as a specification to verify, not as documentation of existing behavior.

## When to Apply

- **Adding a new browser lifecycle state** (or renaming/splitting one): enumerate which transitions into/out of it should change pane visibility, and decide each deliberately using the taxonomy above.
- **Adding any new surface expectation of the form "the browser/panel should appear when X"**: the answer is always an explicit trigger in the renderer keyed off a `browser_state` transition — never an assumption that the shell or server will make it visible.
- **Reviewing browser UX changes**: check the trigger matrix (birth / mid-spawn ready / hydration replay / live→live / background session) and check that any copy promising automatic behavior has a corresponding wired trigger and a regression test.
- **Analogous native-view surfaces** (popups, the agent-mode shield, the detached window, modal-hosted capture views): they inherit the same rect-driven visibility rules, so the same "who mounts, who reports, who triggers" questions apply.

## Examples

The fixed gates in `_applyBrowserState` (`src/client/stores/browser-pane-store.ts:506-530`), abridged:

```ts
if (sessionId !== get().activeSessionId) return        // background sessions: never
if (next === 'handoff_pending') {                      // handoff: badge + auto-expand
  get().setPaneOpen(sessionId, true)
  return
}
// Birth: a hydrated non-live → live transition (spawn, crash rebuild)
const becameLive =
  previous.hydrated && !isLiveControlState(previous.controlState) && isLiveControlState(next)
// Mid-spawn window: hydration can report agent_in_control WITHOUT a port;
// the ready emit then arrives live→live. First known port = birth signal.
const becameReady =
  previous.hydrated &&
  isLiveControlState(next) &&
  data.port !== undefined &&
  previous.port === null
if (becameLive || becameReady) {
  get().setPaneOpen(sessionId, true)
}
```

The seven auto-open regression tests in `src/client/components/browser/__tests__/browser-pane-store.test.ts` map each transition to its open/no-open verdict (an eighth test in the same commit covers the companion localStorage merge fix):

| Test (line) | Transition | Verdict |
|---|---|---|
| `auto-opens the pane when the agent browser comes alive for the active session` (201) | hydrated `none` → `agent_in_control` (with port) | open |
| `does not auto-open when hydration replays an already-live browser` (219) | hydration: `agent_in_control` (with port) as first event | no open — persisted state decides |
| `does not auto-open for a browser coming alive on a background session` (227) | `none` → `agent_in_control` on a non-active session | no open |
| `never re-opens the pane on live-to-live transitions after the user closed it` (235) | `user_in_control` ↔ `agent_in_control` after manual close | no open |
| `re-opens the pane when a lost session browser rebuilds on the next tool call` (250) | `session_lost` → `agent_in_control` (new port) | open — a rebirth, not live→live |
| `auto-opens when hydration catches the browser mid-spawn and the ready event lands` (263) | hydration: `agent_in_control` *no port* → `agent_in_control` *with port* | no open on hydration; open on first port |
| `does not re-open on a live→live transition while the port is already known` (275) | handback cycle with unchanged port after manual close | no open |

## Related

- docs/solutions/conventions/merge-shared-localstorage-writes-across-electron-windows.md — companion learning from the same debugging session and commit 1c720278: cross-window shared localStorage must be merged on write.
- docs/plans/2026-07-18-001-feat-embedded-controlled-browser-plan.md — historical plan defining the browser control state machine whose `browser_state` transitions this trigger consumes.
