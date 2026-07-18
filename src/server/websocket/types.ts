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
}

/**
 * Content-free activity ping (KTD-6): resets the server-fixed handoff timer.
 * Keystrokes and page data NEVER travel on this verb.
 */
export interface BrowserActivityPingPayload {
  sessionId: string
}
