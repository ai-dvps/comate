import { store as workspaceStore } from '../storage/sqlite-store.js';

interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}

interface RetryMeta {
  attempts: number;
  nextRetry: number;
}

const FLUSH_INTERVAL_MS = 30_000;
const MAX_QUEUE_DEPTH = 1000;
const BATCH_SIZE = 100;
const MAX_RETRY_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 30_000;
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes
const SHUTDOWN_FLUSH_TIMEOUT_MS = 5000;
const MESSAGE_RESOLVE_TIMEOUT_MS = 3000;

export class WeComUserIdResolver {
  private tokenCache = new Map<string, TokenCacheEntry>();
  private tokenRefreshInFlight = new Map<string, Promise<string>>();
  private queue = new Map<string, Set<string>>();
  private retryMeta = new Map<string, Map<string, RetryMeta>>();
  private flushTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;

  initialize(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this.flushAll(), FLUSH_INTERVAL_MS);
    // Prevent the timer from keeping the process alive indefinitely
    if (typeof this.flushTimer.unref === 'function') {
      this.flushTimer.unref();
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Flush remaining queued IDs with a bounded timeout
    const flushPromise = this.flushAll();
    const timeoutPromise = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('Shutdown flush timeout')), SHUTDOWN_FLUSH_TIMEOUT_MS),
    );

    try {
      await Promise.race([flushPromise, timeoutPromise]);
    } catch {
      console.warn('[WeComUserIdResolver] Shutdown flush timed out, remaining queue dropped');
    }

    this.tokenRefreshInFlight.clear();
  }

  /**
   * Check if a mapping exists; if not, queue the encrypted ID for batch resolution.
   * This is a fire-and-forget operation intended for the message handling path.
   * It swallows errors so message processing is never blocked.
   */
  async resolveOnMessage(workspaceId: string, encryptedUserId: string): Promise<void> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), MESSAGE_RESOLVE_TIMEOUT_MS);

      try {
        const existing = workspaceStore.getWecomUserMapping(encryptedUserId);
        if (existing) return;
        this.queueId(workspaceId, encryptedUserId);
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      // Silently degrade: message handling continues with the encrypted ID
    }
  }

  /**
   * Track that a WeCom user has sent a message to a workspace.
   * This is a synchronous, fire-and-forget operation.
   */
  trackWorkspaceUser(workspaceId: string, encryptedUserId: string): void {
    try {
      workspaceStore.setWecomWorkspaceUser(workspaceId, encryptedUserId);
    } catch {
      // Silently degrade: tracking failure must not block message handling
    }
  }

  /**
   * Immediately resolve an encrypted user ID.
   * Checks the mapping table first, then falls back to a single-ID API call.
   * On failure, throws an error. The ID is NOT re-queued.
   */
  async resolveImmediate(workspaceId: string, encryptedUserId: string): Promise<string> {
    const existing = workspaceStore.getWecomUserMapping(encryptedUserId);
    if (existing) return existing;

    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace?.settings.wecomCorpId || !workspace.settings.wecomCorpSecret) {
      throw new Error('WeCom corp credentials are not configured for this workspace');
    }

    const token = await this.getToken(workspaceId);
    const result = await this.callBatchApi(token, [encryptedUserId]);

    const mapping = result.mappings.find((m) => m.encryptedUserId === encryptedUserId);
    if (!mapping) {
      throw new Error('Failed to resolve WeCom user ID immediately');
    }

    workspaceStore.setWecomUserMapping(mapping.encryptedUserId, mapping.plaintextUserId);
    this.removeFromQueue(workspaceId, encryptedUserId);
    return mapping.plaintextUserId;
  }

  private queueId(workspaceId: string, encryptedUserId: string): void {
    if (this.shuttingDown) return;

    let wsQueue = this.queue.get(workspaceId);
    if (!wsQueue) {
      wsQueue = new Set();
      this.queue.set(workspaceId, wsQueue);
    }

    if (wsQueue.size >= MAX_QUEUE_DEPTH) {
      console.warn(`[WeComUserIdResolver] Queue depth limit reached for workspace ${workspaceId}, dropping ID`);
      return;
    }

    wsQueue.add(encryptedUserId);
  }

  private removeFromQueue(workspaceId: string, encryptedUserId: string): void {
    const wsQueue = this.queue.get(workspaceId);
    if (wsQueue) {
      wsQueue.delete(encryptedUserId);
      if (wsQueue.size === 0) {
        this.queue.delete(workspaceId);
      }
    }
    const wsRetry = this.retryMeta.get(workspaceId);
    if (wsRetry) {
      wsRetry.delete(encryptedUserId);
      if (wsRetry.size === 0) {
        this.retryMeta.delete(workspaceId);
      }
    }
  }

  private async flushAll(): Promise<void> {
    for (const [workspaceId] of this.queue) {
      try {
        await this.flushWorkspace(workspaceId);
      } catch (err) {
        console.error(`[WeComUserIdResolver] Flush failed for workspace ${workspaceId}:`, this.redactedError(err));
      }
    }
  }

  private async flushWorkspace(workspaceId: string): Promise<void> {
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace?.settings.wecomCorpId || !workspace.settings.wecomCorpSecret) {
      // No credentials configured; drop the queue to avoid infinite retries
      this.queue.delete(workspaceId);
      this.retryMeta.delete(workspaceId);
      return;
    }

    const wsQueue = this.queue.get(workspaceId);
    if (!wsQueue || wsQueue.size === 0) return;

    const now = Date.now();
    const readyIds: string[] = [];
    const wsRetry = this.retryMeta.get(workspaceId) ?? new Map<string, RetryMeta>();

    for (const id of wsQueue) {
      const meta = wsRetry.get(id);
      if (!meta || meta.nextRetry <= now) {
        readyIds.push(id);
        if (readyIds.length >= BATCH_SIZE) break;
      }
    }

    if (readyIds.length === 0) return;

    const token = await this.getToken(workspaceId);
    const result = await this.callBatchApi(token, readyIds);

    // Store successful mappings (global across workspaces)
    for (const mapping of result.mappings) {
      workspaceStore.setWecomUserMapping(mapping.encryptedUserId, mapping.plaintextUserId);
      this.removeFromQueue(workspaceId, mapping.encryptedUserId);
    }

    // Handle failures with retry backoff
    for (const id of result.failedIds) {
      let meta = wsRetry.get(id);
      if (!meta) {
        meta = { attempts: 0, nextRetry: now };
        wsRetry.set(id, meta);
      }
      meta.attempts += 1;
      if (meta.attempts > MAX_RETRY_ATTEMPTS) {
        console.warn(`[WeComUserIdResolver] Dropping ID after ${MAX_RETRY_ATTEMPTS} failed attempts for workspace ${workspaceId}`);
        this.removeFromQueue(workspaceId, id);
        continue;
      }
      const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (meta.attempts - 1), BACKOFF_MAX_MS);
      meta.nextRetry = now + backoff;
    }

    if (wsRetry.size > 0) {
      this.retryMeta.set(workspaceId, wsRetry);
    }
  }

  private async getToken(workspaceId: string): Promise<string> {
    const cached = this.tokenCache.get(workspaceId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.token;
    }

    const inFlight = this.tokenRefreshInFlight.get(workspaceId);
    if (inFlight) return inFlight;

    const refreshPromise = this.fetchToken(workspaceId);
    this.tokenRefreshInFlight.set(workspaceId, refreshPromise);

    try {
      const token = await refreshPromise;
      return token;
    } finally {
      this.tokenRefreshInFlight.delete(workspaceId);
    }
  }

  private async fetchToken(workspaceId: string): Promise<string> {
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace?.settings.wecomCorpId || !workspace.settings.wecomCorpSecret) {
      throw new Error('WeCom corp credentials are not configured for this workspace');
    }

    const corpId = workspace.settings.wecomCorpId;
    const corpSecret = workspace.settings.wecomCorpSecret;
    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(corpSecret)}`;

    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) {
      throw new Error(`gettoken HTTP error: ${response.status}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    if (data.errcode !== 0) {
      throw new Error(`gettoken API error: ${data.errcode} - ${data.errmsg}`);
    }

    const token = String(data.access_token);
    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 7200;
    const expiresAt = Date.now() + expiresIn * 1000 - TOKEN_EXPIRY_BUFFER_MS;

    this.tokenCache.set(workspaceId, { token, expiresAt });
    return token;
  }

  private async callBatchApi(
    token: string,
    encryptedUserIds: string[],
  ): Promise<{ mappings: Array<{ encryptedUserId: string; plaintextUserId: string }>; failedIds: string[] }> {
    const url = `https://qyapi.weixin.qq.com/cgi-bin/batch/openuserid_to_userid?access_token=${encodeURIComponent(token)}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ open_userid_list: encryptedUserIds }),
    });

    if (!response.ok) {
      throw new Error(`batch API HTTP error: ${response.status}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    if (data.errcode !== 0) {
      throw new Error(`batch API error: ${data.errcode} - ${data.errmsg}`);
    }

    const mappings: Array<{ encryptedUserId: string; plaintextUserId: string }> = [];
    const failedIds: string[] = [];

    const resultList = Array.isArray(data.open_userid_list) ? data.open_userid_list : [];
    for (const item of resultList) {
      if (
        item &&
        typeof item === 'object' &&
        typeof (item as Record<string, unknown>).open_userid === 'string' &&
        typeof (item as Record<string, unknown>).userid === 'string'
      ) {
        mappings.push({
          encryptedUserId: (item as Record<string, unknown>).open_userid as string,
          plaintextUserId: (item as Record<string, unknown>).userid as string,
        });
      }
    }

    const invalidList = Array.isArray(data.invalid_open_userid_list) ? data.invalid_open_userid_list : [];
    for (const id of invalidList) {
      if (typeof id === 'string') {
        failedIds.push(id);
      }
    }

    // Any IDs not returned in either list are treated as failed
    const returnedIds = new Set([...mappings.map((m) => m.encryptedUserId), ...failedIds]);
    for (const id of encryptedUserIds) {
      if (!returnedIds.has(id)) {
        failedIds.push(id);
      }
    }

    return { mappings, failedIds };
  }

  private redactedError(err: unknown): unknown {
    if (err instanceof Error) {
      // Replace potential sensitive values in the message
      let message = err.message;
      message = message.replace(/access_token=[^&\s]+/g, 'access_token=<redacted>');
      message = message.replace(/corpid=[^&\s]+/g, 'corpid=<redacted>');
      message = message.replace(/corpsecret=[^&\s]+/g, 'corpsecret=<redacted>');
      return { ...err, message };
    }
    return err;
  }
}

export const wecomUserResolver = new WeComUserIdResolver();
