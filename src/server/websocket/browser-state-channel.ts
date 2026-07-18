import { WebSocket } from 'ws';
import {
  BrowserService,
  browserService,
  type BrowserControlState,
  type BrowserServiceEvent,
} from '../services/browser-service.js';
import { diagLog } from '../utils/diag-logger.js';

/**
 * browser-state-channel — the `browser_state` WebSocket event family (U5,
 * KTD-9). Git-changes-style passive subscription with one deliberate shape
 * change: subscriptions are keyed by chat sessionId (git-changes keys by
 * workspaceId). Discipline:
 *
 *  - Passive: subscribing NEVER creates a runtime or a browser session — the
 *    channel only reads browser-service's registry (KTD-9).
 *  - Hydration: subscribing pushes the current state immediately (the
 *    git-changes-service.ts:171-173 precedent); a session with no browser
 *    hydrates as `browser_state` with state 'none'.
 *  - Every state-machine migration re-broadcasts (browser-service emits on
 *    every transition, including approval resolve/timeout/abort-driven ones
 *    and the crash-driven session_lost); browser_unavailable and
 *    browser_closed ride the same channel so the panel can render the
 *    degraded and empty states.
 *  - Events bypass the session ring buffer entirely — sockets are written to
 *    directly.
 *  - Disconnect cleanup: unsubscribeSocket drops every session subscription
 *    the socket held (registered from the WS server's handleDisconnect).
 */

export type BrowserStateSnapshot = BrowserControlState | 'none';

export interface BrowserStateSnapshotEvent {
  type: 'browser_state';
  sessionId: string;
  workspaceId: string;
  state: BrowserStateSnapshot;
  port?: number;
}

interface WsEventEnvelope {
  type: 'event';
  eventType: string;
  sessionId: string;
  workspaceId: string;
  data: BrowserServiceEvent | BrowserStateSnapshotEvent;
}

export class BrowserStateChannel {
  private readonly service: BrowserService;
  /** sessionId -> subscribed sockets. */
  private readonly subscriptions = new Map<string, Set<WebSocket>>();
  /** socket -> (sessionId -> workspaceId) for disconnect/unsubscribe cleanup. */
  private readonly socketSessions = new Map<WebSocket, Map<string, string>>();

  constructor(service: BrowserService) {
    this.service = service;
    this.service.onEvent((event) => {
      this.forward(event);
    });
  }

  /** Introspection for tests and diagnostics. */
  subscriberCount(sessionId: string): number {
    return this.subscriptions.get(sessionId)?.size ?? 0;
  }

  subscribe(sessionId: string, workspaceId: string, socket: WebSocket): void {
    let sockets = this.subscriptions.get(sessionId);
    if (!sockets) {
      sockets = new Set();
      this.subscriptions.set(sessionId, sockets);
    }
    sockets.add(socket);

    let sessions = this.socketSessions.get(socket);
    if (!sessions) {
      sessions = new Map();
      this.socketSessions.set(socket, sessions);
    }
    sessions.set(sessionId, workspaceId);

    diagLog(`[browser-state] socket subscribed to session ${sessionId}`);

    // Hydration: push the current state so a fresh subscriber never waits for
    // the next transition to learn where the state machine sits.
    this.sendToSocket(socket, this.hydrationEvent(sessionId, workspaceId));
  }

  unsubscribe(sessionId: string, socket: WebSocket): void {
    const sockets = this.subscriptions.get(sessionId);
    if (sockets) {
      sockets.delete(socket);
      if (sockets.size === 0) {
        this.subscriptions.delete(sessionId);
      }
    }
    const sessions = this.socketSessions.get(socket);
    if (sessions) {
      sessions.delete(sessionId);
      if (sessions.size === 0) {
        this.socketSessions.delete(socket);
      }
    }
  }

  /** Drop every session subscription held by a (disconnecting) socket. */
  unsubscribeSocket(socket: WebSocket): void {
    const sessions = this.socketSessions.get(socket);
    if (!sessions) return;
    for (const sessionId of [...sessions.keys()]) {
      this.unsubscribe(sessionId, socket);
    }
  }

  private hydrationEvent(sessionId: string, workspaceId: string): BrowserStateSnapshotEvent {
    const state = this.service.getControlState(sessionId);
    const port = this.service.getSession(sessionId)?.port;
    return {
      type: 'browser_state',
      sessionId,
      workspaceId,
      state: state ?? 'none',
      ...(port !== undefined && { port }),
    };
  }

  private forward(event: BrowserServiceEvent): void {
    const sockets = this.subscriptions.get(event.sessionId);
    if (!sockets) return;
    const envelope: WsEventEnvelope = {
      type: 'event',
      eventType: event.type,
      sessionId: event.sessionId,
      workspaceId: event.workspaceId,
      data: event,
    };
    const msg = JSON.stringify(envelope);
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(msg);
      }
    }
  }

  private sendToSocket(socket: WebSocket, event: BrowserStateSnapshotEvent): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    const envelope: WsEventEnvelope = {
      type: 'event',
      eventType: event.type,
      sessionId: event.sessionId,
      workspaceId: event.workspaceId,
      data: event,
    };
    socket.send(JSON.stringify(envelope));
  }
}

export const browserStateChannel = new BrowserStateChannel(browserService);
