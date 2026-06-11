import { store as workspaceStore } from '../storage/sqlite-store.js';
import { chatService } from './chat-service.js';
import type { WeComProactiveMessage, ProactiveMessageStatus } from '../models/wecom-proactive-message.js';

const POLL_INTERVAL_MS = 5_000;
const GRACE_PERIOD_MS = 30_000;
const STALE_DELIVERING_MS = 5 * 60_000; // 5 minutes
const TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12 hours

interface InFlightDispatch {
  timeout: NodeJS.Timeout;
  messageId: string;
}

export class WeComQueueWorker {
  private pollTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private inFlight = new Map<string, InFlightDispatch>();

  initialize(): void {
    if (this.pollTimer) return;
    this.shuttingDown = false;
    // Fire-and-forget stale reconciliation at startup
    this.reconcileStaleDelivering().catch((err) => {
      console.error('[WeComQueueWorker] Reconciliation error:', err);
    });
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    if (typeof this.pollTimer.unref === 'function') {
      this.pollTimer.unref();
    }
    console.log('[WeComQueueWorker] Initialized, poll interval=' + POLL_INTERVAL_MS + 'ms');
  }

  async shutdown(): Promise<void> {
    console.log('[WeComQueueWorker] Shutting down...');
    this.shuttingDown = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    // Cancel in-flight grace periods — they will be reconciled on next startup
    for (const [messageId, inflight] of this.inFlight) {
      clearTimeout(inflight.timeout);
      console.log(`[WeComQueueWorker] Grace period cancelled for ${messageId} during shutdown`);
    }
    this.inFlight.clear();
  }

  private async poll(): Promise<void> {
    if (this.shuttingDown) return;

    try {
      await this.checkTimeouts();
      await this.processWorkspaces();
    } catch (err) {
      console.error('[WeComQueueWorker] Poll error:', err);
    }
  }

  private async checkTimeouts(): Promise<void> {
    const cutoff = new Date(Date.now() - TIMEOUT_MS).toISOString();
    const workspaces = await workspaceStore.list();
    for (const ws of workspaces) {
      const timedOut = workspaceStore.listProactiveMessages(ws.id, 'pending')
        .filter((m) => m.createdAt < cutoff);
      for (const msg of timedOut) {
        workspaceStore.updateProactiveMessage(msg.id, {
          status: 'failed',
          errorReason: 'timeout: message remained pending for over 12 hours',
        });
        console.log(`[WeComQueueWorker] Message ${msg.id} timed out`);
      }
    }
  }

  private async reconcileStaleDelivering(): Promise<void> {
    const cutoff = new Date(Date.now() - STALE_DELIVERING_MS).toISOString();
    const workspaces = await workspaceStore.list();
    for (const ws of workspaces) {
      const stale = workspaceStore.listProactiveMessages(ws.id, 'delivering')
        .filter((m) => !m.claimedAt || m.claimedAt < cutoff);
      for (const msg of stale) {
        workspaceStore.updateProactiveMessage(msg.id, {
          status: 'pending',
          claimedAt: null,
          errorReason: null,
        });
        console.log(`[WeComQueueWorker] Stale delivering message ${msg.id} reset to pending`);
      }
    }
  }

  private async processWorkspaces(): Promise<void> {
    const workspaces = await workspaceStore.list();
    for (const ws of workspaces) {
      if (this.shuttingDown) break;
      await this.processWorkspace(ws.id);
    }
  }

  private async processWorkspace(workspaceId: string): Promise<void> {
    const entry = workspaceStore.claimNextPendingMessage(workspaceId);
    if (!entry) return;

    try {
      const canDispatch = await this.canDispatch(entry);
      if (!canDispatch) {
        // Release claim back to pending
        workspaceStore.updateProactiveMessage(entry.id, {
          status: 'pending',
          claimedAt: null,
        });
        return;
      }

      await this.dispatch(entry);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[WeComQueueWorker] Dispatch failed for ${entry.id}:`, reason);
      workspaceStore.updateProactiveMessage(entry.id, {
        status: 'failed',
        errorReason: reason,
      });
    }
  }

  private async canDispatch(entry: WeComProactiveMessage): Promise<boolean> {
    // Verify the user ID mapping is still present
    const plaintextId = workspaceStore.getWecomUserMapping(entry.recipientEncryptedUserId);
    if (!plaintextId) {
      console.log(`[WeComQueueWorker] Cannot dispatch ${entry.id}: user ID not decrypted yet`);
      return false;
    }

    // Find recipient session
    const sessionId = workspaceStore.getWecomSession(entry.workspaceId, entry.recipientEncryptedUserId);
    if (!sessionId) {
      console.log(`[WeComQueueWorker] Cannot dispatch ${entry.id}: no session for recipient`);
      return false;
    }

    // Check if runtime exists and is busy
    const runtime = chatService.getRuntimeIfExists(sessionId);
    if (runtime && runtime.isProcessingTurn()) {
      console.log(`[WeComQueueWorker] Cannot dispatch ${entry.id}: recipient runtime is busy`);
      return false;
    }

    return true;
  }

  private async dispatch(entry: WeComProactiveMessage): Promise<void> {
    const sessionId = workspaceStore.getWecomSession(entry.workspaceId, entry.recipientEncryptedUserId)!;

    console.log(`[WeComQueueWorker] Dispatching ${entry.id} to session ${sessionId}`);

    const runtime = await chatService.getOrCreateRuntime(sessionId, entry.workspaceId, true);
    runtime.cancelIdleClose();

    const directive = formatProactiveDirective(entry);
    runtime.pushMessage(directive);

    // Grace period: give the agent time to process and send before marking delivered
    const timeout = setTimeout(() => {
      this.inFlight.delete(entry.id);
      workspaceStore.updateProactiveMessage(entry.id, {
        status: 'delivered',
        deliveredAt: new Date().toISOString(),
      });
      console.log(`[WeComQueueWorker] Message ${entry.id} marked delivered after grace period`);
    }, GRACE_PERIOD_MS);

    this.inFlight.set(entry.id, { timeout, messageId: entry.id });
  }
}

export function formatProactiveDirective(entry: WeComProactiveMessage): string {
  return `Send a WeCom message to ${entry.recipientPlaintextUserId}: ${entry.messageContent}`;
}

export const wecomQueueWorker = new WeComQueueWorker();
