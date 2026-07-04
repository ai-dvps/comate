import type {
  Bot,
  BotMember,
  BotChannel,
  BotChannelSettings,
  BotRole,
  CreateBotInput,
  CreateBotMemberInput,
  UpdateBotInput,
} from '../models/bot.js';
import { store as defaultStore, type SqliteStore } from '../storage/sqlite-store.js';
import { BotAuditLogger } from './bot-audit-logger.js';
import { wecomUserResolver } from './wecom-user-resolver.js';
import { diagLog } from '../utils/diag-logger.js';

export class BotService {
  private store: SqliteStore;
  private auditLogger: BotAuditLogger;

  constructor(store?: SqliteStore, auditLogger?: BotAuditLogger) {
    this.store = store ?? defaultStore;
    this.auditLogger = auditLogger ?? new BotAuditLogger(this.store);
  }

  // Bot CRUD

  createBot(input: CreateBotInput): Bot {
    const errors = this.validateCredentials(input.channelSettings ?? {});
    if (errors.length > 0) {
      throw new BotValidationError(errors.join('; '));
    }

    if (input.activeWorkspaceId) {
      this.ensureWorkspaceNotBound(input.activeWorkspaceId);
    }

    const bot = this.store.createBot(input);
    this.auditLogger.log(bot.id, { type: 'system' }, 'bot_created', { name: bot.name });
    return bot;
  }

  getBot(id: string): Bot | null {
    return this.store.getBot(id);
  }

  listBots(): Bot[] {
    return this.store.listBots();
  }

  listBotsForWorkspace(workspaceId: string): Bot[] {
    return this.store.listBotsForWorkspace(workspaceId);
  }

  updateBot(id: string, input: UpdateBotInput, actor: BotActor = systemActor()): Bot {
    const existing = this.store.getBot(id);
    if (!existing) {
      throw new BotNotFoundError(id);
    }

    this.requireSystemOrUserActor(actor);

    if (input.channelSettings) {
      const errors = this.validateCredentials(input.channelSettings);
      if (errors.length > 0) {
        throw new BotValidationError(errors.join('; '));
      }
    }

    if (input.activeWorkspaceId !== undefined && input.activeWorkspaceId !== existing.activeWorkspaceId) {
      if (input.activeWorkspaceId) {
        this.ensureWorkspaceNotBound(input.activeWorkspaceId, id);
      }
    }

    const hadChannelChanges = input.channelSettings !== undefined;
    const bot = this.store.updateBot(id, input);
    if (!bot) {
      throw new BotNotFoundError(id);
    }

    if (hadChannelChanges) {
      const channels = Object.keys(input.channelSettings ?? {}) as BotChannel[];
      this.auditLogger.logChannelCredentialsChanged(bot.id, actor, channels);
      for (const channel of channels) {
        const wasEnabled = existing.channelSettings[channel]?.enabled ?? false;
        const isEnabled = input.channelSettings?.[channel]?.enabled ?? false;
        if (!wasEnabled && isEnabled) {
          this.auditLogger.logChannelEnabled(bot.id, actor, channel);
        } else if (wasEnabled && !isEnabled) {
          this.auditLogger.logChannelDisabled(bot.id, actor, channel);
        }
      }
    }
    return bot;
  }

  deleteBot(id: string, actor: BotActor = systemActor()): boolean {
    const bot = this.store.getBot(id);
    if (!bot) return false;

    this.requireSystemOrUserActor(actor);
    const deleted = this.store.deleteBot(id);
    if (deleted) {
      this.auditLogger.log(id, actor, 'bot_deleted', { name: bot.name });
    }
    return deleted;
  }

  // Workspace binding

  setActiveWorkspace(botId: string, workspaceId: string, actor: BotActor): Bot {
    const bot = this.store.getBot(botId);
    if (!bot) {
      throw new BotNotFoundError(botId);
    }

    if (actor.type !== 'system') {
      this.requireChannelOwner(botId, actor.channel as BotChannel, actor);
    }

    if (bot.activeWorkspaceId === workspaceId) {
      return bot;
    }

    this.ensureWorkspaceNotBound(workspaceId, botId);

    const updated = this.store.updateBot(botId, { activeWorkspaceId: workspaceId });
    if (!updated) {
      throw new BotNotFoundError(botId);
    }

    this.auditLogger.log(botId, actor, 'active_workspace_switched', {
      previousWorkspaceId: bot.activeWorkspaceId,
      newWorkspaceId: workspaceId,
    });
    return updated;
  }

