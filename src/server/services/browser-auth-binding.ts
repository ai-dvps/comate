import { randomBytes } from 'crypto';
import type { BrowserSessionContext, BrowserSiteAuthEntry } from '../models/workspace.js';
import { registrableDomain, siteKeyForUrl } from './browser-site-key.js';

export type BrowserAuthBindingErrorCode =
  | 'auth_binding_not_found'
  | 'auth_binding_stale'
  | 'domain_not_authorized'
  | 'auth_binding_limit_reached';

export class BrowserAuthBindingError extends Error {
  constructor(readonly code: BrowserAuthBindingErrorCode) {
    super(code);
    this.name = 'BrowserAuthBindingError';
  }
}

export interface CapturedAuthMaterial {
  siteKey: string;
  sourceOrigin: string;
  sessionContext: BrowserSessionContext;
  bearerToken?: string;
}

export interface ResolvedAuthMaterial {
  authorizedSiteKey: string;
  cookies: Array<Record<string, unknown>>;
  bearerToken?: string;
  localStorage?: Record<string, Record<string, string>>;
  sessionStorage?: Record<string, Record<string, string>>;
}

interface EphemeralBinding {
  mode: 'ephemeral';
  material: CapturedAuthMaterial;
}

interface RememberedBinding {
  mode: 'remembered';
  siteKey: string;
  sourceOrigin: string;
  generation: string;
}

type Binding = EphemeralBinding | RememberedBinding;
type RememberedLookup = (
  taskId: string,
  siteKey: string,
) => { entry: BrowserSiteAuthEntry; generation: string } | undefined;

function normalizeOrigin(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BrowserAuthBindingError('domain_not_authorized');
  return url.origin;
}

