import '../../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Options, SDKSessionInfo, SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { sharedContractFixtures } from '@comate/api-contracts';
import { BrowserService } from '../browser-service.js';
import { BrowserControlService } from '../browser-control.js';
import type { BrowserCdpSession } from '../browser-cdp.js';
import {
  startFakeBrowserShell,
  type FakeBrowserShell,
} from '../../test-utils/fake-browser-shell.js';
import type { BrowserNetworkCaptureTransport, CdpEventEnvelope } from '../browser-network-capture.js';
import {
  BROWSER_MCP_SERVER_KEY,
  BROWSER_STREAM_CLOSE_TIMEOUT_MS,
  BROWSER_TOOL_PREFIX,
  buildBrowserToolDefinitions,
  disposeBrowserToolContext,
  type BrowserApprovalRequest,
  type BrowserApprovalDecision,
  type BrowserMcpDeps,
  type BrowserToolDefinition,
} from '../browser-mcp.js';
import type { RawAxNode, RawPageExtraction, SubmitSnapshot } from '../browser-page-model.js';
import { CdpError } from '../browser-cdp.js';
import { ChatService } from '../chat-service.js';
import { SessionRuntime } from '../session-runtime.js';
import { SdkClient } from '../sdk-client.js';
import { store as workspaceStore } from '../../storage/sqlite-store.js';
import { SESSION_TOKEN_ENV } from '../session-capability-service.js';
import type { BrowserAuditToolInput } from '../browser-audit.js';

/**
 * browser-mcp tests — the first-class tool surface (KTD-3), the handler-level
 * submit gate with TOCTOU re-verification (KTD-4 ②), control-state gating,
 * and the chat-service injection point (GUI-only + per-session stream timeout).
 */

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakePageOptions {
  extraction: RawPageExtraction;
  postSubmitExtraction?: RawPageExtraction;
  axNodes?: RawAxNode[];
  probe?: { docId: string; domEpoch: number } | null;
  submitSnapshots?: Array<SubmitSnapshot | null>;
  submitDispatchError?: Error;
  extractResults?: Record<string, unknown>;
  inspectResult?: Record<string, unknown>;
  inspectError?: Error;
  currentUrl?: string;
  screenshotError?: Error;
  networkTransport?: BrowserNetworkCaptureTransport;
}

class FakeNetworkTransport implements BrowserNetworkCaptureTransport {
  readonly primarySessionId = 'page';
  private readonly eventListeners = new Set<(event: CdpEventEnvelope) => void>();
  private readonly closeListeners = new Set<() => void>();
  readonly bodies = new Map<string, { body: string; base64Encoded: boolean }>();
  get listenerCount(): number { return this.eventListeners.size + this.closeListeners.size; }
  async start(): Promise<void> {}
  onEvent(listener: (event: CdpEventEnvelope) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
  async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (method === 'Network.getResponseBody') {
      return (this.bodies.get(String(params.requestId)) ?? { body: '', base64Encoded: false }) as T;
    }
    return {} as T;
  }
  emit(method: string, params: Record<string, unknown>, sessionId = 'page'): void {
    for (const listener of [...this.eventListeners]) listener({ method, params, sessionId });
  }
  close(): void {
    for (const listener of [...this.closeListeners]) listener();
  }
}

class FakePage implements BrowserCdpSession {
  closed = false;
  navigated: string[] = [];
  screenshots = 0;
  clickedBackendNodes: number[] = [];
  actScripts: string[] = [];
  dispatchScripts: string[] = [];
  private readonly options: FakePageOptions;
  private submitSnapshots: Array<SubmitSnapshot | null>;
  private submitDispatched = false;
  private closeListeners = new Set<() => void>();

  constructor(options: FakePageOptions) {
    this.options = options;
    this.submitSnapshots = [...(options.submitSnapshots ?? [])];
  }

  get probe(): { docId: string; domEpoch: number } | null {
    return this.options.probe === undefined
      ? { docId: this.options.extraction.docId, domEpoch: this.options.extraction.domEpoch }
      : this.options.probe;
  }

