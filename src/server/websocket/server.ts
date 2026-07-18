import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { Server } from 'http';
import { diagLog, diagWarn } from '../utils/diag-logger.js';
import { chatService } from '../services/chat-service.js';
import { gitChangesService } from '../services/git-changes-service.js';
import { browserControlService } from '../services/browser-control.js';
import { browserStateChannel } from './browser-state-channel.js';
import {
  createWsUpgradeVerifier,
  type OriginGuardOptions,
} from '../services/security/request-origin-guard.js';
import type {
  WsRequest,
  WsResponse,
  WsErrorResponse,
  WsEventMessage,
  SubscribePayload,
  UnsubscribePayload,
  StatusPayload,
  StatusResult,
  SendMessagePayload,
  LoadMessagesPayload,
  LoadMessagesAfterPayload,
  SubscribeGitChangesPayload,
  UnsubscribeGitChangesPayload,
  SubscribeBrowserStatePayload,
  UnsubscribeBrowserStatePayload,
  BrowserTakeoverPayload,
  BrowserHandbackPayload,
  BrowserActivityPingPayload,
} from './types.js';
import type { SseEvent } from '../types/message.js';

interface ClientContext {
  socket: WebSocket;
  subscriptions: Map<string, string>; // sessionId -> workspaceId
}

export class ComateWebSocketServer {
  private wss?: WebSocketServer;
  private clients = new Map<WebSocket, ClientContext>();
  private runtimeEventUnsubscribers = new Map<string, Map<WebSocket, () => void>>();

  attach(server: Server, options: OriginGuardOptions = {}): void {
    // Origin/Host check on the upgrade handshake (plan U9): cross-origin pages
    // must not ride the event stream. Local non-browser clients (no Origin
    // header) still pass per the guard's documented absent-Origin policy.
    this.wss = new WebSocketServer({
      server,
      path: '/ws',
      verifyClient: createWsUpgradeVerifier(options),
    });
    this.wss.on('connection', (socket) => this.handleConnection(socket));
    chatService.setOnRuntimeClose((sessionId) => this.notifyRuntimeClosed(sessionId));
    diagLog('[WebSocket] server attached on /ws');
  }

  private handleConnection(socket: WebSocket): void {
    diagLog('[WebSocket] client connected');
    const ctx: ClientContext = { socket, subscriptions: new Map() };
    this.clients.set(socket, ctx);

    socket.on('message', (raw) => this.handleMessage(ctx, raw));
    socket.on('close', () => this.handleDisconnect(ctx));
    socket.on('error', (err) => diagWarn(`[WebSocket] client error: ${err.message}`));
  }

  private handleDisconnect(ctx: ClientContext): void {
    diagLog('[WebSocket] client disconnected');
    void gitChangesService.unsubscribeSocket(ctx.socket);
    browserStateChannel.unsubscribeSocket(ctx.socket);
    for (const [sessionId, workspaceId] of ctx.subscriptions) {
      this.unsubscribe(ctx, workspaceId, sessionId);
    }
    this.clients.delete(ctx.socket);
  }

  private handleMessage(ctx: ClientContext, raw: RawData): void {
    let req: WsRequest;
    try {
      req = JSON.parse(raw.toString()) as WsRequest;
      if (!req.id || !req.type) throw new Error('missing id or type');
    } catch (err) {
      this.sendError(ctx.socket, '', {
        message: err instanceof Error ? err.message : 'Invalid JSON',
      });
      return;
    }

    void this.routeRequest(ctx, req);
  }