  resolveActiveWorkspace(botId: string): string | null {
    const bot = this.store.getBot(botId);
    return bot?.activeWorkspaceId ?? null;
  }

  // Members and roles

  addMember(
    botId: string,
    input: CreateBotMemberInput,
    actor: BotActor = systemActor(),
  ): BotMember {
    const bot = this.store.getBot(botId);
    if (!bot) {
      throw new BotNotFoundError(botId);
    }

    this.requireChannelOwner(botId, input.channel, actor);

    const role = input.role ?? 'normal';
    if (role === 'owner') {
      this.ensureNoExistingChannelOwner(botId, input.channel);
    }

    this.store.setBotMember(botId, input.channel, input.channelUserId, role);
    this.auditLogger.log(botId, actor, 'member_added', {
      channel: input.channel,
      channelUserId: input.channelUserId,
      role,
    });
    const raw = this.store.listBotMembers(botId).find(
      (m) => m.channel === input.channel && m.channelUserId === input.channelUserId,
    )!;
    return this.resolveMemberPlaintext(botId, raw);
  }

  setMemberRole(
    botId: string,
    channel: BotChannel,
    channelUserId: string,
    role: BotRole,
    actor: BotActor = systemActor(),
  ): void {
    const bot = this.store.getBot(botId);
    if (!bot) {
      throw new BotNotFoundError(botId);
    }

    this.requireChannelOwner(botId, channel, actor);

    const currentRole = this.store.getBotMemberRole(botId, channel, channelUserId);

    if (role === 'owner' && currentRole !== 'owner') {
      this.ensureNoExistingChannelOwner(botId, channel);
    }

    if (currentRole === 'owner' && role !== 'owner') {
      this.ensureAnotherChannelOwnerExists(botId, channel, channelUserId);
    }

    this.store.setBotMember(botId, channel, channelUserId, role);
    this.auditLogger.log(botId, actor, 'member_role_changed', {
      channel,
      channelUserId,
      previousRole: currentRole,
      newRole: role,
    });
  }

  removeMember(
    botId: string,
    channel: BotChannel,
    channelUserId: string,
    actor: BotActor = systemActor(),
  ): void {
    const bot = this.store.getBot(botId);
    if (!bot) {
      throw new BotNotFoundError(botId);
    }

    this.requireChannelOwner(botId, channel, actor);

    const currentRole = this.store.getBotMemberRole(botId, channel, channelUserId);
    if (currentRole === 'owner') {
      this.ensureAnotherChannelOwnerExists(botId, channel, channelUserId);
    }

    this.store.removeBotMember(botId, channel, channelUserId);
    this.auditLogger.log(botId, actor, 'member_removed', {
      channel,
      channelUserId,
      previousRole: currentRole,
    });
  }

  getMemberRole(botId: string, channel: BotChannel, channelUserId: string): BotRole | null {
    return this.store.getBotMemberRole(botId, channel, channelUserId);
  }

  listMembers(botId: string): BotMember[] {
    return this.store.listBotMembers(botId).map((m) => this.resolveMemberPlaintext(botId, m));
  }

  private resolveMemberPlaintext(botId: string, member: BotMember): BotMember {
    const bot = this.store.getBot(botId);
    if (member.channel === 'wecom') {
      const plaintextUserId = this.store.getWecomUserMapping(member.channelUserId);
      if (plaintextUserId) {
        return { ...member, plaintextUserId, displayName: null, resolutionStatus: 'resolved' };
      }
    } else if (member.channel === 'feishu' && bot?.activeWorkspaceId) {
      const user = this.store.getFeishuWorkspaceUser(bot.activeWorkspaceId, member.channelUserId);
      if (user?.userId) {
        return {
          ...member,
          plaintextUserId: user.userId,
          displayName: user.name,
          resolutionStatus: 'resolved',
        };
      }
    }
    return { ...member, plaintextUserId: null, displayName: null, resolutionStatus: 'pending' };
  }

