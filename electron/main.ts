/**
 * U1: Electron main process — the shell-skeleton port of `src-tauri/src/lib.rs`.
 *
 * Mirrors the Tauri shell's role end to end:
 *  - data-dir pinning to the legacy Tauri paths + `userData` under the same
 *    root (KTD-7), AUMID `com.comate.app`;
 *  - single instance (second-instance focuses the existing window);
 *  - sidecar spawn via child_process with the exact env contract, stdout
 *    ready-line handshake (token never logged), and the verified shutdown
 *    matrix (POST /shutdown → grace → kill, tree-kill on Windows);
 *  - close-to-tray with an explicit isQuitting flag; macOS accessory-policy
 *    toggle keyed to badge count;
 *  - tray menu + 5s status poller (Bearer desktop token);
 *  - UI over the privileged `app.comate://` scheme in production (dev loads
 *    the Vite dev server), macOS Edit menu for Cmd+C/V, main.log file logging.
 */

import { app, BrowserWindow, Menu, Notification, Tray, WebContentsView, dialog, ipcMain, nativeImage, net, protocol, session, shell } from 'electron';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_ID, resolveLegacyDataDir } from './paths';
import { createShellLogger, type ShellLogger } from './logger';
import {
  createControlServer,
  createElectronViewManager,
  type ControlEvent,
  type ControlServerHandle,
  type ElectronViewManager,
} from './control-server';
import {
  buildSidecarEnv,
  resolveResourceDir,
  resolveSidecarBinaryPath,
  selectShutdownGraceMs,
  shutdownSidecar,
  spawnSidecar,
  type ShutdownReason,
  type SidecarHandle,
} from './sidecar';
import { createTray, runTrayStatusPoller, type TrayHandle, type TrayStatusPoller } from './tray';
import { installAppMenu } from './menu';
import { autoUpdater } from 'electron-updater';
import {
  createUpdaterController,
  type UpdaterAdapter,
  type UpdaterController,
} from './updater';

// ---------------------------------------------------------------------------
// Early, pre-ready setup (order matters: these must run before 'ready')
// ---------------------------------------------------------------------------

// Windows toast/shortcut identity (KTD-7). Safe no-op elsewhere.
app.setAppUserModelId(APP_ID);
app.setName('Comate');

// KTD-7: pin the data dir to the exact legacy Tauri path per platform, and
// pin Electron's userData (Chromium profile/caches) to a `shell/` subdir
// under the same root so bridged installs share one data root.
// COMATE_DATA_DIR overrides the pin — the sidecar contract's own variable —
// so dev loops and the U7 e2e gate (scripts/test-electron-cdp.ts) can run a
// fully isolated shell without touching real user data.
const legacyDataDir =
  process.env['COMATE_DATA_DIR'] ||
  resolveLegacyDataDir({
    platform: process.platform,
    home: homedir(),
    appData: process.env['APPDATA'],
    xdgDataHome: process.env['XDG_DATA_HOME'],
  });
app.setPath('userData', join(legacyDataDir, 'shell'));

// Privileged UI scheme (production). Registered pre-ready; handled post-ready.
const UI_SCHEME = 'app.comate';
protocol.registerSchemesAsPrivileged([
  {
    scheme: UI_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

// ---------------------------------------------------------------------------
// U7 (KTD-6): debug port for the in-shell Chromium browser views.
//
// Lockdown (hard requirements, plan Risks "debug-port trust boundary"):
//  - random port: pre-allocated from the OS ephemeral range BEFORE app ready
//    (Chromium needs the switch up front; Electron never writes
//    DevToolsActivePort, so `--remote-debugging-port=0` would leave the port
//    undiscoverable). The listen/close TOCTOU window is accepted and covered
//    by a post-ready /json/version probe — a lost race surfaces as
//    debug_port_unreachable in /api/health/browser, never a silent fallback
//    to a guessable port. An env override exists as a test/dev hook;
//  - loopback only (`--remote-debugging-address=127.0.0.1`);
//  - NEVER `--remote-allow-origins` (the sidecar's `ws` client sends no Origin
//    header, verified against CfT 151 — no origin wildcard is needed);
//  - dev-web mode has no shell process at all, so no debug port exists there
//    (the sidecar then serves the browser stack from its legacy fallback).
// ---------------------------------------------------------------------------
const shellDebugPortOverride = process.env['COMATE_SHELL_DEBUG_PORT'];
/** The concrete port Chromium was told to bind; null = debug port disabled. */
let shellDebugPortSetting: number | null = null;

function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error('loopback port allocation returned no port'));
      });
    });
  });
}

