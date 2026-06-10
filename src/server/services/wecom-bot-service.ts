import AiBot from '@wecom/aibot-node-sdk';
import type { WSClient, WsFrame, TextMessage } from '@wecom/aibot-node-sdk';
import fs from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../models/workspace.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { chatService } from './chat-service.js';
import type { SseEvent } from '../types/message.js';
import { SKILL_MD } from '../assets/wecom-skill.js';
import { debounce } from '../utils/debounce.js';
import { wecomUserResolver } from './wecom-user-resolver.js';
import { wecomSessionRenamer } from './wecom-session-renamer.js';

interface BotConnection {
  client: WSClient;
  workspaceId: string;
  botId: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
}

export class WeComBotService {
  private connections = new Map<string, BotConnection>();
  private botIdToWorkspaceId = new Map<string, string>();
  private serverUrl: string | null = null;

  setServerUrl(url: string): void {
    this.serverUrl = url;
  }

  async initialize(): Promise<void> {
    await this.cleanupStaleContextFiles();
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

    if (this.botIdToWorkspaceId.has(botId)) {
      console.error(`WeCom bot ID ${botId} is already in use by workspace ${this.botIdToWorkspaceId.get(botId)}. Skipping connect for workspace ${workspace.id}.`);
      return;
    }

    const client = new AiBot.WSClient({
      botId,
      secret,
      maxReconnectAttempts: -1,
    });

    const conn: BotConnection = {
      client,
      workspaceId: workspace.id,
      botId,
      status: 'connecting',
    };

    this.connections.set(workspace.id, conn);

    client.on('authenticated', () => {
      conn.status = 'connected';
      this.botIdToWorkspaceId.set(botId, workspace.id);
      this.writeContextFile(workspace, botId).catch((err) => {
        console.warn(`Failed to write WeCom context file for workspace ${workspace.id}:`, err);
      });
      this.writeSkillFiles(workspace).catch((err) => {
        console.warn(`Failed to write WeCom skill files for workspace ${workspace.id}:`, err);
      });
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
    this.botIdToWorkspaceId.delete(conn.botId);
    this.removeContextFile(workspaceId).catch((err) => {
      console.warn(`Failed to remove WeCom context file for workspace ${workspaceId}:`, err);
    });
    this.removeSkillFiles(workspaceId).catch((err) => {
      console.warn(`Failed to remove WeCom skill files for workspace ${workspaceId}:`, err);
    });
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

  async getAggregateStatus(): Promise<{
    state: 'connected' | 'partial' | 'disconnected' | 'not_configured';
  }> {
    let workspaces: Workspace[];
    try {
      workspaces = await workspaceStore.list();
    } catch {
      return { state: 'not_configured' };
    }

    const configured = workspaces.filter(
      (ws) =>
        ws.settings.wecomBotEnabled &&
        ws.settings.wecomBotId &&
        ws.settings.wecomBotSecret,
    );
    if (configured.length === 0) return { state: 'not_configured' };

    let connectedCount = 0;
    for (const ws of configured) {
      if (this.getStatus(ws.id) === 'connected') connectedCount += 1;
    }
    if (connectedCount === configured.length) return { state: 'connected' };
    if (connectedCount === 0) return { state: 'disconnected' };
    return { state: 'partial' };
  }

  private async handleTextMessage(workspaceId: string, frame: WsFrame<TextMessage>): Promise<void> {
    if (!frame.body) return;
    const wecomUserId = frame.body.from.userid;
    const content = frame.body.text.content;

    // Fire-and-forget: queue unseen user IDs for batch resolution
    wecomUserResolver.resolveOnMessage(workspaceId, wecomUserId).catch(() => {
      // Ignore: resolver failures degrade gracefully to encrypted ID usage
    });

    // Track that this user has interacted with this workspace
    wecomUserResolver.trackWorkspaceUser(workspaceId, wecomUserId);

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
        source: 'wecom',
      });
      sessionId = session.id;
      workspaceStore.setWecomSession(workspaceId, wecomUserId, sessionId);

      // If the plaintext ID is already known, trigger rename for all sessions of this user
      const plaintextUserId = workspaceStore.getWecomUserMapping(wecomUserId);
      if (plaintextUserId) {
        wecomSessionRenamer.renameSessionsForUser(workspaceId, wecomUserId).catch((err) => {
          console.error('[WeComBotService] Failed to rename sessions after creation:', err);
        });
      }
    }

    const conn = this.connections.get(workspaceId);
    if (!conn) return;

    const streamId = `${sessionId}-${Date.now()}`;

    let responseText = '';
    let collecting = false;
    let streamFinalized = false;
    let animationInterval: NodeJS.Timeout | null = null;
    let currentPlaceholder: string | null = null;
    let placeholderAnimationInterval: NodeJS.Timeout | null = null;

    const stopAnimation = () => {
      if (animationInterval) {
        clearInterval(animationInterval);
        animationInterval = null;
      }
    };

    const stopPlaceholderAnimation = () => {
      if (placeholderAnimationInterval) {
        clearInterval(placeholderAnimationInterval);
        placeholderAnimationInterval = null;
      }
    };

    const clearPlaceholder = () => {
      stopPlaceholderAnimation();
      if (currentPlaceholder) {
        if (responseText.endsWith(currentPlaceholder)) {
          responseText = responseText.slice(0, -currentPlaceholder.length);
        } else {
          const idx = responseText.lastIndexOf(currentPlaceholder);
          if (idx >= 0) {
            responseText = responseText.slice(0, idx) + responseText.slice(idx + currentPlaceholder.length);
          }
        }
        currentPlaceholder = null;
      }
    };

    // Start a cycling placeholder animation until the first token arrives
    let dotCount = 0;
    const sendAnimationFrame = () => {
      dotCount = (dotCount + 1) % 3;
      const text = `收到，正在处理中${'.'.repeat(dotCount + 1)}`;
      conn.client.replyStreamNonBlocking(frame, streamId, text, false).catch((err) => {
        console.error('Failed to send WeCom animation frame:', err);
      });
    };

    conn.client.replyStream(frame, streamId, '收到，正在处理中.', false).catch((err) => {
      console.error('Failed to send WeCom processing placeholder:', err);
    });
    animationInterval = setInterval(sendAnimationFrame, 600);

    const flushStream = debounce(() => {
      if (!responseText) return;
      conn!.client.replyStreamNonBlocking(frame, streamId, responseText).catch((err) => {
        console.error('Failed to send WeCom stream frame:', err);
      });
    }, 150);

    const setPlaceholder = (text: string, animate: boolean = false) => {
      clearPlaceholder();
      currentPlaceholder = text;
      responseText += text;
      flushStream.flush();
      if (animate) {
        const baseText = text.replace(/\.*$/, '');
        let dotCount = 0;
        const myPlaceholder = text;
        placeholderAnimationInterval = setInterval(() => {
          if (currentPlaceholder !== myPlaceholder) return;
          dotCount = (dotCount + 1) % 3;
          const newPlaceholder = `${baseText}${'.'.repeat(dotCount + 1)}`;
          if (responseText.endsWith(currentPlaceholder)) {
            responseText = responseText.slice(0, -currentPlaceholder.length) + newPlaceholder;
          } else {
            const idx = responseText.lastIndexOf(currentPlaceholder);
            if (idx < 0) return;
            responseText = responseText.slice(0, idx) + newPlaceholder + responseText.slice(idx + currentPlaceholder.length);
          }
          currentPlaceholder = newPlaceholder;
          conn!.client.replyStreamNonBlocking(frame, streamId, responseText).catch((err) => {
            console.error('Failed to send WeCom placeholder animation frame:', err);
          });
        }, 600);
      }
    };

    const finalizeStream = () => {
      streamFinalized = true;
      collecting = false;
      stopAnimation();
      stopPlaceholderAnimation();
      flushStream.abort();

      conn!.client.replyStream(frame, streamId, responseText, true).catch((err) => {
        console.error('Failed to send WeCom stream final frame:', err);
        if (responseText.trim()) {
          conn!.client.sendMessage(wecomUserId, {
            msgtype: 'markdown',
            markdown: { content: responseText },
          }).catch((fallbackErr) => {
            console.error('Failed to send WeCom fallback response:', fallbackErr);
          });
        }
      });
    };

    const handler = (id: number, event: SseEvent) => {
      if (streamFinalized) return;

      if (event.type === 'assistant_start') {
        collecting = true;
        clearPlaceholder();
        if (responseText && !responseText.endsWith('\n\n')) {
          responseText += '\n\n';
        }
      } else if (collecting && event.type === 'text_delta') {
        stopAnimation();
        clearPlaceholder();
        responseText += event.text;
        flushStream();
      } else if (collecting && event.type === 'thinking_start') {
        setPlaceholder('\n\n收到，正在处理中.', true);
      } else if (collecting && event.type === 'tool_use_start') {
        clearPlaceholder();
        setPlaceholder(`\n\n🔧 ${event.toolName}...`, false);
      } else if (event.type === 'tool_result') {
        clearPlaceholder();
      } else if (event.type === 'subagent_start') {
        clearPlaceholder();
        setPlaceholder(`\n\n🤖 ${event.description ?? 'Running subagent'}...`, false);
      } else if (event.type === 'subagent_done') {
        clearPlaceholder();
      } else if (collecting && event.type === 'assistant_done') {
        collecting = false;
        stopAnimation();
        if (currentPlaceholder && currentPlaceholder.includes('收到，正在处理中')) {
          clearPlaceholder();
        }
        flushStream.flush();
      } else if (event.type === 'error_note') {
        clearPlaceholder();
        if (event.text) {
          responseText += `\n\n⚠️ ${event.text}`;
        }
        finalizeStream();
      } else if (event.type === 'result') {
        clearPlaceholder();
        if (event.isError) {
          responseText += '\n\n⚠️ 处理失败，请稍后重试。';
        }
        finalizeStream();
      } else if (event.type === 'interrupted') {
        clearPlaceholder();
        finalizeStream();
      }
    };

    const runtime = await chatService.getOrCreateRuntime(sessionId, workspaceId, true, handler);
    runtime.pushMessage(content);
  }

