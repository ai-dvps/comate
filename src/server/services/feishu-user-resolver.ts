import * as lark from '@larksuiteoapi/node-sdk';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { diagLog } from '../utils/diag-logger.js';

function tid(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}...` : id;
}

function redactedError(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  let message = err.message;
  // Redact Feishu open_ids and user_ids, plus any token/credential fragments.
  message = message.replace(/\bou_[a-zA-Z0-9_-]+\b/g, '<open_id>');
  message = message.replace(/\buser_[a-zA-Z0-9_-]+\b/g, '<user_id>');
  message = message.replace(/access_token=[^&\s]+/g, 'access_token=<redacted>');
  message = message.replace(/appId=[^&\s]+/gi, 'appId=<redacted>');
  message = message.replace(/appSecret=[^&\s]+/gi, 'appSecret=<redacted>');
  const redacted = new Error(message);
  redacted.name = err.name;
  redacted.stack = err.stack;
  return redacted;
}

interface FeishuBasicUser {
  user_id?: string;
  open_id?: string;
  name?: string;
}

/**
 * Resolve and cache human-readable display names for Feishu users.
 *
 * The resolver is cache-first and fire-and-forget: it checks the local store
 * first, then calls Feishu's contact API for uncached users. Errors are
 * swallowed so message handling is never blocked; the UI will show the user
 * as "pending" until a name is cached.
 */
export class FeishuUserResolver {
  async resolveImmediate(
    workspaceId: string,
    openId: string,
    larkClient: lark.Client,
  ): Promise<{ userId: string; name: string }> {
    const existing = workspaceStore.getFeishuWorkspaceUser(workspaceId, openId);
    if (existing?.userId && existing?.name) {
      diagLog(`[FeishuUserResolver] Immediate workspace=${workspaceId} user=${tid(openId)} cached=true`);
      return { userId: existing.userId, name: existing.name };
    }

    diagLog(`[FeishuUserResolver] Immediate workspace=${workspaceId} user=${tid(openId)} resolving`);

    if (!larkClient) {
      throw new Error('No lark client available');
    }

    const response = (await larkClient.contact.user.basicBatch({
      data: { user_ids: [openId] },
      params: { user_id_type: 'open_id' },
    })) as { data?: { users?: FeishuBasicUser[] } };

    const user = response?.data?.users?.[0];
    if (user?.name) {
      workspaceStore.setFeishuWorkspaceUserName(
        workspaceId,
        openId,
        user.name,
        user.user_id ?? null,
      );
      diagLog(`[FeishuUserResolver] Immediate workspace=${workspaceId} user=${tid(openId)} name=${user.name}`);
    }

    if (user?.user_id && user?.name) {
      return { userId: user.user_id, name: user.name };
    }

    throw new Error('Feishu user name/user_id not found in response');
  }

  async resolveOnMessage(
    workspaceId: string,
    openId: string,
    larkClient: lark.Client,
  ): Promise<void> {
    try {
      await this.resolveImmediate(workspaceId, openId, larkClient);
    } catch (err) {
      diagLog('[FeishuUserResolver] resolution failed:', redactedError(err));
      // Swallow: message handling must continue with a pending name.
    }
  }
}

export const feishuUserResolver = new FeishuUserResolver();
