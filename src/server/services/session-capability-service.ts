/**
 * session-capability-service (U12, KTD-28) — the loopback credential
 * authority. Two credential kinds close the "unauthenticated routes are an
 * open set" problem:
 *
 *  1. Per-session capability tokens: task runtimes receive browser/API
 *     audiences, while bots receive an independent WeCom-CLI audience. Both
 *     are injected into their owning subprocess environment and bind callers
 *     to a concrete session + workspace. Lifecycle:
 *       - TTL: 24h backstop (runtimes idle-close after 10 minutes, so a live
 *         token never approaches this in practice).
 *       - Rotation: runtime (re)creation revokes only the matching capability
 *         kind, so a task and WeCom capability can coexist without widening
 *         either token's audience.
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

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { store as defaultStore, type SqliteStore } from '../storage/sqlite-store.js';
import { getStorageDir } from '../storage/data-dir.js';
import { validateUserDirName } from './bot-access-policy.js';
import { sha256Hex } from '../utils/sha256.js';
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
  kind: SessionCapabilityKind;
  audiences: SessionCapabilityAudience[];
  runtimeGeneration: string;
}

export type SessionCapabilityKind = 'task' | 'wecom';
export type SessionCapabilityAudience = 'browser-mcp' | 'api-broker' | 'wecom-cli';

const ALLOWED_AUDIENCES: Record<SessionCapabilityKind, ReadonlySet<SessionCapabilityAudience>> = {
  task: new Set(['browser-mcp', 'api-broker']),
  wecom: new Set(['wecom-cli']),
};

export interface ResolvedSessionToken {
  sessionId: string;
  workspaceId: string;
  botId: string | null;
}

export interface ResolvedAudienceToken extends ResolvedSessionToken {
  kind: SessionCapabilityKind;
  audience: SessionCapabilityAudience;
  runtimeGeneration: string;
  /** SHA-256 token identity; safe for internal binding, never a bearer value. */
  capabilityId: string;
}

export class SessionCapabilityService {
  private readonly store: SqliteStore;
  private desktopToken: string | null = null;
  private readonly metadata = new Map<string, {
    kind: SessionCapabilityKind;
    audiences: ReadonlySet<SessionCapabilityAudience>;
    runtimeGeneration: string;
  }>();
  private readonly liveBySession = new Map<string, Map<SessionCapabilityKind, string>>();

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
   * Mint a fresh capability token for a session. Any prior live token of the
   * same kind is revoked first (rotation-on-rebuild). The plaintext token
   * exists only in the return value and the session's injected env.
   */
  mintForSession(input: {
    sessionId: string;
    workspaceId: string;
    botId: string | null;
    kind?: SessionCapabilityKind;
    audiences?: SessionCapabilityAudience[];
    runtimeGeneration?: string;
    ttlMs?: number;
    now?: Date;
  }): MintedCapability {
    const now = input.now ?? new Date();
    const kind = input.kind ?? 'wecom';
    const audiences = input.audiences ?? ['wecom-cli'];
    const runtimeGeneration = input.runtimeGeneration ?? 'legacy';
    if (audiences.length === 0 || new Set(audiences).size !== audiences.length ||
        audiences.some((audience) => !ALLOWED_AUDIENCES[kind].has(audience))) {
      throw new Error(`invalid audiences for ${kind} capability`);
    }
    const priorHash = this.liveBySession.get(input.sessionId)?.get(kind);
    if (priorHash) {
      this.store.revokeCapabilityToken(priorHash, now.toISOString());
      this.metadata.delete(priorHash);
    }
    const token = randomBytes(24).toString('hex');
    const expiresAt = new Date(now.getTime() + (input.ttlMs ?? CAPABILITY_TOKEN_TTL_MS)).toISOString();
    const tokenHash = sha256Hex(token);
    this.store.insertCapabilityToken({
      tokenHash,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      botId: input.botId,
      createdAt: now.toISOString(),
      expiresAt,
    });
    this.metadata.set(tokenHash, { kind, audiences: new Set(audiences), runtimeGeneration });
    const kinds = this.liveBySession.get(input.sessionId) ?? new Map();
    kinds.set(kind, tokenHash);
    this.liveBySession.set(input.sessionId, kinds);
    return {
      token, sessionId: input.sessionId, workspaceId: input.workspaceId, botId: input.botId,
      expiresAt, kind, audiences: [...audiences], runtimeGeneration,
    };
  }

  /**
   * Resolve a presented Bearer token to its bound session. Returns null for
   * unknown, revoked, or expired tokens — callers treat all three identically
   * (401); the distinction is logged server-side only.
   */
  resolve(token: string, now?: Date): ResolvedSessionToken | null {
    if (typeof token !== 'string' || token.length === 0 || token.length > 256) return null;
    const row = this.store.getCapabilityToken(sha256Hex(token));
    if (!row) return null;
    if (row.revokedAt !== null) return null;
    const expiry = Date.parse(row.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= (now ?? new Date()).getTime()) return null;
    return { sessionId: row.sessionId, workspaceId: row.workspaceId, botId: row.botId };
  }

  resolveForAudience(
    token: string,
    audience: SessionCapabilityAudience,
    expected?: { sessionId?: string; workspaceId?: string; runtimeGeneration?: string },
    now?: Date,
  ): ResolvedAudienceToken | null {
    if (typeof token !== 'string' || token.length === 0 || token.length > 256) return null;
    const tokenHash = sha256Hex(token);
    const metadata = this.metadata.get(tokenHash);
    if (!metadata?.audiences.has(audience)) return null;
    const resolved = this.resolve(token, now);
    if (!resolved) return null;
    if (expected?.sessionId !== undefined && resolved.sessionId !== expected.sessionId) return null;
    if (expected?.workspaceId !== undefined && resolved.workspaceId !== expected.workspaceId) return null;
    if (expected?.runtimeGeneration !== undefined && metadata.runtimeGeneration !== expected.runtimeGeneration) return null;
    return { ...resolved, kind: metadata.kind, audience, runtimeGeneration: metadata.runtimeGeneration, capabilityId: tokenHash };
  }

  isAudienceCapabilityCurrent(
    capabilityId: string,
    audience: SessionCapabilityAudience,
    expected: { sessionId: string; workspaceId: string; runtimeGeneration: string },
    now = new Date(),
  ): boolean {
    const metadata = this.metadata.get(capabilityId);
    if (!metadata?.audiences.has(audience) || metadata.runtimeGeneration !== expected.runtimeGeneration) return false;
    const row = this.store.getCapabilityToken(capabilityId);
    if (!row || row.revokedAt !== null || row.sessionId !== expected.sessionId || row.workspaceId !== expected.workspaceId) return false;
    return Date.parse(row.expiresAt) > now.getTime();
  }

  revokeKind(sessionId: string, kind: SessionCapabilityKind): number {
    const kinds = this.liveBySession.get(sessionId);
    const tokenHash = kinds?.get(kind);
    if (!tokenHash) return 0;
    kinds!.delete(kind);
    if (kinds!.size === 0) this.liveBySession.delete(sessionId);
    this.metadata.delete(tokenHash);
    return this.store.revokeCapabilityToken(tokenHash, new Date().toISOString());
  }

  /** Revoke all live tokens for a session (close/demote/delete). */
  revokeForSession(sessionId: string): number {
    const kinds = this.liveBySession.get(sessionId);
    for (const tokenHash of kinds?.values() ?? []) this.metadata.delete(tokenHash);
    this.liveBySession.delete(sessionId);
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
