import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import * as lark from '@larksuiteoapi/node-sdk';
import { store } from '../storage/sqlite-store.js';
import { feishuCardActionHandler } from '../services/feishu-card-action-handler.js';

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

const router = Router();

router.post(
  '/:workspaceId',
  rawBodyMiddleware,
  async (req: RawBodyRequest, res: Response) => {
    try {
      const workspace = await store.get(req.params.workspaceId);
      if (!workspace) {
        res.status(404).json({ error: 'Workspace not found' });
        return;
      }
      if (!workspace.settings.feishuBotEnabled) {
        res.status(403).json({ error: 'Feishu bot is not enabled for this workspace' });
        return;
      }

      const encryptKey = workspace.settings.feishuEncryptKey ?? '';
      const verificationToken = workspace.settings.feishuVerificationToken ?? '';

      let body: Record<string, unknown>;
      try {
        body = JSON.parse(req.rawBody ?? '{}') as Record<string, unknown>;
      } catch {
        res.status(400).json({ error: 'Invalid JSON body' });
        return;
      }

      const cardHandler = new lark.CardActionHandler(
        { encryptKey, verificationToken },
        async (data: Record<string, unknown>) => {
          const normalized = lark.normalizeCardAction(data);
          if (!normalized) {
            return { toast: { type: 'error', content: '无法解析卡片操作。' } };
          }
          const value = normalized.action?.value as Record<string, unknown> | undefined;
          if (!value) {
            return { toast: { type: 'error', content: '卡片操作缺少参数。' } };
          }
          return feishuCardActionHandler.handle(normalized.operator.openId, value as never);
        },
      );

      const response = await cardHandler.invoke({
        headers: req.headers,
        ...body,
      });

      res.json(response ?? { toast: { type: 'success', content: '已处理。' } });
    } catch (error) {
      console.error('[FeishuCardRoute] card callback error:', error);
      res.status(500).json({ error: 'Failed to process card action' });
    }
  },
);

export default router;
