import '../../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import http from 'node:http';
import { AddressInfo } from 'node:net';

import { createIsolatedStore } from '../../test-utils/test-store.js';
import type { SqliteStore } from '../../storage/sqlite-store.js';
import { store as singletonStore } from '../../storage/sqlite-store.js';
import type { BrowserSiteAuthEntry } from '../../models/workspace.js';
import {
  cookieDomainInScope,
  isIpLiteralHost,
  registrableDomain,
  siteKeyForUrl,
  storageDomainInScope,
} from '../browser-site-key.js';
import { registrableDomain as gateRegistrableDomain } from '../browser-gate-state.js';
import {
  clearBrowserGateSession,
  commitSessionNavigation,
  getVisitedDomains,
} from '../browser-gate-state.js';
import { chatService } from '../chat-service.js';
import chatRouter from '../../routes/chat.js';
import {
  buildStorageInitScript,
  filterContextToScope,
  mergeSiteAuthForUpdate,
  readSiteAuthEntry,
  stripSiteAuthValues,
} from '../browser-site-auth.js';
import { BrowserAuditService } from '../browser-audit.js';
import {
  BrowserService,
  BrowserSiteAuthError,
  type RememberSiteResult,
} from '../browser-service.js';
import { BrowserControlService } from '../browser-control.js';
import type { SteelExitInfo, SteelProcessHandle, SteelProcessOptions } from '../browser-steel-process.js';
import { BrowserToolContext, type BrowserMcpDeps } from '../browser-mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SteelCdpSession } from '../browser-cdp.js';
import type { RawAxNode, RawPageExtraction, SubmitSnapshot } from '../browser-page-model.js';
import workspacesRouter from '../../routes/workspaces.js';

/**
 * browser-site-auth — U8 full-chain tests: the KTD-8 key rule (tldts/PSL),
 * the remember → value-only-in store → inject chain (fake Steel), the GET
 * strip + PUT field-level merge + revoke + workspace cascade, and the
 * browser_audit discipline (positive shape; values never persisted).
 *
 * The secret marker below is asserted ABSENT from audit rows, stripped GET
 * responses, tool results, and diagLog output — the value-containment
 * scenarios of the plan.
 */
const SECRET_COOKIE_VALUE = 'SUPER-SECRET-SESSION-TOKEN-VALUE-do-not-leak';
const SECRET_STORAGE_VALUE = 'SUPER-SECRET-STORAGE-TOKEN-do-not-leak';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const STEEL_DIR = path.join(TEST_DIR, '..', '..', '..', '..', 'src-tauri', 'resources', 'steel');

/** Narrowing helper for the key matrix — fails loudly when the key refused. */
function keyOf(url: string): string {
  const result = siteKeyForUrl(url);
  assert.ok(result.ok, `expected a site key for ${url}`);
  return result.key;
}

// ---------------------------------------------------------------------------
// Key rule (KTD-8)
// ---------------------------------------------------------------------------

describe('browser-site-key: PSL key matrix', () => {
  it('keys public hosts by eTLD+1 (example.co.uk does not leak across co.uk)', () => {
    assert.strictEqual(keyOf('https://example.co.uk/login'), 'example.co.uk');
    assert.strictEqual(keyOf('https://app.example.co.uk/'), 'example.co.uk');
    assert.strictEqual(keyOf('https://other.co.uk/'), 'other.co.uk');
    assert.notStrictEqual(keyOf('https://example.co.uk/'), 'co.uk');
  });

  it('keys private PSL suffixes correctly (user.github.io does not leak across github.io)', () => {
    assert.strictEqual(keyOf('https://user.github.io/app'), 'user.github.io');
    assert.strictEqual(keyOf('https://other.github.io/'), 'other.github.io');
    assert.notStrictEqual(keyOf('https://user.github.io/'), 'github.io');
    // A host that IS a public suffix keys as itself (over-group, never under).
    assert.strictEqual(keyOf('https://github.io/'), 'github.io');
  });

  it('scopes localhost and single-label hosts by port', () => {
    assert.strictEqual(keyOf('http://localhost:3000/'), 'localhost:3000');
    assert.strictEqual(keyOf('http://localhost:8080/'), 'localhost:8080');
    assert.notStrictEqual(keyOf('http://localhost:3000/'), keyOf('http://localhost:8080/'));
    assert.strictEqual(keyOf('http://intranet/'), 'intranet');
  });

  it('refuses IP-literal hosts for remember (unstable cross-network semantics)', () => {
    const v4 = siteKeyForUrl('http://127.0.0.1:3000/');
    assert.strictEqual(v4.ok, false);
    if (!v4.ok) assert.strictEqual(v4.reason, 'ip-literal');
    const v6 = siteKeyForUrl('http://[::1]:8080/');
    assert.strictEqual(v6.ok, false);
    if (!v6.ok) assert.strictEqual(v6.reason, 'ip-literal');
    assert.ok(isIpLiteralHost('127.0.0.1'));
    assert.ok(isIpLiteralHost('[::1]'));
    assert.ok(!isIpLiteralHost('example.com'));
  });

  it('normalizes IDN hosts to punycode keys', () => {
    const result = siteKeyForUrl('https://bücher.de/shop');
    assert.strictEqual(result.ok, true);
    if (result.ok) assert.strictEqual(result.key, 'xn--bcher-kva.de');
    // Same key from the already-punycode spelling — no duplicate entries.
    const puny = siteKeyForUrl('https://xn--bcher-kva.de/shop');
    assert.strictEqual(puny.ok, true);
    if (result.ok && puny.ok) assert.strictEqual(puny.key, result.key);
  });

  it('rejects non-http(s) and unparseable URLs', () => {
    assert.strictEqual(siteKeyForUrl('file:///etc/passwd').ok, false);
    assert.strictEqual(siteKeyForUrl('javascript:alert(1)').ok, false);
    assert.strictEqual(siteKeyForUrl('not a url').ok, false);
  });

  it('the U4 navigation gate now shares the tldts rule', () => {
    // browser-gate-state re-exports the same function (heuristic removed).
    assert.strictEqual(gateRegistrableDomain, registrableDomain);
    assert.strictEqual(
      gateRegistrableDomain(new URL('https://app.example.co.uk/x')),
      'example.co.uk',
    );
    assert.strictEqual(
      gateRegistrableDomain(new URL('https://user.github.io/x')),
      'user.github.io',
    );
    // Navigation ledger keeps IP+port (gate direction: over-group, never under).
    assert.strictEqual(gateRegistrableDomain(new URL('http://127.0.0.1:3000/')), '127.0.0.1:3000');
  });

  it('cookie/storage scope matching follows the key', () => {
    assert.ok(cookieDomainInScope('.example.com', 'example.com'));
    assert.ok(cookieDomainInScope('app.example.com', 'example.com'));
    assert.ok(!cookieDomainInScope('example.com.evil.net', 'example.com'));
    assert.ok(!cookieDomainInScope('other.co.uk', 'example.co.uk'));
    assert.ok(cookieDomainInScope('user.github.io', 'user.github.io'));
    assert.ok(!cookieDomainInScope('other.github.io', 'user.github.io'));
    assert.ok(cookieDomainInScope('localhost', 'localhost:3000'));
    // Cookies are port-less (RFC 6265): a localhost cookie matches both the
    // bare key and any port-scoped key — the port dimension partitions the
    // STORED entries, not the live jar (documented residual).
    assert.ok(cookieDomainInScope('localhost', 'localhost'));
    assert.ok(!cookieDomainInScope('intranet', 'localhost:3000'));
    assert.ok(storageDomainInScope('app.example.com', 'example.com'));
    assert.ok(!storageDomainInScope('evil.org', 'example.com'));
  });
});

