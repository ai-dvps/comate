import { Router } from 'express';
import { store } from '../storage/sqlite-store.js';
import { ChatError } from '../services/chat-service.js';
import { chatService } from '../services/chat-service.js';
import { detectProviderConfig } from '../services/provider-detection.js';
import { kimiUsageService } from '../services/kimi-usage-service.js';
import { bigModelUsageService } from '../services/bigmodel-usage-service.js';
import { providerUsageLoginService, UsageLoginError } from '../services/provider-usage-login-service.js';
import type { CreateProviderInput, UpdateProviderInput, Provider } from '../models/provider.js';
import type { BackendId } from '../services/agent-backends.js';
import { BrowserDirectHttpClient } from '../services/browser-direct-http-client.js';
import { applyProviderPreset, listProviderPresets, providerVendorFromProvenance } from '../services/provider-presets.js';
import { effectiveProviderResourceUrl, providerAvailability, resolveProviderForAgent } from '../services/provider-resolver.js';
import { commandsService } from '../services/commands-service.js';

const router = Router();

const HEALTH_CHECK_TIMEOUT_MS = 5000;

export interface PublicProvider {
  id: string;
  name: string;
  configuration?: Provider['configuration'];
  isDefault: boolean;
  authTokenPresent: boolean;
  createdAt: string;
  updatedAt: string;
  availability: ReturnType<typeof providerAvailability>;
}

function publicConfiguration(configuration: NonNullable<Provider['configuration']>): NonNullable<Provider['configuration']> {
  const anthropic = configuration.endpoints.anthropic;
  const openai = configuration.endpoints.openai;
  return {
    schemaVersion: 1,
    endpoints: {
      ...(anthropic ? { anthropic: { enabled: anthropic.enabled, baseUrl: anthropic.baseUrl } } : {}),
      ...(openai ? { openai: { enabled: openai.enabled, baseUrl: openai.baseUrl, format: openai.format } } : {}),
    },
    models: {
      ...(configuration.models.claudeCode ? { claudeCode: configuration.models.claudeCode } : {}),
      ...(configuration.models.codex ? { codex: configuration.models.codex } : {}),
      ...(configuration.models.openCode ? { openCode: configuration.models.openCode } : {}),
    },
    openCode: { protocol: configuration.openCode.protocol },
    claude: {
      ...(configuration.claude.defaultOpusModel ? { defaultOpusModel: configuration.claude.defaultOpusModel } : {}),
      ...(configuration.claude.defaultSonnetModel ? { defaultSonnetModel: configuration.claude.defaultSonnetModel } : {}),
      ...(configuration.claude.defaultHaikuModel ? { defaultHaikuModel: configuration.claude.defaultHaikuModel } : {}),
      ...(configuration.claude.subagentModel ? { subagentModel: configuration.claude.subagentModel } : {}),
      ...(configuration.claude.effortLevel ? { effortLevel: configuration.claude.effortLevel } : {}),
      ...(configuration.claude.customEnvVars
        ? { customEnvVars: Object.fromEntries(Object.entries(configuration.claude.customEnvVars).map(([key, value]) => [key, value])) }
        : {}),
    },
    codex: {
      ...(configuration.codex.promptCacheRouting ? { promptCacheRouting: configuration.codex.promptCacheRouting } : {}),
      ...(configuration.codex.thinking ? { thinking: configuration.codex.thinking } : {}),
      ...(configuration.codex.effortByModel ? { effortByModel: structuredClone(configuration.codex.effortByModel) } : {}),
      ...(configuration.codex.effortWireMappingByModel
        ? { effortWireMappingByModel: structuredClone(configuration.codex.effortWireMappingByModel) }
        : {}),
    },
    ...(configuration.preset ? { preset: { id: configuration.preset.id, version: configuration.preset.version } } : {}),
  };
}

export function publicProvider(provider: Provider): PublicProvider {
  return {
    id: provider.id,
    name: provider.name,
    ...(provider.configuration ? { configuration: publicConfiguration(provider.configuration) } : {}),
    isDefault: provider.isDefault,
    authTokenPresent: provider.authToken.length > 0,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
    availability: providerAvailability(provider),
  };
}

