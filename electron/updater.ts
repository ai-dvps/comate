/**
 * U5: updater state machine — pure logic over an injectable adapter, so the
 * whole module is node:test-able without an Electron runtime. electron/main.ts
 * supplies the real adapter backed by electron-updater's `autoUpdater`.
 *
 * Parity with the legacy Tauri line (tauri-plugin-updater):
 *  - `autoDownload = false` keeps the manual-download UX: check only discovers,
 *    the client explicitly downloads (UpdateNotification "Download" button);
 *  - quitAndInstall is preceded by arming the is_updating grace (5s sidecar
 *    grace, `prepare_updater_relaunch` semantics) via `armUpdateGrace`;
 *  - `hasDownloadedUpdate()` lets the shell arm the same grace for ANY
 *    implicit quit that carries a downloaded update (electron-updater's
 *    autoInstallOnAppQuit fires on tray-quit / Cmd+Q too);
 *  - failures (manifest 404, signature/checksum mismatch) land in a retryable
 *    `error` state and are logged — never silent;
 *  - same-source retries can resume through electron-updater's cache, while a
 *    cross-source failover resets byte progress and emits a fresh Started event.
 *
 * Event contract: the client (`src/client/lib/updater-api.ts`) keeps the old
 * plugin-updater DownloadEvent shape — Started{contentLength}, then per-chunk
 * Progress{chunkLength} deltas, then Finished. electron-updater reports
 * cumulative `transferred` bytes, so Started is emitted lazily on the FIRST
 * progress event (the only point the total is known) and Progress carries the
 * delta since the previous event.
 */

export interface UpdaterCheckInfo {
  version: string;
  body?: string | undefined;
  date?: string | undefined;
}

/** What the IPC `comate:updater-check` handler resolves with. */
export interface UpdaterUpdateInfo extends UpdaterCheckInfo {
  currentVersion: string;
}

/** Mirrors the client-side DownloadEvent (src/client/lib/desktop-api.ts). */
export type UpdaterDownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

/**
 * Thin seam over electron-updater. `checkForUpdates` resolves null when no
 * update is available and REJECTS on transport/manifest/signature errors.
 * Note: electron-updater's raw checkForUpdates resolves a NON-NULL
 * `{ isUpdateAvailable: false, updateInfo }` when already up-to-date — the
 * real adapter (createElectronUpdaterAdapter in main.ts) maps that to null
 * so this contract holds. `downloadUpdate` rejects on download/signature
 * errors; progress is pushed through `onDownloadProgress` with cumulative
 * byte counts.
 */
export interface UpdaterAdapter {
  checkForUpdates(): Promise<UpdaterCheckInfo | null>;
  downloadUpdate(): Promise<void>;
  quitAndInstall(): void;
  onDownloadProgress(handler: (progress: { transferred: number; total: number }) => void): void;
  /** Signals that an automatic source failover restarted byte progress. */
  onDownloadRestart?(handler: () => void): void;
}

export type UpdaterStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdaterState {
  status: UpdaterStatus;
  /** Retained through download errors so the error state stays retryable. */
  update: UpdaterUpdateInfo | null;
  error: string | null;
}

export interface UpdaterLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface UpdaterControllerDeps {
  adapter: UpdaterAdapter;
  currentVersion: string;
  logger?: UpdaterLogger;
  /** Download events pushed to the renderer (whitelisted preload channel). */
  onDownloadEvent?: (event: UpdaterDownloadEvent) => void;
  /** Arms the shell's is_updating flag (5s sidecar shutdown grace). */
  armUpdateGrace?: () => void;
}

export interface UpdaterController {
  /** Discover an update; resolves null when none and rejects on check errors. */
  check(): Promise<UpdaterUpdateInfo | null>;
  /** Manually download the discovered update; resumable across failures. */
  download(): Promise<void>;
  /** Arm the update grace, then quitAndInstall. Throws unless downloaded. */
  relaunch(): void;
  getState(): UpdaterState;
  /** True once an update is downloaded (implicit install-on-quit arming). */
  hasDownloadedUpdate(): boolean;
}

const noopLogger: UpdaterLogger = { info: () => {}, warn: () => {}, error: () => {} };