function cookiePathMatches(cookiePath: string, requestPath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

/** RFC6265 applicability with conservative treatment of ambiguous modern flags. */
export function cookieAppliesToUrl(
  cookie: Record<string, unknown>,
  url: URL,
  options?: { nowMs?: number; sourceOrigin?: string; partitionKey?: string },
): boolean {
  const name = typeof cookie.name === 'string' ? cookie.name : '';
  const domainRaw = typeof cookie.domain === 'string' ? cookie.domain.toLowerCase() : '';
  if (!name || !domainRaw) return false;
  const domain = domainRaw.replace(/^\./, '');
  const host = url.hostname.toLowerCase();
  const hostOnly = cookie.hostOnly === true || (cookie.hostOnly !== false && !domainRaw.startsWith('.'));
  if (hostOnly ? host !== domain : host !== domain && !host.endsWith(`.${domain}`)) return false;

  const path = typeof cookie.path === 'string' && cookie.path.startsWith('/') ? cookie.path : '/';
  if (!cookiePathMatches(path, url.pathname || '/')) return false;
  if (cookie.secure === true && url.protocol !== 'https:') return false;

  const expires = typeof cookie.expires === 'number' ? cookie.expires : undefined;
  if (expires !== undefined && expires > 0 && expires <= (options?.nowMs ?? Date.now()) / 1000) return false;
  if (name.startsWith('__Secure-') && cookie.secure !== true) return false;
  if (name.startsWith('__Host-') &&
      (cookie.secure !== true || path !== '/' || !hostOnly)) return false;

  if (cookie.partitionKey !== undefined && cookie.partitionKey !== options?.partitionKey) return false;
  const sameSite = typeof cookie.sameSite === 'string' ? cookie.sameSite.toLowerCase() : '';
  if ((sameSite === 'strict' || sameSite === 'lax') && options?.sourceOrigin) {
    const source = new URL(normalizeOrigin(options.sourceOrigin));
    if (source.protocol !== url.protocol || registrableDomain(source) !== registrableDomain(url)) return false;
  }
  return true;
}

function cloneStorage(
  storage: Record<string, Record<string, string>> | undefined,
): Record<string, Record<string, string>> | undefined {
  if (!storage) return undefined;
  return Object.fromEntries(Object.entries(storage).map(([origin, values]) => [origin, { ...values }]));
}

function cloneMaterial(material: CapturedAuthMaterial, sourceOrigin: string): CapturedAuthMaterial {
  return {
    siteKey: material.siteKey,
    sourceOrigin,
    sessionContext: {
      cookies: material.sessionContext.cookies.map((cookie) => ({ ...cookie })),
      ...(material.sessionContext.localStorage
        ? { localStorage: cloneStorage(material.sessionContext.localStorage) }
        : {}),
      ...(material.sessionContext.sessionStorage
        ? { sessionStorage: cloneStorage(material.sessionContext.sessionStorage) }
        : {}),
    },
    ...(material.bearerToken !== undefined ? { bearerToken: material.bearerToken } : {}),
  };
}

function zeroizeMaterial(material: CapturedAuthMaterial): void {
  if (material.bearerToken !== undefined) material.bearerToken = '';
  for (const cookie of material.sessionContext.cookies) {
    if (typeof cookie.value === 'string') cookie.value = '';
  }
  for (const storage of [material.sessionContext.localStorage, material.sessionContext.sessionStorage]) {
    for (const values of Object.values(storage ?? {})) {
      for (const key of Object.keys(values)) values[key] = '';
    }
  }
}

/** Bounded, task-owned opaque handles. It never serializes raw credential material. */
export class BrowserAuthBindingVault {
  private readonly tasks = new Map<string, Map<string, Binding>>();
  private readonly maxBindingsPerTask: number;
  private readonly maxTasks: number;
  private readonly maxMaterialBytes: number;
  private readonly readRemembered?: RememberedLookup;

  constructor(options?: {
    maxBindingsPerTask?: number;
    maxTasks?: number;
    maxMaterialBytes?: number;
    readRemembered?: RememberedLookup;
  }) {
    this.maxBindingsPerTask = options?.maxBindingsPerTask ?? 32;
    this.maxTasks = options?.maxTasks ?? 128;
    this.maxMaterialBytes = options?.maxMaterialBytes ?? 1024 * 1024;
    this.readRemembered = options?.readRemembered;
  }

  capture(taskId: string, material: CapturedAuthMaterial): string {
    if (Buffer.byteLength(JSON.stringify(material), 'utf8') > this.maxMaterialBytes) {
      throw new BrowserAuthBindingError('auth_binding_limit_reached');
    }
    let bindings = this.tasks.get(taskId);
    if (!bindings) {
      if (this.tasks.size >= this.maxTasks) throw new BrowserAuthBindingError('auth_binding_limit_reached');
      bindings = new Map();
      this.tasks.set(taskId, bindings);
    }
    if (bindings.size >= this.maxBindingsPerTask) throw new BrowserAuthBindingError('auth_binding_limit_reached');
    const sourceOrigin = normalizeOrigin(material.sourceOrigin);
    const sourceKey = siteKeyForUrl(sourceOrigin);
    if (!sourceKey.ok || sourceKey.key !== material.siteKey) throw new BrowserAuthBindingError('domain_not_authorized');
    const id = `authb_${randomBytes(24).toString('base64url')}`;
    bindings.set(id, { mode: 'ephemeral', material: cloneMaterial(material, sourceOrigin) });
    return id;
  }

  rebindRemembered(
    taskId: string,
    bindingId: string,
    remembered: { siteKey: string; generation: string },
  ): void {
    const binding = this.requireBinding(taskId, bindingId);
    if (binding.mode !== 'ephemeral' || binding.material.siteKey !== remembered.siteKey) {
      throw new BrowserAuthBindingError('auth_binding_stale');
    }
    const sourceOrigin = binding.material.sourceOrigin;
    zeroizeMaterial(binding.material);
    this.tasks.get(taskId)!.set(bindingId, {
      mode: 'remembered', sourceOrigin, siteKey: remembered.siteKey, generation: remembered.generation,
    });
  }

  /** Server-only read used by an explicit Remember action; it does not rebind automatically. */
  materialForRemember(taskId: string, bindingId: string): CapturedAuthMaterial {
    const binding = this.requireBinding(taskId, bindingId);
    if (binding.mode !== 'ephemeral') throw new BrowserAuthBindingError('auth_binding_stale');
    return binding.material;
  }

  resolve(taskId: string, bindingId: string, destination: string): ResolvedAuthMaterial {
    const binding = this.requireBinding(taskId, bindingId);
    const target = new URL(destination);
    const targetKey = siteKeyForUrl(target.toString());
    const siteKey = binding.mode === 'ephemeral' ? binding.material.siteKey : binding.siteKey;
    if (!targetKey.ok || targetKey.key !== siteKey) throw new BrowserAuthBindingError('domain_not_authorized');

    let entry: BrowserSiteAuthEntry;
    let sourceOrigin: string;
    if (binding.mode === 'ephemeral') {
      entry = {
        sessionContext: binding.material.sessionContext,
        bearerToken: binding.material.bearerToken,
        createdAt: '', updatedAt: '',
      };
      sourceOrigin = binding.material.sourceOrigin;
    } else {
      const remembered = this.readRemembered?.(taskId, binding.siteKey);
      if (!remembered || remembered.generation !== binding.generation) {
        throw new BrowserAuthBindingError('auth_binding_stale');
      }
      entry = remembered.entry;
      sourceOrigin = binding.sourceOrigin;
    }
    const exactOrigin = target.origin === sourceOrigin;
    return {
      authorizedSiteKey: siteKey,
      cookies: entry.sessionContext.cookies.filter((cookie) =>
        cookieAppliesToUrl(cookie, target, { sourceOrigin })),
      ...(exactOrigin && entry.bearerToken ? { bearerToken: entry.bearerToken } : {}),
      ...(exactOrigin && entry.sessionContext.localStorage ? { localStorage: entry.sessionContext.localStorage } : {}),
      ...(exactOrigin && entry.sessionContext.sessionStorage ? { sessionStorage: entry.sessionContext.sessionStorage } : {}),
    };
  }

  browserClosed(taskId: string): void {
    const bindings = this.tasks.get(taskId);
    if (!bindings) return;
    for (const [id, binding] of bindings) {
      if (binding.mode === 'ephemeral') {
        zeroizeMaterial(binding.material);
        bindings.delete(id);
      }
    }
    if (bindings.size === 0) this.tasks.delete(taskId);
  }

  closeTask(taskId: string): void {
    const bindings = this.tasks.get(taskId);
    if (!bindings) return;
    for (const binding of bindings.values()) {
      if (binding.mode === 'ephemeral') zeroizeMaterial(binding.material);
    }
    this.tasks.delete(taskId);
  }

  discard(taskId: string, bindingId: string): void {
    const bindings = this.tasks.get(taskId);
    const binding = bindings?.get(bindingId);
    if (!bindings || !binding) return;
    if (binding.mode === 'ephemeral') zeroizeMaterial(binding.material);
    bindings.delete(bindingId);
    if (bindings.size === 0) this.tasks.delete(taskId);
  }

  private requireBinding(taskId: string, bindingId: string): Binding {
    const binding = this.tasks.get(taskId)?.get(bindingId);
    if (!binding) throw new BrowserAuthBindingError('auth_binding_stale');
    return binding;
  }
}
