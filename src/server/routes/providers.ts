import { Router } from 'express';
import { store } from '../storage/sqlite-store.js';
import { ChatError } from '../services/chat-service.js';
import { detectProviderConfig } from '../services/provider-detection.js';
import type { CreateProviderInput, UpdateProviderInput } from '../models/provider.js';

const router = Router();

const HEALTH_CHECK_TIMEOUT_MS = 5000;

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

// GET /api/providers
router.get('/', (_req, res) => {
  try {
    const providers = store.listProviders();
    res.json({ providers });
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
    res.status(201).json({ provider });
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

    const nameExists = store.getProviderByName(input.name.trim());
    if (nameExists) {
      res.status(409).json({ error: 'A provider with this name already exists.' });
      return;
    }

    const health = await runHealthCheck(input.baseUrl, input.authToken);
    if (!health.ok) {
      res.status(422).json({ error: health.error || 'Health check failed.' });
      return;
    }

    const provider = store.createProvider(input);
    res.status(201).json({ provider });
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

    // Run health check if baseUrl or authToken changed
    const baseUrl = input.baseUrl ?? existing.baseUrl;
    const authToken = input.authToken ?? existing.authToken;
    if (input.baseUrl !== undefined || input.authToken !== undefined) {
      const health = await runHealthCheck(baseUrl, authToken);
      if (!health.ok) {
        res.status(422).json({ error: health.error || 'Health check failed.' });
        return;
      }
    }

    const provider = store.updateProvider(id, input);
    res.json({ provider });
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

export default router;
