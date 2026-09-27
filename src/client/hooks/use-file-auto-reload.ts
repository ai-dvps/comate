import { useEffect, useState } from 'react'
import { useContextTabStore } from '../stores/context-tab-store'

/** Only the visible preview polls; revisiting a tab checks it immediately. */
export function useFileAutoReload(workspaceId: string, id: string, path: string) {
  const [failedPath, setFailedPath] = useState<string>()
  const identity = JSON.stringify([workspaceId, id, path])

  useEffect(() => {
    if (!path) return
    let disposed = false
    let pending: AbortController | undefined
    const check = async () => {
      if (disposed || pending || document.visibilityState === 'hidden') return
      const store = useContextTabStore.getState()
      const tab = store.workspaceTabs[workspaceId]?.tabs.find((item) => item.id === id)
      if (tab?.type !== 'file' || tab.path !== path) return
      const controller = new AbortController()
      pending = controller
      const timeout = setTimeout(() => controller.abort(), 15_000)
      try {
        await store.refreshFile(tab, controller.signal)
        if (!disposed) setFailedPath(undefined)
      } catch {
        if (!disposed) setFailedPath(identity)
      } finally {
        clearTimeout(timeout)
        pending = undefined
      }
    }
    void check()
    const interval = setInterval(() => void check(), 2_000)
    const onVisible = () => { void check() }
    window.addEventListener('focus', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      disposed = true
      pending?.abort()
      clearInterval(interval)
      window.removeEventListener('focus', onVisible)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [workspaceId, id, path, identity])

  return failedPath === identity
}