export function updaterErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createUpdaterController(deps: UpdaterControllerDeps): UpdaterController {
  const logger = deps.logger ?? noopLogger;

  let state: UpdaterState = { status: 'idle', update: null, error: null };
  let inflightCheck: Promise<UpdaterUpdateInfo | null> | null = null;
  let inflightDownload: Promise<void> | null = null;
  // Cumulative-bytes → per-chunk-delta conversion state.
  let downloadStarted = false;
  let lastTransferred = 0;

  function setState(next: UpdaterState): void {
    state = next;
  }

  deps.adapter.onDownloadProgress(({ transferred, total }) => {
    if (state.status !== 'downloading') return;
    if (!downloadStarted) {
      downloadStarted = true;
      deps.onDownloadEvent?.({ event: 'Started', data: { contentLength: total } });
    }
    const chunkLength = Math.max(0, transferred - lastTransferred);
    lastTransferred = transferred;
    deps.onDownloadEvent?.({ event: 'Progress', data: { chunkLength } });
  });
  deps.adapter.onDownloadRestart?.(() => {
    downloadStarted = false;
    lastTransferred = 0;
  });

  async function doCheck(): Promise<UpdaterUpdateInfo | null> {
    setState({ status: 'checking', update: state.update, error: null });
    let checkInfo: UpdaterCheckInfo | null;
    try {
      checkInfo = await deps.adapter.checkForUpdates();
    } catch (err) {
      const message = updaterErrorMessage(err);
      logger.error(`Update check failed: ${message}`);
      setState({ status: 'error', update: null, error: message });
      throw err;
    }
    if (!checkInfo) {
      setState({ status: 'idle', update: null, error: null });
      return null;
    }
    const update: UpdaterUpdateInfo = {
      currentVersion: deps.currentVersion,
      version: checkInfo.version,
      body: checkInfo.body,
      date: checkInfo.date,
    };
    logger.info(`Update available: ${deps.currentVersion} → ${update.version}`);
    setState({ status: 'available', update, error: null });
    return update;
  }

  async function check(): Promise<UpdaterUpdateInfo | null> {
    // A download already in flight or finished wins over re-discovery — the
    // client polls every 4h and must not clobber it.
    if (state.status === 'downloading' || state.status === 'downloaded') {
      return state.update;
    }
    if (inflightCheck) return inflightCheck;
    inflightCheck = doCheck().finally(() => {
      inflightCheck = null;
    });
    return inflightCheck;
  }

  async function doDownload(update: UpdaterUpdateInfo): Promise<void> {
    downloadStarted = false;
    lastTransferred = 0;
    setState({ status: 'downloading', update, error: null });
    try {
      await deps.adapter.downloadUpdate();
    } catch (err) {
      const message = updaterErrorMessage(err);
      logger.error(`Update download failed (retryable): ${message}`);
      setState({ status: 'error', update, error: message });
      throw err;
    }
    logger.info(`Update ${update.version} downloaded; ready to install on restart`);
    setState({ status: 'downloaded', update, error: null });
    deps.onDownloadEvent?.({ event: 'Finished' });
  }

  async function download(): Promise<void> {
    if (state.status === 'downloaded') {
      // Idempotent: a late caller still learns the download finished.
      deps.onDownloadEvent?.({ event: 'Finished' });
      return;
    }
    if (inflightDownload) return inflightDownload;
    const update = state.update;
    if (!update || (state.status !== 'available' && state.status !== 'error')) {
      throw new Error('No update available to download — run check first');
    }
    inflightDownload = doDownload(update).finally(() => {
      inflightDownload = null;
    });
    return inflightDownload;
  }

  function relaunch(): void {
    if (state.status !== 'downloaded') {
      throw new Error('No downloaded update to install — download first');
    }
    // Arm BEFORE quitAndInstall: the ensuing quit must take the 5s update
    // grace for sidecar cleanup (lib.rs prepare_updater_relaunch parity).
    deps.armUpdateGrace?.();
    deps.adapter.quitAndInstall();
  }

  return {
    check,
    download,
    relaunch,
    getState: () => state,
    hasDownloadedUpdate: () => state.status === 'downloaded',
  };
}
