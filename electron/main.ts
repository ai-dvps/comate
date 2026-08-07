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

import { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, net, protocol, shell } from 'electron';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_ID, resolveLegacyDataDir } from './paths';
import { createShellLogger, type ShellLogger } from './logger';
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

// ---------------------------------------------------------------------------
// Early, pre-ready setup (order matters: these must run before 'ready')
// ---------------------------------------------------------------------------

// Windows toast/shortcut identity (KTD-7). Safe no-op elsewhere.
app.setAppUserModelId(APP_ID);
app.setName('Comate');

// KTD-7: pin the data dir to the exact legacy Tauri path per platform, and
// pin Electron's userData (Chromium profile/caches) to a `shell/` subdir
// under the same root so bridged installs share one data root.
const legacyDataDir = resolveLegacyDataDir({
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

  // TODO(U5): electron-updater. Until it is wired, check is a benign
  // "no update available" so the client's periodic checks stay quiet, and
  // relaunch fails loudly (it is unreachable while check returns null).
  ipcMain.handle('comate:updater-check', () => null);
  ipcMain.handle('comate:updater-relaunch', () => {
    throw new Error('Updater not available yet (U5: electron-updater not wired)');
  });
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
    env: buildSidecarEnv({ dataDir: legacyDataDir, resourceDir }),
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
  const graceMs = selectShutdownGraceMs(pendingQuitReason, isUpdating);
  logger.info(`Shutting down sidecar (reason=${pendingQuitReason}, grace=${graceMs}ms)`);
  if (sidecar) {
    await shutdownSidecar(sidecar, { port: apiPort, graceMs, logger });
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

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // A second launch focuses the existing window and exits (lib.rs
  // tauri_plugin_single_instance).
  app.quit();
} else {
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

  void app.whenReady().then(() => {
    logger.info(`Comate shell starting (data dir: ${legacyDataDir})`);
    installAppMenu();
    registerUiProtocol();
    registerIpcHandlers();
    mainWindow = createMainWindow();
    setupTray();
    startSidecar();
  });
}
