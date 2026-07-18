import '../../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Options, SDKSessionInfo, SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { BrowserService } from '../browser-service.js';
import type { SteelExitInfo, SteelProcessHandle, SteelProcessOptions } from '../browser-steel-process.js';
import type { SteelCdpSession } from '../browser-cdp.js';
import {
  BROWSER_MCP_SERVER_KEY,
  BROWSER_STREAM_CLOSE_TIMEOUT_MS,
  BROWSER_TOOL_PREFIX,
  buildBrowserToolDefinitions,
  createBrowserMcpServer,
  type BrowserApprovalRequest,
  type BrowserApprovalDecision,
  type BrowserMcpDeps,
  type BrowserToolDefinition,
} from '../browser-mcp.js';
import type { RawAxNode, RawPageExtraction, SubmitSnapshot } from '../browser-page-model.js';
import { ChatService } from '../chat-service.js';
import { SessionRuntime } from '../session-runtime.js';
import { SdkClient } from '../sdk-client.js';
import { store as workspaceStore } from '../../storage/sqlite-store.js';

/**
 * browser-mcp tests — the first-class tool surface (KTD-3), the handler-level
 * submit gate with TOCTOU re-verification (KTD-4 ②), control-state gating,
 * and the chat-service injection point (GUI-only + per-session stream timeout).
 */

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeSteelHandle implements SteelProcessHandle {
  readonly baseUrl: string;
  private readonly exitListeners = new Set<(info: SteelExitInfo) => void>();

  constructor(private readonly options: SteelProcessOptions) {
    this.baseUrl = `http://127.0.0.1:${options.port}`;
  }

  get sessionId(): string {
    return this.options.sessionId;
  }
  get port(): number {
    return this.options.port;
  }
  get userDataDir(): string {
    return this.options.userDataDir;
  }
  get pid(): number | undefined {
    return 4242;
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async probeHealth(): Promise<boolean> {
    return true;
  }
  onExit(listener: (info: SteelExitInfo) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }
}

interface FakePageOptions {
  extraction: RawPageExtraction;
  axNodes?: RawAxNode[];
  probe?: { docId: string; domEpoch: number };
  submitSnapshots?: Array<SubmitSnapshot | null>;
  extractResults?: Record<string, unknown>;
}

class FakePage implements SteelCdpSession {
  closed = false;
  navigated: string[] = [];
  screenshots = 0;
  clickedBackendNodes: number[] = [];
  actScripts: string[] = [];
  dispatchScripts: string[] = [];
  private readonly options: FakePageOptions;
  private submitSnapshots: Array<SubmitSnapshot | null>;
  private closeListeners = new Set<() => void>();

  constructor(options: FakePageOptions) {
    this.options = options;
    this.submitSnapshots = [...(options.submitSnapshots ?? [])];
  }

  get probe(): { docId: string; domEpoch: number } {
    return (
      this.options.probe ?? { docId: this.options.extraction.docId, domEpoch: this.options.extraction.domEpoch }
    );
  }

  async evaluate<T>(expression: string): Promise<T> {
    if (expression.includes('new MutationObserver')) {
      return this.options.extraction as T; // distiller extractor
    }
    if (expression.includes('window.__comateProbe')) {
      return this.probe as T; // READ_PROBE_SCRIPT
    }
    if (expression.includes('document.forms[') && expression.includes('hash')) {
      const next =
        this.submitSnapshots.length > 1 ? this.submitSnapshots.shift() : this.submitSnapshots[0];
      return (next ?? null) as T; // submit TOCTOU snapshot
    }
    if (expression.includes('requestSubmit')) {
      this.dispatchScripts.push(expression);
      return { ok: true } as T;
    }
    if (expression.includes('XPathResult')) {
      this.actScripts.push(expression);
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
  async captureScreenshot(): Promise<string> {
    this.screenshots += 1;
    return 'aGVsbG8';
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
  };
  tools: Map<string, BrowserToolDefinition>;
  call: (name: string, args: Record<string, unknown>, extra?: unknown) => Promise<CallToolResult>;
  storageDir: string;
}

function makeHarness(options: {
  page: FakePage;
  approvalDecisions?: BrowserApprovalDecision[];
  withApprovalRequester?: boolean;
  maxSessions?: number;
  resolveChromium?: boolean;
}): Harness {
  const storageDir = mkdtempSync(path.join(tmpdir(), 'comate-browser-mcp-'));
  let port = 9300;
  const browserService = new BrowserService({
    storageDir,
    maxSessions: options.maxSessions ?? 4,
    allocatePort: async () => (port += 1),
    resolveChromiumPath: async () =>
      options.resolveChromium === false ? undefined : '/fake/chromium',
    createProcess: (processOptions) => new FakeSteelHandle(processOptions),
    cleanupStale: async () => ({ scanned: 0, killed: 0, removed: 0, skipped: 0 }),
    now: () => Date.now(),
  });

  const approvals: BrowserApprovalRequest[] = [];
  const decisions = [...(options.approvalDecisions ?? [])];
  const deps: BrowserMcpDeps = {
    sessionId: 'chat-session-1',
    workspaceId: 'workspace-1',
    browserService,
    connectPage: async () => options.page,
    pageRegistry: new Map(),
    settleMs: 0,
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
    ctx: { browserService, page: options.page, approvals, approvalDecisions: decisions },
    tools,
    call: async (name, args, extra) => {
      const definition = tools.get(name);
      assert.ok(definition, `tool ${name} must exist`);
      return definition.handler(args, extra ?? {});
    },
    storageDir,
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
  it('registers the six first-class tools with the comate-browser server key', () => {
    const harness = makeHarness({ page: new FakePage({ extraction: makeExtraction() }) });
    assert.deepStrictEqual(
      [...harness.tools.keys()].sort(),
      ['act', 'extract', 'open', 'requestHandoff', 'snapshot', 'submit'],
    );
    rmSync(harness.storageDir, { recursive: true, force: true });
  });

  it('annotates snapshot/extract read-only and marks submit destructive + requiresUserInteraction', () => {
    const harness = makeHarness({ page: new FakePage({ extraction: makeExtraction() }) });
    assert.strictEqual(harness.tools.get('snapshot')?.annotations?.readOnlyHint, true);
    assert.strictEqual(harness.tools.get('extract')?.annotations?.readOnlyHint, true);
    assert.strictEqual(harness.tools.get('submit')?.annotations?.destructiveHint, true);
    // Auxiliary meta only — the security property lives in the handler gate.
    assert.strictEqual(
      harness.tools.get('submit')?._meta?.['anthropic/requiresUserInteraction'],
      true,
    );
    rmSync(harness.storageDir, { recursive: true, force: true });
  });

  it('createBrowserMcpServer returns an sdk-type config with a live instance', () => {
    const server = createBrowserMcpServer({ sessionId: 's', workspaceId: 'w' });
    assert.strictEqual(server.type, 'sdk');
    assert.strictEqual(server.name, BROWSER_MCP_SERVER_KEY);
    assert.ok(server.instance, 'sdk MCP server instance must be present');
    assert.strictEqual(BROWSER_TOOL_PREFIX, 'mcp__comate-browser__');
  });
});

// ---------------------------------------------------------------------------
// open / snapshot
// ---------------------------------------------------------------------------

describe('browser-mcp open/snapshot', () => {
  let harness: Harness;
  afterEach(() => {
    rmSync(harness.storageDir, { recursive: true, force: true });
  });

  it('open navigates and returns the first distilled model with refs', async () => {
    harness = makeHarness({ page: new FakePage({ extraction: makeExtraction() }) });
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
    harness = makeHarness({ page: new FakePage({ extraction: makeExtraction() }) });
    const jsResult = await harness.call('open', { url: 'javascript:alert(1)' });
    assert.strictEqual(jsResult.isError, true);
    assert.strictEqual((resultPayload(jsResult).error as { code: string }).code, 'browser_url_scheme');

    const badResult = await harness.call('open', { url: 'not a url' });
    assert.strictEqual(badResult.isError, true);
    assert.strictEqual((resultPayload(badResult).error as { code: string }).code, 'browser_url_invalid');
    assert.deepStrictEqual(harness.ctx.page.navigated, [], 'no navigation on rejected URLs');
  });

  it('maps browser unavailability to a loud structured error', async () => {
    harness = makeHarness({
      page: new FakePage({ extraction: makeExtraction() }),
      resolveChromium: false,
    });
    const result = await harness.call('open', { url: 'https://shop.example/' });
    assert.strictEqual(result.isError, true);
    const error = resultPayload(result).error as { code: string; stage: string; resolution: string };
    assert.strictEqual(error.code, 'browser_chromium_missing');
    assert.strictEqual(error.stage, 'session_start');
    assert.ok(error.resolution.length > 0, 'resolution path present');
  });

  it('snapshot returns a fresh model and an image block when requested', async () => {
    harness = makeHarness({ page: new FakePage({ extraction: makeExtraction() }) });
    await harness.call('open', { url: 'https://shop.example/checkout' });
    const result = await harness.call('snapshot', { screenshot: true });
    assert.strictEqual(result.isError, undefined);
    const image = result.content.find((block) => block.type === 'image');
    assert.ok(image && image.type === 'image', 'image block present');
    assert.strictEqual(image.mimeType, 'image/jpeg');
    assert.ok(image.data.length > 0, 'bare base64 payload');
    assert.strictEqual(harness.ctx.page.screenshots, 1);
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
    harness = makeHarness({ page: new FakePage({ extraction: makeExtraction() }) });
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
    });
    harness = makeHarness({ page });
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
    harness = makeHarness({ page });
    const { emailRef } = await openAndGetRefs(harness);

    const unknown = await harness.call('act', { ref: 'e999-zz', action: 'click' });
    assert.strictEqual(unknown.isError, true);
    assert.strictEqual((resultPayload(unknown).error as { code: string }).code, 'browser_ref_unknown');

    const stale = await harness.call('act', { ref: emailRef, action: 'fill', value: 'x' });
    assert.strictEqual(stale.isError, true);
    const error = resultPayload(stale).error as { code: string; resolution: string };
    assert.strictEqual(error.code, 'browser_ref_stale');
    assert.ok(error.resolution.includes('snapshot'));
    assert.strictEqual(page.actScripts.length, 0, 'no dispatch for invalid refs');
  });

  it('routes submit-semantics clicks to the submit tool', async () => {
    harness = makeHarness({ page: new FakePage({ extraction: makeExtraction() }) });
    const { payRef } = await openAndGetRefs(harness);
    const result = await harness.call('act', { ref: payRef, action: 'click' });
    assert.strictEqual(result.isError, true);
    const error = resultPayload(result).error as { code: string; resolution: string };
    assert.strictEqual(error.code, 'browser_use_submit_tool');
    assert.ok(error.resolution.includes('submit'));
    assert.strictEqual(harness.ctx.page.actScripts.length, 0, 'submit control never clicked via act');
  });

  it('blocks act while the user is in control (recoverable)', async () => {
    harness = makeHarness({ page: new FakePage({ extraction: makeExtraction() }) });
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
    harness = makeHarness({ page });
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

  it('returns a non-error deny result and never dispatches', async () => {
    const page = new FakePage({
      extraction: makeExtraction(),
      submitSnapshots: [makeSubmitSnapshot()],
    });
    harness = makeHarness({
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
    harness = makeHarness({ page, withApprovalRequester: false });
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
    harness = makeHarness({ page });
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
    harness = makeHarness({ page });
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
    harness = makeHarness({ page });
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
    harness = makeHarness({ page });
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
    harness = makeHarness({ page });
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
    harness = makeHarness({ page: new FakePage({ extraction: makeExtraction() }) });
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
// requestHandoff (U3 placeholder — U5 wires the approval round-trip)
// ---------------------------------------------------------------------------

describe('browser-mcp requestHandoff', () => {
  it('returns the structured handoff-requested placeholder', async () => {
    const harness = makeHarness({ page: new FakePage({ extraction: makeExtraction() }) });
    const result = await harness.call('requestHandoff', { reason: 'CAPTCHA on the login page' });
    assert.strictEqual(result.isError, undefined);
    const payload = resultPayload(result);
    assert.strictEqual(payload.handoffRequested, true);
    assert.strictEqual(payload.reason, 'CAPTCHA on the login page');
    assert.strictEqual(payload.status, 'queued');
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

  function makeService(): BrowserService {
    storageDir = mkdtempSync(path.join(tmpdir(), 'comate-browser-registry-'));
    let port = 9400;
    return new BrowserService({
      storageDir,
      maxSessions: 4,
      allocatePort: async () => (port += 1),
      resolveChromiumPath: async () => '/fake/chromium',
      createProcess: (processOptions) => new FakeSteelHandle(processOptions),
      cleanupStale: async () => ({ scanned: 0, killed: 0, removed: 0, skipped: 0 }),
      now: () => Date.now(),
    });
  }

  it('two server instances for the same session share one CDP connection', async () => {
    const service = makeService();
    const registry = new Map<string, Promise<SteelCdpSession>>();
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
    const snapSecond = second.find((definition) => definition.name === 'snapshot');
    await openFirst?.handler({ url: 'https://shop.example/' }, {});
    await snapSecond?.handler({}, {});
    assert.strictEqual(dials, 1, 'runtime rebuild reuses the live connection');
  });

  it('a closed page is evicted and the next call reconnects', async () => {
    const service = makeService();
    const registry = new Map<string, Promise<SteelCdpSession>>();
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
    const snapshot = defs.find((definition) => definition.name === 'snapshot');
    await open?.handler({ url: 'https://shop.example/' }, {});
    pages[0].close(); // steel crash / socket drop
    const result = await snapshot?.handler({}, {});
    assert.strictEqual(result?.isError, undefined);
    assert.strictEqual(dials, 2, 'dead connection evicted, fresh dial made');
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

  async function captureOptions(isBotSession: boolean): Promise<Options> {
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
    let captured: Options | undefined;
    SessionRuntime.open = (...args: unknown[]) => {
      captured = args[3] as Options;
      return createMockRuntime();
    };
    await service.getOrCreateRuntime(session.id, workspace.id, isBotSession || undefined);
    assert.ok(captured, 'options captured');
    return captured;
  }

  it('GUI sessions get the sdk browser server alongside stdio servers plus the stream timeout', async () => {
    const options = await captureOptions(false);
    const servers = options.mcpServers as Record<string, { type?: string; name?: string }>;
    assert.ok(servers, 'mcpServers present');
    assert.strictEqual(servers['stdio-server']?.type, 'stdio', 'existing stdio server preserved');
    const browser = servers[BROWSER_MCP_SERVER_KEY];
    assert.ok(browser, 'browser server injected');
    assert.strictEqual(browser.type, 'sdk');
    assert.strictEqual(browser.name, BROWSER_MCP_SERVER_KEY);
    assert.ok(
      (browser as { instance?: unknown }).instance,
      'sdk server carries a live instance',
    );
    assert.strictEqual(
      (options.env as Record<string, string>).CLAUDE_CODE_STREAM_CLOSE_TIMEOUT,
      BROWSER_STREAM_CLOSE_TIMEOUT_MS,
      'per-session stream close timeout covers approval round-trips',
    );
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
  });
});
