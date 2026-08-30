import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, unlinkSync } from 'fs';

const execAsync = promisify(exec);
import workspaceRoutes from './routes/workspaces.js';
import fileRoutes from './routes/files.js';
import chatRoutes from './routes/chat.js';
import backendRoutes from './routes/backends.js';
import { createBrowserMcpHttpRouter } from './services/browser-mcp-http.js';
import { createScheduledTasksMcpHttpRouter, resolveScheduledTasksMcpDeps } from './services/scheduled-tasks-mcp.js';
import { chatService } from './services/chat-service.js';
import { browserUploadStagingService } from './services/browser-upload-staging.js';
import { setBoundPort } from './utils/self-port.js';
import workspaceCommandsRoutes from './routes/workspace-commands.js';
import gitStatusRoutes from './routes/git-status.js';
import gitChangesRoutes from './routes/git-changes.js';
import gitGraphRoutes from './routes/git-graph.js';
import wecomBridgeRoutes from './routes/wecom-bridge.js';
import wecomQueueRoutes from './routes/wecom-queue.js';
import wecomSendRoutes from './routes/wecom-send.js';
import wecomSendFileRoutes from './routes/wecom-send-file.js';
import wecomDocRoutes from './routes/wecom-doc.js';
import wecomSmartsheetExportRoutes from './routes/wecom-smartsheet-export.js';
import systemRoutes from './routes/system.js';
import todoRoutes from './routes/todos.js';
import githubRoutes from './routes/github.js';
import scheduledTasksRoutes from './routes/scheduled-tasks.js';
import providerRoutes from './routes/providers.js';
import pluginRoutes from './routes/plugins.js';
import skillRoutes from './routes/skills.js';
import analyticsRoutes from './routes/analytics.js';
import botRoutes from './routes/bots.js';
import healthBrowserRoutes from './routes/health-browser.js';
import healthSandboxRoutes from './routes/health-sandbox.js';
import browserRoutes from './routes/browser.js';
import settingsRoutes from './routes/settings.js';
import apiBrokerRoutes from './routes/api-broker.js';
import { wecomBotService } from './services/wecom-bot-service.js';
import { wecomUserResolver } from './services/wecom-user-resolver.js';
import { wecomQueueWorker } from './services/wecom-queue-worker.js';
import { todoSchedulerService } from './services/todo-scheduler-service.js';
import { runNotifier } from './services/run-notifier.js';
import { wecomSessionRenamer } from './services/wecom-session-renamer.js';
import { feishuBotService } from './services/feishu-bot-service.js';
import { BotMigrationService } from './services/bot-migration-service.js';
import { store as workspaceStore } from './storage/sqlite-store.js';
import { botService } from './services/bot-service.js';
import { builtinPluginService } from './services/builtin-plugin-service.js';
import { diagLog } from './utils/diag-logger.js';
import { getLogsDir, runLogCleanup } from './utils/log-cleanup.js';
import { getStorageDir } from './storage/data-dir.js';
import { resolveSdkBinary } from './utils/resolve-sdk-binary.js';
import { initializeResolvedShellEnv } from './utils/resolve-shell-env.js';
import { resolveBuiltInMarketplacePath } from './utils/resolve-builtin-marketplace-path.js';
import { addExtraKnownMarketplace } from './utils/claude-settings.js';
import { ComateWebSocketServer } from './websocket/server.js';
import { teardownServices } from './service-teardown.js';
import { sessionCapabilityService } from './services/session-capability-service.js';
import { botEscalationLedger } from './services/bot-escalation-ledger.js';
import { createLoopbackAuthMiddleware } from './services/security/loopback-auth.js';
import {
  createProviderRouteHttpRouter,
  providerRouteAcceptanceTransportFromEnv,
} from './services/provider-route-http.js';
import { botAuditLogger, LOOPBACK_AUDIT_BOT_ID } from './services/bot-audit-logger.js';
import {
  createCorsOriginCallback,
  hostHeaderGuard,
  stateChangingRequestGuard,
} from './services/security/request-origin-guard.js';

