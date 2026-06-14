import AiBot from '@wecom/aibot-node-sdk';
import type { WSClient, WsFrame, TextMessage, FileMessage, ImageMessage, VoiceMessage, VideoMessage, BaseMessage } from '@wecom/aibot-node-sdk';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { Workspace } from '../models/workspace.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { chatService } from './chat-service.js';
import { wecomUserResolver } from './wecom-user-resolver.js';
import { wecomSessionRenamer } from './wecom-session-renamer.js';
import { createStreamReply, type StreamReplyResult } from './wecom-stream-reply.js';
import { saveMediaFile } from './wecom-file-storage.js';
import { REPLY_TOOL_NAME, evaluateToolPermission, resolveEffectivePolicy } from './tool-permission-policy.js';

/**
 * Resolve the stream-reply handler for an inbound WeCom message, honoring the
 * workspace's Reply-category permission.
 *
 * - If Reply is allowed (the default in SAFE_PRESET), constructs the stream
 *   reply and returns it; the caller passes `result.handler` to pushMessage.
 * - If Reply is denied, returns undefined. The caller still calls pushMessage
 *   so the agent runs (per R11/AE6), but no reply is sent to WeCom — and
 *   crucially, no placeholder frame leaks, and no Claude tokens are spent
 *   producing text the user will never see (because the stream reply's
 *   placeholder animation never fires).
 *
 * The workspace is read once per inbound message; if absent, defaults to
 * allowing Reply (defensive — should not happen for bot-enabled workspaces).
 */
async function resolveStreamReplyIfNeeded(
  workspaceId: string,
  conn: { client: unknown },
  frame: WsFrame<any>,
  sessionId: string,
  wecomUserId: string,
): Promise<StreamReplyResult | undefined> {
  const workspace = await workspaceStore.get(workspaceId);
  if (!workspace) return undefined;
  const policy = resolveEffectivePolicy(workspace).policy;
  if (evaluateToolPermission(policy, REPLY_TOOL_NAME) === 'deny') {
    return undefined;
  }
  return createStreamReply(conn as any, frame, sessionId, wecomUserId);
}

