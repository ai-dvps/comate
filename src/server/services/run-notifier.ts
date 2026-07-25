import { store as defaultStore, type SqliteStore } from '../storage/sqlite-store.js';
import { schedulerEvents, type SchedulerRunEvent } from './scheduler-service.js';
import { wecomBotService } from './wecom-bot-service.js';
import { diagLog } from '../utils/diag-logger.js';

const SUMMARY_MAX_CHARS = 500;

interface WecomSenderLike {
  sendScheduledTaskSummary(workspaceId: string, wecomUserId: string, markdown: string): Promise<boolean>;
}

interface RunNotifierDeps {
  store?: SqliteStore;
  wecomSender?: WecomSenderLike;
}

/**
 * Run-result fanout (R16): subscribes to the scheduler's run-finished events
 * and pushes an optional result summary to WeCom (KTD-7 — plain markdown
 * text only, no interactive cards). Desktop notifications and the in-app
 * unread badge are driven client-side from the WebSocket relay of the same
 * scheduler events; this service owns the server-side channel.
 */
export class RunNotifier {
  private readonly store: SqliteStore;
  private readonly wecomSender: WecomSenderLike;
  private readonly onRunFinished = (event: SchedulerRunEvent): void => {
    void this.handleRunFinished(event).catch((err) => {
      console.error('[RunNotifier] failed to deliver run summary:', err);
      diagLog(`[RunNotifier] delivery error: ${err}`);
    });
  };

  constructor(deps: RunNotifierDeps = {}) {
    this.store = deps.store ?? defaultStore;
    this.wecomSender = deps.wecomSender ?? wecomBotService;
  }

  initialize(): void {
    schedulerEvents.on('run-finished', this.onRunFinished);
  }

  async shutdown(): Promise<void> {
    schedulerEvents.off('run-finished', this.onRunFinished);
  }

  private async handleRunFinished(event: SchedulerRunEvent): Promise<void> {
    if (event.status !== 'succeeded' && event.status !== 'failed') return;
    const task = this.store.getScheduledTask(event.taskId);
    if (!task || !task.notifyWecom) return;

    const recipient = await this.resolveRecipient(task.workspaceId, task.wecomRecipient);
    if (!recipient) {
      diagLog(`[RunNotifier] task ${event.taskId} has notifyWecom but no resolvable recipient; skipped`);
      return;
    }

    const summary = this.buildSummary(event);
    const ok = await this.wecomSender.sendScheduledTaskSummary(event.workspaceId, recipient, summary);
    diagLog(`[RunNotifier] run ${event.runId} wecom summary to ${recipient}: ${ok ? 'sent' : 'failed'}`);
  }

  private async resolveRecipient(workspaceId: string, configured: string | null): Promise<string | null> {
    if (configured) return configured;
    const workspace = await this.store.get(workspaceId);
    const admins = workspace?.settings.wecomBotIsolation?.adminUserIds;
    return admins && admins.length > 0 ? admins[0] : null;
  }

  private buildSummary(event: SchedulerRunEvent): string {
    const statusText = event.status === 'succeeded' ? '✅ 执行成功' : '❌ 执行失败';
    const body = (event.resultText ?? event.reason ?? '（无结果摘要）').trim();
    const truncated = body.length > SUMMARY_MAX_CHARS ? `${body.slice(0, SUMMARY_MAX_CHARS)}…` : body;
    return `**定时任务${statusText}**：${event.taskName}\n\n${truncated}`;
  }
}

export const runNotifier = new RunNotifier();
