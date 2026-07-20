import { wecomBotService } from './services/wecom-bot-service.js';
import { feishuBotService } from './services/feishu-bot-service.js';
import { wecomQueueWorker } from './services/wecom-queue-worker.js';
import { wecomUserResolver } from './services/wecom-user-resolver.js';
import { gitChangesService } from './services/git-changes-service.js';
import { chatService } from './services/chat-service.js';
import { browserService } from './services/browser-service.js';
import { browserViewerProxy } from './routes/browser-proxy.js';

/**
 * Graceful service teardown for sidecar shutdown (SIGTERM/SIGINT and the
 * loopback-only POST /shutdown endpoint the Tauri layer calls before
 * force-kill). Extracted from server-main so the sequence is unit-testable.
 *
 * Ordering: the viewer proxy stops first (its in-flight viewer sockets are
 * destroyed, so dying Steel processes cannot hang the close), then every
 * Steel browser tree is SIGKILLed within browserService.shutdown's parallel
 * bounded stop (KTD-1 2s budget), and only then are chat runtimes closed.
 */
export async function teardownServices(): Promise<void> {
  wecomBotService.disconnectAll();
  feishuBotService.disconnect();
  await wecomQueueWorker.shutdown();
  await wecomUserResolver.shutdown();
  await gitChangesService.dispose();
  await browserViewerProxy.stop();
  await browserService.shutdown();
  await chatService.closeAllRuntimes();
}
