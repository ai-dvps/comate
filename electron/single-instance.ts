export interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(event: 'second-instance', handler: () => void): unknown;
}

/**
 * Acquires Electron's process-wide lock before the shell starts any services.
 * A losing launch exits immediately; the primary launch owns all lifecycle
 * wiring and restores its existing window when another launch is attempted.
 */
export function enforceSingleInstance(
  app: SingleInstanceApp,
  focusPrimaryWindow: () => void,
): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }

  app.on('second-instance', focusPrimaryWindow);
  return true;
}
