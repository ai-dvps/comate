import { create } from 'zustand'

export type UpdaterStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'restarting'

export interface UpdateInfo {
  currentVersion: string
  version: string
  body?: string
  date?: string
}

export interface UpdaterState {
  status: UpdaterStatus
  update: UpdateInfo | null
  downloadProgress: number
  error: string | null

  setChecking: () => void
  setAvailable: (update: UpdateInfo) => void
  setDownloading: () => void
  setDownloadProgress: (downloaded: number, total?: number) => void
  setReady: () => void
  setRestarting: () => void
  setIdle: () => void
  setError: (error: string) => void
  dismissUpdate: () => void
}

export const useUpdaterStore = create<UpdaterState>((set) => ({
  status: 'idle',
  update: null,
  downloadProgress: 0,
  error: null,

  setChecking: () =>
    set({
      status: 'checking',
      error: null,
      downloadProgress: 0,
    }),

  setAvailable: (update) =>
    set({
      status: 'available',
      update,
      error: null,
      downloadProgress: 0,
    }),

  setDownloading: () =>
    set({
      status: 'downloading',
      error: null,
      downloadProgress: 0,
    }),

  setDownloadProgress: (downloaded, total) => {
    const progress = total && total > 0 ? Math.round((downloaded / total) * 100) : 0
    set({ downloadProgress: Math.min(100, Math.max(0, progress)) })
  },

  setReady: () =>
    set({
      status: 'ready',
      downloadProgress: 100,
      error: null,
    }),

  setRestarting: () =>
    set({
      status: 'restarting',
      error: null,
    }),

  setIdle: () =>
    set({
      status: 'idle',
      update: null,
      downloadProgress: 0,
      error: null,
    }),

  setError: (error) =>
    set({
      status: 'idle',
      error,
      downloadProgress: 0,
    }),

  dismissUpdate: () =>
    set({
      status: 'idle',
      update: null,
      error: null,
      downloadProgress: 0,
    }),
}))
