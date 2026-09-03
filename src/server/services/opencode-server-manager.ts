/**
 * OpencodeServerManager — one `opencode serve` subprocess per Comate session
 * (per-session serve: per-session browser binding and per-session serve
 * config require per-session processes, KTD-6). Each serve gets:
 * - a random per-process password (OPENCODE_SERVER_PASSWORD); every request
 *   carries HTTP Basic auth, so no other local process can drive sessions or
 *   answer permission requests (fail-closed, P1)
 * - a sanitized environment (unrelated providers' secrets never reach the child)
 * - Comate-owned storage via XDG_DATA_HOME under the app data dir (session
 *   transcripts stay in an application-owned, permission-restricted location)
 * - OPENCODE_CONFIG_CONTENT with the Comate provider mapped to an opencode
 *   custom provider and permission defaults that route prompts through the
 *   session core's unified approval flow
 */

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { getStorageDir } from '../storage/data-dir.js';
import { sanitizeSubprocessEnv } from '../utils/sanitize-env.js';
import {
  resolveOpencodeBinary,
  OPENCODE_EXPECTED_VERSION,
} from '../utils/resolve-opencode-binary.js';
import { diagLog } from '../utils/diag-logger.js';
import { getWorkspaceSkillSnapshot } from './opencode-skill-discovery.js';

export interface OpencodeServerInstance {
  sessionKey: string;
  directory: string;
  proc: ChildProcess;
  baseUrl: string;
  authHeaders: Record<string, string>;
  /** Project-local skills present when this runtime was initialized. */
  workspaceSkillSnapshot: string;
}

export interface OpencodeServerConfig {
  /** Serialized into OPENCODE_CONFIG_CONTENT (provider mapping, permissions). */
  config: Record<string, unknown>;
  /** Ambient env to sanitize and inherit (usually the computed session env). */
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const READY_RE = /opencode server listening on (https?:\/\/\S+)/;

let verifiedVersion: string | undefined;

/**
 * Compatibility-unit check (doc-review): the pinned SDK/adapter protocol
 * only supports one opencode version per Comate release — fail loudly on a
 * mismatch (e.g. a stray homebrew binary) instead of silently drifting on
 * renamed events (1.14 permission.asked ↔ 1.18 permission.updated).
 */
function assertOpencodeVersion(binary: string): void {
  if (verifiedVersion !== undefined) {
    if (verifiedVersion !== OPENCODE_EXPECTED_VERSION) {
      throw new Error(
        `opencode version mismatch: expected ${OPENCODE_EXPECTED_VERSION}, found ${verifiedVersion} (${binary})`,
      );
    }
    return;
  }
  const output = execFileSync(binary, ['--version'], {
    timeout: 5_000,
    encoding: 'utf8',
  }).trim();
  verifiedVersion = output.split(/\s+/)[0] || output;
  if (verifiedVersion !== OPENCODE_EXPECTED_VERSION) {
    throw new Error(
      `opencode version mismatch: expected ${OPENCODE_EXPECTED_VERSION}, found ${verifiedVersion} (${binary})`,
    );
  }
}

const findFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (address && typeof address === 'object') {
        srv.close(() => resolve(address.port));
      } else {
        reject(new Error('no address'));
      }
    });
  });

export class OpencodeServerManager {
  // One serve per Comate session (KTD-6): per-session browser binding and
  // per-session serve config require per-session processes; lifecycle maps
  // 1:1 onto the session runtime, so no idle management is needed.
  private instances = new Map<string, OpencodeServerInstance>();
  private starting = new Map<string, Promise<OpencodeServerInstance>>();

  async ensureServer(
    sessionKey: string,
    directory: string,
    options: OpencodeServerConfig,
  ): Promise<OpencodeServerInstance> {
    const existing = this.instances.get(sessionKey);
    if (existing && existing.proc.exitCode === null) return existing;
    const pending = this.starting.get(sessionKey);
    if (pending) return pending;
    const start = this.spawnServer(sessionKey, directory, options)
      .then((instance) => {
        this.instances.set(sessionKey, instance);
        return instance;
      })
      .finally(() => {
        this.starting.delete(sessionKey);
      });
    this.starting.set(sessionKey, start);
    return start;
  }

