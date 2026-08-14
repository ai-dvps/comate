import { create } from 'zustand'
import type { WsEventMessage } from '@server/websocket/types'
import { wsClient } from '../lib/websocket-client.js'
import { onBrowserViewOcclusionChange } from '../lib/browser-view-bridge'
import type { ChatState } from './chat-store'
import type { DetachedBrowserPlacement } from '../lib/desktop-api'
import { detachedBrowserPlacementsEqual } from '../lib/detached-browser-api'

/**
 * browser-pane-store — client half of the chat-side browser panel: pane
 * visibility/width persistence, the per-session control-state mirror of the
 * browser_state channel, the handoff badge + auto-expand, and the
 * takeover/handback verbs with their busy window.
 *
 * The panel is backed by the shell's native WebContentsView (U8); U9 removed
 * the iframe viewer with the legacy browser stack, so outside the Electron
 * shell the panel renders its degraded "needs the desktop app" state
 * (KTD-15) — no viewer URL is ever fetched or constructed client-side.
 *
 * Subscription discipline (KTD-9): one passive subscription follows the
 * ACTIVE chat session — subscribing never creates a browser. Hydration lands
 * as a browser_state event with state 'none' for browserless sessions.
 */

export type BrowserPaneControlState =
  | 'none'
  | 'agent_in_control'
  | 'handoff_pending'
  | 'user_in_control'
  | 'session_lost'

export interface BrowserUnavailableInfo {
  code: string
  reason: string
}

export type BrowserPendingVerb = 'takeover' | 'handback'

export interface SessionBrowserState {
  controlState: BrowserPaneControlState
  /** True once the channel's hydration (or any live event) has landed. */
  hydrated: boolean
  port: number | null
  unavailable: BrowserUnavailableInfo | null
  /** Busy window after a verb click until the state flip arrives. */
  pendingVerb: BrowserPendingVerb | null
  /** Last verb failure, shown in the state bar; cleared on the next event. */
  verbError: string | null
  /**
   * "记住此站点" checkbox (U8): rides along with the next handback — the
   * server then exports the current site's login state into the workspace's
   * value-only-in store. Resets on every real state transition.
   */
  rememberSite: boolean
  /**
   * Idle-reclaim prompt (U3): true while the in-pane "close now / not now"
   * banner should show. Set by a browser_idle_prompt event (pending: true),
   * cleared by activity, snooze, close, or any state transition.
   */
  idlePrompt: boolean
  task: BrowserTaskProjection | null
}

export type BrowserTaskLifecycle = 'active' | 'awaiting-user' | 'validating' | 'ready' | 'blocked' | 'outcome-unknown' | 'complete' | 'abandoned'
export interface BrowserTaskProjection {
  taskId?: string
  version?: number
  lifecycle: BrowserTaskLifecycle
  required: number
  populatedPendingValidation: number
  verified: number
  awaitingAuthority: number
  recoveryExhausted?: boolean
  outcome?: {
    possibleDispatch: boolean
    evidenceStatus: 'none' | 'insufficient' | 'conflicting' | 'durable'
    lastCheckedAt: string | null
    canRecheck: boolean
    canAbandon: boolean
    canAcknowledgeDuplicateRisk: boolean
  }
}

export interface BrowserPaneState {
  /**
   * Per-session expand/collapse state (展开/收起 is independent per session):
   * keyed by sessionId, defaulting to collapsed (false) for unknown sessions.
   * Width/hasOpened stay global — only the open flag is per-session.
   */
  openBySession: Record<string, boolean>
  width: number
  /** Keep-alive gate: the iframe only mounts after the first open. */
  hasOpened: boolean
  detachedPlacement: DetachedBrowserPlacement | null
  activeWorkspaceId: string | null
  activeSessionId: string | null
  sessions: Record<string, SessionBrowserState>
  /**
   * U8 (KTD-14): single modal-occlusion flag — true while a modal-level
   * overlay (dialog/alertdialog) covers the panel area and the shell has
   * hidden every native browser view. Driven by the bridge's watcher.
   */
  nativeViewOccluded: boolean

