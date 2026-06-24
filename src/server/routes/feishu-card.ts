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

/**
 * Extract the operator open_id and event_key from an `application.bot.menu_v6`
 * event payload. The SDK nests the user id under `operator.operator_id.open_id`
 * (NOT `operator.open_id`); this helper centralizes that path so it is tested
 * in one place.
 */
export function extractMenuEvent(data: Record<string, unknown>): {
  openId: string;
  eventKey: string | undefined;
} {
  const operator = data.operator as { operator_id?: { open_id?: string } } | undefined;
  const openId = operator?.operator_id?.open_id ?? '';
  const eventKey = typeof data.event_key === 'string' ? data.event_key : undefined;
  return { openId, eventKey };
}

function readEventType(body: Record<string, unknown>): string | undefined {
  const header = body.header;
  if (header && typeof header === 'object') {
    const type = (header as Record<string, unknown>).event_type;
    if (typeof type === 'string') return type;
  }
  return undefined;
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

    const eventType = readEventType(body);
    diagLog(
      `[FeishuCardRoute] event received workspaceId=${workspaceId} type=${eventType ?? '(unknown)'}`,
    );

    // Menu events need app credentials to build a DM client for the reply.
    // Encryption is NOT required here: it is optional on Feishu, and the SDK's
    // checkIsEventValidated already bypasses signature verification when the
    // encrypt key is empty — the same posture card-action handling relies on,
    // so menu events must not be stricter than the rest of the endpoint.
    if (eventType === 'application.bot.menu_v6') {
      const appId = workspace.settings.feishuAppId?.trim();
      const appSecret = workspace.settings.feishuAppSecret?.trim();
      if (!appId || !appSecret) {
        const missing = [
          !appId && 'feishuAppId',
          !appSecret && 'feishuAppSecret',
        ]
          .filter(Boolean)
          .join(', ');
        diagLog(
          `[FeishuCardRoute] menu event rejected: missing ${missing} for workspace ${workspaceId}`,
        );
        res.status(400).json({ error: 'Workspace Feishu app credentials are not configured' });
        return;
      }
      diagLog(`[FeishuCardRoute] menu event admitted for workspace ${workspaceId}`);
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
      'application.bot.menu_v6': async (data: Record<string, unknown>) => {
        const { openId, eventKey } = extractMenuEvent(data);
        diagLog(
          `[FeishuCardRoute] menu_v6 received openId=${openId || '(missing)'} key=${(eventKey ?? '').slice(0, 40)}`,
        );

        // Credentials are guaranteed present: the route-level guard above
        // rejected menu events for workspaces missing appId/appSecret. Build a
        // fresh client per callback (KTD2) so the correct workspace's
        // credentials are used, independent of the singleton service connection.
        const menuClient = new lark.Client({
          appId: workspace.settings.feishuAppId!.trim(),
          appSecret: workspace.settings.feishuAppSecret!.trim(),
          appType: lark.AppType.SelfBuild,
          loggerLevel: lark.LoggerLevel.error,
        });

        // Fire-and-forget: respond to Feishu immediately so it does not retry
        // (a retry would re-enter runForUser and could create a duplicate
        // session). The DM send is serialized per user inside handleMenuEvent,
        // and its own error handling reports failures back to the user.
        diagLog(`[FeishuCardRoute] menu_v6 dispatching to handleMenuEvent openId=${openId || '(missing)'}`);
        feishuBotService.handleMenuEvent(menuClient, workspace, openId, eventKey).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          diagLog(`[FeishuCardRoute] menu handler error: ${message}`);
        });
        return { toast: { type: 'success', content: '已处理。' } };
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
