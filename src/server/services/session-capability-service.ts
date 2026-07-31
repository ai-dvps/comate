/**
 * session-capability-service (U12, KTD-28) — the loopback credential
 * authority. Two credential kinds close the "unauthenticated routes are an
 * open set" problem:
 *
 *  1. Per-session capability tokens: minted when a bot session's runtime is
 *     created, injected into the sandboxed environment, and presented by the
 *     bundled wecom CLI as a Bearer token. They bind the loopback caller to a
 *     concrete session + workspace, so routes derive identity from the token
 *     instead of a self-asserted sessionId. Lifecycle:
 *       - TTL: 24h backstop (runtimes idle-close after 10 minutes, so a live
 *         token never approaches this in practice).
 *       - Rotation: every runtime (re)creation revokes the session's prior
 *         token and mints a fresh one — rebuilds and demotion rebuilds rotate.
 *       - Revocation: closeRuntime/deleteSession revoke; boot invalidates ALL
 *         tokens (the constructor revokes every live row — tokens are per-boot
 *         runtime artifacts, never durable).
 *       - Storage: sqlite, SHA-256 hash only — a database dump never leaks a
 *         usable credential.
 *
 *  2. The desktop GUI credential: one long-lived (per-boot) random token,
 *     delivered to the local client out-of-band (sidecar ready message for
 *     the Tauri shell; a 0600 file in the Comate data dir for the dev Vite
 *     proxy). It is never injected into any session environment. The Comate
 *     data dir is deny-listed for every bot role (sandbox denyRead + derived
 *     permission deny rules + fail-closed gate), so sandboxed sessions cannot
 *     read the file even on degraded hosts; normal-role sessions have no
 *     unsandboxed escape at all (KTD-10).
 *
 * Token hygiene (V7-style): token values are 48-char random hex, so the
 * audit log's >32-char redaction heuristic masks them automatically; the
 * middleware never logs Authorization headers; and the env names are in the
 * derivation's benign list ONLY so the session's own credential stays visible
 * to its own sandboxed commands (the credential sweep must not hide it from
 * the CLI that needs it).
 */

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { store as defaultStore, type SqliteStore } from '../storage/sqlite-store.js';
import { getStorageDir } from '../storage/data-dir.js';
import { validateUserDirName } from './bot-access-policy.js';
import { diagLog } from '../utils/diag-logger.js';

/** Env var carrying the per-session capability token into the sandbox. */
export const SESSION_TOKEN_ENV = 'COMATE_SESSION_TOKEN';
/** Env var carrying the absolute path of the per-session wecom context file. */
export const WECOM_CONTEXT_FILE_ENV = 'COMATE_WECOM_CONTEXT_FILE';

/** Desktop credential file name inside the Comate data dir (mode 0600). */
export const DESKTOP_AUTH_FILE_NAME = 'desktop-auth.json';

/** 24h TTL backstop; revocation (close/demote/boot) is the primary lifecycle. */
export const CAPABILITY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export interface MintedCapability {
  /** The plaintext token — returned exactly once, never stored. */
  token: string;
  sessionId: string;
  workspaceId: string;
  botId: string | null;
  expiresAt: string;
}