function getDirname(): string {
  try {
    const filename = fileURLToPath(import.meta.url);
    return path.dirname(filename);
  } catch {
    return '';
  }
}

const __dirname = getDirname();

const app = express();
const PORT = process.env.PORT || 3000;
let logCleanupTimer: NodeJS.Timeout | null = null;

/** browser_audit retention (F18): never lets cleanup failures reach the timer. */
function pruneBrowserAudit(): void {
  try {
    const deleted = workspaceStore.pruneBrowserAudit();
    if (deleted > 0) {
      diagLog(`[browser-audit] pruned ${deleted} expired audit rows`);
    }
  } catch (err) {
    diagLog(`[browser-audit] prune failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** bot_audit retention (U6, KTD-22): 90-day default, mirrors pruneBrowserAudit. */
function pruneBotAuditLogs(): void {
  try {
    const deleted = workspaceStore.pruneBotAuditLogs();
    if (deleted > 0) {
      diagLog(`[bot-audit] pruned ${deleted} expired audit rows`);
    }
  } catch (err) {
    diagLog(`[bot-audit] prune failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Escalation-ledger retention (U8): settled rows older than 90 days. */
function pruneBotEscalationLedger(): void {
  try {
    const deleted = workspaceStore.pruneBotEscalationLedger();
    if (deleted > 0) {
      diagLog(`[escalation-ledger] pruned ${deleted} settled rows`);
    }
  } catch (err) {
    diagLog(`[escalation-ledger] prune failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function ensureComateBuiltInMarketplace(): void {
  const marketplacePath = resolveBuiltInMarketplacePath();
  if (!marketplacePath) {
    diagLog('[Marketplace] Built-in marketplace folder not found; skipping registration');
    return;
  }

  try {
    addExtraKnownMarketplace('comate-built-in', {
      source: {
        source: 'directory',
        path: marketplacePath,
      },
    });
    diagLog(`[Marketplace] Registered comate-built-in marketplace in ~/.claude/settings.json from ${marketplacePath}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    diagLog(`[Marketplace] Failed to register comate-built-in marketplace: ${message}`);
  }
}

ensureComateBuiltInMarketplace();
void browserUploadStagingService.cleanupOrphans().catch((error) => {
  diagLog(`[browser-upload] startup staging cleanup failed: ${error instanceof Error ? error.name : 'unknown'}`);
});

// U12 (KTD-28): mint the per-boot desktop GUI credential before any request
// can arrive. Delivered to the local client out-of-band: the sidecar ready
// message (Tauri shell) and a 0600 file in the data dir (dev Vite proxy).
// Never injected into any session environment.
const desktopToken = sessionCapabilityService.mintDesktopToken();
const providerRouteAcceptanceTransport = providerRouteAcceptanceTransportFromEnv(
  process.env.COMATE_PROVIDER_ROUTE_ACCEPTANCE_UPSTREAM,
);
delete process.env.COMATE_PROVIDER_ROUTE_ACCEPTANCE_UPSTREAM;

// Remote-surface hardening (plan U9): Host whitelist (anti-DNS-rebinding) →
// CORS app-origin matrix → state-changing source check. Header-only checks,
// so they run before body parsing and change no functional semantics.
// getSelfPort lets the guard allow the sidecar's own origin (statically
// served UI) once the listener is bound below.
let boundPort: number | undefined;
const getSelfPort = (): number | undefined => boundPort;

// Route authorization verifies the TCP peer before reading Authorization or
// request body data. Keep it ahead of every generic parser and origin guard.
// U5 production route registry: authenticated per-generation Responses
// capabilities terminate here and are converted to the immutable Provider
// snapshot held by the registry. It must remain ahead of CORS and every body
// parser so unauthorized connections cannot make the app consume their body.
app.use('/provider-route', createProviderRouteHttpRouter({
  ...(providerRouteAcceptanceTransport ? { transport: providerRouteAcceptanceTransport } : {}),
}));
app.use(hostHeaderGuard());
// U6: HTTP-hosted browser MCP for both agent backends (Bearer token auth,
// loopback; no browser Origin — mount ahead of the CORS/origin guards).
app.use('/mcp/browser', createBrowserMcpHttpRouter((sessionId) => chatService.resolveBrowserMcpDeps(sessionId)));
// U7: HTTP-hosted scheduled-task MCP (Bearer token auth, loopback; same
// pre-guard mount rationale as the browser MCP).
app.use('/mcp/scheduled-tasks', createScheduledTasksMcpHttpRouter((sessionId) => resolveScheduledTasksMcpDeps(sessionId)));

app.use(cors({ origin: createCorsOriginCallback({ getSelfPort }) }));
app.use(stateChangingRequestGuard({ getSelfPort }));
app.use(express.json());

// U12 (KTD-28): default-deny authentication for the entire /api surface at
// the registration layer. Every present AND future /api route requires a
// Bearer credential — the desktop GUI credential (full surface) or a
// per-session capability token (closed enrolled route set, enforced inside
// the middleware). Exemptions are the explicit list in loopback-auth.ts.
app.use(
  createLoopbackAuthMiddleware({
    // The generic loopback route set is the WeCom CLI audience. GUI task
    // capabilities are deliberately limited to browser MCP + API broker.
    resolveSessionToken: (token) => sessionCapabilityService.resolveForAudience(token, 'wecom-cli'),
    resolveApiBrokerToken: (token) => sessionCapabilityService.resolveForAudience(token, 'api-broker'),
    getDesktopToken: () => sessionCapabilityService.getDesktopToken(),
    // U6 (KTD-22): promote auth rejections from diagLog to the bot audit
    // trail. Attributable rejections (resolved token, 403 class) file under
    // the token's bot; unattributable ones under the sentinel bucket.
    onAuthRejected: (rejection) => {
      botAuditLogger.logLoopbackAuthRejected(
        rejection.botId ?? LOOPBACK_AUDIT_BOT_ID,
        { type: 'system' },
        {
          method: rejection.method,
          path: rejection.path,
          reason: rejection.reason,
          ...(rejection.sessionId ? { sessionId: rejection.sessionId } : {}),
        },
      );
    },
  }),
);

// API routes
app.use('/api/workspaces', workspaceRoutes);
app.use('/api/backends', backendRoutes);
app.use('/api/workspaces/:id/files', fileRoutes);
app.use('/api/workspaces/:id/commands', workspaceCommandsRoutes);
app.use('/api/workspaces/:id/git-ref', gitStatusRoutes);
app.use('/api/workspaces/:id/git-changes', gitChangesRoutes);
app.use('/api/workspaces/:id/git-graph', gitGraphRoutes);
app.use('/api/workspaces/:id', chatRoutes);
app.use('/api/workspaces/:id/todos', todoRoutes);
app.use('/api/todos', todoRoutes);
app.use('/api/github', githubRoutes);
app.use('/api/scheduled-tasks', scheduledTasksRoutes);
app.use('/api/workspaces/:id/scheduled-tasks', scheduledTasksRoutes);
app.use('/api/workspaces/:id/wecom-queue', wecomQueueRoutes);
app.use('/api/workspaces/:workspaceId/wecom/send', wecomSendRoutes);
app.use('/api/workspaces/:workspaceId/wecom/send-file', wecomSendFileRoutes);
app.use('/api/workspaces/:workspaceId/wecom/doc/:tool', wecomDocRoutes);
app.use('/api/workspaces/:workspaceId/wecom/smartsheet-export', wecomSmartsheetExportRoutes);
app.use('/api/wecom', wecomBridgeRoutes);
app.use('/api/system', systemRoutes);
app.use('/api/providers', providerRoutes);
app.use('/api/plugins', pluginRoutes);
app.use('/api/skills', skillRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/bots', botRoutes);
app.use('/api/health/browser', healthBrowserRoutes);
app.use('/api/health/sandbox', healthSandboxRoutes);
app.use('/api/browser', browserRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/broker/request', apiBrokerRoutes);

// Health checks
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/health/migration', (_req, res) => {
  try {
    const state = workspaceStore.getMigrationState();
    res.json({
      version: state.version,
      runAt: state.runAt,
      auditLogsCleared: (state.snapshot.auditLogsCleared as number | undefined) ?? 0,
    });
  } catch (error) {
    console.error('Failed to get migration state:', error);
    res.status(500).json({ error: 'Failed to get migration state' });
  }
});

// Client diagnostic log sink — forwards browser logs into sse-diag.log
app.post('/api/log', express.json({ limit: '1mb' }), (req, res) => {
  const { level = 'log', message } = req.body;
  if (typeof message === 'string') {
    diagLog(`[client] [${level}] ${message}`);
  }
  res.json({ ok: true });
});

app.get('/api/health/claude', async (_req, res) => {
  const binaryPath = resolveSdkBinary();
  if (!binaryPath) {
    res.status(503).json({
      ok: false,
      error: 'Claude binary not found',
      message: 'Claude binary not found in app bundle.',
    });
    return;
  }

  try {
    await execAsync(`"${binaryPath}" --version`, { timeout: 5000 });
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({
      ok: false,
      error: 'Claude binary failed to execute',
      message: 'Claude binary failed to execute.',
    });
  }
});

// Graceful shutdown endpoint — triggered by the Tauri layer before force-kill
app.post('/shutdown', (req, res) => {
  const clientIp = req.ip || req.socket.remoteAddress;
  const allowedIps = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
  if (!clientIp || !allowedIps.includes(clientIp)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  res.json({ ok: true });
  shutdown('http').catch((err) => {
    console.error('Error during HTTP shutdown:', err);
    process.exit(1);
  });
});

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../../dist/client')));

  // SPA fallback
  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, '../../dist/client/index.html'));
  });
}