  getWorkspaceIdByBotId(botId: string): string | undefined {
    return this.botIdToWorkspaceId.get(botId);
  }

  async sendProactiveMessage(botId: string, toUser: string, message: string): Promise<void> {
    const workspaceId = this.botIdToWorkspaceId.get(botId);
    if (!workspaceId) {
      throw new Error(`Unknown bot ID: ${botId}`);
    }
    const conn = this.connections.get(workspaceId);
    if (!conn || conn.status !== 'connected') {
      throw new Error(`Bot ${botId} is not connected`);
    }
    await conn.client.sendMessage(toUser, {
      msgtype: 'markdown',
      markdown: { content: message },
    });
  }

  private getContextFilePath(workspace: Workspace): string {
    return path.join(workspace.folderPath, '.claude', 'wecom-context.json');
  }

  private async writeContextFile(workspace: Workspace, botId: string): Promise<void> {
    if (!this.serverUrl) return;
    const filePath = this.getContextFilePath(workspace);
    const dir = path.dirname(filePath);
    const resolvedDir = path.resolve(dir);
    const resolvedBase = path.resolve(workspace.folderPath);
    if (!resolvedDir.startsWith(resolvedBase)) {
      throw new Error('Context file path is outside workspace directory');
    }
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const content = JSON.stringify({ botId, serverUrl: this.serverUrl }, null, 2);
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  private async removeContextFile(workspaceId: string): Promise<void> {
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) return;
    const filePath = this.getContextFilePath(workspace);
    const resolvedFile = path.resolve(filePath);
    const resolvedBase = path.resolve(workspace.folderPath);
    if (!resolvedFile.startsWith(resolvedBase)) {
      return;
    }
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  private async cleanupStaleContextFiles(): Promise<void> {
    const workspaces = await workspaceStore.list();
    for (const ws of workspaces) {
      const filePath = this.getContextFilePath(ws);
      const resolvedFile = path.resolve(filePath);
      const resolvedBase = path.resolve(ws.folderPath);
      if (!resolvedFile.startsWith(resolvedBase)) {
        continue;
      }
      if (!fs.existsSync(filePath)) continue;
      const botId = ws.settings.wecomBotId;
      if (!botId || !this.botIdToWorkspaceId.has(botId)) {
        try {
          fs.unlinkSync(filePath);
          console.log(`Cleaned up stale WeCom context file for workspace ${ws.id}`);
        } catch (err) {
          console.warn(`Failed to clean up stale context file for workspace ${ws.id}:`, err);
        }
      }
    }
  }

  private async writeSkillFiles(workspace: Workspace): Promise<void> {
    const claudeDir = path.join(workspace.folderPath, '.claude');
    const skillsDir = path.join(claudeDir, 'skills', 'send-wecom-message');

    const resolvedClaudeDir = path.resolve(claudeDir);
    const resolvedBase = path.resolve(workspace.folderPath);
    if (!resolvedClaudeDir.startsWith(resolvedBase)) {
      throw new Error('Skill file path is outside workspace directory');
    }

    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), SKILL_MD, 'utf-8');
  }

  private async removeSkillFiles(workspaceId: string): Promise<void> {
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) return;

    const skillFile = path.join(workspace.folderPath, '.claude', 'skills', 'send-wecom-message', 'SKILL.md');
    const resolvedBase = path.resolve(workspace.folderPath);
    const resolvedFile = path.resolve(skillFile);
    if (!resolvedFile.startsWith(resolvedBase)) return;
    if (fs.existsSync(skillFile)) {
      try {
        fs.unlinkSync(skillFile);
      } catch {
        // ignore
      }
    }
  }
}

export const wecomBotService = new WeComBotService();
