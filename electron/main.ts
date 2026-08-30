/**
 * U1: Electron main process — the shell-skeleton port of the legacy Tauri
 * shell (`lib.rs`, retired in U9).
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

import { app, BrowserWindow, Menu, Notification, Tray, WebContentsView, dialog, ipcMain, nativeImage, nativeTheme, net, protocol, session, shell } from 'electron';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MISSING_UPDATE_FEED_ERROR } from '../src/shared/updater-contract';
import { APP_ID, resolveLegacyDataDir } from './paths';
import { createNoopShellLogger, createShellLogger, type ShellLogger } from './logger';
import { createApiInfoLatch } from './api-info';
import {
  createControlServer,
  SESSION_ID_PATTERN,
  type ControlEvent,
  type ControlServerHandle,
} from './control-server';
import {
  createBrowserViewManager,
  type BrowserViewManager,
  type HostWindowLike,
} from './browser-view-manager';
import {
  createDetachedBrowserWindowController,
  parseDetachedBrowserPlacement,
  type DetachedBrowserPlacement,
  type DetachedBrowserWindowController,
  type DetachedBrowserWindowLike,
} from './detached-browser-window';
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
import { createTray, resolveWindowCloseAction, runTrayStatusPoller, type TrayHandle, type TrayStatusPoller } from './tray';
import { runFirstRunCleanup } from './first-run-cleanup';
import { installAppMenu } from './menu';
import { enforceSingleInstance } from './single-instance';
import { autoUpdater } from 'electron-updater';
import {
  createUpdaterController,
  type UpdaterAdapter,
  type UpdaterController,
} from './updater';
import { resolvePackagedRuntime, resolveUpdaterRuntimeConfig } from './runtime-mode';
import {
  createFailoverUpdaterAdapter,
  fetchManifestWithTimeout,
  loadUpdateSources,
  selectUpdateSources,
  type UpdateBackend,
} from './update-source';
import { isTrustedUiUrl as matchesTrustedUiUrl } from './trusted-ui-url';
import { addSidecarAuthorization } from './api-request-auth';
import { getLinuxLaunchAtLogin, setLinuxLaunchAtLogin } from './launch-at-login';

// ---------------------------------------------------------------------------
// Early, pre-ready setup (order matters: these must run before 'ready')
// ---------------------------------------------------------------------------

// Windows toast/shortcut identity (KTD-7). Safe no-op elsewhere.
app.setAppUserModelId(APP_ID);
app.setName('Comate');

const isPackagedRuntime = resolvePackagedRuntime(
  app.isPackaged,
  process.env['NODE_ENV_ELECTRON_VITE'],
);

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

// Acquire the process lock before allocating the debug port, creating logs,
// or starting any shell services. A losing launch exits immediately, while
// Electron signals the primary process to restore its existing window.
const isPrimaryInstance = enforceSingleInstance(app, showMainWindow);

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
//    header, verified against Chromium 151 — no origin wildcard is needed);
//  - dev-web mode has no shell process at all, so no debug port exists there
//    (the browser stack then reports target_misconfigured until the operator
//    points COMATE_BROWSER_CDP_TARGET at an external Chromium — the R8/AE2
//    fallback, U9 decision).
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
const debugPortConfigured: Promise<void> = isPrimaryInstance ? (async () => {
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
})() : Promise.resolve();

const logger: ShellLogger = isPrimaryInstance
  ? createShellLogger(join(legacyDataDir, 'logs'), {
      mirrorToConsole: !isPackagedRuntime,
    })
  : createNoopShellLogger();

// ---------------------------------------------------------------------------
// Shell state (lib.rs AppState)
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;
let detachedBrowserController: DetachedBrowserWindowController | null = null;
let sidecar: SidecarHandle | null = null;
let trayHandle: TrayHandle | null = null;
let trayPoller: TrayStatusPoller | null = null;
let apiPort: number | null = null;
let apiToken: string | null = null;
const apiInfoLatch = createApiInfoLatch();
let badgeCount = 0;
let isQuitting = false;
let isShuttingDown = false;
let isUpdating = false;
let pendingQuitReason: ShutdownReason = 'exit-requested';
let updaterController: UpdaterController | null = null;
// U7: control channel (KTD-11) + debug port (KTD-6) coordinates handed to the
// sidecar via spawn env. Null when the channel failed to start — the browser
// stack then reports its failure class via /api/health/browser (KTD-15
// degradation); the R8 fallback is COMATE_BROWSER_CDP_TARGET pointing at an
// operator-supplied external Chromium (U9 decision).
let controlServer: ControlServerHandle | null = null;
let viewManager: BrowserViewManager | null = null;
let shellDebugPort: number | null = null;
let shellControlPort: number | null = null;
let shellControlToken: string | null = null;

function authorizeSidecarMediaRequests(port: number, token: string): void {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    {
      urls: [
        `http://localhost:${port}/api/workspaces/*/files/media*`,
        `http://127.0.0.1:${port}/api/workspaces/*/files/media*`,
      ],
    },
    (details, callback) => {
      callback({
        requestHeaders: addSidecarAuthorization(details.requestHeaders, token),
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Updater (U5: electron-updater behind the pure state machine in updater.ts)
// ---------------------------------------------------------------------------

/** electron-updater releaseNotes: string, per-version array, or absent. */
function releaseNotesToBody(notes: unknown): string | undefined {
  if (typeof notes === 'string') return notes;
  if (!Array.isArray(notes)) return undefined;
  return notes
    .map((n) => n.note)
    .filter((n): n is string => typeof n === 'string')
    .join('\n\n');
}

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
  const updaterRuntime = resolveUpdaterRuntimeConfig(
    isPackagedRuntime,
    process.resourcesPath,
    app.getAppPath(),
    existsSync,
  );
  autoUpdater.forceDevUpdateConfig = updaterRuntime.forceDevUpdateConfig;
  autoUpdater.logger = logger;
  const backend: UpdateBackend = {
    setFeedURL: (feed) => autoUpdater.setFeedURL(feed),
    async checkForUpdates() {
      if (!updaterRuntime.enabled) {
        if (isPackagedRuntime) {
          throw new Error(MISSING_UPDATE_FEED_ERROR);
        }
        return null;
      }
      const result = await autoUpdater.checkForUpdates();
      // electron-updater resolves a non-null { isUpdateAvailable: false,
      // updateInfo } when already up-to-date — map that to null, otherwise
      // the controller reports an available update whose download always
      // rejects with 'Please check update first' (AppUpdater.doCheckForUpdates).
      if (!result || result.isUpdateAvailable === false) return null;
      const { updateInfo } = result;
      const notes = updateInfo.releaseNotes;
      return {
        version: updateInfo.version,
        body: releaseNotesToBody(notes),
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

  // A developer-provided dev-app-update.yml remains authoritative in dev so
  // local feeds keep working. Packaged builds probe both public mirrors and
  // let the pure failover adapter own source switching and retry semantics.
  if (!isPackagedRuntime || !updaterRuntime.enabled) return backend;

  const configPath = join(process.resourcesPath, 'app-update.yml');
  const sources = loadUpdateSources({
    readConfig: () => readFileSync(configPath, 'utf8'),
    platform: process.platform,
    arch: process.arch,
    logger,
  });
  if (!sources) return backend;
  return createFailoverUpdaterAdapter({
    backend,
    logger,
    selectSources: () =>
      selectUpdateSources(
        sources,
        (source) =>
          fetchManifestWithTimeout(source, (url, init) => net.fetch(url, init), 6_000),
      ),
  });
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

function loadUi(win: BrowserWindow, mode?: 'detached-browser'): Promise<void> {
  const query = mode ? `?window=${mode}` : '';
  if (isPackagedRuntime) {
    return win.loadURL(`${UI_SCHEME}://localhost/index.html${query}`);
  }
  const devUrl = `http://localhost:5173/${query}`;
  const initialLoad = win.loadURL(devUrl).catch(() => {
    // did-fail-load below retries while the Vite dev server is still booting.
  });
  win.webContents.on('did-fail-load', (_event, _errorCode, _description, validatedURL) => {
    if (isPackagedRuntime || !validatedURL.startsWith(devUrl)) return;
    setTimeout(() => {
      if (!win.isDestroyed()) {
        void win.loadURL(devUrl).catch(() => {});
      }
    }, 500);
  });
  return initialLoad;
}

/** Window/tray icon: staged at resources root packaged, build/ in dev. */
function shellIconPath(): string {
  return isPackagedRuntime
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'build', 'icon.png');
}

// Windows titleBarOverlay colors mirror the app's --color-chrome (header bg)
// and --color-text-secondary (caption symbols) so the native min/max/close
// buttons blend into the custom header. Values track src/client/index.css —
// if those CSS variables change, update these to match.
const TITLEBAR_CHROME_LIGHT = '#f5f5f5'; // hsl(0 0% 96%)
const TITLEBAR_CHROME_DARK = '#212121';  // hsl(0 0% 13%)
const TITLEBAR_SYMBOL_LIGHT = '#6b6b6b'; // hsl(0 0% 42%)
const TITLEBAR_SYMBOL_DARK = '#9e9e9e';  // hsl(0 0% 62%)
const TITLEBAR_HEIGHT = 44;              // matches the h-11 header (11 × 4px)

/** Windows only: native caption-button overlay styled to match the app theme. */
function titlebarOverlayOpts(dark = nativeTheme.shouldUseDarkColors) {
  return {
    color: dark ? TITLEBAR_CHROME_DARK : TITLEBAR_CHROME_LIGHT,
    symbolColor: dark ? TITLEBAR_SYMBOL_DARK : TITLEBAR_SYMBOL_LIGHT,
    height: TITLEBAR_HEIGHT,
  };
}

function isMainWindowMaximized(): boolean {
  return Boolean(
    mainWindow &&
    !mainWindow.isDestroyed() &&
    (mainWindow.isMaximized() || mainWindow.isFullScreen()),
  );
}

function isTrustedUiUrl(url: string): boolean {
  return matchesTrustedUiUrl(url, {
    uiScheme: UI_SCHEME,
    isPackaged: isPackagedRuntime,
  });
}

function hardenTrustedUiWindow(win: BrowserWindow): void {
  // These windows expose privileged preload capabilities. Their main frames
  // must stay on the bundled UI origin, and renderer-created windows are
  // denied so a remote document can never inherit the preload.
  win.webContents.on('will-navigate', (event, url) => {
    if (isTrustedUiUrl(url)) return;
    event.preventDefault();
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
}

function createDetachedBrowserWindow(): BrowserWindow {
  const win = new BrowserWindow({
    title: 'Browser',
    width: 960,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    show: false,
    icon: nativeImage.createFromPath(shellIconPath()),
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'detached-browser-preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  hardenTrustedUiWindow(win);
  return win;
}

function publishDetachedPlacement(placement: DetachedBrowserPlacement | null): void {
  for (const win of [mainWindow, detachedBrowserController?.getWindow() ?? null]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('comate:detached-browser-placement-changed', placement);
    }
  }
}

function setupDetachedBrowserController(): void {
  detachedBrowserController = createDetachedBrowserWindowController({
    createWindow: () => createDetachedBrowserWindow() as unknown as DetachedBrowserWindowLike,
    mainWindow: () => mainWindow as never,
    setViewHost: (sessionId, host) => viewManager?.setViewHost(sessionId, host),
    loadWindow: (win) => loadUi(win as unknown as BrowserWindow, 'detached-browser'),
    publishPlacement: publishDetachedPlacement,
  });
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    title: 'Comate',
    width: 1280,
    height: 800,
    minWidth: 480,
    minHeight: 600,
    center: true,
    icon: nativeImage.createFromPath(shellIconPath()),
    // macOS parity with the Tauri shell (Overlay + hiddenTitle): the client
    // reserves pl-20 for the traffic lights and drags via -webkit-app-region.
    // Tauri's trafficLightPosition y is center-based (22 = half of the h-11
    // header); Electron's is the button's top edge, so 22 - 6 (12px button).
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 14, y: 16 } }
      : process.platform === 'win32'
        ? { titleBarStyle: 'hidden' as const, titleBarOverlay: titlebarOverlayOpts() }
        : {}),
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  if (process.platform === 'win32') {
    const publishMaximizedState = (): void => {
      if (!win.webContents.isDestroyed()) {
        win.webContents.send('comate:window-maximized-changed', isMainWindowMaximized());
      }
    };
    win.on('maximize', publishMaximizedState);
    win.on('unmaximize', publishMaximizedState);
    win.on('enter-full-screen', publishMaximizedState);
    win.on('leave-full-screen', publishMaximizedState);
  }

  hardenTrustedUiWindow(win);

  // Close-to-tray: hide instead of closing, unless an explicit quit path
  // (tray Quit / Cmd+Q / update install) armed isQuitting first. U10: with
  // no tray (creation failed — realistic on Linux desktops lacking a status
  // notifier host) close-to-hide is a trap, so close degrades to quitting
  // (resolveWindowCloseAction in tray.ts).
  win.on('close', (event) => {
    const action = resolveWindowCloseAction(isQuitting || isShuttingDown, trayHandle !== null);
    if (action === 'close') return;
    event.preventDefault();
    if (action === 'quit') {
      initiateQuit('window-destroyed');
      return;
    }
    // The tray represents a hidden single-window application state. Redock
    // before hiding so reopening never leaves an orphan auxiliary window.
    detachedBrowserController?.restore();
    win.hide();
    if (process.platform === 'darwin' && badgeCount === 0) {
      app.setActivationPolicy('accessory');
    }
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  void loadUi(win);
  return win;
}

// ---------------------------------------------------------------------------
// IPC bridge (lib.rs commands; preload exposes getApiInfo/showWindow today,
// U2 wires the rest of the client bridge)
// ---------------------------------------------------------------------------

function trustedRendererWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  if (!event.senderFrame || !isTrustedUiUrl(event.senderFrame.url)) return null;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return null;
  const detached = (detachedBrowserController?.getWindow() ?? null) as BrowserWindow | null;
  return win === mainWindow || win === detached ? win : null;
}

function registerIpcHandlers(): void {
  ipcMain.handle('comate:get-api-info', () => apiInfoLatch.wait());

  ipcMain.handle('comate:show-window', () => {
    showMainWindow();
  });

  ipcMain.handle('comate:is-window-maximized', () => isMainWindowMaximized());

  // Windows: recolor the native min/max/close caption buttons to match the
  // app theme. The renderer calls this on every theme change; no-op off Win32
  // (the overlay only exists with titleBarStyle: 'hidden').
  ipcMain.handle('comate:set-titlebar-overlay', (_event, theme: unknown) => {
    if (process.platform !== 'win32' || !mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setTitleBarOverlay(titlebarOverlayOpts(theme === 'dark'));
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
  // selected in its parent (≈ open -R / explorer /select). Linux caveat
  // (U10): the item highlight rides the org.freedesktop.FileManager1 DBus
  // API — file managers without ShowItems support still open the parent
  // folder but don't select the item; on minimal setups without any portal
  // the call is a silent no-op. Accepted platform difference, verified in
  // the Linux smoke checklist (docs/runbooks/linux-smoke.md).
  ipcMain.handle('comate:reveal-in-file-manager', (_event, targetPath: unknown) => {
    if (typeof targetPath !== 'string' || targetPath.length === 0) {
      throw new Error('reveal-in-file-manager: path is required');
    }
    shell.showItemInFolder(targetPath);
  });

  // Open-folder semantics: unlike reveal-in-file-manager (which selects the
  // item in its parent), this opens the folder itself so the file manager
  // shows its contents — Finder/Explorer double-click behavior.
  ipcMain.handle('comate:open-folder', async (_event, targetPath: unknown) => {
    if (typeof targetPath !== 'string' || targetPath.length === 0) {
      throw new Error('open-folder: path is required');
    }
    // Defense in depth: shell.openPath would happily hand any renderer-supplied
    // path to the OS (it opens files with their default app too), so gate it
    // on the path being an existing directory.
    let stats;
    try {
      stats = statSync(targetPath);
    } catch {
      throw new Error('open-folder: path is not accessible');
    }
    if (!stats.isDirectory()) {
      throw new Error('open-folder: path is not a directory');
    }
    const errorMessage = await shell.openPath(targetPath);
    if (errorMessage) {
      throw new Error(`open-folder: ${errorMessage}`);
    }
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

  // The OS owns persistence for launch-at-login. Reading the effective state
  // after writes keeps the renderer aligned when the platform rejects or
  // normalizes the requested registration.
  const linuxConfigHome =
    process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config');
  ipcMain.handle('comate:get-launch-at-login', () =>
    process.platform === 'linux'
      ? getLinuxLaunchAtLogin(linuxConfigHome)
      : app.getLoginItemSettings().openAtLogin,
  );
  ipcMain.handle('comate:set-launch-at-login', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      throw new Error('set-launch-at-login: enabled must be a boolean');
    }
    if (process.platform === 'linux') {
      setLinuxLaunchAtLogin(linuxConfigHome, process.execPath, enabled);
      return getLinuxLaunchAtLogin(linuxConfigHome);
    }
    app.setLoginItemSettings({ openAtLogin: enabled });
    return app.getLoginItemSettings().openAtLogin;
  });

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

  // U8 (KTD-14): panel-driven browser view control. The renderer reports the
  // panel rect (window-relative CSS pixels — the UI view fills the window),
  // the control-state input gating, and the modal-occlusion flag; the view
  // manager applies them to the native WebContentsView. All inputs are
  // validated main-side; the view manager may not exist yet (control channel
  // still starting) — calls are then no-ops and the next rect report wins.
  ipcMain.handle('comate:browser-view-report-rect', (event, sessionId: unknown, rect: unknown) => {
    const host = trustedRendererWindow(event);
    if (!host) return;
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return;
    if (rect === null) {
      void viewManager?.setViewBoundsFromHost(sessionId, host as never, null);
      return;
    }
    const { x, y, width, height } = (rect ?? {}) as Record<string, unknown>;
    if (![x, y, width, height].every((v) => typeof v === 'number' && Number.isFinite(v))) return;
    void viewManager?.setViewBoundsFromHost(sessionId, host as never, {
      x: Math.round(x as number),
      y: Math.round(y as number),
      width: Math.round(width as number),
      height: Math.round(height as number),
    });
  });
  ipcMain.handle('comate:browser-view-input-mode', (event, sessionId: unknown, mode: unknown) => {
    const host = trustedRendererWindow(event);
    if (!host) return;
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return;
    if (mode !== 'user' && mode !== 'agent') return;
    if (viewManager?.getViewHost(sessionId) !== (host as unknown as HostWindowLike)) return;
    viewManager?.setInputMode(sessionId, mode);
  });
  ipcMain.handle('comate:browser-view-occluded', (event, occluded: unknown) => {
    const host = trustedRendererWindow(event);
    if (!host) return;
    viewManager?.setHostOccluded(host as never, occluded === true);
  });
  // U9: the usage-login modal hosts its capture session's view inside the
  // modal — that one view is exempt from modal occlusion (every other view
  // still hides behind the overlay).
  ipcMain.handle('comate:browser-view-occlusion-exemption', (event, sessionId: unknown) => {
    if (trustedRendererWindow(event) !== mainWindow) return;
    if (sessionId !== null && (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId))) return;
    viewManager?.setOcclusionExemption(sessionId);
  });

  ipcMain.handle('comate:detached-browser-get-placement', (event) => {
    if (!trustedRendererWindow(event)) return null;
    return detachedBrowserController?.getPlacement() ?? null;
  });
  ipcMain.handle('comate:detached-browser-detach', async (event, input: unknown) => {
    if (trustedRendererWindow(event) !== mainWindow) {
      throw new Error('detached browser: main renderer required');
    }
    const placement = parseDetachedBrowserPlacement(input);
    if (!placement) throw new Error('detached browser: invalid placement');
    if (!detachedBrowserController) throw new Error('detached browser: controller unavailable');
    await detachedBrowserController.detach(placement);
  });
  ipcMain.handle('comate:detached-browser-focus', (event) => {
    if (trustedRendererWindow(event) !== mainWindow) return false;
    return detachedBrowserController?.focus() ?? false;
  });
  ipcMain.handle('comate:detached-browser-restore', (event) => {
    if (!trustedRendererWindow(event)) return false;
    return detachedBrowserController?.restore() ?? false;
  });
  ipcMain.handle('comate:detached-browser-renderer-ready', (event, sessionId: unknown) => {
    if (trustedRendererWindow(event) !== detachedBrowserController?.getWindow()) return false;
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return false;
    return detachedBrowserController?.rendererReady(sessionId) ?? false;
  });
  ipcMain.handle('comate:detached-browser-session-ended', (event, sessionId: unknown) => {
    if (trustedRendererWindow(event) !== detachedBrowserController?.getWindow()) return false;
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return false;
    return detachedBrowserController?.browserSessionEnded(sessionId) ?? false;
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
  try {
    // Menu-bar icons render at ~18pt; feeding the 512px app icon directly
    // produces an oversized tray glyph.
    let trayIcon = nativeImage.createFromPath(shellIconPath());
    if (process.platform === 'darwin') {
      trayIcon = trayIcon.resize({ width: 18 });
    }
    trayHandle = createTray({
      TrayClass: Tray,
      MenuClass: Menu,
      icon: trayIcon,
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
 * never started — the browser stack then reports debug_port_unreachable via
 * /api/health/browser (no silent fallback).
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
  viewManager = createBrowserViewManager({
    createViewImpl: (options) =>
      new WebContentsView(options as Electron.WebContentsViewConstructorOptions) as unknown as never,
    sessionFromPartition: (partition) => session.fromPartition(partition) as never,
    onEvent: (event) => emit(event),
    // U8: views attach to the main window's contentView once the panel
    // reports its rect; partitions live under <userData>/Partitions.
    hostWindow: () => mainWindow as never,
    partitionsDir: () => join(app.getPath('userData'), 'Partitions'),
    onEscape: (sessionId) => {
      viewManager?.getViewHost(sessionId)?.webContents.send('comate:browser-view-escape', sessionId);
    },
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
    isPackaged: isPackagedRuntime,
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
    const startupError = err instanceof Error ? err : new Error(String(err));
    apiInfoLatch.fail(startupError);
    showFatalError(
      `Cannot create data directory ${legacyDataDir}: ${startupError.message}`,
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
    debugStdout: !isPackagedRuntime,
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
      if (apiToken) authorizeSidecarMediaRequests(port, apiToken);
      apiInfoLatch.succeed({ port, token: desktopToken ?? '' });
      logger.info(`Sidecar ready on port ${port}`);
    })
    .catch((err: unknown) => {
      const startupError = err instanceof Error ? err : new Error(String(err));
      apiInfoLatch.fail(startupError);
      showFatalError(
        `The Comate backend failed to start: ${startupError.message}`,
      );
    });
}

/** Double-entry guard mirrors lib.rs is_shutting_down compare_exchange. */
async function performShutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  detachedBrowserController?.closeForQuit();
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
  if (!isPrimaryInstance) return;

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
    // macOS dock icon: BrowserWindow's `icon` option is ignored on darwin, so
    // dev mode would otherwise show Electron's default icon; packaged builds
    // already get the dock icon from the bundled icns (same artwork).
    if (process.platform === 'darwin') {
      app.dock?.setIcon(nativeImage.createFromPath(shellIconPath()));
    }
    // U9: sweep legacy browser-stack residue (profiles / pidfiles / Chromium
    // extraction caches) — idempotent, best-effort, never blocks startup;
    // the site-auth store (data.db) is preserved by construction.
    void runFirstRunCleanup(legacyDataDir, { logger }).catch((err: unknown) => {
      logger.warn(`[first-run-cleanup] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    installAppMenu();
    registerUiProtocol();
    setupUpdater();
    registerIpcHandlers();
    mainWindow = createMainWindow();
    setupTray();
    try {
      await setupControlChannel();
    } catch (err) {
      // Non-fatal: the app runs without the native browser stack;
      // /api/health/browser reports the failure class (KTD-15 degradation).
      logger.error(`Control channel failed to start: ${err instanceof Error ? err.message : String(err)}`);
      controlServer = null;
      viewManager = null;
      shellDebugPort = null;
      shellControlPort = null;
      shellControlToken = null;
    }
    setupDetachedBrowserController();
    startSidecar();
  });
});