/**
 * Resolves once the debug-port switch is in place. ALL app-ready wiring
 * awaits this: appendSwitch is a no-op after Chromium init, so registration
 * order matters more than the ~1ms allocation latency (ready physically
 * cannot fire before the first macrotask turn completes).
 */
const debugPortConfigured: Promise<void> = (async () => {
  try {
    shellDebugPortSetting = shellDebugPortOverride
      ? Number(shellDebugPortOverride)
      : await allocateLoopbackPort();
    if (!Number.isInteger(shellDebugPortSetting) || shellDebugPortSetting <= 0) {
      shellDebugPortSetting = null;
    }
  } catch {
    shellDebugPortSetting = null;
  }
  if (shellDebugPortSetting !== null) {
    app.commandLine.appendSwitch('remote-debugging-port', String(shellDebugPortSetting));
    app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  }
})();

const logger: ShellLogger = createShellLogger(join(legacyDataDir, 'logs'), {
  mirrorToConsole: !app.isPackaged,
});

// ---------------------------------------------------------------------------
// Shell state (lib.rs AppState)
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;
let sidecar: SidecarHandle | null = null;
let trayHandle: TrayHandle | null = null;
let trayPoller: TrayStatusPoller | null = null;
let apiPort: number | null = null;
let apiToken: string | null = null;
let badgeCount = 0;
let isQuitting = false;
let isShuttingDown = false;
let isUpdating = false;
let pendingQuitReason: ShutdownReason = 'exit-requested';
let updaterController: UpdaterController | null = null;
// U7: control channel (KTD-11) + debug port (KTD-6) coordinates handed to the
// sidecar via spawn env. Null when the channel failed to start — the sidecar
// then serves the browser stack from its legacy fallback (KTD-15 degradation).
let controlServer: ControlServerHandle | null = null;
let viewManager: ElectronViewManager | null = null;
let shellDebugPort: number | null = null;
let shellControlPort: number | null = null;
let shellControlToken: string | null = null;

// ---------------------------------------------------------------------------
// Updater (U5: electron-updater behind the pure state machine in updater.ts)
// ---------------------------------------------------------------------------

/**
 * Real adapter over electron-updater. Channel selection is build-time: the
 * enterprise flavor bakes `channel: latest-enterprise` into app-update.yml
 * (electron-builder.config.ts publish.channel), and autoUpdater reads it from
 * there — the two flavors can never cross-wire (KTD-13). In dev,
 * forceDevUpdateConfig makes autoUpdater read dev-app-update.yml from the app
 * root instead (gitignored; copy the github provider block to test locally).
 */
function createElectronUpdaterAdapter(): UpdaterAdapter {
  autoUpdater.autoDownload = false; // manual-download UX parity (plan U5)
  // autoInstallOnAppQuit stays true (default): an implicit quit carrying a
  // downloaded update installs it — performShutdown arms the update grace.
  // Dev feed: only when the developer dropped a dev-app-update.yml into the
  // app root (gitignored) — otherwise check stays a quiet "no update".
  if (!app.isPackaged) {
    autoUpdater.forceDevUpdateConfig = existsSync(join(app.getAppPath(), 'dev-app-update.yml'));
  }
  autoUpdater.logger = logger;
  return {
    async checkForUpdates() {
      const result = await autoUpdater.checkForUpdates();
      if (!result) return null; // dev without dev-app-update.yml, or unsupported
      const { updateInfo } = result;
      const notes = updateInfo.releaseNotes;
      return {
        version: updateInfo.version,
        body:
          typeof notes === 'string'
            ? notes
            : Array.isArray(notes)
              ? notes
                  .map((n) => n.note)
                  .filter((n): n is string => typeof n === 'string')
                  .join('\n\n')
              : undefined,
        date: updateInfo.releaseDate,
      };
    },
    downloadUpdate: () => autoUpdater.downloadUpdate().then(() => undefined),
    quitAndInstall: () => autoUpdater.quitAndInstall(),
    onDownloadProgress: (handler) => {
      autoUpdater.on('download-progress', (progress) => {
        handler({ transferred: progress.transferred, total: progress.total });
      });
    },
  };
}

