import AiBot from '@wecom/aibot-node-sdk';
import type { WSClient, WsFrame, TextMessage } from '@wecom/aibot-node-sdk';
import type { Workspace } from '../models/workspace.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { chatService } from './chat-service.js';
import type { SseEvent } from '../types/message.js';

interface BotConnection {
  client: WSClient;
  workspaceId: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
}

export class WeComBotService {
  private connections = new Map<string, BotConnection>();

  async initialize(): Promise<void> {
    const workspaces = await workspaceStore.list();
    for (const ws of workspaces) {
      if (ws.settings.wecomBotEnabled && ws.settings.wecomBotId && ws.settings.wecomBotSecret) {
        this.connect(ws);
      }
    }
  }

  connect(workspace: Workspace): void {
    this.disconnect(workspace.id);

    const botId = workspace.settings.wecomBotId!;
    const secret = workspace.settings.wecomBotSecret!;

    const client = new AiBot.WSClient({
      botId,
      secret,
      maxReconnectAttempts: -1,
    });

    const conn: BotConnection = {
      client,
      workspaceId: workspace.id,
      status: 'connecting',
    };

    this.connections.set(workspace.id, conn);

    client.on('authenticated', () => {
      conn.status = 'connected';
    });

    client.on('disconnected', (reason) => {
      conn.status = 'disconnected';
      console.log(`WeCom bot disconnected for workspace ${workspace.id}: ${reason}`);
    });

    client.on('error', (err) => {
      conn.status = 'error';
      console.error(`WeCom bot error for workspace ${workspace.id}:`, err);
    });

    client.on('message.text', (frame: WsFrame<TextMessage>) => {
      this.handleTextMessage(workspace.id, frame).catch((err) => {
        console.error('Failed to handle WeCom text message:', err);
      });
    });

    client.connect();
  }

  disconnect(workspaceId: string): void {
    const conn = this.connections.get(workspaceId);
    if (!conn) return;
    conn.client.disconnect();
    this.connections.delete(workspaceId);
  }

  disconnectAll(): void {
    for (const [workspaceId] of this.connections) {
      this.disconnect(workspaceId);
    }
  }

  getStatus(workspaceId: string): 'connected' | 'disconnected' | 'error' | 'not_configured' {
    const conn = this.connections.get(workspaceId);
    if (!conn) return 'not_configured';
    if (conn.status === 'connecting') return 'disconnected';
    return conn.status;
  }

  private async handleTextMessage(workspaceId: string, frame: WsFrame<TextMessage>): Promise<void> {
    if (!frame.body) return;
    const wecomUserId = frame.body.from.userid;
    const content = frame.body.text.content;

    let sessionId = workspaceStore.getWecomSession(workspaceId, wecomUserId);

    if (sessionId) {
      // Verify the session still exists
      const session = await chatService.getSession(sessionId, workspaceId);
      if (!session) {
        sessionId = null;
      }
    }

    if (!sessionId) {
      const session = await chatService.createSession({
        workspaceId,
        name: wecomUserId,
      });
      sessionId = session.id;
      workspaceStore.setWecomSession(workspaceId, wecomUserId, sessionId);
    }

    const conn = this.connections.get(workspaceId);
    if (!conn) return;

    let responseText = '';
    let collecting = false;

    const handler = (id: number, event: SseEvent) => {
      if (event.type === 'assistant_start') {
        responseText = '';
        collecting = true;
      } else if (collecting && event.type === 'text_delta') {
        responseText += event.text;
      } else if (
        collecting &&
        (event.type === 'assistant_done' || event.type === 'error_note' || event.type === 'interrupted')
      ) {
        collecting = false;
        this.sendResponse(conn!, wecomUserId, responseText).catch((err) => {
          console.error('Failed to send WeCom response:', err);
        });
      }
    };

    const runtime = await chatService.getOrCreateRuntime(sessionId, workspaceId, true, handler);
    runtime.pushMessage(content);
  }

  private async sendResponse(conn: BotConnection, wecomUserId: string, text: string): Promise<void> {
    if (!text.trim()) return;
    await conn.client.sendMessage(wecomUserId, {
      msgtype: 'markdown',
      markdown: { content: text },
    });
  }
}

export const wecomBotService = new WeComBotService();
