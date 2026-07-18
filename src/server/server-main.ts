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
import workspaceCommandsRoutes from './routes/workspace-commands.js';
import gitStatusRoutes from './routes/git-status.js';
import gitChangesRoutes from './routes/git-changes.js';
import wecomBridgeRoutes from './routes/wecom-bridge.js';
import wecomQueueRoutes from './routes/wecom-queue.js';
import wecomSendRoutes from './routes/wecom-send.js';
import wecomSendFileRoutes from './routes/wecom-send-file.js';
import wecomDocRoutes from './routes/wecom-doc.js';
import wecomSmartsheetExportRoutes from './routes/wecom-smartsheet-export.js';
import systemRoutes from './routes/system.js';
import todoRoutes from './routes/todos.js';
import providerRoutes from './routes/providers.js';
import pluginRoutes from './routes/plugins.js';
import skillRoutes from './routes/skills.js';
import analyticsRoutes from './routes/analytics.js';
import botRoutes from './routes/bots.js';
import healthBrowserRoutes from './routes/health-browser.js';
import { wecomBotService } from './services/wecom-bot-service.js';
import { wecomUserResolver } from './services/wecom-user-resolver.js';
import { wecomQueueWorker } from './services/wecom-queue-worker.js';
import { wecomSessionRenamer } from './services/wecom-session-renamer.js';
import { chatService } from './services/chat-service.js';
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
import { gitChangesService } from './services/git-changes-service.js';
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

// Remote-surface hardening (plan U9): Host whitelist (anti-DNS-rebinding) →
// CORS app-origin matrix → state-changing source check. Header-only checks,
// so they run before body parsing and change no functional semantics.
// getSelfPort lets the guard allow the sidecar's own origin (statically
// served UI) once the listener is bound below.
let boundPort: number | undefined;
const getSelfPort = (): number | undefined => boundPort;

app.use(hostHeaderGuard());
app.use(cors({ origin: createCorsOriginCallback({ getSelfPort }) }));
app.use(stateChangingRequestGuard({ getSelfPort }));
app.use(express.json());

// API routes
app.use('/api/workspaces', workspaceRoutes);
app.use('/api/workspaces/:id/files', fileRoutes);
app.use('/api/workspaces/:id/commands', workspaceCommandsRoutes);
app.use('/api/workspaces/:id/git-ref', gitStatusRoutes);
app.use('/api/workspaces/:id/git-changes', gitChangesRoutes);
app.use('/api/workspaces/:id', chatRoutes);
app.use('/api/workspaces/:id/todos', todoRoutes);
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

const server = app.listen(PORT, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : PORT;
  boundPort = Number(actualPort);
  const serverUrl = `http://localhost:${actualPort}`;
  console.log(`Server running on ${serverUrl}`);
  diagLog(`Server started on ${serverUrl} (diag log file: ${path.join(getLogsDir(), 'sse-diag.log')})`);

  // Attach WebSocket server to the same HTTP listener.
  new ComateWebSocketServer().attach(server, { getSelfPort });

  // Emit ready message for Tauri sidecar discovery when PORT=0
  if (process.env.COMATE_SIDECAR === '1') {
    console.log(JSON.stringify({ type: 'ready', port: actualPort }));
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

    // Initialize WeCom bot connections for enabled bots/workspaces
    wecomBotService.setServerUrl(serverUrl);
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

  // Backfill existing WeCom session names
  wecomSessionRenamer.backfillExistingSessions().catch((err) => {
    console.error('Failed to backfill WeCom session names:', err);
  });

  // Initialize log cleanup — run once at startup, then periodically
  runLogCleanup();
  logCleanupTimer = setInterval(() => {
    runLogCleanup();
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
  wecomBotService.disconnectAll();
  feishuBotService.disconnect();
  await wecomQueueWorker.shutdown();
  await wecomUserResolver.shutdown();
  await gitChangesService.dispose();
  await chatService.closeAllRuntimes();
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
