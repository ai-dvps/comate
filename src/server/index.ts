import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { existsSync, unlinkSync } from 'fs';
import workspaceRoutes from './routes/workspaces.js';
import fileRoutes from './routes/files.js';
import chatRoutes from './routes/chat.js';
import workspaceCommandsRoutes from './routes/workspace-commands.js';
import gitStatusRoutes from './routes/git-status.js';
import wecomBridgeRoutes from './routes/wecom-bridge.js';
import cliInstallRoutes from './routes/cli-install.js';
import systemRoutes from './routes/system.js';
import todoRoutes from './routes/todos.js';
import { wecomBotService } from './services/wecom-bot-service.js';
import { wecomUserResolver } from './services/wecom-user-resolver.js';
import { chatService } from './services/chat-service.js';
import { diagLog } from './utils/diag-logger.js';
import { getLogsDir, runLogCleanup } from './utils/log-cleanup.js';
import { getStorageDir } from './storage/data-dir.js';
import { resolveSdkBinary } from './utils/resolve-sdk-binary.js';
import { initializeResolvedShellPath } from './utils/resolve-shell-path.js';

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

app.use(cors());
app.use(express.json());

// API routes
app.use('/api/workspaces', workspaceRoutes);
app.use('/api/workspaces/:id/files', fileRoutes);
app.use('/api/workspaces/:id/commands', workspaceCommandsRoutes);
app.use('/api/workspaces/:id/git-ref', gitStatusRoutes);
app.use('/api/workspaces/:id', chatRoutes);
app.use('/api/workspaces/:id/todos', todoRoutes);
app.use('/api/wecom', wecomBridgeRoutes);
app.use('/api/cli', cliInstallRoutes);
app.use('/api/system', systemRoutes);

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

app.get('/api/health/claude', (_req, res) => {
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
    execSync(`"${binaryPath}" --version`, { stdio: 'pipe', timeout: 5000 });
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({
      ok: false,
      error: 'Claude binary failed to execute',
      message: 'Claude binary failed to execute.',
    });
  }
});

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../../dist/client')));

  // SPA fallback
  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, '../../dist/client/index.html'));
  });
}

// Start shell PATH resolution early so it's ready before first SDK spawn
initializeResolvedShellPath().catch((err) => {
  console.error('Failed to initialize resolved shell path:', err);
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

  // Initialize WeCom user ID resolver background flush
  wecomUserResolver.initialize();

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