export interface ResolvedSessionToken {
  sessionId: string;
  workspaceId: string;
  botId: string | null;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class SessionCapabilityService {
  private readonly store: SqliteStore;
  private desktopToken: string | null = null;

  constructor(store?: SqliteStore, options?: { skipBootInvalidation?: boolean }) {
    this.store = store ?? defaultStore;
    if (!options?.skipBootInvalidation) {
      // Boot invalidation (KTD-28): tokens never survive a sidecar restart.
      const revoked = this.store.revokeAllCapabilityTokens(new Date().toISOString());
      if (revoked > 0) {
        diagLog(`[SessionCapability] boot invalidation revoked ${revoked} live token(s)`);
      }
    }
  }

  /**
   * Mint a fresh capability token for a session. Any prior live token for the
   * same session is revoked first (rotation-on-rebuild). The plaintext token
   * exists only in the return value and the session's injected env.
   */
  mintForSession(input: {
    sessionId: string;
    workspaceId: string;
    botId: string | null;
    ttlMs?: number;
    now?: Date;
  }): MintedCapability {
    const now = input.now ?? new Date();
    // Rotation: one live token per session.
    this.store.revokeCapabilityTokensForSession(input.sessionId, now.toISOString());
    const token = randomBytes(24).toString('hex');
    const expiresAt = new Date(now.getTime() + (input.ttlMs ?? CAPABILITY_TOKEN_TTL_MS)).toISOString();
    this.store.insertCapabilityToken({
      tokenHash: hashToken(token),
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      botId: input.botId,
      createdAt: now.toISOString(),
      expiresAt,
    });
    return { token, sessionId: input.sessionId, workspaceId: input.workspaceId, botId: input.botId, expiresAt };
  }

  /**
   * Resolve a presented Bearer token to its bound session. Returns null for
   * unknown, revoked, or expired tokens — callers treat all three identically
   * (401); the distinction is logged server-side only.
   */
  resolve(token: string, now?: Date): ResolvedSessionToken | null {
    if (typeof token !== 'string' || token.length === 0 || token.length > 256) return null;
    const row = this.store.getCapabilityToken(hashToken(token));
    if (!row) return null;
    if (row.revokedAt !== null) return null;
    const expiry = Date.parse(row.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= (now ?? new Date()).getTime()) return null;
    return { sessionId: row.sessionId, workspaceId: row.workspaceId, botId: row.botId };
  }

  /** Revoke all live tokens for a session (close/demote/delete). */
  revokeForSession(sessionId: string): number {
    return this.store.revokeCapabilityTokensForSession(sessionId, new Date().toISOString());
  }

  /**
   * Mint (per boot) the desktop GUI credential and persist it for the dev
   * Vite proxy. In-memory only for the Tauri channel — the ready message
   * carries it. File write is best-effort: the Tauri flow never needs it.
   */
  mintDesktopToken(options?: { storageDir?: string }): string {
    this.desktopToken = randomBytes(24).toString('hex');
    this.persistDesktopTokenFile(options?.storageDir);
    return this.desktopToken;
  }

  getDesktopToken(): string | null {
    return this.desktopToken;
  }

  private persistDesktopTokenFile(storageDir?: string): void {
    if (!this.desktopToken) return;
    try {
      const dir = storageDir ?? getStorageDir();
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, DESKTOP_AUTH_FILE_NAME);
      fs.writeFileSync(
        filePath,
        JSON.stringify({ token: this.desktopToken, createdAt: new Date().toISOString() }),
        { mode: 0o600 },
      );
    } catch (err) {
      diagLog(
        `[SessionCapability] desktop token file write failed (dev-proxy auth unavailable): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Write the per-session wecom CLI context file into the session user's
 * `.runtime/` dir (U12): `<workspace>/data/<userDirName>/.runtime/wecom-context.json`.
 * The CLI receives the absolute path via COMATE_WECOM_CONTEXT_FILE; the
 * legacy upward-walk discovery is gone, so a context planted anywhere else
 * (e.g. a user-writable `.claude/`) cannot win. Returns the absolute path.
 * Throws on an invalid dir name (the caller fail-softs: no context, no CLI).
 */
export function writeSessionWecomContext(input: {
  workspaceFolder: string;
  userDirName: string;
  workspaceId: string;
  botId: string;
  serverUrl: string;
}): string {
  const identity = validateUserDirName(input.userDirName);
  if (!identity.ok) {
    throw new Error(`invalid userDirName for context file: ${identity.reason}`);
  }
  const workspaceRoot = path.resolve(input.workspaceFolder);
  const runtimeDir = path.join(workspaceRoot, 'data', identity.userDirName, '.runtime');
  const resolvedRuntime = path.resolve(runtimeDir);
  if (!resolvedRuntime.startsWith(workspaceRoot + path.sep)) {
    throw new Error('context runtime dir escapes the workspace');
  }
  fs.mkdirSync(resolvedRuntime, { recursive: true });
  const filePath = path.join(resolvedRuntime, 'wecom-context.json');
  const content = JSON.stringify(
    { workspaceId: input.workspaceId, botId: input.botId, serverUrl: input.serverUrl },
    null,
    2,
  );
  fs.writeFileSync(filePath, content, { mode: 0o600 });
  return filePath;
}

export const sessionCapabilityService = new SessionCapabilityService();
