import type {
  WsMessage,
  WsRequest,
  WsRequestType,
  WsResponse,
  WsErrorResponse,
  WsEventMessage,
} from '@server/websocket/types';
import { getWebSocketUrl } from './tauri-api.js';

export type WsEventListener = (event: WsEventMessage) => void;
export type WsReconnectListener = () => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export const DEFAULT_TIMEOUT = 30000;
const BASE_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;

class WebSocketClient {
  private socket: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private eventListeners = new Set<WsEventListener>();
  private reconnectListeners = new Set<WsReconnectListener>();
  private reconnectDelay = BASE_RECONNECT_DELAY;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private intentionalClose = false;
  private messageQueue: WsRequest[] = [];
  private connecting = false;

  async connect(): Promise<void> {
    if (this.socket || this.connecting) return;
    this.connecting = true;
    this.intentionalClose = false;

    const url = await getWebSocketUrl();
    if (!url) {
      this.connecting = false;
      throw new Error('WebSocket URL not available');
    }

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;

      socket.onopen = () => {
        this.connecting = false;
        this.reconnectDelay = BASE_RECONNECT_DELAY;
        this.flushQueue();
        for (const listener of this.reconnectListeners) {
          listener();
        }
        resolve();
      };

      socket.onmessage = (evt) => {
        this.handleMessage(evt.data as string);
      };

      socket.onclose = () => {
        this.socket = null;
        this.connecting = false;
        if (!this.intentionalClose) {
          this.scheduleReconnect();
        }
        reject(new Error('WebSocket closed before open'));
      };

      socket.onerror = () => {
        this.connecting = false;
      };
    });
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    for (const { reject, timer } of this.pending.values()) {
      if (timer) clearTimeout(timer);
      reject(new Error('WebSocket disconnected'));
    }
    this.pending.clear();
    this.socket?.close();
    this.socket = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.intentionalClose) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }

  request(type: WsRequestType, payload: Record<string, unknown>, timeout = DEFAULT_TIMEOUT): Promise<unknown> {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const req: WsRequest = { id, type, payload };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`WebSocket request timeout: ${type}`));
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });

      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify(req));
      } else {
        this.messageQueue.push(req);
        void this.connect().catch((err) => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            clearTimeout(timer);
            reject(err);
          }
        });
      }
    });
  }

  private flushQueue(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    while (this.messageQueue.length > 0) {
      const req = this.messageQueue.shift();
      if (req) this.socket.send(JSON.stringify(req));
    }
  }

  private handleMessage(raw: string): void {
    let msg: WsMessage;
    try {
      msg = JSON.parse(raw) as WsMessage;
    } catch {
      return;
    }

    if ('id' in msg && 'ok' in msg) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      if (pending.timer) clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      if (msg.ok) {
        pending.resolve((msg as WsResponse).payload);
      } else {
        const errMsg = (msg as WsErrorResponse).error;
        pending.reject(new Error(errMsg.message));
      }
      return;
    }

    if (msg.type === 'event') {
      for (const listener of this.eventListeners) {
        listener(msg);
      }
    }
  }

  onEvent(listener: WsEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onReconnect(listener: WsReconnectListener): () => void {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }
}

export const wsClient = new WebSocketClient();