function setupUpdater(): void {
  updaterController = createUpdaterController({
    adapter: createElectronUpdaterAdapter(),
    currentVersion: app.getVersion(),
    logger,
    onDownloadEvent: (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('comate:updater-download-event', event);
      }
    },
    armUpdateGrace: () => {
      isUpdating = true;
    },
  });
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function showMainWindow(): void {
  if (process.platform === 'darwin') {
    app.setActivationPolicy('regular');
  }
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Plan U1 error scenario: a dead sidecar must surface, never hang silently. */
function showFatalError(message: string): void {
  logger.error(`Fatal: ${message}`);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const html =
    '<!doctype html><html><head><meta charset="utf-8"><title>Comate</title></head>' +
    '<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;' +
    'font-family:-apple-system,\'Segoe UI\',sans-serif;background:#1c1c1e;color:#f5f5f7;">' +
    '<div style="max-width:560px;padding:32px;text-align:center;">' +
    '<h1 style="font-size:20px;">Comate failed to start</h1>' +
    `<p style="opacity:.8;line-height:1.5;">${escapeHtml(message)}</p>` +
    `<p style="opacity:.55;font-size:12px;word-break:break-all;">Log: ${escapeHtml(
      logger.filePath ?? 'unavailable',
    )}</p>` +
    '</div></body></html>';
  void mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function loadUi(win: BrowserWindow): void {
  if (app.isPackaged) {
    void win.loadURL(`${UI_SCHEME}://localhost/index.html`);
    return;
  }
  const devUrl = 'http://localhost:5173';
  void win.loadURL(devUrl).catch(() => {
    // did-fail-load below retries while the Vite dev server is still booting.
  });
  win.webContents.on('did-fail-load', (_event, _errorCode, _description, validatedURL) => {
    if (app.isPackaged || !validatedURL.startsWith(devUrl)) return;
    setTimeout(() => {
      if (!win.isDestroyed()) {
        void win.loadURL(devUrl).catch(() => {});
      }
    }, 500);
  });
}

function createMainWindow(): BrowserWindow {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'src-tauri', 'icons', '32x32.png');

  const win = new BrowserWindow({
    title: 'Comate',
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    center: true,
    icon: nativeImage.createFromPath(iconPath),
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // Close-to-tray: hide instead of closing, unless an explicit quit path
  // (tray Quit / Cmd+Q / update install) armed isQuitting first.
  win.on('close', (event) => {
    if (isQuitting || isShuttingDown) return;
    event.preventDefault();
    win.hide();
    if (process.platform === 'darwin' && badgeCount === 0) {
      app.setActivationPolicy('accessory');
    }
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  loadUi(win);
  return win;
}

// ---------------------------------------------------------------------------
// IPC bridge (lib.rs commands; preload exposes getApiInfo/showWindow today,
// U2 wires the rest of the client bridge)
// ---------------------------------------------------------------------------

function registerIpcHandlers(): void {
  ipcMain.handle('comate:get-api-info', () => {
    if (apiPort == null) {
      throw new Error('API port not yet discovered');
    }
    return { port: apiPort, token: apiToken ?? '' };
  });

  ipcMain.handle('comate:show-window', () => {
    showMainWindow();
  });

  // lib.rs update_badge_state: badge + macOS accessory-policy toggle when the
  // window is hidden; Windows flashes the taskbar button.
  ipcMain.handle('comate:update-badge-state', (_event, count: unknown) => {
    badgeCount =
      typeof count === 'number' && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    if (process.platform === 'darwin') {
      app.setBadgeCount(badgeCount);
      if (mainWindow && !mainWindow.isVisible()) {
        app.setActivationPolicy(badgeCount > 0 ? 'regular' : 'accessory');
      }
    } else if (process.platform === 'win32') {
      mainWindow?.flashFrame(badgeCount > 0);
    }
  });

  // lib.rs reveal_in_file_manager. shell.showItemInFolder reveals the item
  // selected in its parent on all platforms (≈ open -R / explorer /select).
  ipcMain.handle('comate:reveal-in-file-manager', (_event, targetPath: unknown) => {
    if (typeof targetPath !== 'string' || targetPath.length === 0) {
      throw new Error('reveal-in-file-manager: path is required');
    }
    shell.showItemInFolder(targetPath);
  });

  // lib.rs open_url: http(s) only, system browser.
  ipcMain.handle('comate:open-url', async (_event, url: unknown) => {
    if (typeof url !== 'string' || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      throw new Error(`Unsupported URL scheme: ${String(url)}`);
    }
    await shell.openExternal(url);
  });

  // lib.rs prepare_updater_relaunch: arms the 5s update grace (U5 wires the
  // electron-updater install path onto this flag).
  ipcMain.handle('comate:prepare-updater-relaunch', () => {
    isUpdating = true;
  });

  // Shell version (SettingsPanel "Check for updates" footer), previously
  // @tauri-apps/api/app getVersion().
  ipcMain.handle('comate:get-app-version', () => app.getVersion());

  // Native folder picker (CreateWorkspaceModal). Resolves null on cancel.
  ipcMain.handle('comate:open-directory-dialog', async () => {
    const options: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  // Desktop notifications (scheduler run events, R15/KTD-4). Electron has no
  // runtime permission API on macOS/Windows — support is the grant signal;
  // the OS may still prompt/deny at its own level, and the client degrades
  // to the in-app badge in that case (first-class degraded path).
  ipcMain.handle('comate:notification-is-permission-granted', () =>
    Notification.isSupported(),
  );
  ipcMain.handle('comate:notification-request-permission', () =>
    Notification.isSupported(),
  );
  ipcMain.handle('comate:notification-send', (_event, options: unknown) => {
    const { title, body } = (options ?? {}) as { title?: unknown; body?: unknown };
    if (typeof title !== 'string' || title.length === 0) {
      throw new Error('notification-send: title is required');
    }
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title,
      body: typeof body === 'string' ? body : undefined,
    });
    // Click focuses the window and relays to the renderer, which performs the
    // session jump (KTD-4) via its onNotificationAction handler.
    notification.on('click', () => {
      showMainWindow();
      mainWindow?.webContents.send('comate:notification-action');
    });
    notification.show();
  });

  // U5: electron-updater via the updater.ts state machine. check discovers
  // (autoDownload=false keeps the manual-download UX), download streams
  // progress over 'comate:updater-download-event', relaunch arms the update
  // grace then quitAndInstall. setupUpdater() runs before this registration.
  ipcMain.handle('comate:updater-check', () => updaterController?.check() ?? null);
  ipcMain.handle('comate:updater-download', () => updaterController?.download());
  ipcMain.handle('comate:updater-relaunch', () => updaterController?.relaunch());
}

// ---------------------------------------------------------------------------
// UI scheme handler (production static UI, KTD-15 keeps sidecar static
// hosting untouched for dev/diagnostics)
// ---------------------------------------------------------------------------

function registerUiProtocol(): void {
  const clientRoot = join(app.getAppPath(), 'dist', 'client');
  protocol.handle(UI_SCHEME, (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '' || pathname === '/') pathname = '/index.html';
    const resolved = join(clientRoot, pathname);
    if (resolved !== clientRoot && !resolved.startsWith(clientRoot + sep)) {
      return new Response('Forbidden', { status: 403 });
    }
    let filePath = resolved;
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      // SPA fallback (mirrors the sidecar's production static handler).
      filePath = join(clientRoot, 'index.html');
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function setupTray(): void {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'src-tauri', 'icons', '32x32.png');

  try {
    trayHandle = createTray({
      TrayClass: Tray,
      MenuClass: Menu,
      icon: nativeImage.createFromPath(iconPath),
      onOpen: showMainWindow,
      onQuit: () => initiateQuit('tray-quit'),
      logger,
    });
  } catch (err) {
    // Linux desktops without a status notifier host: window close-to-hide
    // still works; the app stays functional without a tray entry.
    logger.error(`Failed to build system tray: ${err instanceof Error ? err.message : String(err)}`);
  }

  trayPoller = runTrayStatusPoller({
    getPort: () => apiPort,
    getToken: () => apiToken,
    isShuttingDown: () => isShuttingDown,
    onStatus: (status) => trayHandle?.updateStatus(status),
    logger,
  });
}

// ---------------------------------------------------------------------------
// Sidecar lifecycle
// ---------------------------------------------------------------------------

/**
 * Verify the pre-allocated debug port actually came up (post-ready probe of
 * /json/version). Returns null when the devtools server lost the bind race or
 * never started — the sidecar then degrades to its fallback stack and
 * /api/health/browser reports debug_port_unreachable.
 */
async function readShellDebugPort(): Promise<number | null> {
  if (shellDebugPortSetting === null) return null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${shellDebugPortSetting}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (res.ok) return shellDebugPortSetting;
    } catch {
      // devtools server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

/**
 * U7 (KTD-11): per-boot-token control channel + browser view manager. Runs
 * before the sidecar spawn so the ready env carries live coordinates. Failure
 * is non-fatal: the app runs, the browser stack reports its failure class via
 * /api/health/browser.
 */
async function setupControlChannel(): Promise<void> {
  shellControlToken = process.env['COMATE_SHELL_CONTROL_TOKEN'] || randomBytes(24).toString('base64url');
  const buffered: ControlEvent[] = [];
  let emit: (event: ControlEvent) => void = (event) => buffered.push(event);
  viewManager = createElectronViewManager({
    createViewImpl: (options) =>
      new WebContentsView(options as Electron.WebContentsViewConstructorOptions) as unknown as never,
    sessionFromPartition: (partition) => session.fromPartition(partition) as never,
    onEvent: (event) => emit(event),
    logger,
  });
  const controlPortOverride = process.env['COMATE_SHELL_CONTROL_PORT'];
  controlServer = await createControlServer({
    token: shellControlToken,
    views: viewManager,
    isQuitting: () => isQuitting || isShuttingDown,
    logger,
    ...(controlPortOverride ? { port: Number(controlPortOverride) } : {}),
  });
  shellControlPort = controlServer.port;
  emit = (event) => controlServer?.emit(event);
  for (const event of buffered) emit(event);

  shellDebugPort = await readShellDebugPort();
  if (shellDebugPort === null) {
    logger.error('Chromium debug port never materialized (DevToolsActivePort missing)');
  }
  logger.info(`Control channel on 127.0.0.1:${shellControlPort} (debug port: ${shellDebugPort ?? 'unavailable'})`);
}

function startSidecar(): void {
  const pathEnv = {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    repoRoot: app.getAppPath(),
    platform: process.platform,
    arch: process.arch,
  };
  const binaryPath = resolveSidecarBinaryPath(pathEnv);
  const resourceDir = resolveResourceDir(pathEnv);

  try {
    mkdirSync(legacyDataDir, { recursive: true });
  } catch (err) {
    showFatalError(
      `Cannot create data directory ${legacyDataDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  logger.info(`Spawning sidecar: ${binaryPath} (resources: ${resourceDir})`);
  sidecar = spawnSidecar({
    binaryPath,
    env: buildSidecarEnv({
      dataDir: legacyDataDir,
      resourceDir,
      shellDebugPort: shellDebugPort ?? undefined,
      shellControlPort: shellControlPort ?? undefined,
      shellControlToken: shellControlToken ?? undefined,
    }),
    logger,
    debugStdout: !app.isPackaged,
    onExit: (code, signal) => {
      if (!isShuttingDown) {
        showFatalError(
          `The Comate backend stopped unexpectedly (code=${String(code)}, signal=${String(
            signal,
          )}). Please quit and restart the app.`,
        );
      }
    },
  });

  sidecar.ready
    .then(({ port, desktopToken }) => {
      apiPort = port;
      apiToken = desktopToken ?? null;
      logger.info(`Sidecar ready on port ${port}`);
    })
    .catch((err: unknown) => {
      showFatalError(
        `The Comate backend failed to start: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
}

/** Double-entry guard mirrors lib.rs is_shutting_down compare_exchange. */
async function performShutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  trayPoller?.stop();
  // U5: ANY quit carrying a downloaded update (electron-updater's implicit
  // autoInstallOnAppQuit on tray-quit / Cmd+Q, not just the explicit relaunch
  // path) takes the 5s update grace so sidecar cleanup doesn't race the
  // installer relaunch (lib.rs is_updating parity).
  if (updaterController?.hasDownloadedUpdate()) {
    if (!isUpdating) {
      logger.info('Downloaded update pending on implicit quit — arming update grace');
    }
    isUpdating = true;
  }
  const graceMs = selectShutdownGraceMs(pendingQuitReason, isUpdating);
  logger.info(`Shutting down sidecar (reason=${pendingQuitReason}, grace=${graceMs}ms)`);
  if (sidecar) {
    await shutdownSidecar(sidecar, { port: apiPort, graceMs, logger });
  }
  // Keep the control channel up until the sidecar is down — its teardown may
  // still destroy views/wipe partitions through it (KTD-11).
  if (viewManager) {
    await viewManager.destroyAll().catch(() => undefined);
    viewManager = null;
  }
  if (controlServer) {
    await controlServer.close().catch(() => undefined);
    controlServer = null;
  }
}

function initiateQuit(reason: ShutdownReason): void {
  pendingQuitReason = reason;
  isQuitting = true;
  app.quit();
}

// ---------------------------------------------------------------------------
// App event wiring
// ---------------------------------------------------------------------------

// The debug-port switch must land before Chromium init, so every app handler
// registration waits out the (sub-millisecond) port allocation (KTD-6).
void debugPortConfigured.then(() => {
  const gotSingleInstanceLock = app.requestSingleInstanceLock();
  if (!gotSingleInstanceLock) {
    // A second launch focuses the existing window and exits (lib.rs
    // tauri_plugin_single_instance).
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    showMainWindow();
  });

  app.on('before-quit', (event) => {
    if (isShuttingDown) return; // cleanup already ran; let the quit proceed
    event.preventDefault();
    isQuitting = true;
    void performShutdown().finally(() => {
      app.quit();
    });
  });

  // Tray-resident app: closing every window never quits (lib.rs close-to-hide).
  app.on('window-all-closed', () => {});

  app.on('activate', () => {
    // macOS dock click.
    if (mainWindow === null) {
      mainWindow = createMainWindow();
    } else {
      showMainWindow();
    }
  });

  void app.whenReady().then(async () => {
    logger.info(`Comate shell starting (data dir: ${legacyDataDir})`);
    installAppMenu();
    registerUiProtocol();
    setupUpdater();
    registerIpcHandlers();
    mainWindow = createMainWindow();
    setupTray();
    try {
      await setupControlChannel();
    } catch (err) {
      // Non-fatal: the app runs without the native browser stack; the sidecar
      // degrades to its fallback and /api/health/browser reports the class.
      logger.error(`Control channel failed to start: ${err instanceof Error ? err.message : String(err)}`);
      controlServer = null;
      viewManager = null;
      shellDebugPort = null;
      shellControlPort = null;
      shellControlToken = null;
    }
    startSidecar();
  });
});
