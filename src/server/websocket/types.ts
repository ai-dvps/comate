/**
 * WebSocket protocol for Comate sidecar communication.
 *
 * Goals:
 * - Replace browser-fetch/SSE for dynamic GUI<->sidecar traffic.
 * - Keep HTTP for static files and external webhooks.
 * - Support request/response multiplexing plus server-pushed events.
 */

export type WsRequestType =
  | 'subscribe'
  | 'unsubscribe'
  | 'status'
  | 'sendMessage'
  | 'loadMessages'
  | 'loadMessagesAfter'
  | 'subscribeGitChanges'
  | 'unsubscribeGitChanges'
  | 'subscribeBrowserState'
  | 'unsubscribeBrowserState'
  | 'browserTakeover'
  | 'browserHandback'
  | 'browserActivityPing'
  | 'browserClose'
  | 'browserIdleConfirm'
  | 'browserIdleSnooze'

export interface WsRequest {
  id: string
  type: WsRequestType
  payload: Record<string, unknown>
}

export interface WsResponse {
  id: string
  ok: true
  payload?: unknown
}

export interface WsErrorResponse {
  id: string
  ok: false
  error: {
    message: string
    code?: string
  }
}

export interface WsEventMessage {
  type: 'event'
  eventType: string
  sessionId?: string
  workspaceId?: string
  data: unknown
  eventId?: string
}

export type WsMessage = WsRequest | WsResponse | WsErrorResponse | WsEventMessage

// Payloads

export interface SubscribePayload {
  workspaceId: string
  sessionId: string
  lastEventId?: string
}

export interface UnsubscribePayload {
  workspaceId: string
  sessionId: string
}

export interface StatusPayload {
  workspaceId: string
}

export interface StatusResult {
  statuses: Record<string, { pendingCount: number; isProcessing?: boolean }>
}

export interface SendMessagePayload {
  workspaceId: string
  sessionId: string
  content: string
}

export interface LoadMessagesPayload {
  workspaceId: string
  sessionId: string
  offset?: number
  limit?: number
}

export interface LoadMessagesAfterPayload {
  workspaceId: string
  sessionId: string
  afterMessageId?: string
}

export interface SubscribeGitChangesPayload {
  workspaceId: string
}

export interface UnsubscribeGitChangesPayload {
  workspaceId: string
}

/**
 * browser_state channel (U5, KTD-9): sessionId-keyed passive subscription —
 * subscribing never creates a runtime or a browser session.
 */
export interface SubscribeBrowserStatePayload {
  workspaceId: string
  sessionId: string
}

export interface UnsubscribeBrowserStatePayload {
  sessionId: string
}

/** F3 proactive takeover / grant a pending handoff (接管). */
export interface BrowserTakeoverPayload {
  sessionId: string
}

/** Hand control back to the agent (继续). */
export interface BrowserHandbackPayload {
  sessionId: string
  /**
   * "记住此站点" (U8): the state bar's checkbox rides along with the
   * handback — the server exports the current site's login state into the
   * workspace's value-only-in store before handing control back.
   */
  rememberSite?: boolean
}

/**
 * Content-free activity ping (KTD-6): resets the server-fixed handoff timer.
 * Keystrokes and page data NEVER travel on this verb.
 */
export interface BrowserActivityPingPayload {
  sessionId: string
}

/**
 * Explicit browser close (U1/U4): the state bar's "close browser" button.
 * Distinct from collapse-pane (a client-side hide) — this tears the server-side
 * Steel process down. Auto-remembers the current site's login first.
 */
export interface BrowserClosePayload {
  sessionId: string
}

/**
 * Idle-reclaim prompt responses (U3): the in-pane "close now" / "not now"
 * banner. Confirm tears down with the idle source; snooze dismisses the prompt
 * and re-arms the idle timer for a fresh interval.
 */
export interface BrowserIdleActionPayload {
  sessionId: string
}
