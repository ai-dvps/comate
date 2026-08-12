/**
 * A fully rebranded macOS development executable makes Electron report
 * `app.isPackaged === true`. Electron Vite's launch marker is the authoritative
 * signal for its development process, regardless of the executable name.
 */
export function resolvePackagedRuntime(
  appIsPackaged: boolean,
  electronViteMode: string | undefined,
): boolean {
  return appIsPackaged && electronViteMode !== 'development';
}

export function shouldEnableUpdater(
  isPackagedRuntime: boolean,
  hasDevUpdateConfig: boolean,
): boolean {
  return isPackagedRuntime || hasDevUpdateConfig;
}