// ---------------------------------------------------------------------------
// Storage discipline (pure helpers)
// ---------------------------------------------------------------------------

function entryWithSecret(): BrowserSiteAuthEntry {
  return {
    sessionContext: {
      cookies: [{ name: 'sid', value: SECRET_COOKIE_VALUE, domain: '.example.com' }],
      localStorage: { 'app.example.com': { token: SECRET_STORAGE_VALUE } },
    },
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T01:00:00.000Z',
    lastUsedAt: '2026-07-19T02:00:00.000Z',
  };
}

describe('browser-site-auth storage discipline', () => {
  it('stripSiteAuthValues removes contexts but keeps keys + metadata', () => {
    const stripped = stripSiteAuthValues({ browserSiteAuth: { 'example.com': entryWithSecret() } });
    const siteAuth = stripped.browserSiteAuth as Record<string, unknown>;
    assert.deepStrictEqual(Object.keys(siteAuth), ['example.com']);
    const meta = siteAuth['example.com'] as Record<string, unknown>;
    assert.strictEqual(meta.createdAt, '2026-07-19T00:00:00.000Z');
    assert.strictEqual(meta.updatedAt, '2026-07-19T01:00:00.000Z');
    assert.strictEqual(meta.lastUsedAt, '2026-07-19T02:00:00.000Z');
    assert.strictEqual('sessionContext' in meta, false);
    assert.ok(!JSON.stringify(stripped).includes(SECRET_COOKIE_VALUE));
    assert.ok(!JSON.stringify(stripped).includes(SECRET_STORAGE_VALUE));
  });

  it('strip passes settings without the field through untouched', () => {
    const settings = { promptHistoryRetentionDays: 30 };
    assert.strictEqual(stripSiteAuthValues(settings), settings);
  });

  it('merge preserves stored values across whole-bag saves (no field sent)', () => {
    const stored = { browserSiteAuth: { 'example.com': entryWithSecret() } };
    const merged = mergeSiteAuthForUpdate(stored, { promptHistoryRetentionDays: 30 });
    assert.strictEqual(
      readSiteAuthEntry(merged, 'example.com')?.sessionContext.cookies[0].value,
      SECRET_COOKIE_VALUE,
    );
  });

  it('merge prunes removed keys but NEVER accepts client-supplied values', () => {
    const stored = {
      browserSiteAuth: {
        'example.com': entryWithSecret(),
        'other.org': entryWithSecret(),
      },
    };
    // Client sends the stripped view (metas) plus a crafted fake value.
    const incoming = {
      browserSiteAuth: {
        'example.com': { updatedAt: '2026-07-19T01:00:00.000Z' },
        'planted.evil': {
          sessionContext: { cookies: [{ name: 'x', value: 'PLANTED' }] },
          createdAt: 'x',
          updatedAt: 'x',
        },
      } as unknown as Record<string, BrowserSiteAuthEntry>,
    };
    const merged = mergeSiteAuthForUpdate(stored, incoming);
    // Key set from incoming decides survival: other.org pruned.
    assert.deepStrictEqual(Object.keys(merged.browserSiteAuth ?? {}), ['example.com']);
    // Stored value preserved; planted key dropped.
    assert.strictEqual(
      readSiteAuthEntry(merged, 'example.com')?.sessionContext.cookies[0].value,
      SECRET_COOKIE_VALUE,
    );
    assert.ok(!JSON.stringify(merged).includes('PLANTED'));
  });

  it('filterContextToScope keeps only in-scope cookies/storage and drops IndexedDB', () => {
    const scoped = filterContextToScope(
      {
        cookies: [
          { name: 'sid', value: SECRET_COOKIE_VALUE, domain: '.example.com' },
          { name: 'sub', value: 'v2', domain: 'app.example.com' },
          { name: 'other', value: 'v3', domain: '.other.org' },
        ],
        localStorage: {
          'app.example.com': { token: SECRET_STORAGE_VALUE },
          'other.org': { token: 'cross-site' },
        },
        sessionStorage: { 'example.com': { flow: 'sso' } },
        indexedDB: { 'app.example.com': [{ name: 'db' }] },
      },
      'example.com',
    );
    assert.strictEqual(scoped.cookies.length, 2);
    assert.deepStrictEqual(Object.keys(scoped.localStorage ?? {}), ['app.example.com']);
    assert.deepStrictEqual(Object.keys(scoped.sessionStorage ?? {}), ['example.com']);
    assert.ok(!('indexedDB' in scoped), 'IndexedDB is not carried in v1 (R15 scope)');
  });

  it('buildStorageInitScript keys by hostname and embeds both stores', () => {
    const script = buildStorageInitScript({
      localStorage: { 'app.example.com': { a: '1' } },
      sessionStorage: { 'app.example.com': { b: '2' } },
    });
    assert.ok(script);
    assert.ok(script.includes('location.hostname'));
    assert.ok(script.includes('localStorage.setItem'));
    assert.ok(script.includes('sessionStorage.setItem'));
    assert.ok(script.includes('app.example.com'));
    assert.strictEqual(buildStorageInitScript({}), null);
  });
});

