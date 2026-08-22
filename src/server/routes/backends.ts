/**
 * Backend info routes (U5): expose the agent-backend registry to the client —
 * per-backend availability (binary + health check) and the resolved
 * capability declaration table, plus the persisted app-level default.
 */

import { Router } from 'express';
import {
  BACKEND_IDS,
  getBackendAvailability,
  getDefaultBackend,
  listBackendCapabilities,
  setDefaultBackend,
  type BackendId,
} from '../services/agent-backends.js';
import { codexAccountService } from '../services/codex-account-service.js';
import type { GetAccountResponse } from '../generated/codex-protocol/v2/GetAccountResponse.js';
import type { LoginAccountParams } from '../generated/codex-protocol/v2/LoginAccountParams.js';
import type { LoginAccountResponse } from '../generated/codex-protocol/v2/LoginAccountResponse.js';
import type { ModelListResponse } from '../generated/codex-protocol/v2/ModelListResponse.js';

export interface BackendRouteDeps {
  codexAccount: {
    read(): Promise<GetAccountResponse>;
    login(params: LoginAccountParams): Promise<LoginAccountResponse>;
    cancelLogin(loginId: string): Promise<void>;
    logout(): Promise<void>;
    listModels(): Promise<ModelListResponse>;
  };
}

const DEFAULT_DEPS: BackendRouteDeps = { codexAccount: codexAccountService };

export function createBackendRouter(overrides: Partial<BackendRouteDeps> = {}): Router {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const router = Router();

// GET /api/backends — availability + capability table per backend
router.get('/', async (_req, res) => {
  try {
    const backends = await Promise.all(
      BACKEND_IDS.map(async (id) => ({
        id,
        availability: await getBackendAvailability(id),
        capabilities: listBackendCapabilities(id),
      })),
    );
    res.json({ backends });
  } catch (error) {
    console.error('Failed to list backends:', error);
    res.status(500).json({ error: 'Failed to list backends' });
  }
});

// GET /api/backends/default
// The app-level default agent is 'claude' until the user explicitly picks one,
// so the selector/settings always show a real default rather than "nothing
// selected" (which forced a click before chatting).
router.get('/default', async (_req, res) => {
  try {
    const backend = await getDefaultBackend();
    res.json({ backend: backend ?? 'claude' });
  } catch (error) {
    console.error('Failed to read default backend:', error);
    res.status(500).json({ error: 'Failed to read default backend' });
  }
});

// PUT /api/backends/default { backend }
router.put('/default', async (req, res) => {
  try {
    const backend = req.body?.backend as BackendId | undefined;
    if (!BACKEND_IDS.includes(backend as BackendId)) {
      res.status(400).json({ error: "backend must be 'claude', 'opencode', or 'codex'" });
      return;
    }
    await setDefaultBackend(backend as BackendId);
    res.json({ backend });
  } catch (error) {
    console.error('Failed to set default backend:', error);
    res.status(500).json({ error: 'Failed to set default backend' });
  }
});

// Codex account mutations remain behind the app-wide desktop credential. The
// loopback auth middleware rejects session capability tokens before they reach
// these handlers.
router.get('/codex/account', async (_req, res) => {
  try {
    res.json(await deps.codexAccount.read());
  } catch (error) {
    codexAccountFailure('read account', error, res);
  }
});

router.post('/codex/login', async (req, res) => {
  const type = req.body?.type;
  let params: LoginAccountParams;
  if (type === 'chatgpt') {
    params = {
      type: 'chatgpt',
      codexStreamlinedLogin: true,
      useHostedLoginSuccessPage: true,
    };
  } else if (type === 'apiKey') {
    const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
    if (!apiKey || apiKey.length > 20_000) {
      res.status(400).json({ error: 'A valid OpenAI API key is required' });
      return;
    }
    params = { type: 'apiKey', apiKey };
  } else {
    res.status(400).json({ error: "type must be 'chatgpt' or 'apiKey'" });
    return;
  }

  try {
    res.json(await deps.codexAccount.login(params));
  } catch (error) {
    codexAccountFailure('start login', error, res);
  }
});

router.post('/codex/login/cancel', async (req, res) => {
  const loginId = typeof req.body?.loginId === 'string' ? req.body.loginId.trim() : '';
  if (!loginId) {
    res.status(400).json({ error: 'loginId is required' });
    return;
  }
  try {
    await deps.codexAccount.cancelLogin(loginId);
    res.json({ ok: true });
  } catch (error) {
    codexAccountFailure('cancel login', error, res);
  }
});

router.post('/codex/logout', async (_req, res) => {
  try {
    await deps.codexAccount.logout();
    res.json({ ok: true });
  } catch (error) {
    codexAccountFailure('log out', error, res);
  }
});

router.get('/codex/models', async (_req, res) => {
  try {
    res.json(await deps.codexAccount.listModels());
  } catch (error) {
    codexAccountFailure('list models', error, res);
  }
});

  return router;
}

function codexAccountFailure(
  action: string,
  error: unknown,
  res: { status(code: number): { json(body: unknown): void } },
): void {
  const kind = error instanceof Error ? error.name : 'UnknownError';
  console.error(`[backends] Failed to ${action}: ${kind}`);
  res.status(503).json({
    error: 'Codex account service is unavailable. Check the Codex runtime and try again.',
  });
}

export default createBackendRouter();
