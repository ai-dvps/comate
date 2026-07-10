import type {
  Bot,
  BotChannelKey,
  BotChannelSettings,
  BotRoleKey,
  BotRolePolicy,
  BotPersona,
  CreateBotInput,
  UpdateBotInput,
  WeComChannelConfig,
  FeishuChannelConfig,
} from '../models/bot.js';
export type { CreateBotInput, UpdateBotInput } from '../models/bot.js';
import type { BotUser } from '../models/bot-user.js';
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

    if (input.activeWorkspaceId !== undefined && input.activeWorkspaceId !== existing.activeWorkspaceId) {
      if (input.activeWorkspaceId) {
        this.ensureWorkspaceNotBound(input.activeWorkspaceId, id);
      }
    }

    const bot = this.store.updateBot(id, input);
    if (!bot) {
      throw new BotNotFoundError(id);
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
      this.requireChannelOwner(botId, actor.channelKey as BotChannelKey, actor);
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

  getAuditLogger(): BotAuditLogger {
    return this.auditLogger;
  }

  // Channels

  getChannelSettings(botId: string): BotChannelSettings {
    const channels = this.store.listBotChannels(botId);
    const settings: BotChannelSettings = {};
    for (const channel of channels) {
      settings[channel.channelKey] = channel.config[channel.channelKey];
    }
    return settings;
  }

  updateChannelSettings(
    botId: string,
    channelKey: BotChannelKey,
    settings: WeComChannelConfig | FeishuChannelConfig,
    actor: BotActor = systemActor(),
  ): void {
    const bot = this.store.getBot(botId);
    if (!bot) {
      throw new BotNotFoundError(botId);
    }
    this.requireSystemOrUserActor(actor);

    const channel = this.store.getBotChannelByKey(botId, channelKey);
    if (!channel) {
      throw new BotValidationError(`Channel ${channelKey} not found`);
    }

    const errors = this.validateCredentials({ [channelKey]: settings });
    if (errors.length > 0) {
      throw new BotValidationError(errors.join('; '));
    }

    const wasEnabled = channel.config[channelKey]?.enabled ?? false;
    this.store.updateBotChannel(channel.id, { [channelKey]: settings });
    const isEnabled = settings.enabled ?? false;

    this.auditLogger.logChannelCredentialsChanged(bot.id, actor, [channelKey]);
    if (!wasEnabled && isEnabled) {
      this.auditLogger.logChannelEnabled(bot.id, actor, channelKey);
    } else if (wasEnabled && !isEnabled) {
      this.auditLogger.logChannelDisabled(bot.id, actor, channelKey);
    }
  }

  // Roles

  getRolePolicy(botId: string): BotRolePolicy | null {
    const normalRole = this.store.getBotRoleByKey(botId, 'normal');
    return normalRole?.permissions ?? null;
  }

  getRolePersona(botId: string, roleKey: BotRoleKey): BotPersona | null {
    const role = this.store.getBotRoleByKey(botId, roleKey);
    return role?.persona ?? null;
  }

  getRolePersonas(botId: string): Partial<Record<BotRoleKey, BotPersona>> {
    const roles = this.store.listBotRoles(botId);
    const result: Partial<Record<BotRoleKey, BotPersona>> = {};
    for (const role of roles) {
      if (role.persona) {
        result[role.roleKey] = role.persona;
      }
    }
    return result;
  }

  updateRolePolicy(
    botId: string,
    permissions: BotRolePolicy,
    actor: BotActor = systemActor(),
  ): void {
    const bot = this.store.getBot(botId);
    if (!bot) {
      throw new BotNotFoundError(botId);
    }
    this.requireSystemOrUserActor(actor);

    const normalRole = this.store.getBotRoleByKey(botId, 'normal');
    if (!normalRole) {
      throw new BotValidationError('Normal role not found');
    }
    this.store.updateBotRole(normalRole.id, permissions);
  }

  updateRolePersonas(
    botId: string,
    rolePersonas: Partial<Record<BotRoleKey, BotPersona>> | null,
    actor: BotActor = systemActor(),
  ): void {
    const bot = this.store.getBot(botId);
    if (!bot) {
      throw new BotNotFoundError(botId);
    }
    this.requireSystemOrUserActor(actor);

    for (const roleKey of ['owner', 'admin', 'normal'] as BotRoleKey[]) {
      const role = this.store.getBotRoleByKey(botId, roleKey);
      if (role) {
        const persona = rolePersonas?.[roleKey] ?? null;
        this.store.updateBotRole(role.id, role.permissions, persona);
      }
    }
  }

  // Members and roles

  addMember(
    botId: string,
    input: {
      channelKey: BotChannelKey;
      channelUserId: string;
      roleKey?: BotRoleKey;
      plaintextUserId?: string | null;
    },
    actor: BotActor = systemActor(),
  ): BotUser {
    const bot = this.store.getBot(botId);
    if (!bot) {
      throw new BotNotFoundError(botId);
    }

    this.requireChannelOwner(botId, input.channelKey, actor);

    const channel = this.store.getBotChannelByKey(botId, input.channelKey);
    if (!channel) {
      throw new BotValidationError(`Channel ${input.channelKey} not found`);
    }

    const roleKey = input.roleKey ?? 'normal';
    const role = this.store.getBotRoleByKey(botId, roleKey);
    if (!role) {
      throw new BotValidationError(`Role ${roleKey} not found`);
    }

    if (roleKey === 'owner') {
      this.ensureNoExistingChannelOwner(botId, input.channelKey);
    }

    const existing = this.store.getBotUserByChannelIdentity(botId, channel.id, input.channelUserId);
    if (existing) {
      // User already exists (e.g., from auto-tracking), update role if needed
      if (existing.roleKey !== roleKey) {
        this.setMemberRole(botId, input.channelKey, input.channelUserId, roleKey, actor);
      }
      if (input.plaintextUserId !== undefined && input.plaintextUserId !== null && existing.plaintextUserId !== input.plaintextUserId) {
        this.store.updateBotUser(existing.id, { plaintextUserId: input.plaintextUserId });
      }
      return this.store.getBotUser(existing.id)!;
    }

    const user = this.store.createBotUser({
      botId,
      channelId: channel.id,
      roleId: role.id,
      channelUserId: input.channelUserId,
      plaintextUserId: input.plaintextUserId ?? null,
    });

    this.auditLogger.log(botId, actor, 'user_added', {
      channel: input.channelKey,
      channelUserId: input.channelUserId,
      role: roleKey,
    });
    return user;
  }

  setMemberRole(
    botId: string,
    channelKey: BotChannelKey,
    channelUserId: string,
    roleKey: BotRoleKey,
    actor: BotActor = systemActor(),
  ): void {
    const bot = this.store.getBot(botId);
    if (!bot) {
      throw new BotNotFoundError(botId);
    }

    this.requireChannelOwner(botId, channelKey, actor);

    const channel = this.store.getBotChannelByKey(botId, channelKey);
    if (!channel) {
      throw new BotValidationError(`Channel ${channelKey} not found`);
    }

    const user = this.store.getBotUserByChannelIdentity(botId, channel.id, channelUserId);
    if (!user) {
      throw new BotUserNotFoundError(botId, channelKey, channelUserId);
    }

    const currentRoleKey = user.roleKey;

    if (roleKey === 'owner' && currentRoleKey !== 'owner') {
      this.ensureNoExistingChannelOwner(botId, channelKey);
    }

    if (currentRoleKey === 'owner' && roleKey !== 'owner') {
      this.ensureAnotherChannelOwnerExists(botId, channelKey, channelUserId);
    }

    const role = this.store.getBotRoleByKey(botId, roleKey);
    if (!role) {
      throw new BotValidationError(`Role ${roleKey} not found`);
    }

    this.store.updateBotUser(user.id, { roleId: role.id });
    this.auditLogger.log(botId, actor, 'user_role_changed', {
      channel: channelKey,
      channelUserId,
      previousRole: currentRoleKey,
      newRole: roleKey,
    });
  }

  removeMember(
    botId: string,
    channelKey: BotChannelKey,
    channelUserId: string,
    actor: BotActor = systemActor(),
  ): void {
    const bot = this.store.getBot(botId);
    if (!bot) {
      throw new BotNotFoundError(botId);
    }

    this.requireChannelOwner(botId, channelKey, actor);

    const channel = this.store.getBotChannelByKey(botId, channelKey);
    if (!channel) {
      throw new BotValidationError(`Channel ${channelKey} not found`);
    }

    const user = this.store.getBotUserByChannelIdentity(botId, channel.id, channelUserId);
    if (!user) {
      throw new BotUserNotFoundError(botId, channelKey, channelUserId);
    }

    if (user.roleKey === 'owner') {
      this.ensureAnotherChannelOwnerExists(botId, channelKey, channelUserId);
    }

    this.store.deleteBotUser(user.id);
    this.auditLogger.log(botId, actor, 'user_removed', {
      channel: channelKey,
      channelUserId,
      previousRole: user.roleKey,
    });
  }

  getMemberRole(botId: string, channelKey: BotChannelKey, channelUserId: string): BotRoleKey | null {
    const channel = this.store.getBotChannelByKey(botId, channelKey);
    if (!channel) return null;
    const user =
      this.store.getBotUserByChannelIdentity(botId, channel.id, channelUserId) ??
      this.store.getBotUserByChannelPlaintext(botId, channel.id, channelUserId);
    return user?.roleKey ?? null;
  }

  listMembers(botId: string): BotUser[] {
    return this.store.listBotUsers(botId);
  }

  getMember(botId: string, channelKey: BotChannelKey, channelUserId: string): BotUser | null {
    const channel = this.store.getBotChannelByKey(botId, channelKey);
    if (!channel) return null;
    return this.store.getBotUserByChannelIdentity(botId, channel.id, channelUserId);
  }

  ensureMember(
    botId: string,
    channelKey: BotChannelKey,
    channelUserId: string,
    plaintextUserId?: string | null,
  ): BotUser {
    const bot = this.store.getBot(botId);
    if (!bot) {
      throw new BotNotFoundError(botId);
    }

    const channel = this.store.getBotChannelByKey(botId, channelKey);
    if (!channel) {
      throw new BotValidationError(`Channel ${channelKey} not found`);
    }

    const existing = this.store.getBotUserByChannelIdentity(botId, channel.id, channelUserId);
    if (existing) {
      return existing;
    }

    const normalRole = this.store.getBotRoleByKey(botId, 'normal');
    if (!normalRole) {
      throw new BotValidationError('Normal role not found');
    }

    return this.store.createBotUser({
      botId,
      channelId: channel.id,
      roleId: normalRole.id,
      channelUserId,
      plaintextUserId: plaintextUserId ?? null,
    });
  }

  // Workspace-scoped helpers for backward-compatible routes

  getBotForWorkspace(workspaceId: string): Bot | null {
    return this.store.listBotsForWorkspace(workspaceId)[0] ?? null;
  }

  private getChannelForWorkspace(
    workspaceId: string,
    channelKey: BotChannelKey,
  ): { bot: Bot; channel: import('../models/bot.js').BotChannel } | null {
    const bot = this.getBotForWorkspace(workspaceId);
    if (!bot) return null;
    const channel = this.store.getBotChannelByKey(bot.id, channelKey);
    if (!channel) return null;
    return { bot, channel };
  }

  listChannelUsersForWorkspace(workspaceId: string, channelKey: BotChannelKey): BotUser[] {
    const pair = this.getChannelForWorkspace(workspaceId, channelKey);
    if (!pair) return [];
    return this.store.listBotUsersByChannel(pair.bot.id, pair.channel.id);
  }

  setChannelUserPlaintextForWorkspace(
    workspaceId: string,
    channelKey: BotChannelKey,
    channelUserId: string,
    plaintextUserId: string,
  ): BotUser {
    const pair = this.getChannelForWorkspace(workspaceId, channelKey);
    if (!pair) {
      throw new BotValidationError('No bot bound to this workspace');
    }
    return this.setMemberPlaintext(pair.bot.id, channelKey, channelUserId, plaintextUserId);
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

    const resolveFeishu =
      feishuResolver ??
      (async (workspaceId: string, openId: string) => {
        const { feishuBotService } = await import('./feishu-bot-service.js');
        return feishuBotService.resolveFeishuUserName(botId, workspaceId, openId);
      });

    let resolved = 0;
    let failed = 0;

    for (const member of members) {
      const channel = this.store.getBotChannel(member.channelId);
      if (!channel) {
        failed++;
        continue;
      }
      try {
        if (channel.channelKey === 'wecom') {
          await wecomUserResolver.resolveImmediate(bot.activeWorkspaceId ?? '', member.channelUserId);
          resolved++;
        } else if (channel.channelKey === 'feishu' && bot.activeWorkspaceId) {
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

    return Promise.resolve({ resolved, failed });
  }

  setMemberPlaintext(
    botId: string,
    channelKey: BotChannelKey,
    channelUserId: string,
    plaintextUserId: string,
  ): BotUser {
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

    const channel = this.store.getBotChannelByKey(botId, channelKey);
    if (!channel) {
      throw new BotValidationError(`Channel ${channelKey} not found`);
    }

    const user = this.store.getBotUserByChannelIdentity(botId, channel.id, channelUserId);
    if (!user) {
      throw new BotUserNotFoundError(botId, channelKey, channelUserId);
    }

    if (channelKey === 'wecom') {
      const existing = this.store.listBotUsersByChannel(botId, channel.id)
        .find((u) => u.plaintextUserId === plaintextUserId && u.channelUserId !== channelUserId);
      if (existing) {
        throw new BotUserPlaintextConflictError(plaintextUserId);
      }
    }

    this.store.updateBotUser(user.id, { plaintextUserId });
    return this.store.getBotUser(user.id)!;
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

  private requireChannelOwner(botId: string, channelKey: BotChannelKey, actor: BotActor): void {
    if (actor.type === 'system' || actor.type === 'user') {
      return;
    }
    if (actor.channelKey !== channelKey) {
      throw new BotAuthorizationError('only-owner');
    }
    const role = this.getMemberRole(botId, channelKey, actor.channelUserId as string);
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

  private ensureNoExistingChannelOwner(botId: string, channelKey: BotChannelKey): void {
    const channel = this.store.getBotChannelByKey(botId, channelKey);
    if (!channel) return;
    const users = this.store.listBotUsersByChannel(botId, channel.id);
    if (users.some((u) => u.roleKey === 'owner')) {
      throw new BotAuthorizationError('owner-already-exists');
    }
  }

  private ensureAnotherChannelOwnerExists(
    botId: string,
    channelKey: BotChannelKey,
    channelUserId: string,
  ): void {
    const channel = this.store.getBotChannelByKey(botId, channelKey);
    if (!channel) return;
    const users = this.store.listBotUsersByChannel(botId, channel.id);
    const otherOwner = users.some(
      (u) => u.roleKey === 'owner' && u.channelUserId !== channelUserId,
    );
    if (!otherOwner) {
      throw new BotAuthorizationError('last-owner');
    }
  }
}

export interface BotActor {
  type: 'system' | 'user' | 'wecom' | 'feishu';
  channelKey?: BotChannelKey;
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

export class BotUserNotFoundError extends Error {
  public botId: string;
  public channel: BotChannelKey;
  public channelUserId: string;

  constructor(botId: string, channel: BotChannelKey, channelUserId: string) {
    super(`Bot user not found: ${botId}/${channel}/${channelUserId}`);
    this.name = 'BotUserNotFoundError';
    this.botId = botId;
    this.channel = channel;
    this.channelUserId = channelUserId;
  }
}

export class BotUserPlaintextConflictError extends Error {
  public plaintextUserId: string;

  constructor(plaintextUserId: string) {
    super(`Plaintext user id already in use: ${plaintextUserId}`);
    this.name = 'BotUserPlaintextConflictError';
    this.plaintextUserId = plaintextUserId;
  }
}

export const botService = new BotService();