  togglePane: (sessionId: string) => void
  setPaneOpen: (sessionId: string, open: boolean) => void
  setWidth: (width: number) => void
  setDetachedPlacement: (placement: DetachedBrowserPlacement | null) => void
  setActiveSession: (workspaceId: string | null, sessionId: string | null) => void

  takeover: (sessionId: string) => Promise<void>
  handback: (sessionId: string) => Promise<void>
  /** Toggle the "记住此站点" checkbox (user_in_control only). */
  setRememberSite: (sessionId: string, remember: boolean) => void
  recordActivity: (sessionId: string) => void
  /**
   * session_lost manual retry (U8): the server rebuilds the view over the
   * control channel and navigates back to the session's last URL.
   */
  retrySession: (sessionId: string) => Promise<void>
  /** browser_unavailable retry: re-probe health; clear the banner when well. */
  retryUnavailable: (sessionId: string) => Promise<void>
  /** Explicit close (U1/U4): the state bar's "close browser" button. */
  close: (sessionId: string) => Promise<void>
  /** Idle banner "close now" (U3). */
  confirmIdleClose: (sessionId: string) => Promise<void>
  /** Idle banner "not now" (U3). */
  snoozeIdle: (sessionId: string) => Promise<void>
  resolveTaskOutcome: (sessionId: string, action: 'recheck' | 'abandon' | 'acknowledge_duplicate_risk') => Promise<void>

  // Internal setters (driven by the WS listener; exported for tests).
  _applyBrowserState: (
    sessionId: string,
    data: { state: BrowserPaneControlState; port?: number },
  ) => void
  _applyUnavailable: (sessionId: string, info: BrowserUnavailableInfo) => void
  _applyClosed: (sessionId: string) => void
  _applyIdlePrompt: (sessionId: string, pending: boolean) => void
  _applyTaskProjection: (sessionId: string, task: BrowserTaskProjection | null) => void
  /** Bridge watcher → store flag (U8 native occlusion). */
  _setNativeViewOccluded: (occluded: boolean) => void
}

export const BROWSER_PANE_MIN_WIDTH = 320
export const BROWSER_PANE_DEFAULT_WIDTH = 480

const OPEN_BY_SESSION_STORAGE_KEY = 'browser-pane-open-by-session'
const WIDTH_STORAGE_KEY = 'browser-pane-width'

function maxWidth(): number {
  return Math.floor(
    (typeof window !== 'undefined' ? window.innerWidth : BROWSER_PANE_DEFAULT_WIDTH) * 0.8,
  )
}

function clampWidth(value: number): number {
  return Math.min(maxWidth(), Math.max(BROWSER_PANE_MIN_WIDTH, Math.round(value)))
}

function readPersistedOpenBySession(): Record<string, boolean> {
  try {
    const stored = localStorage.getItem(OPEN_BY_SESSION_STORAGE_KEY)
    if (!stored) return {}
    const parsed = JSON.parse(stored) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const result: Record<string, boolean> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'boolean') result[key] = value
    }
    return result
  } catch {
    // localStorage unavailable or corrupt
    return {}
  }
}

function writePersistedOpenBySession(openBySession: Record<string, boolean>): void {
  try {
    localStorage.setItem(OPEN_BY_SESSION_STORAGE_KEY, JSON.stringify(openBySession))
  } catch {
    // localStorage unavailable
  }
}

function readPersistedWidth(): number {
  try {
    const stored = localStorage.getItem(WIDTH_STORAGE_KEY)
    if (stored) {
      const parsed = parseInt(stored, 10)
      if (!isNaN(parsed)) return clampWidth(parsed)
    }
  } catch {
    // localStorage unavailable or corrupt
  }
  return BROWSER_PANE_DEFAULT_WIDTH
}

function writePersistedWidth(width: number): void {
  try {
    localStorage.setItem(WIDTH_STORAGE_KEY, String(width))
  } catch {
    // localStorage unavailable
  }
}

/**
 * The single empty-session object (F11b): selectors and components share ONE
 * reference for unknown sessions, so `useBrowserPaneStore((s) => …?? EMPTY)`
 * keeps selector identity stable across unrelated store updates. Never
 * mutated — every writer spreads it first.
 */