  private async routeRequest(ctx: ClientContext, req: WsRequest): Promise<void> {
    try {
      switch (req.type) {
        case 'subscribe':
          await this.handleSubscribe(ctx, req);
          break;
        case 'unsubscribe':
          await this.handleUnsubscribe(ctx, req);
          break;
        case 'status':
          await this.handleStatus(ctx, req);
          break;
        case 'sendMessage':
          await this.handleSendMessage(ctx, req);
          break;
        case 'loadMessages':
          await this.handleLoadMessages(ctx, req);
          break;
        case 'loadMessagesAfter':
          await this.handleLoadMessagesAfter(ctx, req);
          break;
        case 'subscribeGitChanges':
          await this.handleSubscribeGitChanges(ctx, req);
          break;
        case 'unsubscribeGitChanges':
          await this.handleUnsubscribeGitChanges(ctx, req);
          break;
        case 'subscribeBrowserState':
          this.handleSubscribeBrowserState(ctx, req);
          break;
        case 'unsubscribeBrowserState':
          this.handleUnsubscribeBrowserState(ctx, req);
          break;
        case 'browserTakeover':
          this.handleBrowserTakeover(ctx, req);
          break;
        case 'browserHandback':
          this.handleBrowserHandback(ctx, req);
          break;
        case 'browserActivityPing':
          this.handleBrowserActivityPing(ctx, req);
          break;
        default: {
          const _exhaustive: never = req.type;
          void _exhaustive;
          throw new Error(`Unknown request type: ${(req as WsRequest).type}`);
        }
      }
    } catch (err) {
      diagWarn(`[WebSocket] request ${req.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      this.sendError(ctx.socket, req.id, {
        message: err instanceof Error ? err.message : 'Internal error',
      });
    }
  }

  private async handleSubscribe(ctx: ClientContext, req: WsRequest): Promise<void> {
    const { workspaceId, sessionId, lastEventId } = req.payload as unknown as SubscribePayload;
    const startedAt = Date.now();
    diagLog(`[WebSocket] subscribe request received sessionId=${sessionId} workspaceId=${workspaceId}`);

    const runtime = await chatService.getOrCreateRuntime(sessionId, workspaceId);
    diagLog(`[WebSocket] subscribe runtime ready sessionId=${sessionId} elapsed=${Date.now() - startedAt}ms`);

    // Register client subscription context
    ctx.subscriptions.set(sessionId, workspaceId);

    // Subscribe to runtime events through an in-memory callback.
    let unsubscribersBySession = this.runtimeEventUnsubscribers.get(sessionId);
    if (!unsubscribersBySession) {
      unsubscribersBySession = new Map();
      this.runtimeEventUnsubscribers.set(sessionId, unsubscribersBySession);
    }

    // Remove any existing subscriber for this socket/session to avoid duplicates.
    const existing = unsubscribersBySession.get(ctx.socket);
    if (existing) {
      existing();
    }

    const handler = (id: number, event: SseEvent): void => {
      const msg: WsEventMessage = {
        type: 'event',
        eventType: 'sse',
        sessionId,
        workspaceId,
        data: event,
        eventId: String(id),
      };
      this.sendEvent(ctx.socket, msg);
    };

    runtime.subscribeWebSocket(handler, lastEventId);
    unsubscribersBySession.set(ctx.socket, () => runtime.unsubscribeWebSocket(handler));

    this.sendOk(ctx.socket, req.id, { subscribed: true });
    diagLog(`[WebSocket] subscribe response sent sessionId=${sessionId} elapsed=${Date.now() - startedAt}ms`);
  }

  private async handleUnsubscribe(ctx: ClientContext, req: WsRequest): Promise<void> {
    const { workspaceId, sessionId } = req.payload as unknown as UnsubscribePayload;
    this.unsubscribe(ctx, workspaceId, sessionId);
    await gitChangesService.unsubscribe(workspaceId, ctx.socket);
    this.sendOk(ctx.socket, req.id, { unsubscribed: true });
  }

  private unsubscribe(ctx: ClientContext, _workspaceId: string, sessionId: string): void {
    ctx.subscriptions.delete(sessionId);

    const unsubscribersBySession = this.runtimeEventUnsubscribers.get(sessionId);
    if (unsubscribersBySession) {
      const unsub = unsubscribersBySession.get(ctx.socket);
      if (unsub) {
        unsub();
        unsubscribersBySession.delete(ctx.socket);
      }
      if (unsubscribersBySession.size === 0) {
        this.runtimeEventUnsubscribers.delete(sessionId);
      }
    }
  }

  private notifyRuntimeClosed(sessionId: string): void {
    const unsubscribersBySession = this.runtimeEventUnsubscribers.get(sessionId);
    if (!unsubscribersBySession) return;

    for (const [socket, unsub] of unsubscribersBySession) {
      const ctx = this.clients.get(socket);
      if (!ctx) continue;
      const workspaceId = ctx.subscriptions.get(sessionId);
      if (!workspaceId) continue;

      this.sendEvent(socket, {
        type: 'event',
        eventType: 'runtime_closed',
        sessionId,
        workspaceId,
        data: {},
      });

      // The runtime is gone; remove the stale handler so a future subscribe
      // creates a fresh binding instead of being treated as a duplicate.
      unsub();
      ctx.subscriptions.delete(sessionId);
    }
    this.runtimeEventUnsubscribers.delete(sessionId);
  }

  private async handleStatus(ctx: ClientContext, req: WsRequest): Promise<void> {
    const { workspaceId } = req.payload as unknown as StatusPayload;
    const statuses = chatService.getSessionsStatus(workspaceId);
    const result: StatusResult = { statuses };
    this.sendOk(ctx.socket, req.id, result);
  }

  private async handleSendMessage(ctx: ClientContext, req: WsRequest): Promise<void> {
    const { workspaceId, sessionId, content } = req.payload as unknown as SendMessagePayload;
    await chatService.pushMessage(sessionId, workspaceId, content);
    this.sendOk(ctx.socket, req.id, { sent: true });
  }

  private async handleLoadMessages(ctx: ClientContext, req: WsRequest): Promise<void> {
    const { workspaceId, sessionId, offset, limit } = req.payload as unknown as LoadMessagesPayload;
    const { messages, tasks, subagents, workflows } = await chatService.loadMessages(
      sessionId,
      workspaceId,
      offset,
      limit,
    );
    this.sendOk(ctx.socket, req.id, { messages, tasks, subagents, workflows });
  }

  private async handleLoadMessagesAfter(ctx: ClientContext, req: WsRequest): Promise<void> {
    const { workspaceId, sessionId, afterMessageId } = req.payload as unknown as LoadMessagesAfterPayload;
    const { messages, tasks, subagents, workflows } = await chatService.loadMessagesAfter(
      sessionId,
      workspaceId,
      afterMessageId,
    );
    this.sendOk(ctx.socket, req.id, { messages, tasks, subagents, workflows });
  }

  private async handleSubscribeGitChanges(ctx: ClientContext, req: WsRequest): Promise<void> {
    const { workspaceId } = req.payload as unknown as SubscribeGitChangesPayload;
    await gitChangesService.subscribe(workspaceId, ctx.socket);
    this.sendOk(ctx.socket, req.id, { subscribed: true });
  }

  private async handleUnsubscribeGitChanges(ctx: ClientContext, req: WsRequest): Promise<void> {
    const { workspaceId } = req.payload as unknown as UnsubscribeGitChangesPayload;
    // Await watcher teardown before acknowledging, so a follow-up subscribe
    // for the same workspace cannot race the prior closeWatcher().
    await gitChangesService.unsubscribe(workspaceId, ctx.socket);
    this.sendOk(ctx.socket, req.id, { unsubscribed: true });
  }

  // -------------------------------------------------------------------------
  // browser_state channel (U5, KTD-9): sessionId-keyed, passive — subscribing
  // never creates a runtime or a browser session.
  // -------------------------------------------------------------------------

  private handleSubscribeBrowserState(ctx: ClientContext, req: WsRequest): void {
    const { workspaceId, sessionId } = req.payload as unknown as SubscribeBrowserStatePayload;
    if (!workspaceId || !sessionId) {
      throw new Error('subscribeBrowserState requires workspaceId and sessionId');
    }
    browserStateChannel.subscribe(sessionId, workspaceId, ctx.socket);
    this.sendOk(ctx.socket, req.id, { subscribed: true });
  }

  private handleUnsubscribeBrowserState(ctx: ClientContext, req: WsRequest): void {
    const { sessionId } = req.payload as unknown as UnsubscribeBrowserStatePayload;
    if (!sessionId) {
      throw new Error('unsubscribeBrowserState requires sessionId');
    }
    browserStateChannel.unsubscribe(sessionId, ctx.socket);
    this.sendOk(ctx.socket, req.id, { unsubscribed: true });
  }

  private handleBrowserTakeover(ctx: ClientContext, req: WsRequest): void {
    const { sessionId } = req.payload as unknown as BrowserTakeoverPayload;
    if (!sessionId) {
      throw new Error('browserTakeover requires sessionId');
    }
    const result = browserControlService.takeover(sessionId);
    if (!result.ok) {
      this.sendError(ctx.socket, req.id, {
        message: result.message ?? 'Takeover unavailable',
        ...(result.code !== undefined && { code: result.code }),
      });
      return;
    }
    this.sendOk(ctx.socket, req.id, { takenOver: true });
  }

  private handleBrowserHandback(ctx: ClientContext, req: WsRequest): void {
    const { sessionId } = req.payload as unknown as BrowserHandbackPayload;
    if (!sessionId) {
      throw new Error('browserHandback requires sessionId');
    }
    const result = browserControlService.handback(sessionId);
    if (!result.ok) {
      this.sendError(ctx.socket, req.id, {
        message: result.message ?? 'Handback unavailable',
        ...(result.code !== undefined && { code: result.code }),
      });
      return;
    }
    this.sendOk(ctx.socket, req.id, { handedBack: true });
  }

  private handleBrowserActivityPing(ctx: ClientContext, req: WsRequest): void {
    const { sessionId } = req.payload as unknown as BrowserActivityPingPayload;
    if (!sessionId) {
      throw new Error('browserActivityPing requires sessionId');
    }
    // Content-free: only the server-fixed handoff timer is reset (KTD-6).
    browserControlService.recordActivity(sessionId);
    this.sendOk(ctx.socket, req.id, { ok: true });
  }

  private sendOk(socket: WebSocket, id: string, payload: unknown): void {
    const msg: WsResponse = { id, ok: true, payload };
    this.send(socket, msg);
  }

  private sendError(socket: WebSocket, id: string, error: { message: string; code?: string }): void {
    const msg: WsErrorResponse = { id, ok: false, error };
    this.send(socket, msg);
  }

  private sendEvent(socket: WebSocket, event: WsEventMessage): void {
    this.send(socket, event);
  }

  private send(socket: WebSocket, msg: WsResponse | WsErrorResponse | WsEventMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(msg));
  }
}