  async evaluate<T>(expression: string): Promise<T> {
    if (expression.includes('new MutationObserver')) {
      return (
        this.submitDispatched && this.options.postSubmitExtraction
          ? this.options.postSubmitExtraction
          : this.options.extraction
      ) as T; // distiller extractor
    }
    if (expression.includes('window.__comateProbe')) {
      return this.probe as T; // READ_PROBE_SCRIPT
    }
    if (expression.includes('window.location.href')) {
      return (this.options.currentUrl ?? this.options.extraction.url) as T;
    }
    if (expression.includes('__comateInspectElement')) {
      return (this.options.inspectResult ?? null) as T;
    }
    if (expression.includes('document.forms[') && expression.includes('hash')) {
      const next =
        this.submitSnapshots.length > 1 ? this.submitSnapshots.shift() : this.submitSnapshots[0];
      return (next ?? null) as T; // submit TOCTOU snapshot
    }
    if (expression.includes('requestSubmit')) {
      this.dispatchScripts.push(expression);
      this.submitDispatched = true;
      if (this.options.submitDispatchError) throw this.options.submitDispatchError;
      return { ok: true } as T;
    }
    if (expression.includes('XPathResult')) {
      this.actScripts.push(expression);
      this.submitDispatched = true;
      if (this.options.submitDispatchError) throw this.options.submitDispatchError;
      return { ok: true } as T;
    }
    if (expression.includes('var specs = ')) {
      return (this.options.extractResults ?? {}) as T;
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
    this.clickedBackendNodes.push(backendNodeId);
  }
  async inspectBackendNode(): Promise<import('../browser-page-model.js').InspectedElement | null> {
    if (this.options.inspectError) throw this.options.inspectError;
    return (this.options.inspectResult ?? null) as import('../browser-page-model.js').InspectedElement | null;
  }
  async captureScreenshot(): Promise<string> {
    this.screenshots += 1;
    if (this.options.screenshotError) throw this.options.screenshotError;
    return 'aGVsbG8';
  }
  cookieWrites: Array<Array<Record<string, unknown>>> = [];
  initScripts: string[] = [];
  async setCookies(cookies: Array<Record<string, unknown>>): Promise<void> {
    this.cookieWrites.push(cookies);
  }
  async evaluateOnNewDocument(expression: string): Promise<void> {
    this.initScripts.push(expression);
  }
  createNetworkCaptureTransport(): BrowserNetworkCaptureTransport {
    if (!this.options.networkTransport) throw new Error('network capture unavailable');
    return this.options.networkTransport;
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
    url: 'https://shop.example/checkout',
    title: 'Checkout',
    docId: 'doc-1',
    domEpoch: 0,
    forms: [
      {
        formIndex: 0,
        name: 'payment',
        action: 'https://shop.example/pay',
        method: 'post',
        fields: [
          {
            fieldIndex: 0,
            name: 'email',
            label: 'Email',
            tag: 'input',
            type: 'email',
            required: true,
            autocomplete: 'email',
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
            name: 'cardNumber',
            label: 'Card number',
            tag: 'input',
            type: 'text',
            required: true,
            autocomplete: 'cc-number',
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
            label: 'Pay now',
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
    contentText: 'Checkout page content.',
    contentTruncated: false,
    alerts: [],
    stats: { linkCount: 3, buttonCount: 1, hasPasswordField: false },
    ...overrides,
  };
}

function makeSubmitSnapshot(overrides: Partial<SubmitSnapshot> = {}): SubmitSnapshot {
  return {
    action: 'https://shop.example/pay',
    method: 'post',
    fields: [
      { name: 'email', type: 'email', sensitive: false, value: 'a@b.c' },
      { name: 'cardNumber', type: 'text', sensitive: true, value: 'h:deadbeef:16' },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  ctx: {
    browserService: BrowserService;
    page: FakePage;
    approvals: BrowserApprovalRequest[];
    approvalDecisions: BrowserApprovalDecision[];
    auditActions: BrowserAuditToolInput[];
  };
  tools: Map<string, BrowserToolDefinition>;
  call: (name: string, args: Record<string, unknown>, extra?: unknown) => Promise<CallToolResult>;
  storageDir: string;
  shell: FakeBrowserShell;
}

/** Fake-shell cleanup for every harness a test built (afterEach drain). */
const shellCleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of shellCleanups.splice(0)) {
    await close();
  }
});

async function makeHarness(options: {
  page: FakePage;
  approvalDecisions?: BrowserApprovalDecision[];
  withApprovalRequester?: boolean;
  maxSessions?: number;
  /** Resolve to a misconfigured target (no shell, no external endpoint). */
  misconfigured?: boolean;
  currentPageUrl?: (baseUrl: string) => Promise<string | null>;
  exportContext?: (baseUrl: string) => Promise<unknown>;
}): Promise<Harness> {
  const storageDir = mkdtempSync(path.join(tmpdir(), 'comate-browser-mcp-'));
  const shell = await startFakeBrowserShell();
  shellCleanups.push(shell.close);
  const browserService = new BrowserService({
    storageDir,
    maxSessions: options.maxSessions ?? 4,
    resolveTarget: options.misconfigured
      ? () => ({
          kind: 'misconfigured',
          reason:
            'The embedded browser requires the desktop app. Start it, or point ' +
            'COMATE_BROWSER_CDP_TARGET at an external Chromium debug endpoint.',
        })
      : shell.resolveTarget,
    createControlClient: shell.createControlClient,
    cdpRetry: { budgetMs: 400, intervalMs: 40 },
    listKnownSessionIds: () => [],
    now: () => Date.now(),
    // Fast site-auth fakes for focused MCP tests. Close never implicitly
    // remembers state; explicit Remember behavior has service-level tests.
    currentPageUrl: options.currentPageUrl ?? (async () => null),
    exportContext: options.exportContext ?? (async () => ({})),
    // No-op timer: this suite does not test idle behavior, so the spawn-armed
    // idle timer never needs to fire (and must not leak real setTimeouts that
    // flake cross-test on --test-force-exit).
    timer: { set: () => 0, clear: () => undefined },
  });

  const approvals: BrowserApprovalRequest[] = [];
  const auditActions: BrowserAuditToolInput[] = [];
  const decisions = [...(options.approvalDecisions ?? [])];
  const deps: BrowserMcpDeps = {
    sessionId: 'chat-session-1',
    workspaceId: 'workspace-1',
    browserService,
    handoffControl: new BrowserControlService({ browserService }),
    connectPage: async () => options.page,
    pageRegistry: new Map(),
    settleMs: 0,
    audit: { logToolAction: (input) => { auditActions.push(input); return null; } },
  };
  if (options.withApprovalRequester !== false) {
    deps.approvalRequester = async (_sessionId, request) => {
      approvals.push(request);
      return decisions.length > 0 ? decisions.shift()! : { behavior: 'allow' };
    };
  }

  const definitions = buildBrowserToolDefinitions(deps);
  const tools = new Map(definitions.map((definition) => [definition.name, definition]));
  return {
    ctx: { browserService, page: options.page, approvals, approvalDecisions: decisions, auditActions },
    tools,
    call: async (name, args, extra) => {
      const definition = tools.get(name);
      assert.ok(definition, `tool ${name} must exist`);
      return definition.handler(args, extra ?? {});
    },
    storageDir,
    shell,
  };
}

function resultPayload(result: CallToolResult): Record<string, unknown> {
  const text = result.content.find((block) => block.type === 'text');
  assert.ok(text && text.type === 'text', 'result must have a text block');
  return JSON.parse(text.text) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tool surface
// ---------------------------------------------------------------------------

describe('browser-mcp tool surface (KTD-3)', () => {
  it('registers the first-class tools with the comate-browser server key', async () => {
    const harness = await makeHarness({ page: new FakePage({ extraction: makeExtraction() }) });
    assert.deepStrictEqual(
      [...harness.tools.keys()].sort(),
      ['act', 'authenticatedRequest', 'close', 'extract', 'findElements', 'getElementDetails', 'getPageState', 'open', 'requestHandoff', 'startNetworkCapture', 'stopNetworkCapture', 'submit', 'takeScreenshot'],
    );
    rmSync(harness.storageDir, { recursive: true, force: true });
  });

  it('annotates page observation tools read-only and marks submit destructive + requiresUserInteraction', async () => {
    const harness = await makeHarness({ page: new FakePage({ extraction: makeExtraction() }) });
    assert.strictEqual(harness.tools.get('takeScreenshot')?.annotations?.readOnlyHint, true);
    assert.strictEqual(harness.tools.get('getPageState')?.annotations?.readOnlyHint, true);
    assert.strictEqual(harness.tools.get('extract')?.annotations?.readOnlyHint, true);
    assert.strictEqual(harness.tools.get('findElements')?.annotations?.readOnlyHint, true);
    assert.strictEqual(harness.tools.get('getElementDetails')?.annotations?.readOnlyHint, true);
    assert.strictEqual(harness.tools.get('startNetworkCapture')?.annotations?.readOnlyHint, true);
    assert.strictEqual(harness.tools.get('stopNetworkCapture')?.annotations?.readOnlyHint, true);
    assert.strictEqual(harness.tools.get('submit')?.annotations?.destructiveHint, true);
    // Auxiliary meta only — the security property lives in the handler gate.
    assert.strictEqual(
      harness.tools.get('submit')?._meta?.['anthropic/requiresUserInteraction'],
      true,
    );
    rmSync(harness.storageDir, { recursive: true, force: true });
  });

  it('buildBrowserToolDefinitions yields the full tool surface without the claude SDK', () => {
    const defs = buildBrowserToolDefinitions({ sessionId: 's', workspaceId: 'w' });
    assert.deepEqual(
      defs.map((d) => d.name),
      ['open', 'getPageState', 'findElements', 'getElementDetails', 'act', 'takeScreenshot', 'startNetworkCapture', 'stopNetworkCapture', 'authenticatedRequest', 'submit', 'extract', 'requestHandoff', 'close'],
    );
    assert.match(defs.find((definition) => definition.name === 'getPageState')?.description ?? '', /default observation/i);
    assert.match(defs.find((definition) => definition.name === 'takeScreenshot')?.description ?? '', /only.*visual/i);
    assert.strictEqual(BROWSER_TOOL_PREFIX, 'mcp__comate-browser__');
    const authenticated = defs.find((definition) => definition.name === 'authenticatedRequest');
    assert.ok(authenticated?.inputSchema && 'safeParse' in authenticated.inputSchema);
    const schema = authenticated.inputSchema as { safeParse(value: unknown): { success: boolean } };
    assert.equal(schema.safeParse(sharedContractFixtures.brokerRequest).success, true);
    assert.equal(schema.safeParse({ ...sharedContractFixtures.brokerRequest, unexpected: true }).success, false);
  });
});

// ---------------------------------------------------------------------------
// page observation
// ---------------------------------------------------------------------------

describe('browser-mcp page observation', () => {
  let harness: Harness;
  afterEach(() => {
    rmSync(harness.storageDir, { recursive: true, force: true });
  });

  it('open navigates and returns the first distilled model with refs', async () => {
    harness = await makeHarness({ page: new FakePage({ extraction: makeExtraction() }) });
    const result = await harness.call('open', { url: 'https://shop.example/checkout' });
    assert.strictEqual(result.isError, undefined);
    const payload = resultPayload(result);
    assert.strictEqual(payload.ok, true);
    const model = payload.model as {
      url: string;
      forms: Array<{ ref: string; fields: Array<{ ref: string; sensitive: boolean }> }>;
    };
    assert.strictEqual(model.url, 'https://shop.example/checkout');
    assert.deepStrictEqual(harness.ctx.page.navigated, ['https://shop.example/checkout']);
    assert.ok(model.forms[0].ref, 'form ref minted');
    assert.ok(model.forms[0].fields[0].ref, 'field ref minted');
    assert.strictEqual(model.forms[0].fields[1].sensitive, true);
  });

  it('open rejects non-http(s) and malformed URLs', async () => {
    harness = await makeHarness({ page: new FakePage({ extraction: makeExtraction() }) });
    const jsResult = await harness.call('open', { url: 'javascript:alert(1)' });
    assert.strictEqual(jsResult.isError, true);
    assert.strictEqual((resultPayload(jsResult).error as { code: string }).code, 'browser_url_scheme');

    const badResult = await harness.call('open', { url: 'not a url' });
    assert.strictEqual(badResult.isError, true);
    assert.strictEqual((resultPayload(badResult).error as { code: string }).code, 'browser_url_invalid');
    assert.deepStrictEqual(harness.ctx.page.navigated, [], 'no navigation on rejected URLs');
  });

  it('maps browser unavailability to a loud structured error', async () => {
    harness = await makeHarness({
      page: new FakePage({ extraction: makeExtraction() }),
      misconfigured: true,
    });
    const result = await harness.call('open', { url: 'https://shop.example/' });
    assert.strictEqual(result.isError, true);
    const error = resultPayload(result).error as { code: string; stage: string; resolution: string };
    assert.strictEqual(error.code, 'browser_start_failed');
    assert.strictEqual(error.stage, 'session_start');
    assert.match(error.resolution, /health\/browser|desktop app|COMATE_BROWSER_CDP_TARGET/);
  });

  it('takeScreenshot returns an image block for optional visual reasoning', async () => {
    harness = await makeHarness({
      page: new FakePage({
        extraction: makeExtraction(),
        currentUrl: 'https://shop.example/checkout?token=secret',
      }),
    });
    await harness.call('open', { url: 'https://shop.example/checkout' });
    const result = await harness.call('takeScreenshot', {});
    assert.strictEqual(result.isError, undefined);
    const image = result.content.find((block) => block.type === 'image');
    assert.ok(image && image.type === 'image', 'image block present');
    assert.strictEqual(image.mimeType, 'image/jpeg');
    assert.ok(image.data.length > 0, 'bare base64 payload');
    assert.strictEqual(harness.ctx.page.screenshots, 1);
    assert.strictEqual(harness.ctx.auditActions.at(-1)?.url, 'https://shop.example/checkout?token=secret');
  });

  it('takeScreenshot maps capture failures to a structured capture error', async () => {
    harness = await makeHarness({
      page: new FakePage({
        extraction: makeExtraction(),
        screenshotError: new Error('capture unavailable'),
      }),
    });
    await harness.call('open', { url: 'https://shop.example/checkout' });

    const result = await harness.call('takeScreenshot', {});
    const error = resultPayload(result).error as { code: string; stage: string; message: string };
    assert.strictEqual(result.isError, true);
    assert.strictEqual(error.code, 'browser_cdp_error');
    assert.strictEqual(error.stage, 'capture');
    assert.match(error.message, /capture unavailable/);
  });

  it('takeScreenshot preserves refs from the current text page state', async () => {
    const page = new FakePage({
      extraction: makeExtraction(),
      axNodes: [
        { nodeId: '1', role: { value: 'button' }, name: { value: 'Continue' }, backendDOMNodeId: 77 },
      ],
      inspectResult: {
        tag: 'button',
        attributes: {},
        descendants: [],
        descendantsTruncated: false,
        actions: ['click'],
      },
    });
    harness = await makeHarness({ page });
    const pageState = resultPayload(await harness.call('getPageState', {})).state as {
      elements: Array<{ ref: string; kind: string }>;
    };
    const action = pageState.elements.find((element) => element.kind === 'action');
    assert.ok(action);

    await harness.call('takeScreenshot', {});
    const acted = await harness.call('act', { ref: action.ref, action: 'click' });

    assert.strictEqual(acted.isError, undefined, JSON.stringify(resultPayload(acted)));
    assert.deepStrictEqual(page.clickedBackendNodes, [77]);
  });

  it('getPageState returns a bounded text-only semantic inventory with fresh refs', async () => {
    harness = await makeHarness({
      page: new FakePage({
        extraction: makeExtraction(),
        axNodes: [
          { nodeId: '1', role: { value: 'button' }, name: { value: 'Apply coupon' }, backendDOMNodeId: 77 },
          { nodeId: '2', role: { value: 'link' }, name: { value: 'Help' }, backendDOMNodeId: 78 },
        ],
      }),
    });
    const result = await harness.call('getPageState', { limit: 2, includeContent: false });
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.content.some((block) => block.type === 'image'), false);
    const state = resultPayload(result).state as {
      pageRevision: string;
      elements: Array<{ ref: string; kind: string }>;
      totalElements: number;
      truncated: boolean;
      nextOffset?: number;
      content?: unknown;
    };
    assert.match(state.pageRevision, /^[a-f0-9]{12}$/);
    assert.strictEqual(state.elements.length, 2);
    assert.ok(state.totalElements > state.elements.length);
    assert.strictEqual(state.truncated, true);
    assert.strictEqual(state.nextOffset, 2);
    assert.strictEqual(state.content, undefined);
    assert.match(state.elements[0].ref, /^e\d+-[a-f0-9]{16}$/);
  });

  it('getPageState annotates returned actions with viewport and occlusion state', async () => {
    harness = await makeHarness({
      page: new FakePage({
        extraction: makeExtraction(),
        axNodes: [
          { nodeId: '1', role: { value: 'button' }, name: { value: 'Apply coupon' }, backendDOMNodeId: 77 },
        ],
        inspectResult: {
          tag: 'button',
          attributes: {},
          descendants: [],
          descendantsTruncated: false,
          actions: ['click'],
          visible: true,
          inViewport: true,
          occluded: false,
        },
      }),
    });
    const state = resultPayload(await harness.call('getPageState', { offset: 4, limit: 1 })).state as {
      elements: Array<{ kind: string; visible?: boolean; inViewport?: boolean; occluded?: boolean }>;
    };
    assert.strictEqual(state.elements.length, 1);
    assert.strictEqual(state.elements[0].kind, 'action');
    assert.strictEqual(state.elements[0].visible, true);
    assert.strictEqual(state.elements[0].inViewport, true);
    assert.strictEqual(state.elements[0].occluded, false);
  });

  it('keeps page-state pagination refs usable', async () => {
    const page = new FakePage({
      extraction: makeExtraction(),
      axNodes: Array.from({ length: 3 }, (_, index) => ({
        nodeId: String(index),
        role: { value: 'button' },
        name: { value: `Action ${index}` },
        backendDOMNodeId: index + 1,
      })),
      inspectResult: {
        tag: 'button',
        attributes: {},
        descendants: [],
        descendantsTruncated: false,
        actions: ['click'],
      },
    });
    harness = await makeHarness({ page });
    const first = resultPayload(await harness.call('getPageState', { limit: 6 })).state as {
      elements: Array<{ ref: string; kind: string; visible?: boolean }>;
    };
    const firstAction = first.elements.find((element) => element.kind === 'action');
    assert.ok(firstAction);
    await harness.call('getPageState', { offset: 6, limit: 2 });
    const acted = resultPayload(await harness.call('act', { ref: firstAction.ref, action: 'click' }));
    assert.strictEqual(acted.ok, true);
    assert.deepStrictEqual(page.clickedBackendNodes, [1]);
  });

  it('tolerates page-state geometry probe failures', async () => {
    harness = await makeHarness({
      page: new FakePage({
        extraction: makeExtraction(),
        axNodes: [{
          nodeId: 'action',
          role: { value: 'button' },
          name: { value: 'Action' },
          backendDOMNodeId: 1,
        }],
        inspectError: new Error('geometry unavailable'),
      }),
    });
    const result = resultPayload(await harness.call('getPageState', { offset: 4, limit: 1 })) as {
      ok: boolean;
      state: { elements: Array<{ visible?: boolean }> };
    };
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.state.elements[0].visible, undefined);
  });

  it('findElements refreshes the model and filters refs by text and role', async () => {
    harness = await makeHarness({
      page: new FakePage({
        extraction: makeExtraction(),
        axNodes: [
          { nodeId: '1', role: { value: 'button' }, name: { value: 'Open creator assistant' }, backendDOMNodeId: 77 },
          { nodeId: '2', role: { value: 'link' }, name: { value: 'Creator help' }, backendDOMNodeId: 78 },
        ],
      }),
    });
    const result = await harness.call('findElements', {
      text: 'creator assistant',
      role: 'button',
      exact: false,
      limit: 5,
    });
    assert.strictEqual(result.isError, undefined);
    const payload = resultPayload(result) as {
      matches: Array<{ ref: string; kind: string; role: string; name: string }>;
      total: number;
    };
    assert.strictEqual(payload.total, 1);
    assert.deepStrictEqual(
      payload.matches.map(({ kind, role, name }) => ({ kind, role, name })),
      [{ kind: 'action', role: 'button', name: 'Open creator assistant' }],
    );
    assert.match(payload.matches[0].ref, /^e\d+-[a-f0-9]{16}$/);

    const fieldResult = await harness.call('findElements', {
      text: 'Pay now',
      role: 'button',
      exact: true,
    });
    const fieldPayload = resultPayload(fieldResult) as {
      matches: Array<{ kind: string; submitSemantics?: boolean }>;
    };
    assert.strictEqual(fieldPayload.matches.length, 1);
    assert.strictEqual(fieldPayload.matches[0].kind, 'field');
    assert.strictEqual(fieldPayload.matches[0].submitSemantics, true);

    const regexResult = await harness.call('findElements', {
      regex: '/^Creator help$/i',
      role: 'link',
    });
    const regexPayload = resultPayload(regexResult) as { matches: Array<{ name: string }> };
    assert.deepStrictEqual(regexPayload.matches.map(({ name }) => name), ['Creator help']);
  });

  it('findElements rejects ambiguous or empty queries', async () => {
    harness = await makeHarness({ page: new FakePage({ extraction: makeExtraction() }) });
    for (const args of [{}, { text: 'pay', regex: '/pay/i' }, { regex: '[' }, { regex: '/^(a+)+$/' }]) {
      const result = await harness.call('findElements', args);
      assert.strictEqual(result.isError, true);
      assert.strictEqual((resultPayload(result).error as { code: string }).code, 'browser_find_invalid_query');
    }
  });

  it('findElements searches beyond the page-state response budget', async () => {
    const axNodes: RawAxNode[] = Array.from({ length: 1_220 }, (_, index) => ({
      nodeId: String(index),
      role: { value: 'button' },
      name: { value: index === 1_200 ? 'Deep target' : `Action ${index}` },
      backendDOMNodeId: index + 1,
    }));
    harness = await makeHarness({ page: new FakePage({ extraction: makeExtraction(), axNodes }) });

    const state = resultPayload(await harness.call('getPageState', { limit: 100 })).state as {
      elements: unknown[];
      truncated: boolean;
    };
    assert.strictEqual(state.elements.length, 100);
    assert.strictEqual(state.truncated, true);

    const found = resultPayload(await harness.call('findElements', { text: 'Deep target', exact: true })) as {
      matches: Array<{ name: string }>;
    };
    assert.deepStrictEqual(found.matches.map(({ name }) => name), ['Deep target']);
  });
});

// ---------------------------------------------------------------------------
// act
// ---------------------------------------------------------------------------

describe('browser-mcp act', () => {
  let harness: Harness;
  afterEach(() => {
    rmSync(harness.storageDir, { recursive: true, force: true });
  });

  async function openAndGetRefs(h: Harness): Promise<{
    formRef: string;
    emailRef: string;
    cardRef: string;
    payRef: string;
  }> {
    const result = await h.call('open', { url: 'https://shop.example/checkout' });
    const model = resultPayload(result).model as {
      forms: Array<{ ref: string; fields: Array<{ ref: string }> }>;
    };
    return {
      formRef: model.forms[0].ref,
      emailRef: model.forms[0].fields[0].ref,
      cardRef: model.forms[0].fields[1].ref,
      payRef: model.forms[0].fields[2].ref,
    };
  }

  it('fills a field ref and returns the delta + fresh model', async () => {
    harness = await makeHarness({ page: new FakePage({ extraction: makeExtraction() }) });
    const { emailRef } = await openAndGetRefs(harness);
    const result = await harness.call('act', { ref: emailRef, action: 'fill', value: 'me@example.com' });
    assert.strictEqual(result.isError, undefined);
    const payload = resultPayload(result);
    assert.strictEqual(payload.ok, true);
    assert.ok(payload.delta, 'delta present');
    assert.ok(payload.model, 'fresh model present');
    assert.strictEqual(harness.ctx.page.actScripts.length, 1);
    assert.ok(harness.ctx.page.actScripts[0].includes('/html[1]/body[1]/form[1]/input[1]'));
    assert.ok(harness.ctx.page.actScripts[0].includes('me@example.com'));
  });

  it('clicks an action ref through its backend node', async () => {
    const page = new FakePage({
      extraction: makeExtraction(),
      axNodes: [
        { nodeId: '1', role: { value: 'button' }, name: { value: 'Apply coupon' }, backendDOMNodeId: 77 },
      ],
      inspectResult: { tag: 'button', attributes: {}, descendants: [], descendantsTruncated: false, actions: ['click'] },
    });
    harness = await makeHarness({ page });
    const result = await harness.call('open', { url: 'https://shop.example/checkout' });
    const model = resultPayload(result).model as { actions: Array<{ ref: string }> };
    const clickResult = await harness.call('act', { ref: model.actions[0].ref, action: 'click' });
    assert.strictEqual(clickResult.isError, undefined);
    assert.deepStrictEqual(page.clickedBackendNodes, [77]);
  });

  it('rejects unknown and stale refs with structured errors', async () => {
    const page = new FakePage({
      extraction: makeExtraction(),
      probe: { docId: 'doc-1', domEpoch: 9 }, // DOM moved on since the distill
    });
    harness = await makeHarness({ page });
    const { emailRef } = await openAndGetRefs(harness);

    const unknown = await harness.call('act', { ref: 'e999-zz', action: 'click' });
    assert.strictEqual(unknown.isError, true);
    assert.strictEqual((resultPayload(unknown).error as { code: string }).code, 'browser_ref_unknown');

    const stale = await harness.call('act', { ref: emailRef, action: 'fill', value: 'x' });
    assert.strictEqual(stale.isError, true);
    const error = resultPayload(stale).error as { code: string; resolution: string };
    assert.strictEqual(error.code, 'browser_ref_stale');
    assert.ok(error.resolution.includes('getPageState'));
    assert.strictEqual(page.actScripts.length, 0, 'no dispatch for invalid refs');
  });

  it('routes submit-semantics clicks to the submit tool', async () => {
    harness = await makeHarness({ page: new FakePage({ extraction: makeExtraction() }) });
    const { payRef } = await openAndGetRefs(harness);
    const result = await harness.call('act', { ref: payRef, action: 'click' });
    assert.strictEqual(result.isError, true);
    const error = resultPayload(result).error as { code: string; resolution: string };
    assert.strictEqual(error.code, 'browser_use_submit_tool');
    assert.ok(error.resolution.includes('submit'));
    assert.strictEqual(harness.ctx.page.actScripts.length, 0, 'submit control never clicked via act');
  });

  it('routes AX action refs that resolve to submit controls to the submit tool', async () => {
    const page = new FakePage({
      extraction: makeExtraction(),
      axNodes: [
        { nodeId: '1', role: { value: 'button' }, name: { value: 'Pay now' }, backendDOMNodeId: 77 },
      ],
      inspectResult: { tag: 'button', attributes: {}, descendants: [], descendantsTruncated: false, actions: ['click', 'submit'] },
    });
    harness = await makeHarness({ page });
    const opened = await harness.call('open', { url: 'https://shop.example/checkout' });
    const actionRef = (resultPayload(opened).model as { actions: Array<{ ref: string }> }).actions[0].ref;
    const result = await harness.call('act', { ref: actionRef, action: 'click' });
    assert.strictEqual(result.isError, true);
    assert.strictEqual((resultPayload(result).error as { code: string }).code, 'browser_use_submit_tool');
    assert.deepStrictEqual(page.clickedBackendNodes, [], 'submit action never clicked via act');
  });

  it('blocks act while the user is in control (recoverable)', async () => {
    harness = await makeHarness({ page: new FakePage({ extraction: makeExtraction() }) });
    const { emailRef } = await openAndGetRefs(harness);
    harness.ctx.browserService.setControlState('chat-session-1', 'user_in_control', 'test takeover');
    const result = await harness.call('act', { ref: emailRef, action: 'fill', value: 'x' });
    assert.strictEqual(result.isError, true);
    const error = resultPayload(result).error as { code: string };
    assert.strictEqual(error.code, 'browser_user_in_control');
  });
});

// ---------------------------------------------------------------------------
// submit — handler-level hard gate + TOCTOU (KTD-4 ②)
// ---------------------------------------------------------------------------

describe('browser-mcp submit handler-level gate', () => {
  let harness: Harness;
  afterEach(() => {
    rmSync(harness.storageDir, { recursive: true, force: true });
  });

  async function openAndGetFormRef(h: Harness): Promise<{ formRef: string; payRef: string }> {
    const result = await h.call('open', { url: 'https://shop.example/checkout' });
    const model = resultPayload(result).model as {
      forms: Array<{ ref: string; fields: Array<{ ref: string }> }>;
    };
    return { formRef: model.forms[0].ref, payRef: model.forms[0].fields[2].ref };
  }

  it('asks for confirmation inside the handler and dispatches only after allow', async () => {
    const page = new FakePage({
      extraction: makeExtraction(),
      submitSnapshots: [makeSubmitSnapshot()],
    });
    harness = await makeHarness({ page });
    const { formRef } = await openAndGetFormRef(harness);

    // NOTE (settings short-circuit property, KTD-4 ②): this gate fires
    // regardless of approval mode and regardless of any `.claude/settings.json`
    // `permissions.allow` covering mcp__comate-browser__submit — those rules
    // only influence the SDK's canUseTool evaluation, which this handler does
    // not consult. The requester invocation below is the assertion of that
    // structural property.
    const result = await harness.call('submit', {
      ref: formRef,
      fields: { email: 'a@b.c', cardNumber: '4111111111111111' },
    });
    assert.strictEqual(result.isError, undefined);
    const payload = resultPayload(result);
    assert.strictEqual(payload.submitted, true);
    assert.strictEqual(harness.ctx.approvals.length, 1, 'exactly one approval round-trip');
    assert.strictEqual(page.dispatchScripts.length, 1, 'form dispatched');

    const approval = harness.ctx.approvals[0];
    assert.strictEqual(approval.toolName, 'mcp__comate-browser__submit');
    assert.ok(approval.title.includes('https://shop.example'));
    const cardPayload = approval.payload;
    assert.strictEqual(cardPayload.kind, 'browser_submit');
    const fields = cardPayload.fields as Array<Record<string, unknown>>;
    const card = fields.find((field) => field.name === 'cardNumber');
    assert.ok(card, 'sensitive field listed by name');
    assert.strictEqual('value' in card, false, 'sensitive value never enters the approval card');
    const email = fields.find((field) => field.name === 'email');
    assert.strictEqual(email?.value, 'a@b.c');
    // The raw password/card value appears nowhere in the serialized card.
    assert.ok(!JSON.stringify(cardPayload).includes('4111'));
    assert.ok(!JSON.stringify(cardPayload).includes('deadbeef'));
  });

  for (const testCase of [
    {
      name: 'target navigation during requestSubmit',
      message: 'Inspected target navigated or closed',
      refKind: 'form',
    },
    {
      name: 'execution-context destruction during requestSubmit',
      message: 'Execution context was destroyed',
      refKind: 'form',
    },
    {
      name: 'missing execution context during submit-control click',
      message: 'Cannot find context with specified id',
      refKind: 'control',
    },
  ] as const) {
    it(`treats ${testCase.name} as successful navigation`, async () => {
      const page = new FakePage({
        extraction: makeExtraction(),
        postSubmitExtraction: makeExtraction({
          url: 'https://shop.example/submitted',
          title: 'Submitted',
          forms: [],
        }),
        submitSnapshots: [makeSubmitSnapshot()],
        submitDispatchError: new CdpError(
          `CDP Runtime.evaluate failed: ${testCase.message}`,
          'Runtime.evaluate',
        ),
      });
      harness = await makeHarness({ page });
      const { formRef, payRef } = await openAndGetFormRef(harness);
      const ref = testCase.refKind === 'control' ? payRef : formRef;

      const result = await harness.call('submit', { ref });

      assert.strictEqual(result.isError, undefined);
      const payload = resultPayload(result);
      assert.strictEqual(payload.submitted, true);
      assert.strictEqual((payload.model as { title: string }).title, 'Submitted');
      if (testCase.refKind === 'control') {
        assert.strictEqual(page.dispatchScripts.length, 0);
        assert.ok(page.actScripts.some((script) => script.includes('"click"')));
      }
    });
  }

  for (const testCase of [
    {
      name: 'a navigation-shaped CdpError from another method',
      error: new CdpError(
        'CDP Page.navigate failed: Inspected target navigated or closed',
        'Page.navigate',
      ),
    },
    {
      name: 'a plain Error with a navigation-race message',
      error: new Error('Inspected target navigated or closed'),
    },
    {
      name: 'an unrelated Runtime.evaluate CdpError',
      error: new CdpError('CDP Runtime.evaluate failed: JavaScript exception', 'Runtime.evaluate'),
    },
  ]) {
    it(`propagates ${testCase.name}`, async () => {
      const page = new FakePage({
        extraction: makeExtraction(),
        submitSnapshots: [makeSubmitSnapshot()],
        submitDispatchError: testCase.error,
      });
      harness = await makeHarness({ page });
      const { formRef } = await openAndGetFormRef(harness);

      const result = await harness.call('submit', { ref: formRef });

      assert.strictEqual(result.isError, true);
      const error = resultPayload(result).error as { code: string; message: string };
      assert.strictEqual(error.code, 'browser_cdp_error');
      assert.ok(error.message.includes(testCase.error.message));
    });
  }

  it('returns a non-error deny result and never dispatches', async () => {
    const page = new FakePage({
      extraction: makeExtraction(),
      submitSnapshots: [makeSubmitSnapshot()],
    });
    harness = await makeHarness({
      page,
      approvalDecisions: [{ behavior: 'deny', message: 'not today' }],
    });
    const { formRef } = await openAndGetFormRef(harness);
    const result = await harness.call('submit', { ref: formRef });
    assert.strictEqual(result.isError, undefined, 'deny is a normal tool result, not an error');
    const payload = resultPayload(result);
    assert.strictEqual(payload.submitted, false);
    assert.strictEqual(payload.reason, 'user_denied');
    assert.strictEqual(page.dispatchScripts.length, 0, 'no dispatch on deny');
  });

  it('fails closed when no approval requester is wired', async () => {
    const page = new FakePage({
      extraction: makeExtraction(),
      submitSnapshots: [makeSubmitSnapshot()],
    });
    harness = await makeHarness({ page, withApprovalRequester: false });
    const { formRef } = await openAndGetFormRef(harness);
    const result = await harness.call('submit', { ref: formRef });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(
      (resultPayload(result).error as { code: string }).code,
      'browser_approval_unavailable',
    );
    assert.strictEqual(page.dispatchScripts.length, 0);
  });

  it('TOCTOU: re-confirms once when the form changes post-approval, then dispatches', async () => {
    const page = new FakePage({
      extraction: makeExtraction(),
      // Initial snapshot -> drifted re-read -> stable after re-approval.
      submitSnapshots: [
        makeSubmitSnapshot(),
        makeSubmitSnapshot({ action: 'https://shop.example/pay?rewritten=1' }),
        makeSubmitSnapshot({ action: 'https://shop.example/pay?rewritten=1' }),
      ],
    });
    harness = await makeHarness({ page });
    const { formRef } = await openAndGetFormRef(harness);
    const result = await harness.call('submit', { ref: formRef });
    assert.strictEqual(result.isError, undefined);
    const payload = resultPayload(result);
    assert.strictEqual(payload.submitted, true);
    assert.strictEqual(harness.ctx.approvals.length, 2, 'drift triggered a second confirmation');
    assert.strictEqual(harness.ctx.approvals[1].payload.reconfirmation, true);
    assert.deepStrictEqual(harness.ctx.approvals[1].payload.differences, [
      { kind: 'action_changed' },
    ]);
    assert.strictEqual(page.dispatchScripts.length, 1);
  });

  it('TOCTOU: persistent drift aborts with a loud error and no dispatch', async () => {
    const page = new FakePage({
      extraction: makeExtraction(),
      submitSnapshots: [
        makeSubmitSnapshot(),
        makeSubmitSnapshot({ action: 'https://evil.example/collect' }),
        makeSubmitSnapshot({ action: 'https://evil.example/collect-2' }),
      ],
    });
    harness = await makeHarness({ page });
    const { formRef } = await openAndGetFormRef(harness);
    const result = await harness.call('submit', { ref: formRef });
    assert.strictEqual(result.isError, true);
    const error = resultPayload(result).error as { code: string; stage: string };
    assert.strictEqual(error.code, 'browser_submit_toctou');
    assert.strictEqual(error.stage, 'toctou');
    assert.strictEqual(page.dispatchScripts.length, 0, 'aborted before dispatch');
  });

  it('submits via a submit-control ref (click dispatch)', async () => {
    const page = new FakePage({
      extraction: makeExtraction(),
      submitSnapshots: [makeSubmitSnapshot()],
    });
    harness = await makeHarness({ page });
    const { payRef } = await openAndGetFormRef(harness);
    const result = await harness.call('submit', { ref: payRef });
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(resultPayload(result).submitted, true);
    assert.strictEqual(page.dispatchScripts.length, 0, 'requestSubmit not used for control refs');
    const clickScript = page.actScripts.find((script) => script.includes('"click"'));
    assert.ok(clickScript, 'control clicked via its xpath');
    assert.ok(clickScript.includes('/html[1]/body[1]/form[1]/button[1]'));
  });

  it('blocks submit while the user is in control', async () => {
    const page = new FakePage({
      extraction: makeExtraction(),
      submitSnapshots: [makeSubmitSnapshot()],
    });
    harness = await makeHarness({ page });
    const { formRef } = await openAndGetFormRef(harness);
    harness.ctx.browserService.setControlState('chat-session-1', 'user_in_control', 'test takeover');
    const result = await harness.call('submit', { ref: formRef });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(
      (resultPayload(result).error as { code: string }).code,
      'browser_user_in_control',
    );
    assert.strictEqual(harness.ctx.approvals.length, 0, 'no approval requested while blocked');
  });
});

// ---------------------------------------------------------------------------
// extract
// ---------------------------------------------------------------------------

describe('browser-mcp extract', () => {
  let harness: Harness;
  afterEach(() => {
    rmSync(harness.storageDir, { recursive: true, force: true });
  });

  it('extracts per schema and returns a receipt', async () => {
    const page = new FakePage({
      extraction: makeExtraction(),
      extractResults: { heading: 'Checkout', items: ['anvil'] },
    });
    harness = await makeHarness({ page });
    await harness.call('open', { url: 'https://shop.example/checkout' });
    const result = await harness.call('extract', {
      schema: {
        pageTitle: { source: 'title' },
        pageUrl: { source: 'url' },
        body: { source: 'text' },
        heading: { source: 'selector', selector: 'h1' },
        items: { source: 'selector', selector: '.item', all: true },
        absent: { source: 'selector', selector: '.missing' },
        formSummary: { source: 'forms' },
      },
    });
    assert.strictEqual(result.isError, undefined);
    const payload = resultPayload(result);
    const data = payload.data as Record<string, unknown>;
    assert.strictEqual(data.pageTitle, 'Checkout');
    assert.strictEqual(data.pageUrl, 'https://shop.example/checkout');
    assert.strictEqual(data.body, 'Checkout page content.');
    assert.strictEqual(data.heading, 'Checkout');
    assert.deepStrictEqual(data.items, ['anvil']);
    const receipt = payload.receipt as { extractedFields: string[]; missingFields: string[] };
    assert.ok(receipt.extractedFields.includes('heading'));
    assert.deepStrictEqual(receipt.missingFields, ['absent']);
    // Form summary is the sanitized model shape — no values for sensitive fields.
    const forms = data.formSummary as Array<{ fields: Array<{ name?: string; value?: string }> }>;
    const card = forms[0].fields.find((field) => field.name === 'cardNumber');
    assert.ok(card);
    assert.strictEqual('value' in card, false);
  });

  it('rejects an empty schema', async () => {
    harness = await makeHarness({ page: new FakePage({ extraction: makeExtraction() }) });
    await harness.call('open', { url: 'https://shop.example/checkout' });
    const result = await harness.call('extract', { schema: {} });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(
      (resultPayload(result).error as { code: string }).code,
      'browser_extract_empty',
    );
  });
});

// ---------------------------------------------------------------------------
// requestHandoff (U3 surface; the full U5 flow lives in browser-control.test.ts)
// ---------------------------------------------------------------------------

describe('browser-mcp requestHandoff', () => {
  it('fails closed when no approval channel is wired, leaving no stuck handoff', async () => {
    const harness = await makeHarness({
      page: new FakePage({ extraction: makeExtraction() }),
      withApprovalRequester: false,
    });
    await harness.call('open', { url: 'https://shop.example/checkout' });
    const result = await harness.call('requestHandoff', { reason: 'CAPTCHA on the login page' });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(
      (resultPayload(result).error as { code: string }).code,
      'browser_approval_unavailable',
    );
    // The handoff was rolled back: the state machine is not stuck pending.
    assert.strictEqual(harness.ctx.browserService.getControlState('chat-session-1'), 'agent_in_control');
    rmSync(harness.storageDir, { recursive: true, force: true });
  });
});

describe('browser-mcp close (U2)', () => {
  it('asks the user to confirm, then tears down on allow', async () => {
    const harness = await makeHarness({
      page: new FakePage({ extraction: makeExtraction() }),
      approvalDecisions: [{ behavior: 'allow' }],
    });
    await harness.call('open', { url: 'https://shop.example/checkout' });
    assert.ok(harness.ctx.browserService.getSession('chat-session-1'), 'session live before close');

    const result = await harness.call('close', { reason: 'checkout complete' });
    const payload = resultPayload(result);

    // Exactly one confirmation card, carrying the browser_close payload.
    assert.strictEqual(harness.ctx.approvals.length, 1);
    assert.strictEqual(harness.ctx.approvals[0].payload.kind, 'browser_close');
    // Teardown ran: no live session afterward.
    assert.strictEqual(payload.ok, true);
    assert.strictEqual(payload.closed, true);
    assert.strictEqual(harness.ctx.browserService.getSession('chat-session-1'), undefined);
    rmSync(harness.storageDir, { recursive: true, force: true });
  });

  it('returns closed:false and leaves the browser live when the user denies', async () => {
    const harness = await makeHarness({
      page: new FakePage({ extraction: makeExtraction() }),
      approvalDecisions: [{ behavior: 'deny', message: 'not yet' }],
    });
    await harness.call('open', { url: 'https://shop.example/checkout' });

    const result = await harness.call('close', { reason: 'done' });
    const payload = resultPayload(result);
    assert.strictEqual(payload.closed, false);
    assert.ok(harness.ctx.browserService.getSession('chat-session-1'), 'session still live after deny');
    rmSync(harness.storageDir, { recursive: true, force: true });
  });

  it('fails closed with browser_approval_unavailable when no approval channel is wired', async () => {
    const harness = await makeHarness({
      page: new FakePage({ extraction: makeExtraction() }),
      withApprovalRequester: false,
    });
    await harness.call('open', { url: 'https://shop.example/checkout' });

    const result = await harness.call('close', { reason: 'done' });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(
      (resultPayload(result).error as { code: string }).code,
      'browser_approval_unavailable',
    );
    assert.ok(harness.ctx.browserService.getSession('chat-session-1'), 'session still live');
    rmSync(harness.storageDir, { recursive: true, force: true });
  });

  it('is an ok-noop with no approval card when there is no live browser', async () => {
    const harness = await makeHarness({ page: new FakePage({ extraction: makeExtraction() }) });
    const result = await harness.call('close', { reason: 'done' });
    const payload = resultPayload(result);
    assert.strictEqual(payload.ok, true);
    assert.strictEqual(payload.closed, false);
    assert.strictEqual(harness.ctx.approvals.length, 0);
    rmSync(harness.storageDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Page registry: runtime rebuilds rebind without leaking sockets
// ---------------------------------------------------------------------------

describe('browser-mcp page registry (KTD-5 rebind)', () => {
  let storageDir: string;
  afterEach(() => {
    rmSync(storageDir, { recursive: true, force: true });
  });

  async function makeService(options: { exportContext?: (baseUrl: string) => Promise<unknown> } = {}): Promise<BrowserService> {
    storageDir = mkdtempSync(path.join(tmpdir(), 'comate-browser-registry-'));
    const shell = await startFakeBrowserShell();
    shellCleanups.push(shell.close);
    return new BrowserService({
      storageDir,
      maxSessions: 4,
      resolveTarget: shell.resolveTarget,
      createControlClient: shell.createControlClient,
      cdpRetry: { budgetMs: 400, intervalMs: 40 },
      listKnownSessionIds: () => [],
      now: () => Date.now(),
      exportContext: options.exportContext,
    });
  }

  it('two server instances for the same session share one CDP connection', async () => {
    const service = await makeService();
    const registry = new Map<string, Promise<BrowserCdpSession>>();
    const page = new FakePage({ extraction: makeExtraction() });
    let dials = 0;
    const connectPage = async () => {
      dials += 1;
      return page;
    };
    const deps = { sessionId: 'chat-session-1', workspaceId: 'w', browserService: service, connectPage, pageRegistry: registry, settleMs: 0 };
    const first = buildBrowserToolDefinitions(deps);
    const second = buildBrowserToolDefinitions(deps);
    const openFirst = first.find((definition) => definition.name === 'open');
    const stateSecond = second.find((definition) => definition.name === 'getPageState');
    await openFirst?.handler({ url: 'https://shop.example/' }, {});
    await stateSecond?.handler({}, {});
    assert.strictEqual(dials, 1, 'runtime rebuild reuses the live connection');
  });

  it('a closed page is evicted and the next call reconnects', async () => {
    const service = await makeService();
    const registry = new Map<string, Promise<BrowserCdpSession>>();
    const pages = [
      new FakePage({ extraction: makeExtraction() }),
      new FakePage({ extraction: makeExtraction() }),
    ];
    let dials = 0;
    const connectPage = async () => {
      const page = pages[Math.min(dials, pages.length - 1)];
      dials += 1;
      return page;
    };
    const deps = { sessionId: 'chat-session-1', workspaceId: 'w', browserService: service, connectPage, pageRegistry: registry, settleMs: 0 };
    const defs = buildBrowserToolDefinitions(deps);
    const open = defs.find((definition) => definition.name === 'open');
    const takeScreenshot = defs.find((definition) => definition.name === 'takeScreenshot');
    await open?.handler({ url: 'https://shop.example/' }, {});
    pages[0].close(); // view crash / socket drop
    const result = await takeScreenshot?.handler({}, {});
    assert.strictEqual(result?.isError, undefined);
    assert.strictEqual(dials, 2, 'dead connection evicted, fresh dial made');
  });

  it('preserves current refs across stateless definition builds and rejects stale/forged refs', async () => {
    const service = await makeService();
    const contextRegistry = new Map();
    const page = new FakePage({
      extraction: makeExtraction(),
      inspectResult: {
        tag: 'input',
        attributes: { type: 'email', value: 'must-not-pass', onclick: 'steal()' },
        nearbyText: 'Email address',
        descendants: [],
        descendantsTruncated: false,
        actions: ['fill'],
      },
    });
    const deps: BrowserMcpDeps = {
      sessionId: 'inspect-session', workspaceId: 'w', browserService: service,
      connectPage: async () => page, pageRegistry: new Map(), contextRegistry, settleMs: 0,
    };
    const first = buildBrowserToolDefinitions(deps);
    const opened = await first.find((definition) => definition.name === 'open')!.handler({ url: 'https://shop.example/' }, {});
    const fieldRef = (resultPayload(opened).model as { forms: Array<{ fields: Array<{ ref: string }> }> }).forms[0].fields[0].ref;
    const second = buildBrowserToolDefinitions(deps);
    const details = second.find((definition) => definition.name === 'getElementDetails')!;
    const inspected = await details.handler({ ref: fieldRef }, {});
    const serialized = JSON.stringify(resultPayload(inspected));
    assert.match(serialized, /Email address/);
    assert.doesNotMatch(serialized, /must-not-pass|onclick|steal/);
    const forged = resultPayload(await details.handler({ ref: 'e999-forged' }, {})).error as { code: string };
    assert.equal(forged.code, 'browser_ref_unknown');

    const changedPage = new FakePage({
      extraction: makeExtraction(), probe: { docId: 'doc-1', domEpoch: 1 },
      axNodes: [
        { nodeId: '1', role: { value: 'button' }, name: { value: 'Open assistant' }, backendDOMNodeId: 77 },
      ],
      inspectResult: { tag: 'input', attributes: {}, descendants: [], descendantsTruncated: false, actions: [] },
    });
    const changedDeps: BrowserMcpDeps = {
      sessionId: 'changed-session', workspaceId: 'w', browserService: service,
      connectPage: async () => changedPage, pageRegistry: new Map(), contextRegistry, settleMs: 0,
    };
    const changedDefs = buildBrowserToolDefinitions(changedDeps);
    const changedOpen = await changedDefs.find((definition) => definition.name === 'open')!.handler({ url: 'https://shop.example/' }, {});
    const changedModel = resultPayload(changedOpen).model as {
      forms: Array<{ fields: Array<{ ref: string }> }>;
      actions: Array<{ ref: string }>;
    };
    const changedField = await changedDefs.find((definition) => definition.name === 'getElementDetails')!
      .handler({ ref: changedModel.forms[0].fields[0].ref }, {});
    assert.strictEqual(
      (resultPayload(changedField).error as { code: string }).code,
      'browser_ref_stale',
      'XPath-backed field refs remain strict across DOM mutations',
    );
    const changedAction = await changedDefs.find((definition) => definition.name === 'getElementDetails')!
      .handler({ ref: changedModel.actions[0].ref }, {});
    assert.strictEqual(changedAction.isError, undefined, 'stable backend-node refs survive same-document mutations');

    const stalePage = new FakePage({
      extraction: makeExtraction(), probe: { docId: 'other-doc', domEpoch: 1 },
      inspectResult: { tag: 'input', attributes: {}, descendants: [], descendantsTruncated: false, actions: [] },
    });
    const staleDefs = buildBrowserToolDefinitions({
      ...changedDeps,
      sessionId: 'stale-session',
      connectPage: async () => stalePage,
    });
    const staleOpen = await staleDefs.find((definition) => definition.name === 'open')!.handler({ url: 'https://shop.example/' }, {});
    const staleRef = (resultPayload(staleOpen).model as { forms: Array<{ fields: Array<{ ref: string }> }> }).forms[0].fields[0].ref;
    const stale = resultPayload(await staleDefs.find((definition) => definition.name === 'getElementDetails')!.handler({ ref: staleRef }, {})).error as { code: string };
    assert.equal(stale.code, 'browser_ref_stale');

    const noProbePage = new FakePage({ extraction: makeExtraction(), probe: null });
    const noProbeDefs = buildBrowserToolDefinitions({
      ...changedDeps,
      sessionId: 'no-probe-session',
      connectPage: async () => noProbePage,
    });
    const noProbeOpen = await noProbeDefs.find((definition) => definition.name === 'open')!.handler({ url: 'https://shop.example/' }, {});
    const noProbeRef = (resultPayload(noProbeOpen).model as { forms: Array<{ fields: Array<{ ref: string }> }> }).forms[0].fields[0].ref;
    const unavailable = resultPayload(await noProbeDefs.find((definition) => definition.name === 'getElementDetails')!.handler({ ref: noProbeRef }, {})).error as { code: string };
    assert.equal(unavailable.code, 'browser_probe_unavailable');
  });

  it('preserves capture across stateless builds, ranks APIs, and removes credential sentinels', async () => {
    let contextExports = 0;
    const service = await makeService({ exportContext: async () => {
      contextExports += 1;
      return {};
    } });
    const transport = new FakeNetworkTransport();
    const secret = 'credential-sentinel-1234567890-abcdef';
    transport.bodies.set('api', { body: JSON.stringify({ remaining: 42, unfamiliar: secret }), base64Encoded: false });
    transport.bodies.set('image', { body: 'AAE=', base64Encoded: true });
    const page = new FakePage({ extraction: makeExtraction(), networkTransport: transport });
    const deps: BrowserMcpDeps = {
      sessionId: 'capture-session', workspaceId: 'w', browserService: service,
      connectPage: async () => page, pageRegistry: new Map(), contextRegistry: new Map(),
      settleMs: 0, captureOptions: { quietMs: 1, hardDeadlineMs: 50 },
    };
    const first = buildBrowserToolDefinitions(deps);
    await first.find((definition) => definition.name === 'startNetworkCapture')!.handler({ action: 'Load quota' }, {});
    transport.emit('Network.requestWillBeSent', {
      requestId: 'api', type: 'Fetch',
      request: { url: 'https://api.example.com/v1/quota', method: 'GET', headers: { authorization: `Bearer ${secret}`, accept: 'application/json' } },
    });
    transport.emit('Network.responseReceived', {
      requestId: 'api', response: { url: 'https://api.example.com/v1/quota', status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, mimeType: 'application/json' },
    });
    // Deliberately noisy traffic shares the same temporal window. It remains
    // available as evidence but must not be described as caused by the action.
    for (const [requestId, url, type] of [
      ['telemetry', 'https://api.example.com/v1/telemetry', 'Fetch'],
      ['poll', 'https://api.example.com/api/notifications/poll', 'EventSource'],
    ] as const) {
      transport.emit('Network.requestWillBeSent', {
        requestId, type, request: { url, method: 'GET', headers: {} },
      });
      transport.emit('Network.responseReceived', {
        requestId, response: { url, status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, mimeType: 'application/json' },
      });
    }
    transport.emit('Network.requestWillBeSent', {
      requestId: 'image', type: 'Image', request: { url: 'https://api.example.com/logo.png', method: 'GET', headers: {} },
    });
    transport.emit('Network.responseReceived', {
      requestId: 'image', response: { url: 'https://api.example.com/logo.png', status: 200, statusText: 'OK', headers: { 'content-type': 'image/png' }, mimeType: 'image/png' },
    });
    const second = buildBrowserToolDefinitions(deps);
    const stopping = second.find((definition) => definition.name === 'stopNetworkCapture')!.handler({}, {});
    transport.emit('Network.requestWillBeSent', {
      requestId: 'late', type: 'Fetch', request: { url: 'https://api.example.com/v1/late', method: 'GET', headers: {} },
    });
    transport.emit('Network.loadingFinished', { requestId: 'api' });
    transport.emit('Network.loadingFinished', { requestId: 'telemetry' });
    transport.emit('Network.loadingFinished', { requestId: 'poll' });
    transport.emit('Network.loadingFinished', { requestId: 'image' });
    const payload = resultPayload(await stopping);
    const serialized = JSON.stringify(payload);
    assert.doesNotMatch(serialized, new RegExp(secret));
    assert.doesNotMatch(serialized, /Bearer/);
    const candidates = payload.candidates as Array<{ url: string; authBinding?: string; evidence: { confidence: string; action: string } }>;
    assert.equal(candidates.length, 4, 'background traffic is retained and post-stop traffic is excluded');
    assert.match(candidates[0].url, /\/v1\/quota/);
    assert.equal(candidates[0].evidence.confidence, 'high');
    assert.ok(candidates.every((candidate) => /temporal association only/.test(candidate.evidence.action)));
    assert.ok(candidates.some((candidate) => candidate.url.includes('/v1/telemetry')));
    assert.ok(candidates.some((candidate) => candidate.url.includes('/notifications/poll')));
    assert.match(candidates[0].authBinding ?? '', /^authb_[A-Za-z0-9_-]{8,}$/);
    assert.equal(contextExports, 1, 'all candidates share one browser-context export');
  });

  it('runtime disposal aborts capture drains and removes the task context', async () => {
    const service = await makeService();
    const transport = new FakeNetworkTransport();
    const page = new FakePage({ extraction: makeExtraction(), networkTransport: transport });
    const deps: BrowserMcpDeps = {
      sessionId: 'dispose-capture-session', workspaceId: 'w', browserService: service,
      connectPage: async () => page, pageRegistry: new Map(), settleMs: 0,
      captureOptions: { quietMs: 60_000, hardDeadlineMs: 60_000 },
    };
    const definitions = buildBrowserToolDefinitions(deps);
    await definitions.find((definition) => definition.name === 'startNetworkCapture')!.handler({ action: 'Quota' }, {});
    assert.ok(transport.listenerCount > 0);

    disposeBrowserToolContext('dispose-capture-session', service);

    assert.equal(transport.listenerCount, 0, 'capture listeners must be detached synchronously');
    const rebuilt = buildBrowserToolDefinitions(deps);
    const result = resultPayload(await rebuilt.find((definition) => definition.name === 'stopNetworkCapture')!.handler({}, {}));
    assert.equal((result.error as { code: string }).code, 'capture_not_active');
  });
});

// ---------------------------------------------------------------------------
// chat-service injection: GUI-only server + per-session stream timeout
// ---------------------------------------------------------------------------

class MockSdkClient extends SdkClient {
  override async getSessionInfo(sessionId: string): Promise<SDKSessionInfo | undefined> {
    return {
      sessionId,
      summary: 'Test Session',
      createdAt: new Date().toISOString(),
      lastModified: new Date().toISOString(),
    } as SDKSessionInfo;
  }
  override async listSessions(): Promise<SDKSessionInfo[]> {
    return [];
  }
  override async listSubagents(): Promise<string[]> {
    return [];
  }
  override async getSessionMessages(): Promise<SessionMessage[]> {
    return [];
  }
  override async getSubagentMessages(): Promise<SessionMessage[]> {
    return [];
  }
  override async renameSession(): Promise<void> {}
  override async forkSession(): Promise<{ sessionId: string }> {
    return { sessionId: 'fork-s1' };
  }
}

class TestChatService extends ChatService {
  constructor() {
    super(new MockSdkClient());
  }
  protected override async testClaudeBinary(): Promise<void> {}
}

function createMockRuntime(): SessionRuntime {
  return {
    isClosed: () => false,
    getStatus: () => ({ pendingCount: 0, isProcessing: false, workspaceId: 'ws-1' }),
    close: () => Promise.resolve(),
    subscribe: () => {},
    unsubscribe: () => {},
    pushMessage: () => {},
    resolveApproval: () => {},
    interrupt: () => Promise.resolve(),
    addBotEventHandler: () => {},
    clearBotEventHandlers: () => {},
    removeBotEventHandler: () => {},
    setApprovalMode: () => {},
    getApprovalMode: () => 'manual' as const,
  } as unknown as SessionRuntime;
}

describe('chat-service browser MCP injection (KTD-3, KTD-4 ③)', { concurrency: false }, () => {
  let service: TestChatService;
  const originalOpen = SessionRuntime.open;
  let folderPath: string;

  beforeEach(() => {
    workspaceStore.resetData();
    service = new TestChatService();
    folderPath = mkdtempSync(path.join(tmpdir(), 'comate-browser-inject-'));
  });

  afterEach(async () => {
    await service.closeAllRuntimes();
    SessionRuntime.open = originalOpen;
    rmSync(folderPath, { recursive: true, force: true });
  });

  async function captureOptions(isBotSession: boolean, backend?: 'claude' | 'opencode'): Promise<Options> {
    const workspace = await workspaceStore.create({
      name: 'Browser Workspace',
      folderPath,
      mcpServers: [{ name: 'stdio-server', command: '/bin/echo', args: ['hi'] }],
    });
    const provider = workspaceStore.createProvider({
      name: `Provider ${crypto.randomUUID()}`,
      baseUrl: 'http://test',
      authToken: 'test',
      model: 'test-model',
      isDefault: false,
    });
    const session = workspaceStore.createLocalSession(
      workspace.id,
      'Browser Session',
      undefined,
      provider.id,
      isBotSession ? 'wecom' : 'gui',
    );
    if (backend) workspaceStore.updateSessionBackend(session.id, backend);
    let captured: Options | undefined;
    SessionRuntime.open = (...args: unknown[]) => {
      captured = args[3] as Options;
      return createMockRuntime();
    };
    await service.getOrCreateRuntime(session.id, workspace.id, isBotSession || undefined);
    assert.ok(captured, 'options captured');
    return captured;
  }

  it('GUI sessions get the HTTP browser server alongside stdio servers plus the stream timeout', async () => {
    const options = await captureOptions(false);
    const servers = options.mcpServers as Record<string, { type?: string; name?: string }>;
    assert.ok(servers, 'mcpServers present');
    assert.strictEqual(servers['stdio-server']?.type, 'stdio', 'existing stdio server preserved');
    const browser = servers[BROWSER_MCP_SERVER_KEY] as unknown as {
      type: string;
      url: string;
      headers?: Record<string, string>;
    };
    assert.ok(browser, 'browser server injected');
    // U6 (KTD-6): served by the sidecar over HTTP for both backends, with a
    // per-session URL and a Bearer token.
    assert.strictEqual(browser.type, 'http');
    assert.ok(
      /\/mcp\/browser\/[^/]+$/.test(browser.url),
      `per-session MCP URL, got ${browser.url}`,
    );
    assert.strictEqual(browser.headers?.Authorization?.startsWith('Bearer '), true);
    assert.strictEqual(
      browser.headers?.Authorization,
      `Bearer ${(options.env as Record<string, string>)[SESSION_TOKEN_ENV]}`,
      'Claude MCP and subprocess env must share the same task capability',
    );
    assert.strictEqual(
      (options.env as Record<string, string>).CLAUDE_CODE_STREAM_CLOSE_TIMEOUT,
      BROWSER_STREAM_CLOSE_TIMEOUT_MS,
      'per-session stream close timeout covers approval round-trips',
    );
    const guiEnv = options.env as Record<string, string>;
    assert.ok(guiEnv.COMATE_CLI_PATH, 'GUI backend gets the packaged/dev Comate CLI path');
    assert.match(guiEnv.COMATE_SERVER_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(guiEnv.COMATE_WORKSPACE_ROOT, folderPath);
    assert.ok(guiEnv.PATH.includes(path.dirname(guiEnv.COMATE_CLI_PATH)));
  });

  it('bot sessions never get the browser server or the browser stream timeout', async () => {
    const options = await captureOptions(true);
    const servers = options.mcpServers as Record<string, { type?: string }> | undefined;
    assert.ok(servers, 'mcpServers present (stdio server still merged)');
    assert.strictEqual(
      servers[BROWSER_MCP_SERVER_KEY],
      undefined,
      'bot session must not register the browser server (KTD-4 ③)',
    );
    assert.strictEqual(
      (options.env as Record<string, string | undefined>).CLAUDE_CODE_STREAM_CLOSE_TIMEOUT,
      undefined,
    );
    assert.strictEqual((options.env as Record<string, string | undefined>).COMATE_CLI_PATH, undefined);
  });

  it('OpenCode GUI sessions receive the same Comate CLI environment', async () => {
    const options = await captureOptions(false, 'opencode');
    const env = options.env as Record<string, string>;
    assert.ok(env.COMATE_CLI_PATH);
    assert.ok(env.PATH.includes(path.dirname(env.COMATE_CLI_PATH)));
    assert.match(env.COMATE_SERVER_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(env.COMATE_WORKSPACE_ROOT, folderPath);
  });
});