// Start shell environment capture early so it's ready before first SDK spawn
initializeResolvedShellEnv().catch((err) => {
  console.error('Failed to initialize resolved shell env:', err);
});

const server = app.listen(Number(PORT), '127.0.0.1', () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : PORT;
  boundPort = Number(actualPort);
  setBoundPort(boundPort);
  const serverUrl = `http://localhost:${actualPort}`;
  console.log(`Server running on ${serverUrl}`);
  diagLog(`Server started on ${serverUrl} (diag log file: ${path.join(getLogsDir(), 'sse-diag.log')})`);

  // Attach WebSocket server to the same HTTP listener.
  new ComateWebSocketServer().attach(server, { getSelfPort });

  // Emit ready message for Tauri sidecar discovery when PORT=0. The
  // desktopToken field hands the GUI credential to the Tauri shell, which
  // injects it into the webview's request layer (U12); the shell must not
  // log this line.
  if (process.env.COMATE_SIDECAR === '1') {
    console.log(JSON.stringify({ type: 'ready', port: actualPort, desktopToken }));
  }

  // Run bot migration before initializing channel connections so legacy
  // workspace-embedded configs are promoted to standalone bots once.
  (async () => {
    try {
      const migrationService = new BotMigrationService(workspaceStore);
      if (!migrationService.hasMigrationRun()) {
        const result = await migrationService.migrate();
        if (!result.success) {
          console.error('[BotMigration] failed:', result.errors);
        } else {
          diagLog(`[BotMigration] completed: ${result.createdBots} bots created`);
        }
      }
    } catch (err) {
      console.error('[BotMigration] unexpected error:', err);
    }

    // U8 (KTD-16): escalation ledger boot recovery. Every still-pending
    // approval belongs to a Promise that died with the previous process —
    // expire them all (fail-closed, never auto-allow) with an audit row per
    // entry, and queue requester notifications per bot. The queue flushes
    // when each bot's WeCom connection reports ready (this sequence must NOT
    // await connections), so this runs BEFORE wecomBotService.initialize().
    try {
      const expiredEscalations = botEscalationLedger.expireAllPendingForBoot();
      if (expiredEscalations.length > 0) {
        diagLog(`[Startup] boot recovery expired ${expiredEscalations.length} pending bot escalation(s)`);
        wecomBotService.enqueueEscalationExpiryNotifications(expiredEscalations);
      }
    } catch (err) {
      console.error('[Startup] escalation ledger boot recovery failed:', err);
    }

    // Backfill the built-in wecom plugin for any existing WeCom-enabled bots.
    // This repairs workspaces that were created after the skill-to-plugin refactor
    // but before auto-install was added.
    try {
      for (const bot of botService.listBots()) {
        if (botService.getChannelSettings(bot.id).wecom?.enabled && bot.activeWorkspaceId) {
          await builtinPluginService.ensureWecomPluginInstalled(bot.activeWorkspaceId).catch((err) => {
            console.error(
              `[Startup] failed to backfill wecom plugin for workspace ${bot.activeWorkspaceId}:`,
              err,
            );
          });
        }
      }
    } catch (err) {
      console.error('[Startup] unexpected error during wecom plugin backfill:', err);
    }

    // Initialize WeCom bot connections for enabled bots/workspaces.
    // (U12: setServerUrl is gone — per-session CLI context files derive the
    // loopback URL from the bound port via self-port at session creation.)
    wecomBotService.initialize().catch((err) => {
      console.error('Failed to initialize WeCom bot service:', err);
    });

    // Initialize Feishu bot service for the active workspace binding
    feishuBotService.initialize().catch((err) => {
      console.error('Failed to initialize Feishu bot service:', err);
    });
  })();

  // Wire resolver to renamer before initializing
  wecomUserResolver.setOnMappingStored(async (workspaceId, encryptedUserId) => {
    await wecomSessionRenamer.renameSessionsForUser(workspaceId, encryptedUserId);
  });

  // Initialize WeCom user ID resolver background flush
  wecomUserResolver.initialize();

  // Initialize WeCom proactive message queue worker
  wecomQueueWorker.initialize();

  // Initialize the unified Todo scheduler (tick + startup reconciliation).
  todoSchedulerService.initialize();

  // Fan out run results (WeCom summary push; WS relay lives in the ws server)
  runNotifier.initialize();

  // Backfill existing WeCom session names
  wecomSessionRenamer.backfillExistingSessions().catch((err) => {
    console.error('Failed to backfill WeCom session names:', err);
  });

  // Initialize log cleanup — run once at startup, then periodically. The same
  // timer bounds the append-only browser_audit table (age + row cap) and the
  // bot_audit table (U6: 90-day age retention).
  runLogCleanup();
  pruneBrowserAudit();
  pruneBotAuditLogs();
  pruneBotEscalationLedger();
  logCleanupTimer = setInterval(() => {
    runLogCleanup();
    pruneBrowserAudit();
    pruneBotAuditLogs();
    pruneBotEscalationLedger();
  }, 6 * 60 * 60 * 1000); // 6 hours
  logCleanupTimer.unref();

  // Clean up legacy log files from storage root
  try {
    const storageDir = getStorageDir();
    for (const legacyFile of ['sidecar.log', 'sse-diag.log']) {
      const legacyPath = path.join(storageDir, legacyFile);
      if (existsSync(legacyPath)) {
        unlinkSync(legacyPath);
      }
    }
  } catch {
    // Ignore legacy cleanup errors
  }
});

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}, shutting down...`);
  if (logCleanupTimer) {
    clearInterval(logCleanupTimer);
    logCleanupTimer = null;
  }
  await teardownServices();
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((err) => {
    console.error('Error during SIGTERM shutdown:', err);
    process.exit(1);
  });
});
process.on('SIGINT', () => {
  shutdown('SIGINT').catch((err) => {
    console.error('Error during SIGINT shutdown:', err);
    process.exit(1);
  });
});
