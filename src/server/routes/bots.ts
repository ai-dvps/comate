import { Router } from 'express';
import { botService } from '../services/bot-service.js';
import { chatService } from '../services/chat-service.js';
import { wecomBotService } from '../services/wecom-bot-service.js';
import { feishuBotService } from '../services/feishu-bot-service.js';
import { BotMigrationService } from '../services/bot-migration-service.js';
import { builtinPluginService } from '../services/builtin-plugin-service.js';
import { SAFE_PRESET } from '../services/tool-permission-policy.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { ENCRYPTED_CHANNEL_KEYS } from '../models/bot.js';
import type { BotChannelSettings, CreateBotInput, UpdateBotInput, BotChannelKey } from '../models/bot.js';
import { sanitizeChannelError } from '../utils/channel-error-sanitizer.js';
import {
  BotAuthorizationError,
  BotUserNotFoundError,
  BotUserPlaintextConflictError,
  BotNotFoundError,
  BotValidationError,
  BotWorkspaceBoundError,
  type BotActor,
} from '../services/bot-service.js';

const router = Router();
const reconnectRateLimits = new Map<string, number>();
const RECONNECT_RATE_LIMIT_MS = 30_000;

function systemActor(): BotActor {
  return { type: 'system' };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidateBotRuntimesIfNeeded(botId: string, input: { persona?: unknown; rolePersonas?: unknown; rolePolicy?: unknown }): void {
  if (input.persona !== undefined || input.rolePersonas !== undefined || input.rolePolicy !== undefined) {
    chatService.scheduleRebuildsForBot(botId);
  }
}

function redactProviderConfig(config: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (ENCRYPTED_CHANNEL_KEYS.includes(key)) {
      result[key] = typeof value === 'string' && value.length > 0 ? true : undefined;
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function redactChannelSettings(settings: BotChannelSettings): BotChannelSettings {
  const result: BotChannelSettings = {};
  if (isPlainObject(settings.wecom)) {
    result.wecom = redactProviderConfig(settings.wecom) as BotChannelSettings['wecom'];
  }
  if (isPlainObject(settings.feishu)) {
    result.feishu = redactProviderConfig(settings.feishu) as BotChannelSettings['feishu'];
  }
  return result;
}

function redactBot(bot: import('../models/bot.js').Bot) {
  const channelSettings = botService.getChannelSettings(bot.id);
  const rolePolicy = botService.getRolePolicy(bot.id);
  const rolePersonas = botService.getRolePersonas(bot.id);
  return {
    ...bot,
    channelSettings: redactChannelSettings(channelSettings),
    rolePolicy: rolePolicy ?? {
      normalToolPolicy: SAFE_PRESET,
      skillAllowlist: [],
      bashWhitelist: [],
    },
    rolePersonas,
  };
}

export function mapBotError(error: unknown): { status: number; message: string; code?: string } {
  if (error instanceof BotNotFoundError) {
    return { status: 404, message: error.message };
  }
  if (error instanceof BotUserNotFoundError) {
    return { status: 404, message: error.message };
  }
  if (error instanceof BotValidationError) {
    return { status: 400, message: error.message };
  }
  if (error instanceof BotAuthorizationError) {
    return { status: 403, message: error.message, code: 'forbidden' };
  }
  if (error instanceof BotWorkspaceBoundError) {
    return { status: 400, message: error.message, code: 'workspace-bound' };
  }
  if (error instanceof BotUserPlaintextConflictError) {
    return { status: 409, message: error.message, code: 'plaintext-conflict' };
  }
  return { status: 500, message: 'Internal server error' };
}

// GET /api/bots
router.get('/', (_req, res) => {
  try {
    const bots = botService.listBots().map(redactBot);
    res.json({ bots });
  } catch (error) {
    console.error('Failed to list bots:', error);
    res.status(500).json({ error: 'Failed to list bots' });
  }
});

function resolveSentinelCredentials(
  input: BotChannelSettings,
  existing: BotChannelSettings,
): BotChannelSettings {
  const result: BotChannelSettings = {};
  for (const channel of ['wecom', 'feishu'] as const) {
    const incoming = input[channel];
    if (!incoming) continue;
    const current = existing[channel] ?? {};
    const merged: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(incoming)) {
      if (ENCRYPTED_CHANNEL_KEYS.includes(key) && value === true) {
        merged[key] = (current as Record<string, unknown>)[key];
      } else {
        merged[key] = value;
      }
    }
    result[channel] = merged as BotChannelSettings[typeof channel];
  }
  return result;
}

// POST /api/bots
router.post('/', async (req, res) => {
  try {
    const body = req.body as CreateBotInput & {
      channelSettings?: BotChannelSettings;
      rolePolicy?: import('../models/bot.js').BotRolePolicy;
      rolePersonas?: Partial<Record<import('../models/bot.js').BotRoleKey, import('../models/bot.js').BotPersona>>;
    };
    if (!body.name || typeof body.name !== 'string' || body.name.trim() === '') {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    const { channelSettings, rolePolicy, rolePersonas, ...botInput } = body;

    if (channelSettings) {
      const errors = botService.validateCredentials(channelSettings);
      if (errors.length > 0) {
        res.status(400).json({ error: errors.join('; ') });
        return;
      }
    }

    const bot = botService.createBot(botInput);

    if (channelSettings) {
      for (const channelKey of Object.keys(channelSettings) as import('../models/bot.js').BotChannelKey[]) {
        const settings = channelSettings[channelKey];
        if (settings) {
          botService.updateChannelSettings(bot.id, channelKey, settings);
        }
      }
    }

    if (rolePolicy) {
      botService.updateRolePolicy(bot.id, rolePolicy);
    }

    if (rolePersonas) {
      botService.updateRolePersonas(bot.id, rolePersonas);
    }

    await connectEnabledChannels(bot);
    res.status(201).json({ bot: redactBot(bot) });
  } catch (error) {
    const mapped = mapBotError(error);
    console.error('Failed to create bot:', error);
    res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
  }
});

// GET /api/bots/:id
router.get('/:id', (req, res) => {
  try {
    const bot = botService.getBot(req.params.id);
    if (!bot) {
      res.status(404).json({ error: 'Bot not found' });
      return;
    }
    const members = botService.listMembers(req.params.id);
    res.json({ bot: redactBot(bot), members });
  } catch (error) {
    console.error('Failed to get bot:', error);
    res.status(500).json({ error: 'Failed to get bot' });
  }
});

// PUT /api/bots/:id
router.put('/:id', async (req, res) => {
  try {
    const body = req.body as UpdateBotInput & {
      channelSettings?: BotChannelSettings;
      rolePolicy?: import('../models/bot.js').BotRolePolicy;
      rolePersonas?: Partial<Record<import('../models/bot.js').BotRoleKey, import('../models/bot.js').BotPersona>> | null;
    };
    const { channelSettings, rolePolicy, rolePersonas, ...botInput } = body;

    let preUpdateSettingsSnapshot: BotChannelSettings | undefined;
    let preUpdateActiveWorkspaceIdSnapshot: string | null | undefined;
    if (channelSettings) {
      const existingSettings = botService.getChannelSettings(req.params.id);
      preUpdateSettingsSnapshot = existingSettings;
      preUpdateActiveWorkspaceIdSnapshot = botService.getBot(req.params.id)?.activeWorkspaceId;
      const resolved = resolveSentinelCredentials(channelSettings, existingSettings);
      for (const channelKey of Object.keys(resolved) as BotChannelKey[]) {
        const settings = resolved[channelKey];
        if (settings) {
          botService.updateChannelSettings(req.params.id, channelKey, settings);
        }
      }
    }

    const bot = botService.updateBot(req.params.id, botInput, systemActor());

    if (rolePolicy) {
      botService.updateRolePolicy(req.params.id, rolePolicy);
    }

    if (rolePersonas !== undefined) {
      botService.updateRolePersonas(req.params.id, rolePersonas);
    }

    invalidateBotRuntimesIfNeeded(bot.id, { persona: botInput.persona, rolePersonas, rolePolicy });
    await reconcileChannelConnections(
      bot,
      preUpdateSettingsSnapshot,
      preUpdateActiveWorkspaceIdSnapshot,
    );
    res.json({ bot: redactBot(bot) });
  } catch (error) {
    const mapped = mapBotError(error);
    console.error('Failed to update bot:', error);
    res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
  }
});

// DELETE /api/bots/:id
router.delete('/:id', async (req, res) => {
  try {
    const bot = botService.getBot(req.params.id);
    if (!bot) {
      res.status(404).json({ error: 'Bot not found' });
      return;
    }

    wecomBotService.disconnectBot(req.params.id);
    feishuBotService.disconnectBot(req.params.id);

    const deleted = botService.deleteBot(req.params.id, systemActor());
    if (!deleted) {
      res.status(404).json({ error: 'Bot not found' });
      return;
    }
    res.status(204).send();
  } catch (error) {
    const mapped = mapBotError(error);
    console.error('Failed to delete bot:', error);
    res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
  }
});

// POST /api/bots/:id/active-workspace
router.post('/:id/active-workspace', async (req, res) => {
  try {
    const { workspaceId } = req.body as { workspaceId?: unknown };
    if (!workspaceId || typeof workspaceId !== 'string') {
      res.status(400).json({ error: 'workspaceId is required' });
      return;
    }

    const preUpdateSettings = botService.getChannelSettings(req.params.id);
    const preUpdateActiveWorkspaceId = botService.getBot(req.params.id)?.activeWorkspaceId;
    const bot = botService.setActiveWorkspace(req.params.id, workspaceId, systemActor());
    await reconcileChannelConnections(bot, preUpdateSettings, preUpdateActiveWorkspaceId);
    res.json({ bot: redactBot(bot) });
  } catch (error) {
    const mapped = mapBotError(error);
    console.error('Failed to switch active workspace:', error);
    res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
  }
});

// POST /api/bots/:id/members
router.post('/:id/members', (req, res) => {
  try {
    const { channel, channelUserId, role } = req.body as {
      channel?: unknown;
      channelUserId?: unknown;
      role?: unknown;
    };
    if (!channel || (channel !== 'wecom' && channel !== 'feishu')) {
      res.status(400).json({ error: 'channel must be wecom or feishu' });
      return;
    }
    if (!channelUserId || typeof channelUserId !== 'string') {
      res.status(400).json({ error: 'channelUserId is required' });
      return;
    }
    if (!role || (role !== 'owner' && role !== 'admin' && role !== 'normal')) {
      res.status(400).json({ error: 'role must be owner, admin, or normal' });
      return;
    }

    const member = botService.addMember(
      req.params.id,
      { channelKey: channel, channelUserId, roleKey: role },
      systemActor(),
    );
    chatService.scheduleRebuildsForBot(req.params.id);
    res.status(201).json({ member });
  } catch (error) {
    const mapped = mapBotError(error);
    console.error('Failed to add bot member:', error);
    res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
  }
});

// PUT /api/bots/:id/members/:channelUserId/role
router.put('/:id/members/:channelUserId/role', (req, res) => {
  try {
    const { role } = req.body as { role?: unknown };
    if (!role || (role !== 'owner' && role !== 'admin' && role !== 'normal')) {
      res.status(400).json({ error: 'role must be owner, admin, or normal' });
      return;
    }

    const { channel } = req.query as { channel?: unknown };
    if (!channel || (channel !== 'wecom' && channel !== 'feishu')) {
      res.status(400).json({ error: 'channel query parameter must be wecom or feishu' });
      return;
    }

    botService.setMemberRole(
      req.params.id,
      channel,
      req.params.channelUserId,
      role,
      systemActor(),
    );
    chatService.scheduleRebuildsForBot(req.params.id);
    res.status(204).send();
  } catch (error) {
    const mapped = mapBotError(error);
    console.error('Failed to set bot member role:', error);
    res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
  }
});

// DELETE /api/bots/:id/members/:channelUserId
router.delete('/:id/members/:channelUserId', (req, res) => {
  try {
    const { channel } = req.query as { channel?: unknown };
    if (!channel || (channel !== 'wecom' && channel !== 'feishu')) {
      res.status(400).json({ error: 'channel query parameter must be wecom or feishu' });
      return;
    }

    botService.removeMember(req.params.id, channel, req.params.channelUserId, systemActor());
    chatService.scheduleRebuildsForBot(req.params.id);
    res.status(204).send();
  } catch (error) {
    const mapped = mapBotError(error);
    console.error('Failed to remove bot member:', error);
    res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
  }
});

// POST /api/bots/:id/members/resolve-pending
router.post('/:id/members/resolve-pending', async (req, res) => {
  try {
    const result = await botService.resolvePendingMembers(req.params.id);
    res.json(result);
  } catch (error) {
    const mapped = mapBotError(error);
    console.error('Failed to resolve pending members:', error);
    res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
  }
});

// PUT /api/bots/:id/members/:channelUserId/plaintext
router.put('/:id/members/:channelUserId/plaintext', (req, res) => {
  try {
    const { channel } = req.query as { channel?: unknown };
    if (!channel || (channel !== 'wecom' && channel !== 'feishu')) {
      res.status(400).json({ error: 'channel query parameter must be wecom or feishu' });
      return;
    }

    const { plaintextUserId } = req.body as {
      plaintextUserId?: unknown;
    };
    if (!plaintextUserId || typeof plaintextUserId !== 'string') {
      res.status(400).json({ error: 'plaintextUserId is required' });
      return;
    }

    const member = botService.setMemberPlaintext(
      req.params.id,
      channel,
      req.params.channelUserId,
      plaintextUserId,
    );
    chatService.scheduleRebuildsForBot(req.params.id);
    res.json({ member });
  } catch (error) {
    const mapped = mapBotError(error);
    console.error('Failed to set member plaintext:', error);
    res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
  }
});

// GET /api/bots/:id/status
router.get('/:id/status', (req, res) => {
  try {
    const bot = botService.getBot(req.params.id);
    if (!bot) {
      res.status(404).json({ error: 'Bot not found' });
      return;
    }
    const wecomStatus = wecomBotService.getBotStatus(req.params.id);
    const feishuStatus = feishuBotService.getBotStatus(req.params.id);
    const errors: { wecom?: string; feishu?: string } = {};
    if (wecomStatus === 'error') {
      errors.wecom = sanitizeChannelError(wecomBotService.getChannelError(req.params.id));
    }
    if (feishuStatus === 'error') {
      errors.feishu = sanitizeChannelError(feishuBotService.getChannelError(req.params.id));
    }
    res.json({
      wecom: wecomStatus,
      feishu: feishuStatus,
      ...(Object.keys(errors).length > 0 && { errors }),
    });
  } catch (error) {
    console.error('Failed to get bot status:', error);
    res.status(500).json({ error: 'Failed to get bot status' });
  }
});

// POST /api/bots/:id/channels/:channelKey/reconnect
router.post('/:id/channels/:channelKey/reconnect', async (req, res) => {
  try {
    const bot = botService.getBot(req.params.id);
    if (!bot) {
      res.status(404).json({ error: 'Bot not found' });
      return;
    }

    const channelKey = req.params.channelKey;
    if (channelKey !== 'wecom' && channelKey !== 'feishu') {
      res.status(400).json({ error: 'channelKey must be wecom or feishu' });
      return;
    }

    const allSettings = botService.getChannelSettings(req.params.id);
    const channelSettings = allSettings[channelKey];
    if (!channelSettings?.enabled) {
      res.status(400).json({ error: 'Channel is disabled' });
      return;
    }

    const credential = channelSettings as Record<string, unknown>;
    const primarySecret = channelKey === 'wecom' ? credential.botSecret : credential.appSecret;
    const primaryId = channelKey === 'wecom' ? credential.botId : credential.appId;
    if (typeof primaryId !== 'string' || !primaryId.trim() || typeof primarySecret !== 'string' || !primarySecret.trim()) {
      res.status(400).json({ error: 'Missing credentials' });
      return;
    }

    const rateLimitKey = `${req.params.id}:${channelKey}`;
    const now = Date.now();
    const lastAttempt = reconnectRateLimits.get(rateLimitKey) ?? 0;
    if (now - lastAttempt < RECONNECT_RATE_LIMIT_MS) {
      res.status(429).json({ error: 'Too many reconnect attempts' });
      return;
    }
    reconnectRateLimits.set(rateLimitKey, now);

    const actor = systemActor();
    botService.getAuditLogger().log(req.params.id, actor, 'channel_reconnect_requested', { channelKey });

    if (channelKey === 'wecom') {
      wecomBotService.disconnectChannel(req.params.id, channelKey);
      await wecomBotService.connectChannel(req.params.id, channelKey);
    } else {
      feishuBotService.disconnectChannel(req.params.id, channelKey);
      await feishuBotService.connectChannel(req.params.id, channelKey);
    }

    const wecomStatus = wecomBotService.getBotStatus(req.params.id);
    const feishuStatus = feishuBotService.getBotStatus(req.params.id);
    const errors: { wecom?: string; feishu?: string } = {};
    if (wecomStatus === 'error') {
      errors.wecom = sanitizeChannelError(wecomBotService.getChannelError(req.params.id));
    }
    if (feishuStatus === 'error') {
      errors.feishu = sanitizeChannelError(feishuBotService.getChannelError(req.params.id));
    }

    const failed = channelKey === 'wecom' ? wecomStatus === 'error' : feishuStatus === 'error';
    if (failed) {
      botService.getAuditLogger().log(req.params.id, actor, 'channel_reconnect_failed', {
        channelKey,
        error: errors[channelKey],
      });
      res.status(502).json({
        wecom: wecomStatus,
        feishu: feishuStatus,
        ...(Object.keys(errors).length > 0 && { errors }),
      });
      return;
    }

    botService.getAuditLogger().log(req.params.id, actor, 'channel_reconnect_succeeded', { channelKey });
    res.json({
      wecom: wecomStatus,
      feishu: feishuStatus,
      ...(Object.keys(errors).length > 0 && { errors }),
    });
  } catch (error) {
    console.error('Failed to reconnect channel:', error);
    res.status(500).json({ error: 'Failed to reconnect channel' });
  }
});

// POST /api/bots/migrate
router.post('/migrate', async (req, res) => {
  try {
    const { dryRun } = req.body as { dryRun?: unknown };
    const migrationService = new BotMigrationService(workspaceStore);
    const result = await migrationService.migrate({ dryRun: dryRun === true });
    res.json({ result });
  } catch (error) {
    console.error('Failed to run bot migration:', error);
    res.status(500).json({ error: 'Failed to run bot migration' });
  }
});

async function connectEnabledChannels(bot: import('../models/bot.js').Bot): Promise<void> {
  const channelSettings = botService.getChannelSettings(bot.id);
  await ensureWecomPluginForBot(bot.id, channelSettings);
  if (channelSettings.wecom?.enabled) {
    await wecomBotService.connectBot({ ...bot, channelSettings } as import('../models/bot.js').Bot & { channelSettings: import('../models/bot.js').BotChannelSettings }).catch((err) => {
      console.error(`[BotsRoute] WeCom connect failed for bot ${bot.id}:`, err);
    });
  }
  if (channelSettings.feishu?.enabled) {
    await feishuBotService.connectBot({ ...bot, channelSettings } as import('../models/bot.js').Bot & { channelSettings: import('../models/bot.js').BotChannelSettings }).catch((err) => {
      console.error(`[BotsRoute] Feishu connect failed for bot ${bot.id}:`, err);
    });
  }
}

function getEffectiveCredentials(
  settings: BotChannelSettings,
  channelKey: BotChannelKey,
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  if (channelKey === 'wecom') {
    const cfg = settings.wecom;
    if (!cfg) return result;
    result.botId = cfg.botId;
    result.botSecret = cfg.botSecret;
    result.corpId = cfg.corpId;
    result.corpSecret = cfg.corpSecret;
  } else {
    const cfg = settings.feishu;
    if (!cfg) return result;
    result.appId = cfg.appId;
    result.appSecret = cfg.appSecret;
    result.encryptKey = cfg.encryptKey;
    result.verificationToken = cfg.verificationToken;
  }
  return result;
}

function effectiveCredentialsChanged(
  pre: BotChannelSettings,
  post: BotChannelSettings,
  channelKey: BotChannelKey,
): boolean {
  const preCreds = getEffectiveCredentials(pre, channelKey);
  const postCreds = getEffectiveCredentials(post, channelKey);
  const keys = new Set([...Object.keys(preCreds), ...Object.keys(postCreds)]);
  for (const key of keys) {
    if (preCreds[key] !== postCreds[key]) return true;
  }
  return false;
}

async function reconcileChannelConnections(
  bot: import('../models/bot.js').Bot,
  preUpdateSettings?: BotChannelSettings,
  preUpdateActiveWorkspaceId?: string | null,
): Promise<void> {
  const channelSettings = botService.getChannelSettings(bot.id);
  await ensureWecomPluginForBot(bot.id, channelSettings);

  for (const channelKey of ['wecom', 'feishu'] as BotChannelKey[]) {
    const service = channelKey === 'wecom' ? wecomBotService : feishuBotService;
    const enabled = !!channelSettings[channelKey]?.enabled;
    const wasEnabled = !!preUpdateSettings?.[channelKey]?.enabled;
    const status = service.getBotStatus(bot.id);

    if (enabled) {
      const credentialsChanged =
        preUpdateSettings !== undefined &&
        effectiveCredentialsChanged(preUpdateSettings, channelSettings, channelKey);
      if (!wasEnabled || status === 'not_configured' || credentialsChanged) {
        try {
          service.disconnectChannel(bot.id, channelKey);
        } catch (err) {
          console.error(`[BotsRoute] ${channelKey} disconnect failed for bot ${bot.id}:`, err);
        }
        await service.connectChannel(bot.id, channelKey).catch((err) => {
          console.error(`[BotsRoute] ${channelKey} connect failed for bot ${bot.id}:`, err);
        });
      } else if (bot.activeWorkspaceId && preUpdateActiveWorkspaceId !== bot.activeWorkspaceId) {
        await service.updateConnectionForBot(bot.id, bot.activeWorkspaceId);
      } else if (preUpdateSettings === undefined && bot.activeWorkspaceId) {
        await service.updateConnectionForBot(bot.id, bot.activeWorkspaceId);
      }
    } else {
      service.disconnectChannel(bot.id, channelKey);
    }
  }
}

async function ensureWecomPluginForBot(botId: string, channelSettings: import('../models/bot.js').BotChannelSettings): Promise<void> {
  if (!channelSettings.wecom?.enabled) {
    return;
  }
  const bot = botService.getBot(botId);
  if (!bot?.activeWorkspaceId) {
    return;
  }
  try {
    await builtinPluginService.ensureWecomPluginInstalled(bot.activeWorkspaceId);
  } catch (err) {
    console.error(
      `[BotsRoute] Failed to ensure wecom plugin for bot ${botId} / workspace ${bot.activeWorkspaceId}:`,
      err,
    );
  }
}

export default router;
