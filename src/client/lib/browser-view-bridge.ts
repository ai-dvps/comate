/**
 * browser-view-bridge (U8, KTD-14) — the client half of the native browser
 * view panel. When the Electron shell exposes `window.comate.browserView`,
 * the panel is backed by a native WebContentsView instead of the Steel
 * iframe viewer (which stays as the dev-web fallback until U9):
 *
 *  - rect reporting: the hosting surface (pane body or popout) measures its
 *    container and reports window-relative CSS pixels; null hides the view;
 *  - input gating: the control state maps to `user`/`agent` shell-side;
 *  - occlusion: a MutationObserver watches for modal-level overlays (the
 *    `data-modal-overlay` marker carried by every full-screen dialog/modal —
 *    the decision recorded in the migration plan: dropdowns/tooltips/
 *    notifications and inline cards like the approval surface deliberately do
 *    NOT hide the view, modal dialogs do) and flips a single flag; the shell
 *    hides every browser view while it is set;
 *  - Esc: the shell intercepts Esc on a user-driven view and notifies here so
 *    the panel can reclaim focus and announce the release.
 *
 * All shell calls are fire-and-forget: a missing bridge (plain browser) or a
 * lost IPC race must never break the panel — the native host simply stays
 * blank and the degraded/iframe paths keep working.
 */

import { getDesktopBridge, type BrowserViewRect, type BrowserViewInputMode } from './desktop-api'

export type { BrowserViewRect, BrowserViewInputMode }

/** True when the shell can host native browser views (Electron + U8 preload). */
export function isNativeBrowserView(): boolean {
  return getDesktopBridge()?.browserView?.reportRect != null
}

// ---------------------------------------------------------------------------
// Rect reporting (deduped — ResizeObserver fires on every layout nudge)
// ---------------------------------------------------------------------------

const lastReportedKey = new Map<string, string>()

function roundRect(rect: BrowserViewRect): BrowserViewRect {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

/**
 * Report the panel rect for a session's view; null (or a zero-area rect)
 * hides it. Identical consecutive reports are dropped.
 */
export function reportBrowserViewRect(sessionId: string, rect: BrowserViewRect | null): void {
  const effective = rect && rect.width > 0 && rect.height > 0 ? roundRect(rect) : null
  const key = effective
    ? `${effective.x},${effective.y},${effective.width},${effective.height}`
    : 'hidden'
  if (lastReportedKey.get(sessionId) === key) return
  lastReportedKey.set(sessionId, key)
  void getDesktopBridge()
    ?.browserView?.reportRect?.(sessionId, effective)
    ?.catch(() => {})
}

/** Test hook: forget dedup state (reports are process-lifetime otherwise). */
export function resetBrowserViewRectCache(): void {
  lastReportedKey.clear()
}

// ---------------------------------------------------------------------------
// Input gating + occlusion
// ---------------------------------------------------------------------------

export function setBrowserViewInputMode(sessionId: string, mode: BrowserViewInputMode): void {
  void getDesktopBridge()?.browserView?.setInputMode?.(sessionId, mode)?.catch(() => {})
}

export function setBrowserViewOccluded(occluded: boolean): void {
  void getDesktopBridge()?.browserView?.setOccluded?.(occluded)?.catch(() => {})
}

// ---------------------------------------------------------------------------
// Esc notifications (shell → renderer)
// ---------------------------------------------------------------------------

const escapeHandlers = new Set<(sessionId: string) => void>()
let escapeSubscription: (() => void) | null = null

export function onBrowserViewEscape(handler: (sessionId: string) => void): () => void {
  escapeHandlers.add(handler)
  if (!escapeSubscription) {
    escapeSubscription =
      getDesktopBridge()
        ?.browserView?.onEscape?.((sessionId) => {
          for (const h of [...escapeHandlers]) h(sessionId)
        }) ?? null
  }
  return () => {
    escapeHandlers.delete(handler)
  }
}

// ---------------------------------------------------------------------------
// Modal-occlusion watcher (single flag, KTD-14 decision)
// ---------------------------------------------------------------------------

const MODAL_OVERLAY_SELECTOR = '[data-modal-overlay]'

const occlusionListeners = new Set<(occluded: boolean) => void>()
let occlusionWatcherStarted = false
let occluded = false

function computeOccluded(): boolean {
  return document.querySelector(MODAL_OVERLAY_SELECTOR) !== null
}

function setOccludedState(next: boolean): void {
  if (next === occluded) return
  occluded = next
  setBrowserViewOccluded(next)
  for (const listener of [...occlusionListeners]) listener(next)
}

/**
 * Subscribe to the modal-occlusion flag. The watcher starts lazily and only
 * in native mode (a plain browser keeps the iframe viewer, which composes
 * overlays correctly on its own).
 */
export function onBrowserViewOcclusionChange(listener: (occluded: boolean) => void): () => void {
  occlusionListeners.add(listener)
  startOcclusionWatcher()
  return () => {
    occlusionListeners.delete(listener)
  }
}

function startOcclusionWatcher(): void {
  if (occlusionWatcherStarted) return
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
  if (!isNativeBrowserView()) return
  occlusionWatcherStarted = true
  let scheduled = false
  const observer = new MutationObserver(() => {
    // Coalesce the mutation burst a portal mount produces into one check.
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      setOccludedState(computeOccluded())
    })
  })
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-modal-overlay'],
  })
  setOccludedState(computeOccluded())
}