  resolveMemberRole(botId: string, channel: BotChannel, channelUserId: string): BotRole | null {
    return this.store.getBotMemberRole(botId, channel, channelUserId);
  }

  async resolvePendingMembers(
    botId: string,
    feishuResolver?: (workspaceId: string, openId: string) => Promise<{ userId: string; name: string } | null>,
  ): Promise<{ resolved: number; failed: number }> {
    const bot = this.store.getBot(botId);
    if (!bot) {
      throw new BotNotFoundError(botId);
    }

    const members = this.listMembers(botId).filter((m) => m.resolutionStatus === 'pending');
    let resolved = 0;
    let failed = 0;

    const resolveFeishu =
      feishuResolver ??
      (async (workspaceId: string, openId: string) => {
        const { feishuBotService } = await import('./feishu-bot-service.js');
        return feishuBotService.resolveFeishuUserName(botId, workspaceId, openId);
      });

    for (const member of members) {
      try {
        if (member.channel === 'wecom') {
          await wecomUserResolver.resolveImmediate(bot.activeWorkspaceId ?? '', member.channelUserId);
          resolved++;
        } else if (member.channel === 'feishu' && bot.activeWorkspaceId) {
          const result = await resolveFeishu(bot.activeWorkspaceId, member.channelUserId);
          if (result) {
            resolved++;
          } else {
            failed++;
          }
        } else {
          failed++;
        }
      } catch (err) {
        diagLog('[BotService] resolvePendingMembers failed:', err);
        failed++;
      }
    }

    return { resolved, failed };
  }

  setMemberPlaintext(
    botId: string,
    channel: BotChannel,
    channelUserId: string,
    plaintextUserId: string,
    displayName?: string,
  ): BotMember {
    const bot = this.store.getBot(botId);
    if (!bot) {
      throw new BotNotFoundError(botId);
    }
    if (!bot.activeWorkspaceId) {
      throw new BotValidationError('Bot has no active workspace');
    }
    if (!plaintextUserId || typeof plaintextUserId !== 'string' || plaintextUserId.trim() === '') {
      throw new BotValidationError('plaintextUserId is required');
    }

    const role = this.store.getBotMemberRole(botId, channel, channelUserId);
    if (role === null) {
      throw new BotMemberNotFoundError(botId, channel, channelUserId);
    }

    if (channel === 'wecom') {
      const existingEncrypted = this.store.getEncryptedUserIdByPlaintext(plaintextUserId);
      if (existingEncrypted && existingEncrypted !== channelUserId) {
        const used = this.store.isPlaintextUserIdUsedInWorkspace(
          bot.activeWorkspaceId,
          plaintextUserId,
          channelUserId,
        );
        if (used) {
          throw new BotMemberPlaintextConflictError(plaintextUserId);
        }
      }
      this.store.setWecomUserMapping(channelUserId, plaintextUserId);
    } else if (channel === 'feishu') {
      this.store.setFeishuWorkspaceUserName(
        bot.activeWorkspaceId,
        channelUserId,
        displayName ?? plaintextUserId,
        plaintextUserId,
      );
    } else {
      throw new BotValidationError('channel must be wecom or feishu');
    }

    const raw = this.store.listBotMembers(botId).find(
      (m) => m.channel === channel && m.channelUserId === channelUserId,
    )!;
    return this.resolveMemberPlaintext(botId, raw);
  }

  // Credential validation

