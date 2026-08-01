/**
 * bot-escalation-notifier (U11) — the seam between the permission gate
 * (chat-service) and the channel card layer (wecom-bot-service; Feishu card
 * alignment is deferred). The gate must not import channel services
 * (circularity), so it publishes escalation lifecycle events here and channel
 * services subscribe.
 *
 * Two events:
 * - pending:  an admins-audience ledger row was just created → channel
 *   delivers actionable cards to the recipients.
 * - resolved: an admins-audience row settled (approve/deny/expiry, any
 *   source: card click, desktop funnel, TTL) → channel delivers terminal
 *   notification cards to the requester and the non-clicking recipients
 *   (the vendor API cannot terminate non-clicked cards server-side).
 *
 * Listeners are synchronous-fire-and-forget: they return Promises the
 * notifier deliberately does not await (the gate's ask is already pending;
 * card delivery must never block the permission decision). Listener errors
 * are logged, never propagated.
 */

import type { BotEscalationEntry } from '../storage/sqlite-store.js';
import { diagLog } from '../utils/diag-logger.js';

export type BotEscalationPendingListener = (entry: BotEscalationEntry) => void | Promise<void>;
export type BotEscalationResolvedListener = (entry: BotEscalationEntry) => void | Promise<void>;

const pendingListeners = new Set<BotEscalationPendingListener>();
const resolvedListeners = new Set<BotEscalationResolvedListener>();

/** Subscribe to admins-audience escalation creation. Returns an unsubscribe. */
export function subscribeEscalationPending(listener: BotEscalationPendingListener): () => void {
  pendingListeners.add(listener);
  return () => pendingListeners.delete(listener);
}

/** Subscribe to admins-audience escalation settlement. Returns an unsubscribe. */
export function subscribeEscalationResolved(listener: BotEscalationResolvedListener): () => void {
  resolvedListeners.add(listener);
  return () => resolvedListeners.delete(listener);
}

function settlePromise(label: string, requestId: string, promise: void | Promise<void>): void {
  if (promise && typeof promise.then === 'function') {
    promise.catch((err: unknown) => {
      diagLog(
        `[BotEscalationNotifier] ${label} listener rejected requestId=${requestId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
}

/** Fire-and-forget pending notification (called by the gate after createPending). */
export function notifyEscalationPending(entry: BotEscalationEntry): void {
  for (const listener of pendingListeners) {
    try {
      settlePromise('pending', entry.id, listener(entry));
    } catch (err) {
      diagLog(
        `[BotEscalationNotifier] pending listener threw requestId=${entry.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Fire-and-forget resolution notification (called by the gate continuation). */
export function notifyEscalationResolved(entry: BotEscalationEntry): void {
  for (const listener of resolvedListeners) {
    try {
      settlePromise('resolved', entry.id, listener(entry));
    } catch (err) {
      diagLog(
        `[BotEscalationNotifier] resolved listener threw requestId=${entry.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