function validProtocol(value: unknown): value is Provider['protocol'] {
  return value === 'anthropic' || value === 'openai-responses';
}

export interface ProviderHealthClient {
  request(input: Parameters<BrowserDirectHttpClient['request']>[0]): ReturnType<BrowserDirectHttpClient['request']>;
}

const providerHealthClient = new BrowserDirectHttpClient({
  limits: { totalTimeoutMs: HEALTH_CHECK_TIMEOUT_MS, maxRedirects: 1 },
});

export async function runProviderHealthCheck(
  provider: Provider,
  agent: BackendId,
  client: ProviderHealthClient = providerHealthClient,
): Promise<{ ok: boolean; error?: string; reason?: string }> {
  const resolved = resolveProviderForAgent(provider, agent);
  if (!resolved.available) {
    return { ok: false, error: 'Provider configuration is unavailable for this Agent.', reason: resolved.reason };
  }
  try {
    const result = await client.request({
      url: effectiveProviderResourceUrl(resolved, 'models'),
      method: 'GET',
      redirectPolicy: 'error',
      headers: { accept: 'application/json' },
      prepareHopHeaders: (): Record<string, string> => resolved.mode === 'direct-anthropic'
        ? { 'x-api-key': resolved.credential, 'anthropic-version': '2023-06-01' }
        : { authorization: `Bearer ${resolved.credential}` },
    });
    if (result.status === 401 || result.status === 403) {
      return { ok: false, error: 'Authentication failed — check your auth token.' };
    }
    return result.status < 500
      ? { ok: true }
      : { ok: false, error: 'Provider endpoint is unreachable — check the base URL and network.' };
  } catch {
    return { ok: false, error: 'Provider endpoint is unreachable — check the base URL and network.' };
  }
}

export async function discoverProviderModels(
  provider: Provider,
  agent: BackendId,
  client: ProviderHealthClient = providerHealthClient,
): Promise<{ models: string[]; reason?: string }> {
  const resolved = resolveProviderForAgent(provider, agent);
  if (!resolved.available) return { models: [], reason: resolved.reason };
  try {
    const result = await client.request({
      url: effectiveProviderResourceUrl(resolved, 'models'),
      method: 'GET',
      redirectPolicy: 'error',
      headers: { accept: 'application/json' },
      prepareHopHeaders: (): Record<string, string> => resolved.mode === 'direct-anthropic'
        ? { 'x-api-key': resolved.credential, 'anthropic-version': '2023-06-01' }
        : { authorization: `Bearer ${resolved.credential}` },
    });
    if (result.status < 200 || result.status >= 300) return { models: [] };
    const parsed = JSON.parse(result.body.toString('utf8')) as unknown;
    const root = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    const entries = Array.isArray(root.data) ? root.data : Array.isArray(root.models) ? root.models : [];
    const models = entries.flatMap((entry) => {
      if (typeof entry === 'string') return [entry];
      if (!entry || typeof entry !== 'object') return [];
      const id = (entry as Record<string, unknown>).id;
      return typeof id === 'string' && id.length > 0 ? [id] : [];
    });
    return { models: [...new Set(models)] };
  } catch {
    return { models: [] };
  }
}

function validAgent(value: unknown): value is BackendId {
  return value === 'claude' || value === 'codex' || value === 'opencode';
}

function candidateConfiguration(input: CreateProviderInput): Provider['configuration'] {
  if (input.configuration) return input.configuration;
  if (!input.baseUrl) return undefined;
  const openai = input.protocol === 'openai-responses';
  return {
    schemaVersion: 1,
    endpoints: openai
      ? { openai: { enabled: true, baseUrl: input.baseUrl, format: 'openai-responses' } }
      : { anthropic: { enabled: true, baseUrl: input.baseUrl } },
    models: { claudeCode: input.model, codex: input.model, openCode: input.model },
    openCode: { protocol: openai ? 'openai' : 'anthropic' },
    claude: {},
    codex: {},
  };
}

