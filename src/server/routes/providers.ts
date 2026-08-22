import { Router } from 'express';
import { store } from '../storage/sqlite-store.js';
import { ChatError } from '../services/chat-service.js';
import { chatService } from '../services/chat-service.js';
import { detectProviderConfig } from '../services/provider-detection.js';
import { kimiUsageService } from '../services/kimi-usage-service.js';
import { bigModelUsageService } from '../services/bigmodel-usage-service.js';
import { providerUsageLoginService, UsageLoginError } from '../services/provider-usage-login-service.js';
import type { CreateProviderInput, UpdateProviderInput, Provider } from '../models/provider.js';

const router = Router();

const HEALTH_CHECK_TIMEOUT_MS = 5000;

type PublicProvider = Omit<Provider, 'authToken'> & { authTokenPresent: boolean };

export function publicProvider(provider: Provider): PublicProvider {
  const { authToken, ...safe } = provider;
  return { ...safe, protocol: provider.protocol ?? 'anthropic', authTokenPresent: authToken.length > 0 };
}

function validProtocol(value: unknown): value is Provider['protocol'] {
  return value === 'anthropic' || value === 'openai-responses';
}

async function runHealthCheck(baseUrl: string, authToken: string): Promise<{ ok: boolean; error?: string }> {
  const trimmedBase = baseUrl.replace(/\/$/, '');
  const urlsToTry = [`${trimmedBase}/v1/models`, trimmedBase];

  for (const url of urlsToTry) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

      const response = await fetch(url, {
        method: url.endsWith('/v1/models') ? 'GET' : 'HEAD',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.status === 401 || response.status === 403) {
        return { ok: false, error: 'Authentication failed — check your auth token.' };
      }

      if (response.ok || response.status < 500) {
        // Any reachable response <500 is considered healthy enough
        return { ok: true };
      }
    } catch (err) {
      // Try next URL
      continue;
    }
  }

  return { ok: false, error: 'Provider endpoint is unreachable — check the base URL and network.' };
}

function hasSnapshottedProviderChange(input: UpdateProviderInput, existing: Provider): boolean {
  const fields: (keyof Provider & keyof UpdateProviderInput)[] = [
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
    if (!input.baseUrl || typeof input.baseUrl !== 'string' || input.baseUrl.trim().length === 0) {
      res.status(400).json({ error: 'baseUrl is required' });
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
      const health = await runHealthCheck(input.baseUrl, input.authToken);
      if (!health.ok) {
        res.status(422).json({ error: health.error || 'Health check failed.' });
        return;
      }
    }

    const provider = store.createProvider(input);
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
    const baseUrl = input.baseUrl ?? existing.baseUrl;
    const authToken = input.authToken ?? existing.authToken;
    if (!input.skipHealthCheck && (input.baseUrl !== undefined || input.authToken !== undefined)) {
      const health = await runHealthCheck(baseUrl, authToken);
      if (!health.ok) {
        res.status(422).json({ error: health.error || 'Health check failed.' });
        return;
      }
    }

    const provider = store.updateProvider(id, input);
    if (existing && hasSnapshottedProviderChange(input, existing)) {
      chatService.scheduleRebuildsForProvider(id);
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
    const success = store.deleteProvider(id);
    if (!success) {
      res.status(404).json({ error: 'Provider not found' });
      return;
    }
    chatService.scheduleRebuildsForProvider(id);
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

    const health = await runHealthCheck(provider.baseUrl, provider.authToken);
    res.json({ ok: health.ok, error: health.error });
  } catch (error) {
    console.error('Failed to run health check:', error);
    res.status(500).json({ error: 'Failed to run health check' });
  }
});

// POST /api/providers/:id/usage — coding-plan usage (server-side only).
// Dispatches to the right service by provider baseUrl.
router.post('/:id/usage', async (req, res) => {
  try {
    const id = req.params.id;
    const provider = store.getProvider(id);
    if (!provider) {
      res.status(404).json({ error: 'Provider not found' });
      return;
    }
    const url = provider.baseUrl.toLowerCase();
    const result = url.includes('kimi.com')
      ? await kimiUsageService.runUsageCheck(id)
      : url.includes('bigmodel.cn')
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