  validateCredentials(channelSettings: BotChannelSettings): string[] {
    const errors: string[] = [];
    const wecom = channelSettings.wecom;
    const feishu = channelSettings.feishu;

    if (wecom?.enabled === true) {
      if (!wecom.botId || typeof wecom.botId !== 'string' || wecom.botId.trim() === '') {
        errors.push('WeCom botId is required when WeCom is enabled');
      }
      if (!wecom.botSecret || typeof wecom.botSecret !== 'string' || wecom.botSecret.trim() === '') {
        errors.push('WeCom botSecret is required when WeCom is enabled');
      }
    }

    if (feishu?.enabled === true) {
      if (!feishu.appId || typeof feishu.appId !== 'string' || feishu.appId.trim() === '') {
        errors.push('Feishu appId is required when Feishu is enabled');
      }
      if (!feishu.appSecret || typeof feishu.appSecret !== 'string' || feishu.appSecret.trim() === '') {
        errors.push('Feishu appSecret is required when Feishu is enabled');
      }
    }

    return errors;
  }

  // Authorization helpers

  private requireSystemOrUserActor(actor: BotActor): void {
    if (actor.type === 'system' || actor.type === 'user') {
      return;
    }
    throw new BotAuthorizationError('only-system');
  }

  private requireChannelOwner(botId: string, channel: BotChannel, actor: BotActor): void {
    if (actor.type === 'system' || actor.type === 'user') {
      return;
    }
    if (actor.channel !== channel) {
      throw new BotAuthorizationError('only-owner');
    }
    const role = this.store.getBotMemberRole(botId, channel, actor.channelUserId as string);
    if (role !== 'owner') {
      throw new BotAuthorizationError('only-owner');
    }
  }

  private ensureWorkspaceNotBound(workspaceId: string, excludeBotId?: string): void {
    const existing = this.store.listBotsForWorkspace(workspaceId);
    const bound = existing.find((b) => b.id !== excludeBotId);
    if (bound) {
      throw new BotWorkspaceBoundError(bound.id, workspaceId);
    }
  }

  private ensureNoExistingChannelOwner(botId: string, channel: BotChannel): void {
    const members = this.store.listBotMembers(botId);
    if (members.some((m) => m.channel === channel && m.role === 'owner')) {
      throw new BotAuthorizationError('owner-already-exists');
    }
  }

  private ensureAnotherChannelOwnerExists(
    botId: string,
    channel: BotChannel,
    channelUserId: string,
  ): void {
    const members = this.store.listBotMembers(botId);
    const otherOwner = members.some(
      (m) => m.channel === channel && m.role === 'owner' && m.channelUserId !== channelUserId,
    );
    if (!otherOwner) {
      throw new BotAuthorizationError('last-owner');
    }
  }
}

export interface BotActor {
  type: 'system' | 'user' | 'wecom' | 'feishu';
  channel?: BotChannel;
  channelUserId?: string;
}

function systemActor(): BotActor {
  return { type: 'system' };
}

export class BotNotFoundError extends Error {
  constructor(botId: string) {
    super(`Bot not found: ${botId}`);
    this.name = 'BotNotFoundError';
  }
}

export class BotAuthorizationError extends Error {
  constructor(code: string) {
    super(`Bot authorization failed: ${code}`);
    this.name = 'BotAuthorizationError';
  }
}

export class BotValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BotValidationError';
  }
}

export class BotWorkspaceBoundError extends Error {
  public boundBotId: string;
  public workspaceId: string;

  constructor(boundBotId: string, workspaceId: string) {
    super('该 workspace 已被其他 bot 激活绑定，请先解绑');
    this.name = 'BotWorkspaceBoundError';
    this.boundBotId = boundBotId;
    this.workspaceId = workspaceId;
  }
}

export class BotMemberNotFoundError extends Error {
  public botId: string;
  public channel: BotChannel;
  public channelUserId: string;

  constructor(botId: string, channel: BotChannel, channelUserId: string) {
    super(`Bot member not found: ${botId}/${channel}/${channelUserId}`);
    this.name = 'BotMemberNotFoundError';
    this.botId = botId;
    this.channel = channel;
    this.channelUserId = channelUserId;
  }
}

export class BotMemberPlaintextConflictError extends Error {
  public code = 'duplicate-plaintext';
  public plaintextUserId: string;

  constructor(plaintextUserId: string) {
    super(`Plaintext user ID already mapped to another user: ${plaintextUserId}`);
    this.name = 'BotMemberPlaintextConflictError';
    this.plaintextUserId = plaintextUserId;
  }
}

export const botService = new BotService();