function candidateProviderForUpdate(existing: Provider, input: UpdateProviderInput): Provider {
  if (input.configuration) return { ...existing, ...input, configuration: input.configuration, authToken: input.authToken ?? existing.authToken };
  const configuration = existing.configuration ? structuredClone(existing.configuration) : undefined;
  if (configuration) {
    if (input.protocol !== undefined) configuration.openCode.protocol = input.protocol === 'openai-responses' ? 'openai' : 'anthropic';
    if (input.baseUrl !== undefined) {
      if ((input.protocol ?? (configuration.openCode.protocol === 'openai' ? 'openai-responses' : 'anthropic')) === 'openai-responses') {
        configuration.endpoints.openai = {
          enabled: true,
          baseUrl: input.baseUrl,
          format: configuration.endpoints.openai?.format ?? 'openai-responses',
        };
      } else {
        configuration.endpoints.anthropic = { enabled: true, baseUrl: input.baseUrl };
      }
    }
    if (input.model !== undefined) {
      configuration.models.claudeCode = input.model;
      configuration.models.codex = input.model;
      configuration.models.openCode = input.model;
    }
  }
  return { ...existing, ...input, configuration, authToken: input.authToken ?? existing.authToken };
}

export function hasSnapshottedProviderChange(input: UpdateProviderInput, existing: Provider): boolean {
  const fields: (keyof Provider & keyof UpdateProviderInput)[] = [
    'configuration',
    'baseUrl',
    'authToken',
    'protocol',
    'model',
    'defaultOpusModel',
    'defaultSonnetModel',
    'defaultHaikuModel',
    'subagentModel',
    'effortLevel',
    'customEnvVars',
  ];
  return fields.some((field) => input[field] !== undefined && input[field] !== existing[field]);
}

export function hasDefaultProviderChange(input: UpdateProviderInput, existing: Provider): boolean {
  return input.isDefault !== undefined && input.isDefault !== existing.isDefault;
}

// GET /api/providers
router.get('/', (_req, res) => {
  try {
    const providers = store.listProviders();
    res.json({ providers: providers.map(publicProvider) });
  } catch (error) {
    console.error('Failed to list providers:', error);
    res.status(500).json({ error: 'Failed to list providers' });
  }
});

router.get('/presets', (_req, res) => {
  res.json({ presets: listProviderPresets() });
});

router.post('/presets/:presetId/apply', (req, res) => {
  const configuration = applyProviderPreset(req.params.presetId);
  if (!configuration) {
    res.status(404).json({ error: 'Provider preset not found' });
    return;
  }
  res.json({ configuration });
});

// POST /api/providers/detect
router.post('/detect', (_req, res) => {
  try {
    const detected = detectProviderConfig();
    if (!detected) {
      res.json({ detected: null });
      return;
    }

    // Check if a provider with this name already exists
    const existing = store.getProviderByName(detected.name);
    if (existing) {
      res.json({ detected: null, message: 'A default provider already exists.' });
      return;
    }

    const provider = store.createProvider(detected);
    commandsService.invalidateProviderConfiguration();
    if (provider.isDefault) chatService.scheduleRebuildsForProvider(provider.id, true);
    res.status(201).json({ provider: publicProvider(provider) });
  } catch (error) {
    console.error('Failed to detect provider:', error);
    res.status(500).json({ error: 'Failed to detect provider' });
  }
});

