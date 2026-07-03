import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { Server } from 'http';
import { diagLog, diagWarn } from '../utils/diag-logger.js';
import { chatService } from '../services/chat-service.js';
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

  attach(server: Server): void {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (socket) => this.handleConnection(socket));
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

    const runtime = await chatService.getOrCreateRuntime(sessionId, workspaceId);

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
    unsubscribersBySession.set(ctx.socket, () => runtime.removeWebEventHandler(handler));

    this.sendOk(ctx.socket, req.id, { subscribed: true });
  }

  private async handleUnsubscribe(ctx: ClientContext, req: WsRequest): Promise<void> {
    const { workspaceId, sessionId } = req.payload as unknown as UnsubscribePayload;
    this.unsubscribe(ctx, workspaceId, sessionId);
    this.sendOk(ctx.socket, req.id, { unsubscribed: true });
  }

  private unsubscribe(ctx: ClientContext, workspaceId: string, sessionId: string): void {
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

    const runtime = chatService.getRuntimeIfExists(sessionId);
    if (runtime) {
      runtime.unsubscribe();
    }
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
    const { messages, tasks, subagents } = await chatService.loadMessages(
      sessionId,
      workspaceId,
      offset,
      limit,
    );
    this.sendOk(ctx.socket, req.id, { messages, tasks, subagents });
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
