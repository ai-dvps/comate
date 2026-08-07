import {
  isDesktop,
  checkForUpdate,
  prepareUpdaterRelaunch,
  relaunchApp,
  getAppVersion as getBridgeAppVersion,
  type DesktopUpdate,
  type DownloadEvent,
} from './desktop-api'
import { useUpdaterStore, type UpdaterStatus } from '../stores/updater-store'

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000 // 4 hours
const JITTER_MAX_MS = 5 * 60 * 1000 // 5 minutes

let checkIntervalId: ReturnType<typeof setInterval> | null = null
let currentUpdate: DesktopUpdate | null = null
let downloadedBytes = 0
let totalContentLength = 0

export interface UpdaterPreferences {
  autoCheckUpdates: boolean
}

function getIntervalWithJitter(): number {
  return CHECK_INTERVAL_MS + Math.floor(Math.random() * JITTER_MAX_MS)
}

function mapUpdate(update: DesktopUpdate): { currentVersion: string; version: string; body?: string; date?: string } {
  return {
    currentVersion: update.currentVersion,
    version: update.version,
    body: update.body,
    date: update.date,
  }
}

export function canStartDownload(status: UpdaterStatus): boolean {
  return status !== 'downloading' && status !== 'ready' && status !== 'restarting'
}

export function canRestart(status: UpdaterStatus): boolean {
  return status === 'ready'
}

export function handleDownloadEvent(event: DownloadEvent): void {
  const store = useUpdaterStore.getState()

  switch (event.event) {
    case 'Started':
      downloadedBytes = 0
      totalContentLength = event.data.contentLength ?? 0
      store.setDownloading()
      break
    case 'Progress':
      downloadedBytes += event.data.chunkLength
      store.setDownloadProgress(downloadedBytes, totalContentLength)
      break
    case 'Finished':
      store.setReady()
      break
  }
}

export async function checkForUpdates(): Promise<void> {
  if (!isDesktop()) return

  const store = useUpdaterStore.getState()
  if (store.status === 'downloading' || store.status === 'ready' || store.status === 'restarting') {
    return
  }

  store.setChecking()

  try {
    const update = await checkForUpdate()
    if (update) {
      currentUpdate = update
      store.setAvailable(mapUpdate(update))
    } else {
      currentUpdate = null
      store.setIdle()
    }
  } catch {
    currentUpdate = null
    store.setIdle()
  }
}

export async function downloadAndInstallUpdate(): Promise<void> {
  if (!isDesktop() || !currentUpdate) return

  const store = useUpdaterStore.getState()
  if (!canStartDownload(store.status)) return

  store.setDownloading()
  downloadedBytes = 0

  try {
    await currentUpdate.downloadAndInstall(handleDownloadEvent)
  } catch (err) {
    store.setError(err instanceof Error ? err.message : 'Download failed')
  }
}

export async function restartToUpdate(): Promise<void> {
  if (!isDesktop()) return

  const store = useUpdaterStore.getState()
  if (!canRestart(store.status)) return

  store.setRestarting()

  try {
    await prepareUpdaterRelaunch()
    await relaunchApp()
  } catch (err) {
    store.setError(err instanceof Error ? err.message : 'Restart failed')
  }
}

export function dismissUpdate(): void {
  currentUpdate = null
  useUpdaterStore.getState().dismissUpdate()
}

export function startPeriodicUpdateChecks(
  getPreferences: () => UpdaterPreferences,
  onCheck?: () => void
): void {
  if (!isDesktop()) return
  if (checkIntervalId) return

  void checkForUpdates().then(() => onCheck?.())

  const scheduleNext = () => {
    checkIntervalId = setInterval(() => {
      if (!getPreferences().autoCheckUpdates) return
      void checkForUpdates().then(() => onCheck?.())
    }, getIntervalWithJitter())
  }

  scheduleNext()
}

export function stopPeriodicUpdateChecks(): void {
  if (checkIntervalId) {
    clearInterval(checkIntervalId)
    checkIntervalId = null
  }
}

export async function getAppVersion(): Promise<string | null> {
  if (!isDesktop()) return null
  return getBridgeAppVersion()
}
