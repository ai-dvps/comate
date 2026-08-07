/**
 * @deprecated U2: the desktop bridge moved to ./desktop-api (Electron
 * `window.comate` instead of `@tauri-apps/*`). This shim only keeps legacy
 * import sites (websocket-client.ts) working under their old names — new code
 * must import from './desktop-api'.
 */
export {
  isDesktop as isTauri,
  getApiBase,
  getApiToken,
  getWebSocketUrl,
  initDesktopApi as initTauriApi,
} from './desktop-api';
