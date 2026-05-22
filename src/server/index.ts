import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import workspaceRoutes from './routes/workspaces.js';
import fileRoutes from './routes/files.js';
import chatRoutes from './routes/chat.js';
import workspaceCommandsRoutes from './routes/workspace-commands.js';
import wecomBridgeRoutes from './routes/wecom-bridge.js';
import cliInstallRoutes from './routes/cli-install.js';
import { wecomBotService } from './services/wecom-bot-service.js';

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

app.use(cors());
app.use(express.json());

// API routes
app.use('/api/workspaces', workspaceRoutes);
app.use('/api/workspaces/:id/files', fileRoutes);
app.use('/api/workspaces/:id/commands', workspaceCommandsRoutes);
app.use('/api/workspaces/:id', chatRoutes);
app.use('/api/wecom', wecomBridgeRoutes);
app.use('/api/cli', cliInstallRoutes);

// Health checks
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/health/claude', (_req, res) => {
  try {
    execSync('claude --version', { stdio: 'pipe', timeout: 5000 });
    res.json({ ok: true });
  } catch (err) {
    const isWindows = process.platform === 'win32';
    res.status(503).json({
      ok: false,
      error: 'Claude CLI not found or not authenticated',
      message: isWindows
        ? 'Claude CLI must be installed and authenticated. Run "claude login" in your terminal.'
        : 'Claude CLI must be installed and authenticated. Run "claude login" in your terminal.',
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

const server = app.listen(PORT, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : PORT;
  const serverUrl = `http://localhost:${actualPort}`;
  console.log(`Server running on ${serverUrl}`);

  // Emit ready message for Tauri sidecar discovery when PORT=0
  if (process.env.CLAUDE_CODE_GUI_SIDECAR === '1') {
    console.log(JSON.stringify({ type: 'ready', port: actualPort }));
  }

  // Initialize WeCom bot connections for enabled workspaces
  wecomBotService.setServerUrl(serverUrl);
  wecomBotService.initialize().catch((err) => {
    console.error('Failed to initialize WeCom bot service:', err);
  });
});

// Graceful shutdown
function shutdown(signal: string): void {
  console.log(`Received ${signal}, shutting down...`);
  wecomBotService.disconnectAll();
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
