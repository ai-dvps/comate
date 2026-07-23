/**
 * Agent backend registry (KTD-4): the single source of truth for which
 * agent runtimes exist, what each can do (capability declaration table),
 * whether each is currently usable (availability), and the app-level
 * default backend.
 *
 * Design rules that callers depend on:
 * - Capability defaults differ per backend (doc-review correction):
 *   claude defaults to `full` (canonical backend); opencode defaults to
 *   `unavailable` — a capability must be explicitly declared before the UI
 *   may present it, so unverified features never appear available (R10).
 * - Availability means "binary resolved AND health check passed" — file
 *   presence alone is not runtime availability. Results are cached per
 *   backend; registration invalidates the cache.
 * - The opencode runtime resolver is registered by the packaging unit (U3);
 *   until then the backend reports unavailable-with-reason.
 */

import { spawn } from 'node:child_process';
import { resolveSdkBinary } from '../utils/resolve-sdk-binary.js';
import { resolveOpencodeBinary } from '../utils/resolve-opencode-binary.js';
import { getAppSetting, setAppSetting } from '../storage/app-settings-store.js';
import { diagLog } from '../utils/diag-logger.js';

export type BackendId = 'claude' | 'opencode';
export const BACKEND_IDS: readonly BackendId[] = ['claude', 'opencode'];

// ---------------------------------------------------------------------------
// Capability declaration table
// ---------------------------------------------------------------------------

export type CapabilityState = 'full' | 'degraded' | 'unavailable';

export interface CapabilityEntry {
  state: CapabilityState;
  /** i18n key for the disable+reason UI; required when state !== 'full'. */
  reasonKey?: string;
}

export type CapabilityId =
  | 'streaming'
  | 'toolRendering'
  | 'approvals'
  | 'askUserQuestion'
  | 'subagents'
  | 'browser'
  | 'hooks'
  | 'slashCommands'
  | 'todos'
  | 'sessionManagement'
  | 'modelSwitching'
  | 'analytics';

const FULL: CapabilityEntry = { state: 'full' };

/**
 * Static per-backend declarations. claude is the canonical backend and needs
 * no entries (all full). opencode entries flip from unavailable to full as
 * their delivering units land (U4/U6/U7); analytics stays degraded for v1
 * (KTD-10 — opencode sessions are not counted in usage analytics).
 */
const CAPABILITY_TABLE: Record<BackendId, Partial<Record<CapabilityId, CapabilityEntry>>> = {
  claude: {},
  opencode: {
    analytics: {
      state: 'unavailable',
      reasonKey: 'backend.analyticsNotCounted',
    },
  },
};

export function getCapability(backend: BackendId, capability: CapabilityId): CapabilityEntry {
  const declared = CAPABILITY_TABLE[backend][capability];
  if (declared) return declared;
  if (backend === 'claude') return FULL;
  return { state: 'unavailable', reasonKey: 'backend.capabilityUndeclared' };
}

export const CAPABILITY_IDS: readonly CapabilityId[] = [
  'streaming',
  'toolRendering',
  'approvals',
  'askUserQuestion',
  'subagents',
  'browser',
  'hooks',
  'slashCommands',
  'todos',
  'sessionManagement',
  'modelSwitching',
  'analytics',
];

/** Fully-resolved capability table for one backend (defaults applied). */
export function listBackendCapabilities(
  backend: BackendId,
): Record<CapabilityId, CapabilityEntry> {
  const resolved = {} as Record<CapabilityId, CapabilityEntry>;
  for (const id of CAPABILITY_IDS) {
    resolved[id] = getCapability(backend, id);
  }
  return resolved;
}

/** Test hook for U4/U6/U7: declare or update a capability at runtime. */
export function declareCapability(
  backend: BackendId,
  capability: CapabilityId,
  entry: CapabilityEntry,
): void {
  CAPABILITY_TABLE[backend][capability] = entry;
}

// ---------------------------------------------------------------------------
// Runtime availability
// ---------------------------------------------------------------------------

export interface BackendRuntimeResolver {
  resolveBinaryPath(): string | undefined;
  /** Returns true when healthy, otherwise a failure description. */
  healthCheck?(binaryPath: string): Promise<true | string>;
}

export interface BackendAvailability {
  status: 'available' | 'unavailable';
  reason?: string;
}

/**
 * Spawn `<binary> --version` with a 10s timeout — generalized from
 * ChatService.testClaudeBinary (presence alone is not availability).
 */