export interface BotConnection {
  client: WSClient;
  workspaceId: string;
  botId: string;
  folderPath: string;
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
      folderPath: workspace.folderPath,
      status: 'connecting',
    };

    this.connections.set(workspace.id, conn);

    client.on('authenticated', () => {
      conn.status = 'connected';
      this.botIdToWorkspaceId.set(botId, workspace.id);
      this.writeContextFile(workspace, botId).catch((err) => {
        console.warn(`Failed to write WeCom context file for workspace ${workspace.id}:`, err);
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

    client.on('message.file', (frame: WsFrame<FileMessage>) => {
      this.handleMediaMessage(workspace.id, frame).catch((err) => {
        console.error('Failed to handle WeCom file message:', err);
      });
    });

    client.on('message.image', (frame: WsFrame<ImageMessage>) => {
      this.handleMediaMessage(workspace.id, frame).catch((err) => {
        console.error('Failed to handle WeCom image message:', err);
      });
    });

    client.on('message.voice', (frame: WsFrame<VoiceMessage>) => {
      this.handleMediaMessage(workspace.id, frame).catch((err) => {
        console.error('Failed to handle WeCom voice message:', err);
      });
    });

    client.on('message.video', (frame: WsFrame<VideoMessage>) => {
      this.handleMediaMessage(workspace.id, frame).catch((err) => {
        console.error('Failed to handle WeCom video message:', err);
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

    const sessionId = await this.getOrCreateSession(workspaceId, wecomUserId);
    if (!sessionId) return;

    const conn = this.connections.get(workspaceId);
    if (!conn) return;

    const streamReply = await resolveStreamReplyIfNeeded(workspaceId, conn, frame, sessionId, wecomUserId);

    await chatService.pushMessage(sessionId, workspaceId, content, true, streamReply?.handler);
  }

  private async handleMediaMessage(workspaceId: string, frame: WsFrame<BaseMessage>): Promise<void> {
    if (!frame.body) return;
    const wecomUserId = frame.body.from.userid;
    const msgtype = frame.body.msgtype;

    // Fire-and-forget: queue unseen user IDs for batch resolution
    wecomUserResolver.resolveOnMessage(workspaceId, wecomUserId).catch(() => {});
    wecomUserResolver.trackWorkspaceUser(workspaceId, wecomUserId);

    const conn = this.connections.get(workspaceId);
    if (!conn) return;

    try {
      // Voice messages only have a text transcription (no download URL)
      if (msgtype === 'voice') {
        const voiceContent = frame.body.voice?.content;
        if (!voiceContent) {
          // Voice message with no transcription — notify user
          await conn.client.sendMessage(wecomUserId, {
            msgtype: 'markdown',
            markdown: { content: '⚠️ 语音消息无法识别，请重试。' },
          });
          return;
        }

        // Look up or create session
        const sessionId = await this.getOrCreateSession(workspaceId, wecomUserId);
        if (!sessionId) return;

        const streamReply = await resolveStreamReplyIfNeeded(workspaceId, conn, frame, sessionId, wecomUserId);
        const prompt = `a voice message transcribed as: "${voiceContent}" uploaded by ${wecomUserId}, if there is skill can process this content, process it with that skill, if no proper skill find, ask user how to handle it.`;
        try {
          await chatService.pushMessage(sessionId, workspaceId, prompt, true, streamReply?.handler);
        } catch (err) {
          streamReply?.handler.cleanup();
          throw err;
        }
        return;
      }

      // Downloadable media: file, image, video
      const mediaInfo = this.extractMediaInfo(frame.body);
      if (!mediaInfo) {
        console.warn(`[WeComBotService] No downloadable media found in ${msgtype} message from ${wecomUserId}`);
        return;
      }

      const { url, aesKey } = mediaInfo;
      const { buffer, filename: sdkFilename } = await conn.client.downloadFile(url, aesKey);

      // Determine filename with fallback
      const filename = sdkFilename ?? this.generateFallbackFilename(msgtype);

      // Determine user folder name
      const plaintextUserId = workspaceStore.getWecomUserMapping(wecomUserId);
      const userFolderName = plaintextUserId ?? wecomUserId;

      // Save file to workspace
      const relativePath = await saveMediaFile(conn.folderPath, userFolderName, buffer, filename);

      // Look up or create session
      const sessionId = await this.getOrCreateSession(workspaceId, wecomUserId);
      if (!sessionId) return;

      const streamReply = await resolveStreamReplyIfNeeded(workspaceId, conn, frame, sessionId, wecomUserId);
      const defaultFilePrompt = `a file named @${relativePath} uploaded by ${userFolderName}, if there is skill can process this file, process it with that skill, if no proper skill find, ask user how to handle it.`;
      const prompt = await this.resolveFilePrompt(workspaceId, relativePath, defaultFilePrompt);
      try {
        await chatService.pushMessage(sessionId, workspaceId, prompt, true, streamReply?.handler);
      } catch (err) {
        streamReply?.handler.cleanup();
        throw err;
      }
    } catch (err) {
      console.error(`[WeComBotService] Failed to handle ${msgtype} message from ${wecomUserId}:`, err);
      // Reply to the WeCom user with a failure message
      try {
        await conn.client.sendMessage(wecomUserId, {
          msgtype: 'markdown',
          markdown: { content: '⚠️ 文件处理失败，请稍后重试。' },
        });
      } catch (sendErr) {
        console.error('[WeComBotService] Failed to send error reply:', sendErr);
      }
    }
  }

  private extractMediaInfo(body: BaseMessage): { url: string; aesKey?: string } | null {
    if (body.file?.url) return { url: body.file.url, aesKey: body.file.aeskey };
    if (body.image?.url) return { url: body.image.url, aesKey: body.image.aeskey };
    if (body.video?.url) return { url: body.video.url, aesKey: body.video.aeskey };
    return null;
  }

  private generateFallbackFilename(msgtype: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '-').slice(0, 19);
    const extMap: Record<string, string> = {
      image: 'png',
      video: 'mp4',
      file: 'bin',
    };
    const ext = extMap[msgtype] ?? 'bin';
    return `${msgtype}_${timestamp}.${ext}`;
  }

  private async resolveFilePrompt(
    workspaceId: string,
    relativePath: string,
    defaultPrompt: string,
  ): Promise<string> {
    const workspace = await workspaceStore.get(workspaceId);
    const template = workspace?.settings?.wecomFilePromptTemplate?.trim();
    if (!template) return defaultPrompt;
    return template.replace(/\$file_name\$/g, relativePath);
  }

  private async getOrCreateSession(workspaceId: string, wecomUserId: string): Promise<string | null> {
    let sessionId = workspaceStore.getWecomSession(workspaceId, wecomUserId);

    if (sessionId) {
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

      const plaintextUserId = workspaceStore.getWecomUserMapping(wecomUserId);
      if (plaintextUserId) {
        wecomSessionRenamer.renameSessionsForUser(workspaceId, wecomUserId).catch((err) => {
          console.error('[WeComBotService] Failed to rename sessions after creation:', err);
        });
      }
    }

    return sessionId;
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

  async sendDirectMessage(
    workspaceId: string,
    toUser: string,
    message: string,
  ): Promise<void> {
    const conn = this.connections.get(workspaceId);
    if (!conn || conn.status !== 'connected') {
      throw new Error(`Bot for workspace ${workspaceId} is not connected`);
    }
    // NOTE: The WeCom SDK's sendMessage only supports markdown for proactive sends.
    // We always send markdown regardless of the requested msgType.
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
    try {
      await fsPromises.mkdir(dir, { recursive: true });
    } catch {
      // ignore
    }
    const content = JSON.stringify({ workspaceId: workspace.id, botId, serverUrl: this.serverUrl }, null, 2);
    await fsPromises.writeFile(filePath, content, 'utf-8');
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
    try {
      await fsPromises.unlink(filePath);
    } catch {
      // ignore
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
      let exists = false;
      try {
        await fsPromises.access(filePath);
        exists = true;
      } catch {
        continue;
      }
      if (!exists) continue;
      const botId = ws.settings.wecomBotId;
      if (!botId || !this.botIdToWorkspaceId.has(botId)) {
        try {
          await fsPromises.unlink(filePath);
          console.log(`Cleaned up stale WeCom context file for workspace ${ws.id}`);
        } catch (err) {
          console.warn(`Failed to clean up stale context file for workspace ${ws.id}:`, err);
        }
      }
    }
  }

}

export const wecomBotService = new WeComBotService();
