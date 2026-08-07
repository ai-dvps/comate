/**
 * browser-view-bridge (U8, KTD-14) — the client half of the native browser
 * view panel. When the Electron shell exposes `window.comate.browserView`,
 * the panel is backed by a native WebContentsView (U9 removed the iframe
 * viewer with the legacy browser stack — outside the shell the panel shows
 * its degraded 'needs desktop' state):
 *
 *  - rect reporting: the hosting surface (pane body, popout, or the
 *    usage-login modal) measures its container and reports window-relative
 *    CSS pixels; null hides the view;
 *  - input gating: the control state maps to `user`/`agent` shell-side;
 *  - occlusion: a MutationObserver watches for modal-level overlays (the
 *    `data-modal-overlay` marker carried by every full-screen dialog/modal —
 *    the decision recorded in the migration plan: dropdowns/tooltips/
 *    notifications and inline cards like the approval surface deliberately do
 *    NOT hide the view, modal dialogs do) and flips a single flag; the shell
 *    hides every browser view while it is set — except one explicitly
 *    exempted session (the usage-login modal hosts its capture view INSIDE
 *    the modal, U9);
 *  - Esc: the shell intercepts Esc on a user-driven view and notifies here so
 *    the panel can reclaim focus and announce the release.
 *
 * All shell calls are fire-and-forget: a missing bridge (plain browser) or a
 * lost IPC race must never break the panel — the degraded state covers every
 * non-shell environment.
 */

import { useEffect, type RefObject } from 'react'

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

/**
 * U9: exempt one session's view from modal occlusion (the usage-login modal
 * hosts its capture session's view inside the modal). Pass null on cleanup.
 */
export function setBrowserViewOcclusionExemption(sessionId: string | null): void {
  void getDesktopBridge()?.browserView?.setOcclusionExemption?.(sessionId)?.catch(() => {})
}

// ---------------------------------------------------------------------------
// Rect-report hook (shared by NativeBrowserView and the usage-login modal)
// ---------------------------------------------------------------------------

export interface BrowserViewRectReportOptions {
  /** Input mode to set while reporting (the usage-login modal is user-driven). */
  inputMode?: BrowserViewInputMode
  /** U9: exempt this session from modal occlusion while reporting; cleared on cleanup. */
  occlusionExempt?: boolean
}

/**
 * Report `ref`'s window-relative rect for a session's view while `active`:
 * an initial report, then rAF-throttled re-reports on ResizeObserver and
 * window resize. Cleanup cancels a pending rAF and hides the view (null
 * report). An inactive hook reports nothing at all — no rect is hidden
 * shell-side by default.
 */
export function useBrowserViewRectReport(
  ref: RefObject<HTMLElement | null>,
  sessionId: string | null,
  active: boolean,
  { inputMode, occlusionExempt }: BrowserViewRectReportOptions = {},
): void {
  useEffect(() => {
    if (!active || !sessionId) return
    if (occlusionExempt) setBrowserViewOcclusionExemption(sessionId)
    if (inputMode) setBrowserViewInputMode(sessionId, inputMode)
    const el = ref.current
    if (!el) return
    let raf = 0
    const report = () => {
      raf = 0
      const rect = el.getBoundingClientRect()
      reportBrowserViewRect(
        sessionId,
        rect.width > 0 && rect.height > 0
          ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          : null,
      )
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(report)
    }
    report()
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(schedule)
      observer.observe(el)
    }
    window.addEventListener('resize', schedule)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', schedule)
      if (raf) cancelAnimationFrame(raf)
      reportBrowserViewRect(sessionId, null)
      if (occlusionExempt) setBrowserViewOcclusionExemption(null)
    }
  }, [ref, sessionId, active, inputMode, occlusionExempt])
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
 * in native mode (outside the shell there is no view to hide).
 */
export function onBrowserViewOcclusionChange(listener: (occluded: boolean) => void): () => void {
  occlusionListeners.add(listener)
  startOcclusionWatcher()
  return () => {
    occlusionListeners.delete(listener)
  }
}

/**
 * True when a mutation could change which `[data-modal-overlay]` elements
 * exist — the observer fires constantly during chat streaming, so the full
 * querySelector recompute only runs for records that touch the marker.
 */
function mutationTouchesOverlay(record: MutationRecord): boolean {
  if (record.type === 'attributes') {
    // attributeFilter is the marker itself; any attribute record is relevant.
    // Non-element targets fall back to the full recompute.
    return record.target instanceof Element
  }
  if (record.type === 'childList') {
    for (const node of [...record.addedNodes, ...record.removedNodes]) {
      // Overlays mount with the marker present; text/comment nodes can never
      // carry it and are skipped.
      if (!(node instanceof Element)) continue
      if (node.matches(MODAL_OVERLAY_SELECTOR) || node.querySelector(MODAL_OVERLAY_SELECTOR)) {
        return true
      }
    }
    return false
  }
  // Unknown record type: conservative full recompute.
  return true
}

function startOcclusionWatcher(): void {
  if (occlusionWatcherStarted) return
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
  if (!isNativeBrowserView()) return
  occlusionWatcherStarted = true
  let scheduled = false
  const observer = new MutationObserver((records) => {
    if (!records.some(mutationTouchesOverlay)) return
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
