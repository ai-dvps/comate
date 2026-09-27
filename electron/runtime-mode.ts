import { join } from 'node:path';

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

export interface UpdaterRuntimeConfig {
  enabled: boolean;
  forceDevUpdateConfig: boolean;
}

export function resolveUpdaterRuntimeConfig(
  isPackagedRuntime: boolean,
  resourcesPath: string,
  appPath: string,
  pathExists: (path: string) => boolean,
): UpdaterRuntimeConfig {
  const configPath = isPackagedRuntime
    ? join(resourcesPath, 'app-update.yml')
    : join(appPath, 'dev-app-update.yml');
  const enabled = pathExists(configPath);

  return {
    enabled,
    forceDevUpdateConfig: !isPackagedRuntime && enabled,
  };
}
