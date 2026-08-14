import {
  getDesktopBridge,
  type DetachedBrowserPlacement,
} from './desktop-api'

export async function detachBrowserWindow(placement: DetachedBrowserPlacement): Promise<void> {
  await getDesktopBridge()?.detachedBrowser?.detach?.(placement)
}

export async function focusDetachedBrowserWindow(): Promise<boolean> {
  return (await getDesktopBridge()?.detachedBrowser?.focus?.()) ?? false
}

export async function restoreDetachedBrowser(): Promise<boolean> {
  return (await getDesktopBridge()?.detachedBrowser?.restore?.()) ?? false
}

export async function getDetachedBrowserPlacement(): Promise<DetachedBrowserPlacement | null> {
  return (await getDesktopBridge()?.detachedBrowser?.getPlacement?.()) ?? null
}

export async function markDetachedBrowserRendererReady(sessionId: string): Promise<boolean> {
  return (await getDesktopBridge()?.detachedBrowser?.rendererReady?.(sessionId)) ?? false
}

export async function notifyDetachedBrowserSessionEnded(sessionId: string): Promise<boolean> {
  return (await getDesktopBridge()?.detachedBrowser?.sessionEnded?.(sessionId)) ?? false
}

export function onDetachedBrowserPlacementChange(
  handler: (placement: DetachedBrowserPlacement | null) => void,
): () => void {
  return getDesktopBridge()?.detachedBrowser?.onPlacementChange?.(handler) ?? (() => {})
}