export const EMPTY_SESSION_BROWSER_STATE: SessionBrowserState = {
  controlState: 'none',
  hydrated: false,
  port: null,
  unavailable: null,
  pendingVerb: null,
  verbError: null,
  rememberSite: false,
  idlePrompt: false,
  task: null,
}

export function initialSessionBrowserState(): SessionBrowserState {
  return { ...EMPTY_SESSION_BROWSER_STATE }
}

function getSessionState(
  state: BrowserPaneState,
  sessionId: string,
): SessionBrowserState {
  return state.sessions[sessionId] ?? EMPTY_SESSION_BROWSER_STATE
}

/** True while the control state describes a live (or starting) browser. */
export function isLiveControlState(state: BrowserPaneControlState): boolean {
  return state === 'agent_in_control' || state === 'handoff_pending' || state === 'user_in_control'
}

// ---------------------------------------------------------------------------
// WS subscription lifecycle (git-changes pattern, single active session slot)
// ---------------------------------------------------------------------------

let subscribedSessionId: string | null = null
let subscriptionGeneration = 0

async function subscribeTo(workspaceId: string, sessionId: string): Promise<void> {
  const generation = ++subscriptionGeneration
  await wsClient
    .request('subscribeBrowserState', { workspaceId, sessionId })
    .catch((err) => {
      console.error(`Failed to subscribe to browser state for ${sessionId}:`, err)
    })
  if (generation !== subscriptionGeneration) {
    // A newer subscribe/unsubscribe superseded this one mid-flight — drop the
    // server-side subscription we just made instead of leaking it.
    wsClient.request('unsubscribeBrowserState', { sessionId }).catch(() => {})
    return
  }
  subscribedSessionId = sessionId
}

function unsubscribeCurrent(): void {
  subscriptionGeneration += 1
  const sessionId = subscribedSessionId
  subscribedSessionId = null
  if (sessionId) {
    wsClient.request('unsubscribeBrowserState', { sessionId }).catch(() => {})
  }
}

const ACTIVITY_PING_INTERVAL_MS = 15_000
const lastActivityPingAt = new Map<string, number>()

const persistedOpenBySessionAtBoot = readPersistedOpenBySession()

