/** Least-privilege bridge for the independent browser renderer. */
import { contextBridge, ipcRenderer } from 'electron';

interface BrowserViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DetachedBrowserPlacement {
  workspaceId: string;
  sessionId: string;
  title: string;
}

const api = {
  getApiInfo: (): Promise<{ port: number; token: string }> =>
    ipcRenderer.invoke('comate:get-api-info'),

  browserView: {
    reportRect: (sessionId: string, rect: BrowserViewRect | null): Promise<void> =>
      ipcRenderer.invoke('comate:browser-view-report-rect', sessionId, rect),
    setInputMode: (sessionId: string, mode: 'user' | 'agent'): Promise<void> =>
      ipcRenderer.invoke('comate:browser-view-input-mode', sessionId, mode),
    setOccluded: (occluded: boolean): Promise<void> =>
      ipcRenderer.invoke('comate:browser-view-occluded', occluded),
    setOcclusionExemption: (sessionId: string | null): Promise<void> =>
      ipcRenderer.invoke('comate:browser-view-occlusion-exemption', sessionId),
    onEscape: (handler: (sessionId: string) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, sessionId: unknown): void => {
        if (typeof sessionId === 'string') handler(sessionId);
      };
      ipcRenderer.on('comate:browser-view-escape', listener);
      return () => ipcRenderer.removeListener('comate:browser-view-escape', listener);
    },
  },

  detachedBrowser: {
    restore: (): Promise<boolean> => ipcRenderer.invoke('comate:detached-browser-restore'),
    getPlacement: (): Promise<DetachedBrowserPlacement | null> =>
      ipcRenderer.invoke('comate:detached-browser-get-placement'),
    rendererReady: (sessionId: string): Promise<boolean> =>
      ipcRenderer.invoke('comate:detached-browser-renderer-ready', sessionId),
    sessionEnded: (sessionId: string): Promise<boolean> =>
      ipcRenderer.invoke('comate:detached-browser-session-ended', sessionId),
    onPlacementChange: (
      handler: (placement: DetachedBrowserPlacement | null) => void,
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        placement: DetachedBrowserPlacement | null,
      ): void => handler(placement);
      ipcRenderer.on('comate:detached-browser-placement-changed', listener);
      return () => ipcRenderer.removeListener('comate:detached-browser-placement-changed', listener);
    },
  },
};

contextBridge.exposeInMainWorld('comate', api);
