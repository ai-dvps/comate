/**
 * browser-target — R8/F2: which CDP target serves the browser tools.
 *
 * Resolution order from the sidecar's environment:
 *  - `COMATE_BROWSER_CDP_TARGET` unset / empty / `auto`:
 *      shell env complete → the in-shell Chromium (U7 default when the
 *      Electron shell spawned this sidecar); otherwise `steel` (dev-web and
 *      the pre-U9 legacy path).
 *  - `steel`  → force the legacy vendored-Steel child-process stack.
 *  - `shell`  → force the in-shell Chromium; `misconfigured` when the shell
 *               env is incomplete (fail loud, never silently drift).
 *  - an endpoint (`http://host:port`, `ws://host:port/…`, `host:port`, or a
 *    bare port) → external debug-port Chromium (AE2: operators point the
 *    tools at a manually started Chromium WITHOUT a client release; each
 *    session gets an isolated throwaway browser context, KTD-10 semantics).
 *
 * The shell coordinates themselves arrive via spawn env (KTD-6/KTD-11):
 * `COMATE_SHELL_DEBUG_PORT`, `COMATE_SHELL_CONTROL_PORT`,
 * `COMATE_SHELL_CONTROL_TOKEN`.
 */

export type BrowserCdpTarget =
  | { kind: 'shell'; debugPort: number; controlPort: number; controlToken: string }
  | { kind: 'external'; host: string; port: number }
  | { kind: 'steel' }
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
  const candidate = /^wss?:\/\//.test(raw)
    ? raw.replace(/^ws/i, 'http')
    : /^https?:\/\//.test(raw)
      ? raw
      : /^[\d.:\w-]+$/.test(raw)
        ? `http://${raw}`
        : undefined;
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
    return shell ?? { kind: 'steel' };
  }
  if (override === 'steel') return { kind: 'steel' };
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
      'Use auto | steel | shell | http://host:port | ws://host:port/… | host:port.',
  };
}
