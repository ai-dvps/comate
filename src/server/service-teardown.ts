import { wecomBotService } from './services/wecom-bot-service.js';
import { feishuBotService } from './services/feishu-bot-service.js';
import { wecomQueueWorker } from './services/wecom-queue-worker.js';
import { todoSchedulerService } from './services/todo-scheduler-service.js';
import { runNotifier } from './services/run-notifier.js';
import { wecomUserResolver } from './services/wecom-user-resolver.js';
import { gitChangesService } from './services/git-changes-service.js';
import { chatService } from './services/chat-service.js';
import { browserService } from './services/browser-service.js';
import { shutdown as shutdownGithubAuth } from './services/github-auth.js';

/**
 * Graceful service teardown for sidecar shutdown (SIGTERM/SIGINT and the
 * loopback-only POST /shutdown endpoint the shell calls before force-kill).
 * Extracted from server-main so the sequence is unit-testable.
 *
 * Ordering: every live browser view is destroyed within
 * browserService.shutdown's parallel bounded stop (KTD-1 2s budget) before
 * chat runtimes are closed.
 */
export async function teardownServices(): Promise<void> {
  // Zero the GitHub token holder first (R13/KTD3) — cheap, and ensures the
  // decrypted token never outlives the sidecar process.
  shutdownGithubAuth();
  wecomBotService.disconnectAll();
  feishuBotService.disconnect();
  await wecomQueueWorker.shutdown();
  await todoSchedulerService.shutdown();
  await runNotifier.shutdown();
  await wecomUserResolver.shutdown();
  await gitChangesService.dispose();
  await browserService.shutdown();
  await chatService.closeAllRuntimes();
}