export const useBrowserPaneStore = create<BrowserPaneState>((set, get) => {
  const patchSession = (sessionId: string, patch: Partial<SessionBrowserState>): void => {
    set((state) => {
      const current = getSessionState(state, sessionId)
      const merged = { ...current, ...patch }
      // No-op guard: duplicate events — e.g. WS reconnect hydration replays —
      // must not rebuild the session object.
      let changed = false
      for (const key of Object.keys(merged) as Array<keyof SessionBrowserState>) {
        if (merged[key] !== current[key]) {
          changed = true
          break
        }
      }
      if (!changed) return state
      return {
        sessions: { ...state.sessions, [sessionId]: merged },
      }
    })
  }

  const runVerb = async (sessionId: string, verb: BrowserPendingVerb): Promise<void> => {
    const current = getSessionState(get(), sessionId)
    if (current.pendingVerb) return
    patchSession(sessionId, { pendingVerb: verb, verbError: null })
    try {
      // "记住此站点" (U8): the checkbox state rides the handback verb; the
      // response reports whether the login state was actually remembered.
      const rememberSite = verb === 'handback' ? current.rememberSite : undefined
      const response = (await wsClient.request(verb === 'takeover' ? 'browserTakeover' : 'browserHandback', {
        sessionId,
        ...(rememberSite ? { rememberSite: true } : {}),
      })) as { siteAuth?: { saved: boolean; key?: string; error?: string } } | undefined
      if (verb === 'handback' && rememberSite) {
        if (response?.siteAuth?.saved === false) {
          patchSession(sessionId, {
            rememberSite: false,
            verbError: response.siteAuth.error ?? null,
          })
        } else {
          patchSession(sessionId, { rememberSite: false })
        }
      }
      // Synchronous flips (F3 takeover, F3 handback) already arrived over the
      // channel — it emits before the verb response — so pendingVerb is only
      // still set when the flip is genuinely pending: the handoff grant /
      // decline / card-driven handback completes when the agent's in-progress
      // action settles. Anything else was a no-op: settle the busy window.
      if (getSessionState(get(), sessionId).pendingVerb === verb) {
        const state = getSessionState(get(), sessionId).controlState
        const flipExpected =
          state === 'handoff_pending' || (verb === 'handback' && state === 'user_in_control')
        if (!flipExpected) {
          patchSession(sessionId, { pendingVerb: null })
        }
      }
    } catch (err) {
      patchSession(sessionId, {
        pendingVerb: null,
        verbError: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    openBySession: persistedOpenBySessionAtBoot,
    width: readPersistedWidth(),
    hasOpened: Object.values(persistedOpenBySessionAtBoot).some((v) => v),
    detachedPlacement: null,
    activeWorkspaceId: null,
    activeSessionId: null,
    sessions: {},
    nativeViewOccluded: false,

    togglePane: (sessionId: string) => {
      get().setPaneOpen(sessionId, !selectSessionOpen(get(), sessionId))
    },

    setPaneOpen: (sessionId: string, open: boolean) => {
      if (selectSessionOpen(get(), sessionId) === open) return
      set((state) => ({
        openBySession: { ...state.openBySession, [sessionId]: open },
        ...(open ? { hasOpened: true } : {}),
      }))
      writePersistedOpenBySession(get().openBySession)
    },

    setWidth: (width: number) => {
      const clamped = clampWidth(width)
      if (get().width === clamped) return
      set({ width: clamped })
      writePersistedWidth(clamped)
    },

    setDetachedPlacement: (placement) => {
      const current = get().detachedPlacement
      if (detachedBrowserPlacementsEqual(current, placement)) return
      set({ detachedPlacement: placement ? { ...placement } : null })
    },

    setActiveSession: (workspaceId: string | null, sessionId: string | null) => {
      const prev = get()
      if (prev.activeWorkspaceId === workspaceId && prev.activeSessionId === sessionId) return
      set({ activeWorkspaceId: workspaceId, activeSessionId: sessionId })
      unsubscribeCurrent()
      if (workspaceId && sessionId) {
        void subscribeTo(workspaceId, sessionId)
      }
    },

    takeover: (sessionId: string) => runVerb(sessionId, 'takeover'),
    handback: (sessionId: string) => runVerb(sessionId, 'handback'),

    close: async (sessionId: string) => {
      // Terminal action: the browser_closed event (or the ok response) resets
      // the UI. Swallow errors — a failed close leaves the pane as-is.
      try {
        await wsClient.request('browserClose', { sessionId })
      } catch {
        /* server-side browser_closed is the source of truth */
      }
    },
    confirmIdleClose: async (sessionId: string) => {
      try {
        await wsClient.request('browserIdleConfirm', { sessionId })
      } catch {
        /* noop */
      }
    },
    snoozeIdle: async (sessionId: string) => {
      patchSession(sessionId, { idlePrompt: false })
      try {
        await wsClient.request('browserIdleSnooze', { sessionId })
      } catch {
        /* noop */
      }
    },

    resolveTaskOutcome: async (sessionId, action) => {
      const state = get()
      const task = getSessionState(state, sessionId).task
      if (!task?.outcome || !task.taskId || task.version === undefined || !state.activeWorkspaceId) return
      const response = await fetch(`/api/browser/${encodeURIComponent(sessionId)}/task-outcome/${action}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: state.activeWorkspaceId, taskId: task.taskId, expectedTaskVersion: task.version }),
      })
      if (!response.ok) throw new Error(`browser outcome reconciliation failed (${response.status})`)
    },

    setRememberSite: (sessionId: string, remember: boolean) => {
      const session = getSessionState(get(), sessionId)
      // The checkbox only exists against the live user-driven page.
      if (session.controlState !== 'user_in_control') return
      patchSession(sessionId, { rememberSite: remember })
    },

    recordActivity: (sessionId: string) => {
      const session = getSessionState(get(), sessionId)
      if (!isLiveControlState(session.controlState)) return
      const now = Date.now()
      const last = lastActivityPingAt.get(sessionId) ?? 0
      if (now - last < ACTIVITY_PING_INTERVAL_MS) return
      lastActivityPingAt.set(sessionId, now)
      // Content-free (KTD-6): only the server-fixed handoff timer is reset.
      wsClient.request('browserActivityPing', { sessionId }).catch(() => {})
    },

    retrySession: async (sessionId: string) => {
      // Native stack (U8): the server rebuilds the view over the control
      // channel and navigates back to the session's last URL (the
      // partition survives, so login state is kept). The browser_state
      // event flips the panel out of session_lost.
      try {
        await fetch(`/api/browser/${encodeURIComponent(sessionId)}/retry`, { method: 'POST' })
      } catch {
        // A failed retry leaves the session_lost copy up; the state bar
        // copy already sets expectations ("next tool call also rebuilds").
      }
    },

    retryUnavailable: async (sessionId: string) => {
      let healthy = false
      let reason: string | null = null
      try {
        const res = await fetch('/api/health/browser')
        healthy = res.ok
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null
          reason = typeof body?.error === 'string' ? body.error : null
        }
      } catch {
        healthy = false
      }
      const current = getSessionState(get(), sessionId)
      if (healthy) {
        patchSession(sessionId, { unavailable: null })
      } else {
        patchSession(sessionId, {
          unavailable: {
            code: current.unavailable?.code ?? 'browser_start_failed',
            reason: reason ?? current.unavailable?.reason ?? '',
          },
        })
      }
    },

    _applyBrowserState: (sessionId, data) => {
      const next = data.state
      patchSession(sessionId, {
        controlState: next,
        hydrated: true,
        port: data.port ?? null,
        // Any real transition settles the verb busy window and stale errors;
        // a moving state machine also supersedes a stale unavailable banner.
        pendingVerb: null,
        verbError: null,
        unavailable: null,
        // The remember-site checkbox only makes sense against the live
        // user_in_control page; a transition (handback, timeout, crash)
        // always clears it.
        rememberSite: false,
        // A moving state machine supersedes a stale idle prompt.
        idlePrompt: false,
      })
      // handoff → header badge + auto-expand (R1/R5).
      if (next === 'handoff_pending' && sessionId === get().activeSessionId) {
        get().setPaneOpen(sessionId, true)
      }
    },

    _applyUnavailable: (sessionId, info) => {
      patchSession(sessionId, {
        hydrated: true,
        unavailable: info,
        pendingVerb: null,
      })
    },

    _applyClosed: (sessionId) => {
      patchSession(sessionId, {
        ...initialSessionBrowserState(),
        hydrated: true,
      })
    },
    _applyIdlePrompt: (sessionId, pending) => {
      patchSession(sessionId, { idlePrompt: pending })
    },
    _applyTaskProjection: (sessionId, task) => patchSession(sessionId, { task }),
    _setNativeViewOccluded: (occluded) => {
      if (get().nativeViewOccluded === occluded) return
      set({ nativeViewOccluded: occluded })
    },
  }
})

// ---------------------------------------------------------------------------
// Module-level WS wiring (git-changes-store pattern)
// ---------------------------------------------------------------------------

interface BrowserStateEventPayload {
  type: 'browser_state'
  state: BrowserPaneControlState
  port?: number
  task?: BrowserTaskProjection | null
}

interface BrowserUnavailableEventPayload {
  type: 'browser_unavailable'
  code: string
  reason: string
}

function handleBrowserChannelEvent(msg: WsEventMessage): void {
  const sessionId = msg.sessionId
  if (!sessionId) return
  const store = useBrowserPaneStore.getState()
  if (msg.eventType === 'browser_state') {
    const data = msg.data as BrowserStateEventPayload
    if (typeof data?.state !== 'string') return
    store._applyBrowserState(sessionId, {
      state: data.state,
      ...(typeof data.port === 'number' ? { port: data.port } : {}),
    })
    if ('task' in data) store._applyTaskProjection(sessionId, data.task ?? null)
  } else if (msg.eventType === 'browser_unavailable') {
    const data = msg.data as BrowserUnavailableEventPayload
    store._applyUnavailable(sessionId, {
      code: typeof data?.code === 'string' ? data.code : 'browser_start_failed',
      reason: typeof data?.reason === 'string' ? data.reason : '',
    })
  } else if (msg.eventType === 'browser_closed') {
    store._applyClosed(sessionId)
  } else if (msg.eventType === 'browser_idle_prompt') {
    const data = msg.data as { pending?: boolean } | undefined
    store._applyIdlePrompt(sessionId, data?.pending === true)
  } else if (msg.eventType === 'browser_task_state') {
    const data = msg.data as { task?: BrowserTaskProjection | null } | undefined
    store._applyTaskProjection(sessionId, data?.task ?? null)
  }
}

wsClient.onEvent(handleBrowserChannelEvent)

wsClient.onReconnect(() => {
  const { activeWorkspaceId, activeSessionId } = useBrowserPaneStore.getState()
  if (activeWorkspaceId && activeSessionId) {
    unsubscribeCurrent()
    void subscribeTo(activeWorkspaceId, activeSessionId)
  }
})

// U8 (KTD-14): modal-occlusion flag — the bridge watcher is a no-op outside
// the Electron shell, so this subscription is safe in every environment.
onBrowserViewOcclusionChange((occluded) => {
  useBrowserPaneStore.getState()._setNativeViewOccluded(occluded)
})

// ---------------------------------------------------------------------------
// Selectors / helpers for components
// ---------------------------------------------------------------------------

/** Selector: the pane session slice, with stable defaults for unknown ids. */
export function selectSessionBrowser(
  state: BrowserPaneState,
  sessionId: string | null | undefined,
): SessionBrowserState {
  if (!sessionId) return EMPTY_SESSION_BROWSER_STATE
  return getSessionState(state, sessionId)
}

/** Selector: whether the pane is open for the given session (default collapsed). */
export function selectSessionOpen(
  state: BrowserPaneState,
  sessionId: string | null | undefined,
): boolean {
  if (!sessionId) return false
  return state.openBySession[sessionId] ?? false
}

/** Header badge: the session's handoff is waiting on the user (R5). */
export function selectHandoffPending(
  state: BrowserPaneState,
  sessionId: string | null | undefined,
): boolean {
  return selectSessionBrowser(state, sessionId).controlState === 'handoff_pending'
}

/**
 * F5 first-use signal: a browser tool call is in flight for the session
 * (tool_use without its tool_result). Drives both the pane's determinate
 * progress state (open path) and the chat's in-flight progress copy carrier
 * (closed path — the tool call itself is rendered by the message list).
 *
 * Reads chat-store's incrementally maintained per-session id set (O(1)) —
 * the set is updated where tool_use/tool_result parts land, instead of
 * rescanning every message part on each chat-store update during streaming.
 */
export function selectHasInFlightBrowserTool(
  state: Pick<ChatState, 'inFlightBrowserTools'>,
  sessionId: string | null | undefined,
): boolean {
  if (!sessionId) return false
  return (state.inFlightBrowserTools[sessionId]?.size ?? 0) > 0
}

export type BrowserStartPhase = 'preparing' | 'starting' | null

/**
 * Determinate first-use progress phase (F5): two observable milestones —
 * the tool call has been issued (runtime resolution) and the browser session
 * exists but its view is not live yet (shell view creation).
 */
export function selectBrowserStartPhase(
  session: SessionBrowserState,
  hasInFlightBrowserTool: boolean,
): BrowserStartPhase {
  if (session.controlState === 'session_lost') return null
  if (isLiveControlState(session.controlState)) return 'starting'
  if (session.controlState === 'none' && hasInFlightBrowserTool) return 'preparing'
  return null
}

/** Phase → determinate progress percentage shown in the pane. */
export const BROWSER_START_PHASE_PERCENT: Record<Exclude<BrowserStartPhase, null>, number> = {
  preparing: 30,
  starting: 70,
}