// POST /api/providers
router.post('/', async (req, res) => {
  try {
    const input = req.body as CreateProviderInput;

    if (!input.name || typeof input.name !== 'string' || input.name.trim().length === 0) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    if (!input.configuration && (!input.baseUrl || typeof input.baseUrl !== 'string' || input.baseUrl.trim().length === 0)) {
      res.status(400).json({ error: 'configuration or baseUrl is required' });
      return;
    }
    if (!input.authToken || typeof input.authToken !== 'string' || input.authToken.trim().length === 0) {
      res.status(400).json({ error: 'authToken is required' });
      return;
    }
    if (input.protocol !== undefined && !validProtocol(input.protocol)) {
      res.status(400).json({ error: "protocol must be 'anthropic' or 'openai-responses'" });
      return;
    }

    const nameExists = store.getProviderByName(input.name.trim());
    if (nameExists) {
      res.status(409).json({ error: 'A provider with this name already exists.' });
      return;
    }

    if (!input.skipHealthCheck) {
      if (!validAgent(req.body?.agent)) {
        res.status(400).json({ error: "agent is required for health checks and must be 'claude', 'codex', or 'opencode'" });
        return;
      }
      const candidate: Provider = {
        id: '__candidate__', name: input.name, configuration: candidateConfiguration(input),
        baseUrl: input.baseUrl ?? '', authToken: input.authToken, protocol: input.protocol,
        model: input.model, isDefault: false, createdAt: '', updatedAt: '',
      };
      const health = await runProviderHealthCheck(candidate, req.body.agent);
      if (!health.ok) {
        res.status(422).json({ error: health.error || 'Health check failed.' });
        return;
      }
    }

    const provider = store.createProvider(input);
    commandsService.invalidateProviderConfiguration();
    if (provider.isDefault) chatService.scheduleRebuildsForProvider(provider.id, true);
    res.status(201).json({ provider: publicProvider(provider) });
  } catch (error) {
    console.error('Failed to create provider:', error);
    if (error instanceof ChatError) {
      res.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
    res.status(500).json({ error: 'Failed to create provider' });
  }
});

// PUT /api/providers/:id
router.put('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const input = req.body as UpdateProviderInput;

    const existing = store.getProvider(id);
    if (!existing) {
      res.status(404).json({ error: 'Provider not found' });
      return;
    }

    if (input.name !== undefined) {
      if (typeof input.name !== 'string' || input.name.trim().length === 0) {
        res.status(400).json({ error: 'name must be a non-empty string' });
        return;
      }
      const nameExists = store.getProviderByName(input.name.trim());
      if (nameExists && nameExists.id !== id) {
        res.status(409).json({ error: 'A provider with this name already exists.' });
        return;
      }
    }
    if (input.protocol !== undefined && !validProtocol(input.protocol)) {
      res.status(400).json({ error: "protocol must be 'anthropic' or 'openai-responses'" });
      return;
    }
    if (input.authToken !== undefined) {
      if (typeof input.authToken !== 'string') {
        res.status(400).json({ error: 'authToken must be a string when provided' });
        return;
      }
      if (input.authToken.trim().length === 0) delete input.authToken;
    }

    // Run health check if baseUrl or authToken changed
    if (!input.skipHealthCheck && (input.configuration !== undefined || input.baseUrl !== undefined || input.authToken !== undefined)) {
      if (!validAgent(req.body?.agent)) {
        res.status(400).json({ error: "agent is required for health checks and must be 'claude', 'codex', or 'opencode'" });
        return;
      }
      const candidate = candidateProviderForUpdate(existing, input);
      const health = await runProviderHealthCheck(candidate, req.body.agent);
      if (!health.ok) {
        res.status(422).json({ error: health.error || 'Health check failed.' });
        return;
      }
    }

    const defaultChanged = hasDefaultProviderChange(input, existing);
    const provider = store.updateProvider(id, input);
    commandsService.invalidateProviderConfiguration();
    if (hasSnapshottedProviderChange(input, existing) || defaultChanged) {
      chatService.scheduleRebuildsForProvider(id, defaultChanged || existing.isDefault || input.isDefault === true);
    }
    res.json({ provider: provider ? publicProvider(provider) : null });
  } catch (error) {
    console.error('Failed to update provider:', error);
    if (error instanceof ChatError) {
      res.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
    res.status(500).json({ error: 'Failed to update provider' });
  }
});

// DELETE /api/providers/:id
router.delete('/:id', (req, res) => {
  try {
    const id = req.params.id;
    const existing = store.getProvider(id);
    const success = store.deleteProvider(id);
    if (!success) {
      res.status(404).json({ error: 'Provider not found' });
      return;
    }
    commandsService.invalidateProviderConfiguration();
    chatService.scheduleRebuildsForProvider(id, existing?.isDefault === true);
    res.json({ ok: true });
  } catch (error) {
    console.error('Failed to delete provider:', error);
    res.status(500).json({ error: 'Failed to delete provider' });
  }
});

