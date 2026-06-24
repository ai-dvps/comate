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
import wecomBridgeRoutes from './routes/wecom-bridge.js';
import wecomQueueRoutes from './routes/wecom-queue.js';
import wecomSendRoutes from './routes/wecom-send.js';
import wecomSendFileRoutes from './routes/wecom-send-file.js';
import wecomDocRoutes from './routes/wecom-doc.js';
import wecomSmartsheetExportRoutes from './routes/wecom-smartsheet-export.js';
import feishuCardRoutes from './routes/feishu-card.js';
import systemRoutes from './routes/system.js';
import todoRoutes from './routes/todos.js';
import providerRoutes from './routes/providers.js';
import pluginRoutes from './routes/plugins.js';
import skillRoutes from './routes/skills.js';
import analyticsRoutes from './routes/analytics.js';
import { wecomBotService } from './services/wecom-bot-service.js';
import { wecomUserResolver } from './services/wecom-user-resolver.js';
import { wecomQueueWorker } from './services/wecom-queue-worker.js';
import { wecomSessionRenamer } from './services/wecom-session-renamer.js';
import { chatService } from './services/chat-service.js';
import { feishuBotService } from './services/feishu-bot-service.js';
import { diagLog } from './utils/diag-logger.js';
import { getLogsDir, runLogCleanup } from './utils/log-cleanup.js';
import { getStorageDir } from './storage/data-dir.js';
import { resolveSdkBinary } from './utils/resolve-sdk-binary.js';
import { initializeResolvedShellEnv } from './utils/resolve-shell-env.js';
import { resolveBuiltInMarketplacePath } from './utils/resolve-builtin-marketplace-path.js';
import { addExtraKnownMarketplace } from './utils/claude-settings.js';

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

app.use(cors());
// Feishu card callbacks need the raw request body for signature verification.
// Mount this route before express.json() consumes the stream.
app.use('/api/feishu/card', feishuCardRoutes);
app.use(express.json());

// API routes
app.use('/api/workspaces', workspaceRoutes);
app.use('/api/workspaces/:id/files', fileRoutes);
app.use('/api/workspaces/:id/commands', workspaceCommandsRoutes);
app.use('/api/workspaces/:id/git-ref', gitStatusRoutes);
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

// Health checks
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
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
  const serverUrl = `http://localhost:${actualPort}`;
  console.log(`Server running on ${serverUrl}`);
  diagLog(`Server started on ${serverUrl} (diag log file: ${path.join(getLogsDir(), 'sse-diag.log')})`);

  // Emit ready message for Tauri sidecar discovery when PORT=0
  if (process.env.COMATE_SIDECAR === '1') {
    console.log(JSON.stringify({ type: 'ready', port: actualPort }));
  }

  // Initialize WeCom bot connections for enabled workspaces
  wecomBotService.setServerUrl(serverUrl);
  wecomBotService.initialize().catch((err) => {
    console.error('Failed to initialize WeCom bot service:', err);
  });

  // Initialize Feishu bot service for the active workspace binding
  feishuBotService.initialize().catch((err) => {
    console.error('Failed to initialize Feishu bot service:', err);
  });

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
