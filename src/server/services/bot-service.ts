import type {
  Bot,
  BotMember,
  BotProvider,
  BotProviderSettings,
  BotRole,
  CreateBotInput,
  CreateBotMemberInput,
  UpdateBotInput,
} from '../models/bot.js';
import { store as defaultStore, type SqliteStore } from '../storage/sqlite-store.js';
import { diagLog } from '../utils/diag-logger.js';

export class BotService {
  private store: SqliteStore;

  constructor(store?: SqliteStore) {
    this.store = store ?? defaultStore;
  }

  // Bot CRUD

  createBot(input: CreateBotInput): Bot {
    const errors = this.validateCredentials(input.providerSettings ?? {});
    if (errors.length > 0) {
      throw new BotValidationError(errors.join('; '));
    }

    if (input.activeWorkspaceId) {
      this.ensureWorkspaceNotBound(input.activeWorkspaceId);
    }

    const bot = this.store.createBot(input);
    this.audit(bot.id, { type: 'system' }, 'bot_created', { name: bot.name });
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

    if (input.providerSettings) {
      const errors = this.validateCredentials(input.providerSettings);
      if (errors.length > 0) {
        throw new BotValidationError(errors.join('; '));
      }
    }

    if (input.activeWorkspaceId !== undefined && input.activeWorkspaceId !== existing.activeWorkspaceId) {
      this.requireOwner(existing, actor);
      if (input.activeWorkspaceId) {
        this.ensureWorkspaceNotBound(input.activeWorkspaceId, id);
      }
    }

    const hadProviderChanges = input.providerSettings !== undefined;
    const bot = this.store.updateBot(id, input);
    if (!bot) {
      throw new BotNotFoundError(id);
    }

    if (hadProviderChanges) {
      this.audit(bot.id, actor, 'provider_credentials_changed', {
        providers: Object.keys(input.providerSettings ?? {}),
      });
    }
    return bot;
  }

  deleteBot(id: string, actor: BotActor = systemActor()): boolean {
    const bot = this.store.getBot(id);
    if (!bot) return false;

    this.requireOwner(bot, actor);
    const deleted = this.store.deleteBot(id);
    if (deleted) {
      this.audit(id, actor, 'bot_deleted', { name: bot.name });
    }
    return deleted;
  }

  // Workspace binding

  setActiveWorkspace(botId: string, workspaceId: string, actor: BotActor): Bot {
    const bot = this.store.getBot(botId);
    if (!bot) {
      throw new BotNotFoundError(botId);
    }

    this.requireOwner(bot, actor);

    if (bot.activeWorkspaceId === workspaceId) {
      return bot;
    }

    this.ensureWorkspaceNotBound(workspaceId, botId);

    const updated = this.store.updateBot(botId, { activeWorkspaceId: workspaceId });
    if (!updated) {
      throw new BotNotFoundError(botId);
    }

    this.audit(botId, actor, 'active_workspace_switched', {
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

    this.requireOwner(bot, actor);

    const role = input.role ?? 'normal';
    if (role === 'owner') {
      this.ensureNoExistingOwner(botId);
    }

    this.store.setBotMember(botId, input.provider, input.providerUserId, role);
    this.audit(botId, actor, 'member_added', {
      provider: input.provider,
      providerUserId: input.providerUserId,
      role,
    });
    return this.store.listBotMembers(botId).find(
      (m) => m.provider === input.provider && m.providerUserId === input.providerUserId,
    )!;
  }

  setMemberRole(
    botId: string,
    provider: BotProvider,
    providerUserId: string,
    role: BotRole,
    actor: BotActor = systemActor(),
  ): void {
    const bot = this.store.getBot(botId);
    if (!bot) {
      throw new BotNotFoundError(botId);
    }

    this.requireOwner(bot, actor);

    const currentRole = this.store.getBotMemberRole(botId, provider, providerUserId);

    if (role === 'owner' && currentRole !== 'owner') {
      this.ensureNoExistingOwner(botId);
    }

    if (currentRole === 'owner' && role !== 'owner') {
      this.ensureAnotherOwnerExists(botId, provider, providerUserId);
    }

    this.store.setBotMember(botId, provider, providerUserId, role);
    this.audit(botId, actor, 'member_role_changed', {
      provider,
      providerUserId,
      previousRole: currentRole,
      newRole: role,
    });
  }

  removeMember(
    botId: string,
    provider: BotProvider,
    providerUserId: string,
    actor: BotActor = systemActor(),
  ): void {
    const bot = this.store.getBot(botId);
    if (!bot) {
      throw new BotNotFoundError(botId);
    }

    this.requireOwner(bot, actor);

    const currentRole = this.store.getBotMemberRole(botId, provider, providerUserId);
    if (currentRole === 'owner') {
      this.ensureAnotherOwnerExists(botId, provider, providerUserId);
    }

    this.store.removeBotMember(botId, provider, providerUserId);
    this.audit(botId, actor, 'member_removed', {
      provider,
      providerUserId,
      previousRole: currentRole,
    });
  }

  getMemberRole(botId: string, provider: BotProvider, providerUserId: string): BotRole | null {
    return this.store.getBotMemberRole(botId, provider, providerUserId);
  }

  listMembers(botId: string): BotMember[] {
    return this.store.listBotMembers(botId);
  }

  resolveMemberRole(botId: string, provider: BotProvider, providerUserId: string): BotRole | null {
    return this.store.getBotMemberRole(botId, provider, providerUserId);
  }

  // Credential validation

  validateCredentials(providerSettings: BotProviderSettings): string[] {
    const errors: string[] = [];
    const wecom = providerSettings.wecom;
    const feishu = providerSettings.feishu;

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

  private requireOwner(bot: Bot, actor: BotActor): void {
    if (actor.type === 'system') {
      return;
    }
    const role = this.store.getBotMemberRole(bot.id, actor.provider as BotProvider, actor.providerUserId as string);
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

  private ensureNoExistingOwner(botId: string): void {
    const members = this.store.listBotMembers(botId);
    if (members.some((m) => m.role === 'owner')) {
      throw new BotAuthorizationError('owner-already-exists');
    }
  }

  private ensureAnotherOwnerExists(
    botId: string,
    provider: BotProvider,
    providerUserId: string,
  ): void {
    const members = this.store.listBotMembers(botId);
    const otherOwner = members.some(
      (m) => m.role === 'owner' && (m.provider !== provider || m.providerUserId !== providerUserId),
    );
    if (!otherOwner) {
      throw new BotAuthorizationError('last-owner');
    }
  }

  private audit(
    botId: string,
    actor: BotActor,
    eventType: string,
    details: Record<string, unknown>,
  ): void {
    try {
      this.store.recordAuditLog({
        botId,
        actorType: actor.type,
        actorId: actor.providerUserId ?? 'system',
        eventType,
        details,
      });
    } catch (err) {
      diagLog('Failed to record bot audit log', { botId, eventType, error: String(err) });
    }
  }
}

export interface BotActor {
  type: 'system' | 'user' | 'wecom' | 'feishu';
  provider?: BotProvider;
  providerUserId?: string;
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

export const botService = new BotService();