// POST /api/providers/:id/health
router.post('/:id/health', async (req, res) => {
  try {
    const id = req.params.id;
    const provider = store.getProvider(id);
    if (!provider) {
      res.status(404).json({ error: 'Provider not found' });
      return;
    }

    const agent = req.body?.agent;
    if (!validAgent(agent)) {
      res.status(400).json({ error: "agent must be 'claude', 'codex', or 'opencode'" });
      return;
    }
    const health = await runProviderHealthCheck(provider, agent);
    res.json({ ok: health.ok, error: health.error });
  } catch (error) {
    console.error('Failed to run health check:', error);
    res.status(500).json({ error: 'Failed to run health check' });
  }
});

router.get('/:id/models', async (req, res) => {
  try {
    const provider = store.getProvider(req.params.id);
    if (!provider) {
      res.status(404).json({ error: 'Provider not found' });
      return;
    }
    const agent = req.query.agent;
    if (!validAgent(agent)) {
      res.status(400).json({ error: "agent query is required and must be 'claude', 'codex', or 'opencode'" });
      return;
    }
    res.json(await discoverProviderModels(provider, agent));
  } catch (error) {
    console.error('Failed to discover provider models:', error);
    res.status(500).json({ error: 'Failed to discover provider models' });
  }
});

// POST /api/providers/:id/usage — coding-plan usage (server-side only).
// Dispatches by immutable stored preset provenance, never by editable URLs.
router.post('/:id/usage', async (req, res) => {
  try {
    const id = req.params.id;
    const provider = store.getProvider(id);
    if (!provider) {
      res.status(404).json({ error: 'Provider not found' });
      return;
    }
    const agent = req.body?.agent;
    if (!validAgent(agent)) {
      res.status(400).json({ error: "agent must be 'claude', 'codex', or 'opencode'" });
      return;
    }
    const resolved = resolveProviderForAgent(provider, agent);
    if (!resolved.available) {
      res.json({ status: 'unsupported', reason: resolved.reason });
      return;
    }
    const vendor = providerVendorFromProvenance(provider.configuration?.preset);
    const result = vendor === 'kimi'
      ? await kimiUsageService.runUsageCheck(id)
      : vendor === 'bigmodel'
        ? await bigModelUsageService.runUsageCheck(id)
        : { status: 'unsupported' as const };
    res.json(result);
  } catch (error) {
    console.error('Failed to fetch provider usage:', error);
    res.status(500).json({ error: 'Failed to fetch provider usage' });
  }
});

// POST /api/providers/:id/usage-login/start — open a transient capture session.
router.post('/:id/usage-login/start', async (req, res) => {
  try {
    const result = await providerUsageLoginService.startLogin(req.params.id);
    res.json(result);
  } catch (error) {
    if (error instanceof UsageLoginError) {
      res.status(400).json({ error: error.message, code: error.code });
      return;
    }
    console.error('Failed to start usage login:', error);
    res.status(500).json({ error: 'Failed to start usage login' });
  }
});

// POST /api/providers/:id/usage-login/finalize — verify origin, extract the JWT,
// store the login in the global site-auth store, and tear the capture session down.
router.post('/:id/usage-login/finalize', async (req, res) => {
  try {
    const result = await providerUsageLoginService.finalizeLogin(req.params.id);
    res.json(result);
  } catch (error) {
    console.error('Failed to finalize usage login:', error);
    res.status(500).json({ error: 'Failed to finalize usage login' });
  }
});

// POST /api/providers/:id/usage-login/cancel — tear down an in-flight capture.
router.post('/:id/usage-login/cancel', async (_req, res) => {
  try {
    await providerUsageLoginService.cancelLogin(_req.params.id);
    res.json({ ok: true });
  } catch (error) {
    console.error('Failed to cancel usage login:', error);
    res.status(500).json({ error: 'Failed to cancel usage login' });
  }
});

export default router;