  private async spawnServer(
    sessionKey: string,
    directory: string,
    options: OpencodeServerConfig,
  ): Promise<OpencodeServerInstance> {
    const binary = resolveOpencodeBinary();
    if (!binary) {
      throw new Error('opencode binary not found (packaging or install issue)');
    }
    assertOpencodeVersion(binary);
    const workspaceSkillSnapshot = await getWorkspaceSkillSnapshot(directory);
    const port = await findFreePort();
    const password = randomBytes(16).toString('hex');
    const env: NodeJS.ProcessEnv = {
      ...sanitizeSubprocessEnv(options.env as Record<string, string | undefined>),
      ...(options.env.WECOM_CLI_PATH ? { WECOM_CLI_PATH: options.env.WECOM_CLI_PATH } : {}),
      OPENCODE_SERVER_PASSWORD: password,
      XDG_DATA_HOME: `${getStorageDir()}/opencode`,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config),
    };

    const proc = spawn(
      binary,
      ['serve', '--hostname=127.0.0.1', `--port=${port}`],
      { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    diagLog(`[OpencodeServerManager] spawning serve for session ${sessionKey} on 127.0.0.1:${port} (pid=${proc.pid})`);

    const baseUrl = await new Promise<string>((resolve, reject) => {
      let buffer = '';
      let stderrTail = '';
      const timeoutMs = options.timeoutMs ?? 20_000;
      const timer = setTimeout(() => {
        proc.kill();
        reject(
          new Error(
            `opencode serve did not report a listening URL within ${timeoutMs}ms. ` +
              `stdout tail: ${buffer.slice(-300)} | stderr tail: ${stderrTail.slice(-300)}`,
          ),
        );
      }, timeoutMs);
      proc.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const match = buffer.match(READY_RE);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderrTail += chunk.toString();
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`failed to spawn opencode: ${err.message}`));
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        this.instances.delete(sessionKey);
        reject(new Error(`opencode serve exited early (code=${code}). stderr tail: ${stderrTail.slice(-300)}`));
      });
    });

    const username = 'opencode';
    return {
      sessionKey,
      directory,
      proc,
      baseUrl,
      authHeaders: {
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
      },
      workspaceSkillSnapshot,
    };
  }

  /** OpenCode snapshots skills at instance init, so changes require a runtime rebuild. */
  async workspaceSkillsChanged(instance: OpencodeServerInstance): Promise<boolean> {
    return (await getWorkspaceSkillSnapshot(instance.directory)) !== instance.workspaceSkillSnapshot;
  }

  async stopServer(sessionKey: string): Promise<void> {
    const instance = this.instances.get(sessionKey);
    if (!instance) return;
    this.instances.delete(sessionKey);
    instance.proc.kill();
    diagLog(`[OpencodeServerManager] stopped serve for session ${sessionKey}`);
  }

  /** Current live instance for a session key, if any (no spawn side-effects). */
  getInstance(sessionKey: string): OpencodeServerInstance | undefined {
    const instance = this.instances.get(sessionKey);
    return instance && instance.proc.exitCode === null ? instance : undefined;
  }

  async stopAll(): Promise<void> {
    for (const workspaceId of [...this.instances.keys()]) {
      await this.stopServer(workspaceId);
    }
  }
}

export const opencodeServerManager = new OpencodeServerManager();

/** Authenticated fetch helper bound to a serve instance + directory scope. */
export function opencodeFetch(
  instance: OpencodeServerInstance,
  path: string,
  init: RequestInit & { skipDirectory?: boolean } = {},
): Promise<Response> {
  const { skipDirectory, ...rest } = init;
  const separator = path.includes('?') ? '&' : '?';
  const url = skipDirectory
    ? `${instance.baseUrl}${path}`
    : `${instance.baseUrl}${path}${separator}directory=${encodeURIComponent(instance.directory)}`;
  return fetch(url, {
    // REST calls (prompt, permission replies, session ops) carry no server
    // guarantee — fail closed on a wedged serve instead of pinning the turn
    // (cross-model review P2). Callers may override per request.
    signal: rest.signal ?? AbortSignal.timeout(30_000),
    ...rest,
    headers: {
      ...(rest.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...instance.authHeaders,
      ...(rest.headers ?? {}),
    },
  });
}
