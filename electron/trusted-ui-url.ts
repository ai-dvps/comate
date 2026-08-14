export interface TrustedUiUrlOptions {
  uiScheme: string;
  isPackaged: boolean;
}

/** Exact origin check for application renderers that carry privileged preloads. */
export function isTrustedUiUrl(
  value: string,
  { uiScheme, isPackaged }: TrustedUiUrlOptions,
): boolean {
  try {
    const url = new URL(value);
    const isBundledUi =
      url.protocol === `${uiScheme}:` &&
      url.hostname === 'localhost' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '';
    if (isBundledUi) return true;
    return !isPackaged && url.origin === 'http://localhost:5173';
  } catch {
    return false;
  }
}
