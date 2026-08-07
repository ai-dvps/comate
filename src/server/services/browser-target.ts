/**
 * browser-target — R8/F2: which CDP target serves the browser tools.
 *
 * Resolution order from the sidecar's environment:
 *  - `COMATE_BROWSER_CDP_TARGET` unset / empty / `auto`:
 *      shell env complete → the in-shell Chromium (the default when the
 *      Electron shell spawned this sidecar); otherwise `misconfigured`
 *      (dev-web has no shell — U9 removed the bundled child-process stack;
 *      the operator remedy is an external endpoint, below).
 *  - `shell`  → force the in-shell Chromium; `misconfigured` when the shell
 *               env is incomplete (fail loud, never silently drift).
 *  - an endpoint (`http://host:port`, `ws://host:port/…`, `host:port`, or a
 *    bare port) → external debug-port Chromium (AE2: operators point the
 *    tools at a manually started Chromium WITHOUT a client release; each
 *    session gets an isolated throwaway browser context, KTD-10 semantics).
 *
 * U9 decision (R8 open question): the external endpoint IS the rollback
 * landing spot going forward — no bundled Chromium, no system-Chrome
 * resolution; the fallback targets support/enterprise-ops scenarios.
 *
 * The shell coordinates themselves arrive via spawn env (KTD-6/KTD-11):
 * `COMATE_SHELL_DEBUG_PORT`, `COMATE_SHELL_CONTROL_PORT`,
 * `COMATE_SHELL_CONTROL_TOKEN`.
 */

export type BrowserCdpTarget =
  | { kind: 'shell'; debugPort: number; controlPort: number; controlToken: string }
  | { kind: 'external'; host: string; port: number }
  | { kind: 'misconfigured'; reason: string };

export const BROWSER_CDP_TARGET_ENV = 'COMATE_BROWSER_CDP_TARGET';

type Env = Record<string, string | undefined>;

function parsePort(raw: string | undefined): number | undefined {
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

function shellTargetFromEnv(env: Env): BrowserCdpTarget | undefined {
  const debugPort = parsePort(env['COMATE_SHELL_DEBUG_PORT']);
  const controlPort = parsePort(env['COMATE_SHELL_CONTROL_PORT']);
  const controlToken = env['COMATE_SHELL_CONTROL_TOKEN'];
  if (debugPort && controlPort && controlToken) {
    return { kind: 'shell', debugPort, controlPort, controlToken };
  }
  return undefined;
}

function parseExternalEndpoint(raw: string): { host: string; port: number } | undefined {
  // A bare port means a loopback Chromium (operator convenience).
  if (/^\d+$/.test(raw)) {
    const port = parsePort(raw);
    return port ? { host: '127.0.0.1', port } : undefined;
  }
  let candidate: string | undefined;
  if (/^wss?:\/\//.test(raw)) {
    candidate = raw.replace(/^ws/i, 'http');
  } else if (/^https?:\/\//.test(raw)) {
    candidate = raw;
  } else if (/^[\d.:\w-]+$/.test(raw)) {
    candidate = `http://${raw}`;
  }
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    const port = parsePort(url.port);
    if (!port || !url.hostname) return undefined;
    return { host: url.hostname, port };
  } catch {
    return undefined;
  }
}

export function resolveBrowserCdpTarget(env: Env = process.env): BrowserCdpTarget {
  const override = env[BROWSER_CDP_TARGET_ENV]?.trim();
  const shell = shellTargetFromEnv(env);
  if (!override || override === 'auto') {
    return (
      shell ?? {
        kind: 'misconfigured',
        reason:
          'The embedded browser requires the desktop app (this sidecar has no shell CDP ' +
          'coordinates). Start the desktop app, or point ' +
          `${BROWSER_CDP_TARGET_ENV} at an external Chromium debug endpoint ` +
          '(http://host:port, ws://host:port/…, host:port, or a bare port).',
      }
    );
  }
  if (override === 'shell') {
    return (
      shell ?? {
        kind: 'misconfigured',
        reason:
          `${BROWSER_CDP_TARGET_ENV}=shell but the shell did not provide its CDP coordinates ` +
          '(COMATE_SHELL_DEBUG_PORT / COMATE_SHELL_CONTROL_PORT / COMATE_SHELL_CONTROL_TOKEN). ' +
          'Start the desktop app, or pick another target.',
      }
    );
  }
  const external = parseExternalEndpoint(override);
  if (external) return { kind: 'external', ...external };
  return {
    kind: 'misconfigured',
    reason:
      `Unparseable ${BROWSER_CDP_TARGET_ENV}=${JSON.stringify(override)}. ` +
      'Use auto | shell | http://host:port | ws://host:port/… | host:port.',
  };
}
