import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './tauri-api'
import { useUpdaterStore } from '../stores/updater-store'
import { getVersion } from '@tauri-apps/api/app'

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000 // 4 hours
const JITTER_MAX_MS = 5 * 60 * 1000 // 5 minutes

let checkIntervalId: ReturnType<typeof setInterval> | null = null
let currentUpdate: Update | null = null
let downloadedBytes = 0

export interface UpdaterPreferences {
  autoCheckUpdates: boolean
}

function getIntervalWithJitter(): number {
  return CHECK_INTERVAL_MS + Math.floor(Math.random() * JITTER_MAX_MS)
}

function mapUpdate(update: Update): { currentVersion: string; version: string; body?: string; date?: string } {
  return {
    currentVersion: update.currentVersion,
    version: update.version,
    body: update.body,
    date: update.date,
  }
}

function handleDownloadEvent(event: DownloadEvent): void {
  const store = useUpdaterStore.getState()

  switch (event.event) {
    case 'Started':
      downloadedBytes = 0
      store.setDownloading()
      break
    case 'Progress':
      downloadedBytes += event.data.chunkLength
      store.setDownloadProgress(downloadedBytes)
      break
    case 'Finished':
      store.setReady()
      break
  }
}

export async function checkForUpdates(): Promise<void> {
  if (!isTauri()) return

  const store = useUpdaterStore.getState()
  if (store.status === 'downloading' || store.status === 'ready' || store.status === 'restarting') {
    return
  }

  store.setChecking()

  try {
    const update = await check()
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
  if (!isTauri() || !currentUpdate) return

  const store = useUpdaterStore.getState()
  store.setDownloading()
  downloadedBytes = 0

  try {
    await currentUpdate.downloadAndInstall(handleDownloadEvent)
  } catch (err) {
    store.setError(err instanceof Error ? err.message : 'Download failed')
  }
}

export async function restartToUpdate(): Promise<void> {
  if (!isTauri()) return

  const store = useUpdaterStore.getState()
  store.setRestarting()

  try {
    await invoke('prepare_updater_relaunch')
    await relaunch()
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
  if (!isTauri()) return
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
  if (!isTauri()) return null
  try {
    return await getVersion()
  } catch {
    return null
  }
}
