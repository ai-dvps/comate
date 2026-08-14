import type { HostWindowLike } from './browser-view-manager';

export interface DetachedBrowserPlacement {
  workspaceId: string;
  sessionId: string;
  title: string;
}

const PLACEMENT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const MAX_PLACEMENT_TITLE_LENGTH = 200;

export function parseDetachedBrowserPlacement(value: unknown): DetachedBrowserPlacement | null {
  if (typeof value !== 'object' || value === null) return null;
  const { workspaceId, sessionId, title } = value as Record<string, unknown>;
  if (
    typeof workspaceId !== 'string' ||
    !PLACEMENT_ID_PATTERN.test(workspaceId) ||
    typeof sessionId !== 'string' ||
    !PLACEMENT_ID_PATTERN.test(sessionId) ||
    typeof title !== 'string'
  ) {
    return null;
  }
  const normalizedTitle = title.trim();
  if (normalizedTitle.length === 0 || normalizedTitle.length > MAX_PLACEMENT_TITLE_LENGTH) {
    return null;
  }
  return { workspaceId, sessionId, title: normalizedTitle };
}

export interface DetachedWindowCloseEvent {
  preventDefault(): void;
}

export interface DetachedBrowserWindowLike extends HostWindowLike {
  webContents: HostWindowLike['webContents'] & {
    on(
      event: 'render-process-gone',
      listener: (event: unknown, details: unknown) => void,
    ): void;
  };
  on(event: 'close', listener: (event: DetachedWindowCloseEvent) => void): void;
  on(event: 'closed', listener: () => void): void;
  show(): void;
  hide(): void;
  focus(): void;
  isMinimized(): boolean;
  restore(): void;
  setTitle(title: string): void;
  close(): void;
  destroy(): void;
}

export interface DetachedBrowserWindowControllerDeps {
  createWindow(): DetachedBrowserWindowLike;
  mainWindow(): HostWindowLike | null;
  setViewHost(sessionId: string, host: HostWindowLike | null): void;
  loadWindow(window: DetachedBrowserWindowLike): Promise<void>;
  publishPlacement(placement: DetachedBrowserPlacement | null): void;
  formatTitle?(placement: DetachedBrowserPlacement): string;
}

export interface DetachedBrowserWindowController {
  getPlacement(): DetachedBrowserPlacement | null;
  getWindow(): DetachedBrowserWindowLike | null;
  detach(placement: DetachedBrowserPlacement): Promise<void>;
  rendererReady(sessionId: string): boolean;
  focus(): boolean;
  restore(): boolean;
  browserSessionEnded(sessionId: string): boolean;
  closeForQuit(): void;
}

function samePlacement(
  left: DetachedBrowserPlacement | null,
  right: DetachedBrowserPlacement,
): boolean {
  return left?.workspaceId === right.workspaceId && left.sessionId === right.sessionId;
}

export function createDetachedBrowserWindowController(
  deps: DetachedBrowserWindowControllerDeps,
): DetachedBrowserWindowController {
  let window: DetachedBrowserWindowLike | null = null;
  let placement: DetachedBrowserPlacement | null = null;
  let programmaticClose = false;
  let initialLoad: Promise<void> | null = null;

  const publish = (next: DetachedBrowserPlacement | null): void => {
    placement = next ? { ...next } : null;
    deps.publishPlacement(placement ? { ...placement } : null);
  };

  const focusWindow = (): boolean => {
    if (!window || window.isDestroyed() || !placement) return false;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return true;
  };

  const redock = (): boolean => {
    if (!placement) return false;
    const current = placement;
    deps.setViewHost(current.sessionId, deps.mainWindow());
    publish(null);
    if (window && !window.isDestroyed()) window.hide();
    return true;
  };

  const closeWithoutRedock = (): void => {
    if (placement) {
      deps.setViewHost(placement.sessionId, null);
      publish(null);
    }
    const currentWindow = window;
    if (!currentWindow || currentWindow.isDestroyed()) return;
    programmaticClose = true;
    currentWindow.close();
  };

  const destroyFailedWindow = (): void => {
    redock();
    const failedWindow = window;
    if (!failedWindow || failedWindow.isDestroyed()) return;
    programmaticClose = true;
    failedWindow.destroy();
  };

  const ensureWindow = (): { window: DetachedBrowserWindowLike; created: boolean } => {
    if (window && !window.isDestroyed()) return { window, created: false };
    const createdWindow = deps.createWindow();
    window = createdWindow;
    programmaticClose = false;
    createdWindow.on('close', (event) => {
      if (programmaticClose) return;
      event.preventDefault();
      redock();
    });
    createdWindow.on('closed', () => {
      if (window === createdWindow) window = null;
      programmaticClose = false;
    });
    createdWindow.webContents.on('render-process-gone', () => {
      if (!programmaticClose && window === createdWindow) destroyFailedWindow();
    });
    return { window: createdWindow, created: true };
  };

  return {
    getPlacement: () => (placement ? { ...placement } : null),
    getWindow: () => window,

    async detach(next) {
      if (samePlacement(placement, next) && focusWindow()) return;
      if (placement) redock();

      const target = ensureWindow();
      target.window.setTitle(
        deps.formatTitle?.(next) ?? `Browser — ${next.title}`,
      );
      publish(next);
      if (target.created) {
        const loadingWindow = target.window;
        const load = deps.loadWindow(loadingWindow).catch((error) => {
          if (window === loadingWindow) {
            if (placement) publish(null);
            if (!loadingWindow.isDestroyed()) {
              programmaticClose = true;
              loadingWindow.destroy();
            }
          }
          throw error;
        }).finally(() => {
          if (initialLoad === load) initialLoad = null;
        });
        initialLoad = load;
      }
      await initialLoad;
    },

    rendererReady(sessionId) {
      if (!placement || placement.sessionId !== sessionId || !window || window.isDestroyed()) {
        return false;
      }
      deps.setViewHost(sessionId, window);
      focusWindow();
      return true;
    },

    focus: focusWindow,

    restore() {
      return redock();
    },

    browserSessionEnded(sessionId) {
      if (!placement || placement.sessionId !== sessionId) return false;
      closeWithoutRedock();
      return true;
    },

    closeForQuit() {
      closeWithoutRedock();
    },
  };
}