export function defaultHealthCheck(binaryPath: string): Promise<true | string> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: true | string): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let proc;
    try {
      proc = spawn(binaryPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      finish(`spawn failed: ${(err as Error).message}`);
      return;
    }
    let output = '';
    proc.stdout?.on('data', (d: Buffer) => {
      output += String(d);
    });
    proc.stderr?.on('data', (d: Buffer) => {
      output += String(d);
    });
    const timer = setTimeout(() => {
      proc.kill();
      finish('health check timed out after 10s');
    }, 10_000);
    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      finish(`spawn error: ${err.message}`);
    });
    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      finish(code === 0 ? true : `exit code ${code}: ${output.trim().slice(-200)}`);
    });
  });
}

const runtimeResolvers = new Map<BackendId, BackendRuntimeResolver>();
const availabilityCache = new Map<BackendId, BackendAvailability>();

export function registerBackendRuntime(backend: BackendId, resolver: BackendRuntimeResolver): void {
  runtimeResolvers.set(backend, resolver);
  availabilityCache.delete(backend);
}

async function computeAvailability(backend: BackendId): Promise<BackendAvailability> {
  const resolver = runtimeResolvers.get(backend);
  if (!resolver) {
    return { status: 'unavailable', reason: `no runtime registered for backend '${backend}'` };
  }
  const binaryPath = resolver.resolveBinaryPath();
  if (!binaryPath) {
    return { status: 'unavailable', reason: 'runtime binary missing or not found' };
  }
  const check = await (resolver.healthCheck ?? defaultHealthCheck)(binaryPath);
  if (check !== true) {
    return { status: 'unavailable', reason: `health check failed: ${check}` };
  }
  return { status: 'available' };
}

export async function getBackendAvailability(backend: BackendId): Promise<BackendAvailability> {
  const cached = availabilityCache.get(backend);
  if (cached) return cached;
  const availability = await computeAvailability(backend);
  diagLog(`[agent-backends] availability ${backend}: ${availability.status}${availability.reason ? ` (${availability.reason})` : ''}`);
  availabilityCache.set(backend, availability);
  return availability;
}

// Built-in backends: their resolvers ship with the registry (claude via the
// SDK's platform optional dep, opencode via the pinned opencode-* packages).
function registerDefaultBackendRuntimes(): void {
  registerBackendRuntime('claude', { resolveBinaryPath: () => resolveSdkBinary() });
  registerBackendRuntime('opencode', { resolveBinaryPath: () => resolveOpencodeBinary() });
}

registerDefaultBackendRuntimes();

/** Clear all resolvers and cached availability. Tests re-register per case. */
export function resetBackendRegistryForTests(): void {
  runtimeResolvers.clear();
  availabilityCache.clear();
}

// ---------------------------------------------------------------------------
// Default backend (app-level setting + availability-aware resolution, KTD-5)
// ---------------------------------------------------------------------------

const DEFAULT_BACKEND_KEY = 'defaultBackend';

export async function getDefaultBackend(): Promise<BackendId | undefined> {
  const value = await getAppSetting<string>(DEFAULT_BACKEND_KEY);
  return value === 'claude' || value === 'opencode' ? value : undefined;
}

export async function setDefaultBackend(backend: BackendId): Promise<void> {
  await setAppSetting(DEFAULT_BACKEND_KEY, backend);
}

export async function clearDefaultBackend(): Promise<void> {
  await setAppSetting(DEFAULT_BACKEND_KEY, undefined);
}

export interface ResolvedDefaultBackend {
  backend: BackendId;
  /** Set when the stored default was unavailable and a fallback was used. */
  fallbackFrom?: BackendId;
}

export async function resolveDefaultBackend(): Promise<ResolvedDefaultBackend> {
  const stored = await getDefaultBackend();
  if (stored) {
    if ((await getBackendAvailability(stored)).status === 'available') {
      return { backend: stored };
    }
    for (const candidate of BACKEND_IDS) {
      if (candidate === stored) continue;
      if ((await getBackendAvailability(candidate)).status === 'available') {
        return { backend: candidate, fallbackFrom: stored };
      }
    }
    // Nothing available: surface the stored value; callers check availability.
    return { backend: stored };
  }
  for (const candidate of BACKEND_IDS) {
    if ((await getBackendAvailability(candidate)).status === 'available') {
      return { backend: candidate };
    }
  }
  return { backend: 'claude' };
}
