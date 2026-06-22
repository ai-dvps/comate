import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import * as lark from '@larksuiteoapi/node-sdk';
import { store } from '../storage/sqlite-store.js';
import { feishuCardActionHandler } from '../services/feishu-card-action-handler.js';
import { feishuBotService } from '../services/feishu-bot-service.js';
import { diagLog } from '../utils/diag-logger.js';

interface RawBodyRequest extends Request {
  rawBody?: string;
}

function rawBodyMiddleware(req: RawBodyRequest, res: Response, next: NextFunction): void {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    req.rawBody = Buffer.concat(chunks).toString('utf8');
    next();
  });
  req.on('error', (err) => next(err));
}

export function parseCardActionValue(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object') {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore malformed JSON
    }
  }
  return null;
}

function buildDispatcherInput(
  req: RawBodyRequest,
  body: Record<string, unknown>,
): Record<string, unknown> {
  // Mirror the SDK's own adaptors: body fields are own enumerable properties,
  // headers live on the prototype so they are excluded from JSON.stringify
  // during signature verification but remain accessible as data.headers.
  return Object.assign(Object.create({ headers: req.headers }), body);
}

async function handleCardCallback(
  req: RawBodyRequest,
  res: Response,
  workspaceId: string,
): Promise<void> {
  try {
    diagLog(`[FeishuCardRoute] callback received workspaceId=${workspaceId} path=${req.path}`);

    const workspace = await store.get(workspaceId);
    if (!workspace) {
      diagLog(`[FeishuCardRoute] workspace not found: ${workspaceId}`);
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    if (!workspace.settings.feishuBotEnabled) {
      diagLog(`[FeishuCardRoute] Feishu bot disabled for workspace: ${workspaceId}`);
      res.status(403).json({ error: 'Feishu bot is not enabled for this workspace' });
      return;
    }

    const encryptKey = workspace.settings.feishuEncryptKey ?? '';
    const verificationToken = workspace.settings.feishuVerificationToken ?? '';

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(req.rawBody ?? '{}') as Record<string, unknown>;
    } catch {
      diagLog('[FeishuCardRoute] invalid JSON body');
      res.status(400).json({ error: 'Invalid JSON body' });
      return;
    }

    const dispatcher = new lark.EventDispatcher({ encryptKey, verificationToken });
    dispatcher.register({
      url_verification: (data: Record<string, unknown>) => {
        diagLog('[FeishuCardRoute] url_verification challenge');
        return { challenge: data.challenge };
      },
      'card.action.trigger': async (data: Record<string, unknown>) => {
        const normalized = lark.normalizeCardAction(data);
        if (!normalized) {
          diagLog('[FeishuCardRoute] normalizeCardAction returned null');
          return { toast: { type: 'error', content: '无法解析卡片操作。' } };
        }
        diagLog(
          `[FeishuCardRoute] action operator=${normalized.operator.openId} tag=${normalized.action.tag} name=${normalized.action.name ?? ''}`,
        );
        const rawValue = normalized.action?.value;
        const value = parseCardActionValue(rawValue);
        if (!value) {
          diagLog(`[FeishuCardRoute] action value missing or unparseable: ${typeof rawValue}`);
          return { toast: { type: 'error', content: '卡片操作缺少参数。' } };
        }
        diagLog(`[FeishuCardRoute] action payload: ${JSON.stringify(value)}`);
        try {
          return await feishuCardActionHandler.handle(normalized.operator.openId, value as never, {
            setActiveWorkspace: (workspaceId: string) => feishuBotService.setActiveWorkspace(workspaceId),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          diagLog(`[FeishuCardRoute] action handler error: ${message}`);
          return { toast: { type: 'error', content: '处理操作失败。' } };
        }
      },
    });

    const response = await dispatcher.invoke(buildDispatcherInput(req, body));

    if (response === undefined) {
      diagLog('[FeishuCardRoute] EventDispatcher returned undefined (likely verification failed)');
      res.json({ toast: { type: 'success', content: '已处理。' } });
      return;
    }

    if (typeof response === 'string' && response.startsWith('no ')) {
      diagLog(`[FeishuCardRoute] ${response}`);
      res.json({ toast: { type: 'success', content: '已处理。' } });
      return;
    }

    diagLog(`[FeishuCardRoute] callback response: ${JSON.stringify(response)}`);
    res.json(response);
  } catch (error) {
    console.error('[FeishuCardRoute] card callback error:', error);
    res.status(500).json({ error: 'Failed to process card action' });
  }
}

const router = Router();

// Backward-compatible per-workspace callback URL.
router.post('/:workspaceId', rawBodyMiddleware, async (req: RawBodyRequest, res: Response) => {
  await handleCardCallback(req, res, req.params.workspaceId);
});

// Simple callback URL that matches the setup checklist. Uses the active Feishu
// workspace binding's credentials for signature verification.
router.post('/', rawBodyMiddleware, async (req: RawBodyRequest, res: Response) => {
  const activeWorkspaceId = store.getFeishuActiveWorkspace();
  if (!activeWorkspaceId) {
    diagLog('[FeishuCardRoute] root callback rejected: no active Feishu workspace binding');
    res.status(400).json({ error: 'No active Feishu workspace binding' });
    return;
  }
  diagLog(`[FeishuCardRoute] root callback using active workspace: ${activeWorkspaceId}`);
  await handleCardCallback(req, res, activeWorkspaceId);
});

export default router;
