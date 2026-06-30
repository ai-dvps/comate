import { Router } from 'express';
import { botService } from '../services/bot-service.js';
import { chatService } from '../services/chat-service.js';
import { wecomBotService } from '../services/wecom-bot-service.js';
import { feishuBotService } from '../services/feishu-bot-service.js';
import { BotMigrationService } from '../services/bot-migration-service.js';
import { builtinPluginService } from '../services/builtin-plugin-service.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { ENCRYPTED_PROVIDER_KEYS } from '../models/bot.js';
import type { BotProviderSettings, CreateBotInput, UpdateBotInput } from '../models/bot.js';
import {
  BotAuthorizationError,
  BotNotFoundError,
  BotValidationError,
  BotWorkspaceBoundError,
  type BotActor,
} from '../services/bot-service.js';

const router = Router();

function systemActor(): BotActor {
  return { type: 'system' };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidateBotRuntimesIfNeeded(botId: string, input: UpdateBotInput): void {
  if (input.persona !== undefined || input.rolePersonas !== undefined || input.rolePolicy !== undefined) {
    chatService.closeRuntimesForBot(botId).catch((err) => {
      console.error(`Failed to invalidate runtimes for bot ${botId}:`, err);
    });
  }
}

function redactProviderConfig(config: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (ENCRYPTED_PROVIDER_KEYS.includes(key)) {
      result[key] = typeof value === 'string' && value.length > 0 ? true : undefined;
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function redactProviderSettings(settings: BotProviderSettings): BotProviderSettings {
  const result: BotProviderSettings = {};
  if (isPlainObject(settings.wecom)) {
    result.wecom = redactProviderConfig(settings.wecom) as BotProviderSettings['wecom'];
  }
  if (isPlainObject(settings.feishu)) {
    result.feishu = redactProviderConfig(settings.feishu) as BotProviderSettings['feishu'];
  }
  return result;
}

function redactBot(bot: import('../models/bot.js').Bot) {
  return {
    ...bot,
    providerSettings: redactProviderSettings(bot.providerSettings),
  };
}

function mapBotError(error: unknown): { status: number; message: string; code?: string } {
  if (error instanceof BotNotFoundError) {
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
  input: BotProviderSettings,
  existing: BotProviderSettings,
): BotProviderSettings {
  const result: BotProviderSettings = {};
  for (const provider of ['wecom', 'feishu'] as const) {
    const incoming = input[provider];
    if (!incoming) continue;
    const current = existing[provider] ?? {};
    const merged: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(incoming)) {
      if (ENCRYPTED_PROVIDER_KEYS.includes(key) && value === true) {
        merged[key] = (current as Record<string, unknown>)[key];
      } else {
        merged[key] = value;
      }
    }
    result[provider] = merged as BotProviderSettings[typeof provider];
  }
  return result;
}

// POST /api/bots
router.post('/', async (req, res) => {
  try {
    const input = req.body as CreateBotInput;
    if (!input.name || typeof input.name !== 'string' || input.name.trim() === '') {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    const bot = botService.createBot(input);
    await connectEnabledProviders(bot);
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
    const input = req.body as UpdateBotInput;
    if (input.providerSettings) {
      const existing = botService.getBot(req.params.id);
      input.providerSettings = resolveSentinelCredentials(
        input.providerSettings,
        existing?.providerSettings ?? {},
      );
    }
    const bot = botService.updateBot(req.params.id, input, systemActor());
    invalidateBotRuntimesIfNeeded(bot.id, input);
    await reconcileProviderConnections(bot);
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

    const bot = botService.setActiveWorkspace(req.params.id, workspaceId, systemActor());
    await reconcileProviderConnections(bot);
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
    const { provider, providerUserId, role } = req.body as {
      provider?: unknown;
      providerUserId?: unknown;
      role?: unknown;
    };
    if (!provider || (provider !== 'wecom' && provider !== 'feishu')) {
      res.status(400).json({ error: 'provider must be wecom or feishu' });
      return;
    }
    if (!providerUserId || typeof providerUserId !== 'string') {
      res.status(400).json({ error: 'providerUserId is required' });
      return;
    }
    if (!role || (role !== 'owner' && role !== 'admin' && role !== 'normal')) {
      res.status(400).json({ error: 'role must be owner, admin, or normal' });
      return;
    }

    const member = botService.addMember(
      req.params.id,
      { provider, providerUserId, role },
      systemActor(),
    );
    chatService.closeRuntimesForBot(req.params.id).catch((err) => {
      console.error(`Failed to invalidate runtimes for bot ${req.params.id}:`, err);
    });
    res.status(201).json({ member });
  } catch (error) {
    const mapped = mapBotError(error);
    console.error('Failed to add bot member:', error);
    res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
  }
});

// PUT /api/bots/:id/members/:providerUserId/role
router.put('/:id/members/:providerUserId/role', (req, res) => {
  try {
    const { role } = req.body as { role?: unknown };
    if (!role || (role !== 'owner' && role !== 'admin' && role !== 'normal')) {
      res.status(400).json({ error: 'role must be owner, admin, or normal' });
      return;
    }

    const { provider } = req.query as { provider?: unknown };
    if (!provider || (provider !== 'wecom' && provider !== 'feishu')) {
      res.status(400).json({ error: 'provider query parameter must be wecom or feishu' });
      return;
    }

    botService.setMemberRole(
      req.params.id,
      provider,
      req.params.providerUserId,
      role,
      systemActor(),
    );
    chatService.closeRuntimesForBot(req.params.id).catch((err) => {
      console.error(`Failed to invalidate runtimes for bot ${req.params.id}:`, err);
    });
    res.status(204).send();
  } catch (error) {
    const mapped = mapBotError(error);
    console.error('Failed to set bot member role:', error);
    res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
  }
});

// DELETE /api/bots/:id/members/:providerUserId
router.delete('/:id/members/:providerUserId', (req, res) => {
  try {
    const { provider } = req.query as { provider?: unknown };
    if (!provider || (provider !== 'wecom' && provider !== 'feishu')) {
      res.status(400).json({ error: 'provider query parameter must be wecom or feishu' });
      return;
    }

    botService.removeMember(req.params.id, provider, req.params.providerUserId, systemActor());
    chatService.closeRuntimesForBot(req.params.id).catch((err) => {
      console.error(`Failed to invalidate runtimes for bot ${req.params.id}:`, err);
    });
    res.status(204).send();
  } catch (error) {
    const mapped = mapBotError(error);
    console.error('Failed to remove bot member:', error);
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
    res.json({
      status: {
        wecom: wecomBotService.getBotStatus(req.params.id),
        feishu: feishuBotService.getBotStatus(req.params.id),
      },
    });
  } catch (error) {
    console.error('Failed to get bot status:', error);
    res.status(500).json({ error: 'Failed to get bot status' });
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

async function connectEnabledProviders(bot: import('../models/bot.js').Bot): Promise<void> {
  await ensureWecomPluginForBot(bot);
  if (bot.providerSettings.wecom?.enabled) {
    await wecomBotService.connectBot(bot).catch((err) => {
      console.error(`[BotsRoute] WeCom connect failed for bot ${bot.id}:`, err);
    });
  }
  if (bot.providerSettings.feishu?.enabled) {
    await feishuBotService.connectBot(bot).catch((err) => {
      console.error(`[BotsRoute] Feishu connect failed for bot ${bot.id}:`, err);
    });
  }
}

async function reconcileProviderConnections(bot: import('../models/bot.js').Bot): Promise<void> {
  await ensureWecomPluginForBot(bot);
  if (bot.providerSettings.wecom?.enabled) {
    const status = wecomBotService.getBotStatus(bot.id);
    if (status === 'not_configured') {
      await wecomBotService.connectBot(bot).catch((err) => {
        console.error(`[BotsRoute] WeCom connect failed for bot ${bot.id}:`, err);
      });
    } else if (bot.activeWorkspaceId) {
      await wecomBotService.updateConnectionForBot(bot.id, bot.activeWorkspaceId);
    }
  } else {
    wecomBotService.disconnectBot(bot.id);
  }

  if (bot.providerSettings.feishu?.enabled) {
    const status = feishuBotService.getBotStatus(bot.id);
    if (status === 'not_configured') {
      await feishuBotService.connectBot(bot).catch((err) => {
        console.error(`[BotsRoute] Feishu connect failed for bot ${bot.id}:`, err);
      });
    } else if (bot.activeWorkspaceId) {
      await feishuBotService.updateConnectionForBot(bot.id, bot.activeWorkspaceId);
    }
  } else {
    feishuBotService.disconnectBot(bot.id);
  }
}

async function ensureWecomPluginForBot(bot: import('../models/bot.js').Bot): Promise<void> {
  if (!bot.providerSettings.wecom?.enabled || !bot.activeWorkspaceId) {
    return;
  }
  try {
    await builtinPluginService.ensureWecomPluginInstalled(bot.activeWorkspaceId);
  } catch (err) {
    console.error(
      `[BotsRoute] Failed to ensure wecom plugin for bot ${bot.id} / workspace ${bot.activeWorkspaceId}:`,
      err,
    );
  }
}

export default router;