// ---------------------------------------------------------------------------
// Fake Steel harness for the remember/inject chain
// ---------------------------------------------------------------------------

class FakeSteelHandle implements SteelProcessHandle {
  readonly baseUrl: string;
  started = false;
  stopped = false;
  private exitListeners = new Set<(info: SteelExitInfo) => void>();

  constructor(private readonly options: SteelProcessOptions) {
    this.baseUrl = `http://127.0.0.1:${options.port}`;
  }
  get sessionId(): string {
    return this.options.sessionId;
  }
  get port(): number {
    return this.options.port;
  }
  get pid(): number | undefined {
    return 20_000 + this.options.port;
  }
  get userDataDir(): string {
    return this.options.userDataDir;
  }
  async start(): Promise<void> {
    this.started = true;
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  async probeHealth(): Promise<boolean> {
    return this.started && !this.stopped;
  }
  onExit(listener: (info: SteelExitInfo) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
}

interface FakePageOptions {
  extractions: RawPageExtraction[];
  submitSnapshots?: Array<SubmitSnapshot | null>;
  axNodes?: RawAxNode[];
}

class FakePage implements SteelCdpSession {
  closed = false;
  navigated: string[] = [];
  cookieWrites: Array<Array<Record<string, unknown>>> = [];
  initScripts: string[] = [];
  dispatchCount = 0;
  clicks: number[] = [];
  private extractionIndex = 0;
  private readonly submitSnapshots: Array<SubmitSnapshot | null>;
  private readonly closeListeners = new Set<() => void>();

  constructor(private readonly options: FakePageOptions) {
    this.submitSnapshots = [...(options.submitSnapshots ?? [])];
  }

  private nextExtraction(): RawPageExtraction {
    const extraction =
      this.options.extractions[Math.min(this.extractionIndex, this.options.extractions.length - 1)];
    this.extractionIndex += 1;
    return extraction;
  }

  async evaluate<T>(expression: string): Promise<T> {
    if (expression.includes('new MutationObserver')) {
      return this.nextExtraction() as T; // distiller extractor
    }
    if (expression.includes('window.__comateProbe')) {
      return { docId: 'doc-1', domEpoch: 0 } as T; // READ_PROBE_SCRIPT
    }
    if (expression.includes('document.forms[') && expression.includes('hash')) {
      const next =
        this.submitSnapshots.length > 1 ? this.submitSnapshots.shift() : this.submitSnapshots[0];
      return (next ?? null) as T; // submit TOCTOU snapshot
    }
    if (expression.includes('requestSubmit')) {
      this.dispatchCount += 1;
      return { ok: true } as T;
    }
    if (expression.includes('XPathResult')) {
      return { ok: true } as T; // act dispatch
    }
    throw new Error(`FakePage: unexpected script: ${expression.slice(0, 120)}`);
  }

  async navigate(url: string): Promise<void> {
    this.navigated.push(url);
  }
  async getFullAXTree(): Promise<RawAxNode[]> {
    return this.options.axNodes ?? [];
  }
  async clickBackendNode(backendNodeId: number): Promise<void> {
    this.clicks.push(backendNodeId);
  }
  async captureScreenshot(): Promise<string> {
    return 'aGVsbG8';
  }
  async setCookies(cookies: Array<Record<string, unknown>>): Promise<void> {
    this.cookieWrites.push(cookies);
  }
  async evaluateOnNewDocument(expression: string): Promise<void> {
    this.initScripts.push(expression);
  }
  onClose(listener: () => void): void {
    this.closeListeners.add(listener);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener();
  }
}

function makeExtraction(overrides: Partial<RawPageExtraction> = {}): RawPageExtraction {
  return {
    url: 'https://app.example.com/login',
    title: 'Login',
    docId: 'doc-1',
    domEpoch: 0,
    forms: [
      {
        formIndex: 0,
        name: 'login',
        action: 'https://app.example.com/session',
        method: 'post',
        fields: [
          {
            fieldIndex: 0,
            name: 'username',
            label: 'Username',
            tag: 'input',
            type: 'text',
            required: true,
            disabled: false,
            readOnly: false,
            sensitive: false,
            value: '',
            filled: false,
            submitSemantics: false,
            xpath: '/html[1]/body[1]/form[1]/input[1]',
          },
          {
            fieldIndex: 1,
            name: 'password',
            label: 'Password',
            tag: 'input',
            type: 'password',
            required: true,
            autocomplete: 'current-password',
            disabled: false,
            readOnly: false,
            sensitive: true,
            value: undefined,
            filled: false,
            submitSemantics: false,
            xpath: '/html[1]/body[1]/form[1]/input[2]',
          },
          {
            fieldIndex: 2,
            name: undefined,
            label: 'Sign in',
            tag: 'button',
            type: 'submit',
            required: false,
            disabled: false,
            readOnly: false,
            sensitive: false,
            value: undefined,
            filled: false,
            submitSemantics: true,
            xpath: '/html[1]/body[1]/form[1]/button[1]',
          },
        ],
      },
    ],
    standalone: [],
    contentText: 'Login page.',
    contentTruncated: false,
    alerts: [],
    stats: { linkCount: 1, buttonCount: 1, hasPasswordField: true },
    ...overrides,
  };
}

function makeSubmitSnapshot(): SubmitSnapshot {
  return {
    action: 'https://app.example.com/session',
    method: 'post',
    fields: [
      { name: 'username', type: 'text', sensitive: false, value: 'ada' },
      { name: 'password', type: 'password', sensitive: true, value: 'h:deadbeef:12' },
    ],
  };
}

// Named result types — deeply nested inline `as` casts trip an esbuild
// generics-parsing edge (`}> }>`), so the shapes live here.
interface OpenResultModel {
  model: {
    forms: Array<{ ref: string; fields: Array<{ name?: string; ref: string }> }>;
    actions: Array<{ ref: string; backendNodeId: number }>;
  };
}

function resultModel(result: CallToolResult): OpenResultModel {
  const text = result.content.find((block) => block.type === 'text');
  assert.ok(text && text.type === 'text', 'result must carry a text block');
  return JSON.parse(text.text) as OpenResultModel;
}

interface ChainHarness {
  store: SqliteStore;
  audit: BrowserAuditService;
  browserService: BrowserService;
  storageDir: string;
  handles: FakeSteelHandle[];
  currentUrl: string | null;
  exportPayload: unknown;
}

function makeChainHarness(overrides?: {
  currentUrl?: string | null;
  exportPayload?: unknown;
}): ChainHarness {
  const store = createIsolatedStore();
  const audit = new BrowserAuditService(store);
  const storageDir = mkdtempSync(path.join(tmpdir(), 'comate-u8-chain-'));
  const handles: FakeSteelHandle[] = [];
  let nextPort = 51_000;
  const harness: ChainHarness = {
    store,
    audit,
    storageDir,
    handles,
    currentUrl: overrides?.currentUrl ?? 'https://app.example.com/account',
    exportPayload: overrides?.exportPayload ?? {
      cookies: [
        { name: 'sid', value: SECRET_COOKIE_VALUE, domain: '.example.com' },
        { name: 'other', value: 'cross-site-cookie', domain: '.other.org' },
      ],
      localStorage: {
        'app.example.com': { token: SECRET_STORAGE_VALUE },
        'other.org': { token: 'cross-site-storage' },
      },
      sessionStorage: { 'app.example.com': { flow: 'sso' } },
    },
    browserService: undefined as unknown as BrowserService,
  };
  harness.browserService = new BrowserService({
    storageDir,
    maxSessions: 4,
    allocatePort: async () => nextPort++,
    resolveChromiumPath: async () => '/fake/chromium',
    createProcess: (options) => {
      const handle = new FakeSteelHandle(options);
      handles.push(handle);
      return handle;
    },
    cleanupStale: async () => ({ scanned: 0, killed: 0, removed: 0, skipped: 0 }),
    now: () => Date.now(),
    store,
    audit,
    currentPageUrl: async () => harness.currentUrl,
    exportContext: async () => harness.exportPayload,
  });
  return harness;
}

async function createWorkspace(store: SqliteStore): Promise<string> {
  const ws = await store.create({ name: 'Test', folderPath: '/tmp/ws' });
  return ws.id;
}

// ---------------------------------------------------------------------------
// remember → inject chain
// ---------------------------------------------------------------------------

describe('remember → store → inject chain (KTD-8)', () => {
  let harness: ChainHarness;
  let workspaceId: string;

  beforeEach(async () => {
    harness = makeChainHarness();
    workspaceId = await createWorkspace(harness.store);
  });

  afterEach(() => {
    rmSync(harness.storageDir, { recursive: true, force: true });
  });

  it('remember exports a scope-filtered context under the site key, with a value-free audit row', async () => {
    await harness.browserService.ensureSession({ sessionId: 'chat-1', workspaceId });
    const result = await harness.browserService.rememberCurrentSite('chat-1');
    assert.strictEqual(result.key, 'example.com');
    assert.strictEqual(result.cookieCount, 1);
    assert.strictEqual(result.storageDomainCount, 2);

    const ws = await harness.store.get(workspaceId);
    const entry = readSiteAuthEntry(ws!.settings, 'example.com');
    assert.ok(entry, 'entry stored under the eTLD+1 key');
    // Only in-scope material: cross-site cookie/storage dropped.
    assert.strictEqual(entry!.sessionContext.cookies.length, 1);
    assert.deepStrictEqual(Object.keys(entry!.sessionContext.localStorage ?? {}), [
      'app.example.com',
    ]);
    assert.deepStrictEqual(Object.keys(entry!.sessionContext.sessionStorage ?? {}), [
      'app.example.com',
    ]);
    assert.ok(entry!.createdAt && entry!.updatedAt);

    const rows = harness.store.listBrowserAudit(workspaceId);
    const remember = rows.find((row) => row.category === 'site_auth' && row.action === 'remember');
    assert.ok(remember, 'remember audit row exists');
    assert.strictEqual(remember!.siteKey, 'example.com');
    assert.strictEqual(remember!.outcome, 'ok');
    assert.strictEqual(remember!.sessionId, 'chat-1');
    assert.ok(
      !JSON.stringify(rows).includes(SECRET_COOKIE_VALUE),
      'audit rows never carry values',
    );
    assert.ok(!JSON.stringify(rows).includes(SECRET_STORAGE_VALUE));
  });

  it('injects the remembered context on the first open of a NEW session (cookies before navigate, storage via init script)', async () => {
    // Seed the store as if a previous session remembered the site.
    await harness.browserService.ensureSession({ sessionId: 'chat-1', workspaceId });
    await harness.browserService.rememberCurrentSite('chat-1');

    // A new chat session = a fresh browser process = fresh eligibility.
    const page = new FakePage({ extractions: [makeExtraction()] });
    const ctx = new BrowserToolContext({
      sessionId: 'chat-2',
      workspaceId,
      browserService: harness.browserService,
      handoffControl: new BrowserControlService({ browserService: harness.browserService, audit: harness.audit }),
      connectPage: async () => page,
      pageRegistry: new Map(),
      settleMs: 0,
      audit: harness.audit,
    } satisfies BrowserMcpDeps);

    const result = await ctx.handleOpen({ url: 'https://app.example.com/dashboard' });
    assert.strictEqual(result.isError, undefined);

    assert.strictEqual(page.cookieWrites.length, 1, 'cookies injected exactly once');
    assert.strictEqual(page.cookieWrites[0][0].value, SECRET_COOKIE_VALUE);
    assert.strictEqual(page.initScripts.length, 1, 'storage init script registered');
    assert.ok(page.initScripts[0].includes('app.example.com'));
    assert.strictEqual(page.navigated.length, 1, 'navigated after injection');
    // lastUsedAt bookkeeping landed.
    const ws = await harness.store.get(workspaceId);
    assert.ok(readSiteAuthEntry(ws!.settings, 'example.com')?.lastUsedAt);

    const injectRows = harness.store
      .listBrowserAudit(workspaceId)
      .filter((row) => row.category === 'site_auth' && row.action === 'inject');
    assert.strictEqual(injectRows.length, 1);
    assert.strictEqual(injectRows[0].siteKey, 'example.com');
  });

  it('injects exactly once per browser process (second open does not re-inject)', async () => {
    await harness.browserService.ensureSession({ sessionId: 'chat-1', workspaceId });
    await harness.browserService.rememberCurrentSite('chat-1');

    const page = new FakePage({ extractions: [makeExtraction()] });
    const ctx = new BrowserToolContext({
      sessionId: 'chat-1',
      workspaceId,
      browserService: harness.browserService,
      handoffControl: new BrowserControlService({ browserService: harness.browserService, audit: harness.audit }),
      connectPage: async () => page,
      pageRegistry: new Map(),
      settleMs: 0,
      audit: harness.audit,
    } satisfies BrowserMcpDeps);

    await ctx.handleOpen({ url: 'https://app.example.com/a' });
    await ctx.handleOpen({ url: 'https://app.example.com/b' });
    assert.strictEqual(page.cookieWrites.length, 1, 'eligibility is one-shot per process');
    assert.strictEqual(page.navigated.length, 2);
  });

  it('does not inject when the first open matches no remembered key', async () => {
    await harness.browserService.ensureSession({ sessionId: 'chat-1', workspaceId });
    await harness.browserService.rememberCurrentSite('chat-1'); // key: example.com

    const page = new FakePage({ extractions: [makeExtraction({ url: 'https://unrelated.net/' })] });
    const ctx = new BrowserToolContext({
      sessionId: 'chat-1',
      workspaceId,
      browserService: harness.browserService,
      handoffControl: new BrowserControlService({ browserService: harness.browserService, audit: harness.audit }),
      connectPage: async () => page,
      pageRegistry: new Map(),
      settleMs: 0,
      audit: harness.audit,
    } satisfies BrowserMcpDeps);
    await ctx.handleOpen({ url: 'https://unrelated.net/' });
    assert.strictEqual(page.cookieWrites.length, 0);
    assert.strictEqual(page.initScripts.length, 0);
  });

  it('F3 proactive takeover (no handoff card) can still remember the site', async () => {
    await harness.browserService.ensureSession({ sessionId: 'chat-1', workspaceId });
    const control = new BrowserControlService({ browserService: harness.browserService, audit: harness.audit });
    // F3: no beginHandoff — the user takes over directly.
    const takeover = control.takeover('chat-1');
    assert.strictEqual(takeover.ok, true);
    assert.strictEqual(harness.browserService.getControlState('chat-1'), 'user_in_control');

    const result: RememberSiteResult = await harness.browserService.rememberCurrentSite('chat-1');
    assert.strictEqual(result.key, 'example.com');

    const handback = control.handback('chat-1');
    assert.strictEqual(handback.ok, true);
    assert.strictEqual(harness.browserService.getControlState('chat-1'), 'agent_in_control');
    // Control-plane audit rows landed for the F3 pair.
    const controlVerbs = harness.store
      .listBrowserAudit(workspaceId)
      .filter((row) => row.category === 'control')
      .map((row) => row.action);
    assert.ok(controlVerbs.includes('takeover'));
    assert.ok(controlVerbs.includes('handback'));
  });

  it('revoke clears the entry and stops injection', async () => {
    await harness.browserService.ensureSession({ sessionId: 'chat-1', workspaceId });
    await harness.browserService.rememberCurrentSite('chat-1');
    assert.strictEqual(harness.store.deleteWorkspaceSiteAuthEntry(workspaceId, 'example.com'), true);
    assert.strictEqual(
      harness.store.deleteWorkspaceSiteAuthEntry(workspaceId, 'example.com'),
      false,
      'second revoke reports the missing key',
    );
    const injection = await harness.browserService.prepareSiteAuthInjection(
      'chat-1',
      'https://app.example.com/x',
    );
    assert.strictEqual(injection, null);
  });

  it('refuses IP-literal pages and empty contexts with typed errors', async () => {
    harness.currentUrl = 'http://127.0.0.1:3000/admin';
    await harness.browserService.ensureSession({ sessionId: 'chat-1', workspaceId });
    await assert.rejects(
      harness.browserService.rememberCurrentSite('chat-1'),
      (err: unknown) => {
        assert.ok(err instanceof BrowserSiteAuthError);
        assert.strictEqual(err.code, 'ip_literal');
        return true;
      },
    );

    harness.currentUrl = 'https://app.example.com/account';
    harness.exportPayload = { cookies: [] };
    await assert.rejects(harness.browserService.rememberCurrentSite('chat-1'), (err: unknown) => {
      assert.ok(err instanceof BrowserSiteAuthError);
      assert.strictEqual(err.code, 'empty_context');
      return true;
    });
  });

  it('value containment: the context never appears in tool results, audit rows, or the stripped GET view', async () => {
    await harness.browserService.ensureSession({ sessionId: 'chat-1', workspaceId });
    await harness.browserService.rememberCurrentSite('chat-1');

    const page = new FakePage({ extractions: [makeExtraction()] });
    const ctx = new BrowserToolContext({
      sessionId: 'chat-2',
      workspaceId,
      browserService: harness.browserService,
      handoffControl: new BrowserControlService({ browserService: harness.browserService, audit: harness.audit }),
      connectPage: async () => page,
      pageRegistry: new Map(),
      settleMs: 0,
      audit: harness.audit,
    } satisfies BrowserMcpDeps);
    const result = await ctx.handleOpen({ url: 'https://app.example.com/' });
    const toolResultText = JSON.stringify(result);
    assert.ok(!toolResultText.includes(SECRET_COOKIE_VALUE), 'tool results carry no context values');
    assert.ok(!toolResultText.includes(SECRET_STORAGE_VALUE));

    const auditText = JSON.stringify(harness.store.listBrowserAudit(workspaceId));
    assert.ok(!auditText.includes(SECRET_COOKIE_VALUE), 'audit rows carry no values');
    assert.ok(!auditText.includes(SECRET_STORAGE_VALUE));

    const ws = await harness.store.get(workspaceId);
    const stripped = stripSiteAuthValues(ws!.settings);
    assert.ok(!JSON.stringify(stripped).includes(SECRET_COOKIE_VALUE), 'GET strip carries no values');
  });
});

// ---------------------------------------------------------------------------
// Workspace cascade
// ---------------------------------------------------------------------------

describe('workspace delete cascade (KTD-8)', () => {
  it('store.delete removes the workspace (site-auth field with it) and its audit rows', async () => {
    const store = createIsolatedStore();
    const audit = new BrowserAuditService(store);
    const workspaceId = await createWorkspace(store);
    store.setWorkspaceSiteAuthEntry(workspaceId, 'example.com', entryWithSecret());
    audit.logSiteAuth({ workspaceId, siteKey: 'example.com', action: 'remember', outcome: 'ok' });
    assert.strictEqual(store.listBrowserAudit(workspaceId).length, 1);

    const deleted = await store.delete(workspaceId);
    assert.strictEqual(deleted, true);
    assert.strictEqual(await store.get(workspaceId), null);
    assert.strictEqual(store.listBrowserAudit(workspaceId).length, 0, 'audit rows cascaded');
  });
});

// ---------------------------------------------------------------------------
// browser_audit discipline
// ---------------------------------------------------------------------------

describe('browser_audit table + service contract', () => {
  it('constructor migrates to version 6 and resetData wipes the table', () => {
    const store = createIsolatedStore();
    assert.strictEqual(store.getMigrationVersion(), 6);
    const audit = new BrowserAuditService(store);
    audit.logControl({ workspaceId: 'ws', sessionId: 's', verb: 'takeover', outcome: 'ok' });
    assert.strictEqual(store.listBrowserAudit('ws').length, 1);
    store.resetData();
    assert.strictEqual(store.listBrowserAudit('ws').length, 0);
  });

  it('derives origins from URLs and bounds free-form fields', () => {
    const store = createIsolatedStore();
    const audit = new BrowserAuditService(store);
    audit.logToolAction({
      workspaceId: 'ws',
      sessionId: 's',
      toolName: 'mcp__comate-browser__open',
      url: 'https://app.example.com/path?token=secret-query',
      outcome: 'ok',
      detail: 'x'.repeat(1000),
    });
    const [row] = store.listBrowserAudit('ws');
    assert.strictEqual(row.origin, 'https://app.example.com', 'origin only — never query');
    assert.ok(!JSON.stringify(row).includes('secret-query'));
    assert.strictEqual(row.detail!.length, 256);
    assert.strictEqual(row.potentialSubmit, false);
  });

  it('act/submit/takeover/handback sequences land with the correct shapes', async () => {
    const harness = makeChainHarness();
    const workspaceId = await createWorkspace(harness.store);
    try {
      const control = new BrowserControlService({
        browserService: harness.browserService,
        audit: harness.audit,
      });
      const page = new FakePage({
        extractions: [
          makeExtraction({ url: 'https://app.example.com/form' }),
          makeExtraction({ url: 'https://app.example.com/form' }),
        ],
        submitSnapshots: [makeSubmitSnapshot()],
      });
      const approvals: Array<Record<string, unknown>> = [];
      const ctx = new BrowserToolContext({
        sessionId: 'chat-1',
        workspaceId,
        browserService: harness.browserService,
        handoffControl: control,
        approvalRequester: async (_sessionId, request) => {
          approvals.push(request.payload);
          return { behavior: 'allow' };
        },
        connectPage: async () => page,
        pageRegistry: new Map(),
        settleMs: 0,
        audit: harness.audit,
      } satisfies BrowserMcpDeps);

      // act: fill (non-submit field).
      const openResult = await ctx.handleOpen({ url: 'https://app.example.com/form' });
      const model = resultModel(openResult);
      const usernameRef = model.model.forms[0].fields[0].ref;
      const actResult = await ctx.handleAct({ ref: usernameRef, action: 'fill', value: 'ada' });
      assert.strictEqual(actResult.isError, undefined);

      // submit: full handler gate flow (approval allow). Refs from the act
      // result's FRESH model — every distill begins a new ref batch.
      const formRef = resultModel(actResult).model.forms[0].ref;
      const submitResult = await ctx.handleSubmit({ ref: formRef, fields: { username: 'ada' } });
      assert.strictEqual(submitResult.isError, undefined);

      // takeover + handback (F3).
      control.takeover('chat-1');
      control.handback('chat-1');

      const rows = harness.store.listBrowserAudit(workspaceId);
      const byAction = (category: string, action: string) =>
        rows.find((row) => row.category === category && row.action === action);

      const open = byAction('tool', 'mcp__comate-browser__open');
      assert.ok(open);
      assert.strictEqual(open!.origin, 'https://app.example.com');
      assert.strictEqual(open!.outcome, 'ok');

      const act = byAction('tool', 'mcp__comate-browser__act');
      assert.ok(act);
      // act audits the field's structural identity (accessible label from the
      // ref entry); submit audits form field NAMES. Neither carries values.
      assert.deepStrictEqual(act!.fieldNames, ['Username']);
      assert.strictEqual(act!.potentialSubmit, false, 'fill is never potential-submit');

      const submit = byAction('tool', 'mcp__comate-browser__submit');
      assert.ok(submit);
      assert.deepStrictEqual(submit!.fieldNames, ['username', 'password']);
      assert.strictEqual(submit!.outcome, 'ok');
      assert.strictEqual(submit!.origin, 'https://app.example.com');
      assert.ok(!JSON.stringify(submit).includes('ada'), 'field values never audited');

      assert.ok(byAction('control', 'takeover'));
      assert.ok(byAction('control', 'handback'));
      assert.ok(!JSON.stringify(rows).includes(SECRET_COOKIE_VALUE));
    } finally {
      rmSync(harness.storageDir, { recursive: true, force: true });
    }
  });

  it('flags a click followed by navigation as a potential submit (RISK-1)', async () => {
    const harness = makeChainHarness();
    const workspaceId = await createWorkspace(harness.store);
    try {
      const axNodes: RawAxNode[] = [
        {
          role: { value: 'link' },
          name: { value: 'Continue to checkout' },
          backendDOMNodeId: 777,
        },
      ];
      const page = new FakePage({
        extractions: [
          makeExtraction({ url: 'https://app.example.com/a' }),
          makeExtraction({ url: 'https://app.example.com/b' }),
        ],
        axNodes,
      });
      const ctx = new BrowserToolContext({
        sessionId: 'chat-1',
        workspaceId,
        browserService: harness.browserService,
        handoffControl: new BrowserControlService({
          browserService: harness.browserService,
          audit: harness.audit,
        }),
        connectPage: async () => page,
        pageRegistry: new Map(),
        settleMs: 0,
        audit: harness.audit,
      } satisfies BrowserMcpDeps);

      const openResult = await ctx.handleOpen({ url: 'https://app.example.com/a' });
      const model = resultModel(openResult);
      const linkRef = model.model.actions[0].ref;
      const actResult = await ctx.handleAct({ ref: linkRef, action: 'click' });
      assert.strictEqual(actResult.isError, undefined);
      assert.deepStrictEqual(page.clicks, [777]);

      const rows = harness.store.listBrowserAudit(workspaceId);
      const act = rows.find(
        (row) => row.category === 'tool' && row.action === 'mcp__comate-browser__act',
      );
      assert.ok(act);
      assert.strictEqual(act!.potentialSubmit, true, 'click followed by navigation is flagged');
      assert.strictEqual(act!.origin, 'https://app.example.com');
    } finally {
      rmSync(harness.storageDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Route-level: GET strip, PUT merge, revoke endpoint, workspace cascade
// ---------------------------------------------------------------------------

describe('workspaces routes — browserSiteAuth discipline', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    singletonStore.resetData();
    const app = express();
    app.use(express.json());
    app.use('/api/workspaces', workspacesRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    singletonStore.resetData();
  });

  async function seedWorkspaceWithSite(): Promise<string> {
    const ws = await singletonStore.create({ name: 'R', folderPath: '/tmp/r' });
    singletonStore.setWorkspaceSiteAuthEntry(ws.id, 'example.com', entryWithSecret());
    return ws.id;
  }

  it('GET list and GET by id strip the values (keys + metadata only)', async () => {
    const id = await seedWorkspaceWithSite();

    const listRes = await fetch(`${baseUrl}/api/workspaces`);
    const listBody = (await listRes.json()) as { workspaces: Array<{ settings: Record<string, unknown> }> };
    const listed = listBody.workspaces.find((w) => (w as { id: string }).id === id)!;
    const listAuth = listed.settings.browserSiteAuth as Record<string, Record<string, unknown>>;
    assert.deepStrictEqual(Object.keys(listAuth), ['example.com']);
    assert.strictEqual('sessionContext' in listAuth['example.com'], false);
    assert.ok(!JSON.stringify(listBody).includes(SECRET_COOKIE_VALUE));

    const getRes = await fetch(`${baseUrl}/api/workspaces/${id}`);
    const getBody = (await getRes.json()) as { workspace: { settings: Record<string, unknown> } };
    const getAuth = getBody.workspace.settings.browserSiteAuth as Record<string, Record<string, unknown>>;
    assert.strictEqual('sessionContext' in getAuth['example.com'], false);
    assert.ok(getAuth['example.com'].updatedAt, 'metadata survives');
    assert.ok(!JSON.stringify(getBody).includes(SECRET_COOKIE_VALUE));
  });

  it('PUT whole-bag settings preserves the stored values (field-level merge) and strips the response', async () => {
    const id = await seedWorkspaceWithSite();
    const putRes = await fetch(`${baseUrl}/api/workspaces/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { promptHistoryRetentionDays: 7 } }),
    });
    assert.strictEqual(putRes.status, 200);
    const body = (await putRes.json()) as { workspace: { settings: Record<string, unknown> } };
    const auth = body.workspace.settings.browserSiteAuth as Record<string, Record<string, unknown>>;
    assert.strictEqual('sessionContext' in auth['example.com'], false, 'response stripped');
    // Stored value survived the whole-bag replace.
    const stored = readSiteAuthEntry((await singletonStore.get(id))!.settings, 'example.com');
    assert.strictEqual(stored?.sessionContext.cookies[0].value, SECRET_COOKIE_VALUE);
  });

  it('PUT with a client-supplied browserSiteAuth never plants values (key-set merge)', async () => {
    const id = await seedWorkspaceWithSite();
    const putRes = await fetch(`${baseUrl}/api/workspaces/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        settings: {
          browserSiteAuth: {
            'planted.evil': {
              sessionContext: { cookies: [{ name: 'x', value: 'PLANTED-VALUE' }] },
              createdAt: 'x',
              updatedAt: 'x',
            },
          },
        },
      }),
    });
    assert.strictEqual(putRes.status, 200);
    const ws = await singletonStore.get(id);
    assert.strictEqual(readSiteAuthEntry(ws!.settings, 'planted.evil'), undefined);
    // The crafted keyset also pruned the legit entry — documented semantics
    // of revoke-by-save; the planting attempt is what must never succeed.
    assert.ok(!JSON.stringify(ws!.settings).includes('PLANTED-VALUE'));
  });

  it('DELETE /:id/browser-site-auth/:siteKey revokes (204) and 404s on unknown keys', async () => {
    const id = await seedWorkspaceWithSite();
    const res = await fetch(`${baseUrl}/api/workspaces/${id}/browser-site-auth/example.com`, {
      method: 'DELETE',
    });
    assert.strictEqual(res.status, 204);
    assert.strictEqual(
      readSiteAuthEntry((await singletonStore.get(id))!.settings, 'example.com'),
      undefined,
    );
    const auditRows = singletonStore.listBrowserAudit(id);
    assert.ok(
      auditRows.some((row) => row.category === 'site_auth' && row.action === 'revoke'),
      'revoke audit row',
    );
    const missing = await fetch(`${baseUrl}/api/workspaces/${id}/browser-site-auth/example.com`, {
      method: 'DELETE',
    });
    assert.strictEqual(missing.status, 404);
  });

  it('DELETE /:id cascades: workspace row (site-auth with it) and audit rows', async () => {
    const id = await seedWorkspaceWithSite();
    new BrowserAuditService(singletonStore).logSiteAuth({
      workspaceId: id,
      siteKey: 'example.com',
      action: 'remember',
      outcome: 'ok',
    });
    const res = await fetch(`${baseUrl}/api/workspaces/${id}`, { method: 'DELETE' });
    assert.strictEqual(res.status, 204);
    assert.strictEqual(await singletonStore.get(id), null);
    assert.strictEqual(singletonStore.listBrowserAudit(id).length, 0);
  });
});

// ---------------------------------------------------------------------------
// Session delete → browser teardown wiring (KTD-1 path 1 + U4 gate state)
// ---------------------------------------------------------------------------

describe('chat session delete — browser teardown wiring', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    singletonStore.resetData();
    const app = express();
    app.use(express.json());
    app.use('/api/workspaces/:id', chatRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearBrowserGateSession('teardown-session');
    singletonStore.resetData();
  });

  it('deleting a chat session clears its U4 gate state (and tears down any browser)', async () => {
    const ws = await singletonStore.create({ name: 'T', folderPath: '/tmp/t' });
    const session = await chatService.createSession({ workspaceId: ws.id, name: 's' });
    // Seed the navigation ledger for this session (U4 gate state).
    commitSessionNavigation(session.id, 'example.com');
    assert.ok(getVisitedDomains(session.id).includes('example.com'));

    const res = await fetch(`${baseUrl}/api/workspaces/${ws.id}/sessions/${session.id}`, {
      method: 'DELETE',
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(getVisitedDomains(session.id), [], 'gate state cleared on delete');
  });
});

// ---------------------------------------------------------------------------
// Entry criterion pin — the vendored artifact matches the documented R15 scope
// ---------------------------------------------------------------------------

describe('entry criterion: vendored Steel context endpoint (pinned SHA)', () => {
  const manifestPath = path.join(STEEL_DIR, 'steel-manifest.json');
  const bundlePresent = existsSync(manifestPath);

  it(
    'vendored build is the pinned SHA with classic-level stubbed (storage extraction is CDP-only)',
    { skip: !bundlePresent },
    () => {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
        upstreamCommit: string;
        stubbed: string[];
      };
      assert.strictEqual(
        manifest.upstreamCommit,
        'd6b15d5ba658eb748ebb376d9ea837043cad814b',
      );
      assert.ok(manifest.stubbed.includes('classic-level'));

      // The stub throws on construction, so the LevelDB disk readers
      // (ChromeContextService.getSessionData) degrade to {} — cookies come
      // from CDP (complete), storage from open pages only.
      const stub = readFileSync(
        path.join(STEEL_DIR, 'node_modules', 'classic-level', 'index.js'),
        'utf-8',
      );
      assert.ok(stub.includes('throw new Error'));

      const cdpService = readFileSync(
        path.join(STEEL_DIR, 'build', 'services', 'cdp', 'cdp.service.js'),
        'utf-8',
      );
      // getBrowserState merges: CDP cookies + LevelDB session data (stubbed)
      // + CDP per-page storage extraction. This pins the documented R15 scope:
      // cookie-primary auth + web storage for the open pages.
      assert.ok(cdpService.includes('this.getCookies()'));
      assert.ok(cdpService.includes('chromeSessionService.getSessionData(userDataDir)'));
      assert.ok(cdpService.includes('getExistingPageSessionData()'));
      assert.ok(cdpService.includes('injectSessionContext'));
    },
  );
});
