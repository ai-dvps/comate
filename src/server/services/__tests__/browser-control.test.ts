import '../../test-utils/test-env.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { WebSocket } from 'ws';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BrowserService, type BrowserServiceEvent } from '../browser-service.js';
import {
  BROWSER_CONTROL_TRANSITIONS,
  BrowserControlService,
  type ApprovalCardResolver,
  type ApprovalCardTimeout,
} from '../browser-control.js';
import type { SteelExitInfo, SteelProcessHandle, SteelProcessOptions } from '../browser-steel-process.js';
import type { SteelCdpSession } from '../browser-cdp.js';
import {
  buildBrowserToolDefinitions,
  type BrowserApprovalDecision,
  type BrowserApprovalRequest,
  type BrowserApprovalRequester,
  type BrowserMcpDeps,
  type BrowserToolDefinition,
} from '../browser-mcp.js';
import type { RawAxNode, RawPageExtraction } from '../browser-page-model.js';
import { BrowserStateChannel } from '../../websocket/browser-state-channel.js';

/**
 * browser-control tests (U5): the mutual-exclusion control state machine
 * (transition table as assertion source), the requestHandoff handler-body
 * pending_approval round-trips (KTD-6), the server-fixed 10-minute timeout
 * with content-free ping resets, the sanitized handback state diff (R7/AE1),
 * the race rules, crash/runtime-close cleanup, and the browser_state
 * WebSocket channel (KTD-9).
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
  crash(info: SteelExitInfo = { code: 1, signal: null }): void {
    for (const listener of [...this.exitListeners]) {
      listener(info);
    }
  }
}

class FakePage implements SteelCdpSession {
  closed = false;
  screenshots = 0;
  extraction: RawPageExtraction;
  probe = { docId: 'doc-1', domEpoch: 0 };
  private readonly closeListeners = new Set<() => void>();

  constructor(extraction: RawPageExtraction) {
    this.extraction = extraction;
  }

  async evaluate<T>(expression: string): Promise<T> {
    if (expression.includes('new MutationObserver')) {
      return this.extraction as T; // distiller extractor
    }
    if (expression.includes('window.__comateProbe')) {
      return this.probe as T; // READ_PROBE_SCRIPT
    }
    if (expression.includes('XPathResult')) {
      return { ok: true } as T; // act dispatch
    }
    throw new Error(`FakePage: unexpected script: ${expression.slice(0, 120)}`);
  }

  async navigate(): Promise<void> {}
  async getFullAXTree(): Promise<RawAxNode[]> {
    return [];
  }
  async clickBackendNode(): Promise<void> {}
  async captureScreenshot(): Promise<string> {
    this.screenshots += 1;
    return 'aGVsbG8';
  }
  async setCookies(): Promise<void> {}
  async evaluateOnNewDocument(): Promise<void> {}
  onClose(listener: () => void): void {
    this.closeListeners.add(listener);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener();
  }
}

interface CapturedCard {
  requestId: string;
  request: BrowserApprovalRequest;
  resolve: (decision: BrowserApprovalDecision) => void;
}

/**
 * Stands in for chat-service's runtime channel: captures the handler's
 * approval round-trips so tests can resolve them like a user (or like the
 * runtime's timeoutDeny) would.
 */
class FakeApprovalChannel {
  readonly cards: CapturedCard[] = [];
  readonly resolutions: Array<{ requestId: string; result: 'allow' | 'deny'; message?: string }> = [];
  readonly timeouts: string[] = [];

  readonly requester: BrowserApprovalRequester = (_sessionId, request) => {
    return new Promise<BrowserApprovalDecision>((resolve) => {
      this.cards.push({ requestId: request.requestId ?? '', request, resolve });
    });
  };

  readonly resolveCard: ApprovalCardResolver = (_sessionId, requestId, result, message) => {
    this.resolutions.push({ requestId, result, ...(message !== undefined && { message }) });
    const card = this.cards.find((candidate) => candidate.requestId === requestId);
    card?.resolve(
      result === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', ...(message !== undefined && { message }) },
    );
  };

  readonly timeoutCard: ApprovalCardTimeout = (_sessionId, requestId) => {
    this.timeouts.push(requestId);
    const card = this.cards.find((candidate) => candidate.requestId === requestId);
    card?.resolve({ behavior: 'deny', message: 'Request timed out waiting for user response.' });
  };

  lastCard(): CapturedCard {
    const card = this.cards[this.cards.length - 1];
    assert.ok(card, 'expected a captured approval card');
    return card;
  }
}

class FakeTimer {
  readonly handles: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];

  readonly set = (fn: () => void, ms: number): unknown => {
    const handle = { fn, ms, cleared: false };
    this.handles.push(handle);
    return handle;
  };

  readonly clear = (handle: unknown): void => {
    (handle as { cleared: boolean }).cleared = true;
  };

  activeCount(): number {
    return this.handles.filter((handle) => !handle.cleared).length;
  }

  fireLatest(): void {
    const handle = [...this.handles].reverse().find((candidate) => !candidate.cleared);
    assert.ok(handle, 'no active timer to fire');
    handle.cleared = true; // setTimeout is one-shot
    handle.fn();
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
        ],
      },
    ],
    standalone: [],
    contentText: 'Checkout page content.',
    contentTruncated: false,
    alerts: [],
    stats: { linkCount: 3, buttonCount: 1, hasPasswordField: true },
    ...overrides,
  };
}

/**
 * The page after the user drove it: email filled (non-sensitive — the value
 * rides the state diff per R7) and the password typed in-page (sensitive —
 * the in-page extractor never reads it out, so value stays undefined).
 */
function userDrivenExtraction(): RawPageExtraction {
  const base = makeExtraction({ contentText: 'Welcome back! Your session is ready.' });
  const form = base.forms[0];
  form.fields[0] = { ...form.fields[0], value: 'user@example.com', filled: true };
  form.fields[1] = { ...form.fields[1], value: undefined, filled: true };
  return base;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  service: BrowserService;
  control: BrowserControlService;
  channel: FakeApprovalChannel;
  timer: FakeTimer;
  page: FakePage;
  handles: FakeSteelHandle[];
  events: BrowserServiceEvent[];
  storageDir: string;
  call: (name: string, args: Record<string, unknown>, extra?: unknown) => Promise<CallToolResult>;
}

function makeHarness(): Harness {
  const storageDir = mkdtempSync(path.join(tmpdir(), 'comate-browser-control-'));
  const handles: FakeSteelHandle[] = [];
  const events: BrowserServiceEvent[] = [];
  let port = 9700;
  const service = new BrowserService({
    storageDir,
    maxSessions: 4,
    allocatePort: async () => (port += 1),
    resolveChromiumPath: async () => '/fake/chromium',
    createProcess: (options) => {
      const handle = new FakeSteelHandle(options);
      handles.push(handle);
      return handle;
    },
    cleanupStale: async () => ({ scanned: 0, killed: 0, removed: 0, skipped: 0 }),
    now: () => Date.now(),
  });
  service.onEvent((event) => events.push(event));

  const channel = new FakeApprovalChannel();
  const timer = new FakeTimer();
  const control = new BrowserControlService({
    browserService: service,
    resolveApprovalCard: channel.resolveCard,
    timeoutApprovalCard: channel.timeoutCard,
    timer,
  });

  const page = new FakePage(makeExtraction());
  const deps: BrowserMcpDeps = {
    sessionId: 'sess-1',
    workspaceId: 'ws-1',
    browserService: service,
    handoffControl: control,
    approvalRequester: channel.requester,
    connectPage: async () => page,
    pageRegistry: new Map(),
    settleMs: 0,
  };
  const definitions = buildBrowserToolDefinitions(deps);
  const tools = new Map<string, BrowserToolDefinition>(definitions.map((d) => [d.name, d]));
  return {
    service,
    control,
    channel,
    timer,
    page,
    handles,
    events,
    storageDir,
    call: async (name, args, extra) => {
      const definition = tools.get(name);
      assert.ok(definition, `tool ${name} must exist`);
      return definition.handler(args, extra ?? {});
    },
  };
}

function resultPayload(result: CallToolResult): Record<string, unknown> {
  const text = result.content.find((block) => block.type === 'text');
  assert.ok(text && text.type === 'text', 'result must have a text block');
  return JSON.parse(text.text) as Record<string, unknown>;
}

function errorCode(result: CallToolResult): string {
  const payload = resultPayload(result);
  return (payload.error as { code: string }).code;
}

/** Flush the microtask/immediate queue so handler continuations settle. */
async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function browserStateValues(events: BrowserServiceEvent[]): string[] {
  return events
    .filter((event): event is Extract<BrowserServiceEvent, { type: 'browser_state' }> => event.type === 'browser_state')
    .map((event) => event.state);
}

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.service.shutdown().catch(() => undefined);
    rmSync(harness.storageDir, { recursive: true, force: true });
  }
});

function track(harness: Harness): Harness {
  harnesses.push(harness);
  return harness;
}

// ---------------------------------------------------------------------------
// Transition table: proactive takeover / handback / rebuild / reject cells
// ---------------------------------------------------------------------------

describe('browser-control state machine (transition table)', () => {
  it('agent_in_control: takeover_click -> user_in_control (F3), handback_click -> back', async () => {
    const h = track(makeHarness());
    await h.service.ensureSession({ sessionId: 'sess-1', workspaceId: 'ws-1' });
    assert.strictEqual(h.service.getControlState('sess-1'), 'agent_in_control');

    const grant = h.control.takeover('sess-1');
    assert.strictEqual(grant.ok, true);
    assert.strictEqual(
      h.service.getControlState('sess-1'),
      BROWSER_CONTROL_TRANSITIONS.agent_in_control.takeover_click.next,
    );

    // takeover_click in user_in_control is a no-op per the table.
    assert.strictEqual(h.control.takeover('sess-1').ok, true);
    assert.strictEqual(h.service.getControlState('sess-1'), 'user_in_control');

    const back = h.control.handback('sess-1');
    assert.strictEqual(back.ok, true);
    assert.strictEqual(
      h.service.getControlState('sess-1'),
      BROWSER_CONTROL_TRANSITIONS.user_in_control.handback_click.next,
    );

    // handback_click in agent_in_control is a no-op per the table.
    assert.strictEqual(h.control.handback('sess-1').ok, true);
    assert.strictEqual(h.service.getControlState('sess-1'), 'agent_in_control');

    // No handoff was active: no card was ever issued, no timer armed.
    assert.strictEqual(h.channel.cards.length, 0);
    assert.strictEqual(h.timer.activeCount(), 0);
  });

  it('session_lost: takeover rejected, handback no-op, tool call rebuilds (table cells)', async () => {
    const h = track(makeHarness());
    await h.service.ensureSession({ sessionId: 'sess-1', workspaceId: 'ws-1' });

    // Unknown session: no browser to drive.
    assert.strictEqual(h.control.takeover('nope').code, 'browser_no_session');

    // crash cell -> session_lost.
    h.handles[0].crash();
    assert.strictEqual(
      h.service.getControlState('sess-1'),
      BROWSER_CONTROL_TRANSITIONS.agent_in_control.crash.next,
    );

    const rejected = h.control.takeover('sess-1');
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.code, 'browser_session_lost');
    assert.strictEqual(BROWSER_CONTROL_TRANSITIONS.session_lost.takeover_click.effect, 'reject_no_browser');

    assert.strictEqual(h.control.handback('sess-1').ok, true);
    assert.strictEqual(h.service.getControlState('sess-1'), 'session_lost');

    // agent_tool_call cell: the next tool call transparently rebuilds.
    const result = await h.call('open', { url: 'https://shop.example/' });
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(h.handles.length, 2, 'a fresh Steel process was spawned');
    assert.strictEqual(
      h.service.getControlState('sess-1'),
      BROWSER_CONTROL_TRANSITIONS.session_lost.agent_tool_call.next,
    );
  });
});

// ---------------------------------------------------------------------------
// Handoff full cycle (R5/R6/R7, AE1)
// ---------------------------------------------------------------------------

describe('browser-control handoff full cycle', () => {
  it('request → pending → takeover → handback → agent receives the sanitized state diff', async () => {
    const h = track(makeHarness());
    await h.call('open', { url: 'https://shop.example/checkout' });

    const pending = h.call('requestHandoff', { reason: 'Log in with your password' });
    await flush();

    // Pending: handoff card #1 issued, state flipped, timer armed (10 min fixed).
    assert.strictEqual(h.service.getControlState('sess-1'), 'handoff_pending');
    assert.strictEqual(h.channel.cards.length, 1);
    const card1 = h.channel.cards[0];
    assert.strictEqual(card1.requestId, 'browser-handoff-sess-1-1');
    assert.strictEqual(card1.request.payload.kind, 'browser_handoff');
    assert.strictEqual(card1.request.payload.phase, 'takeover');
    assert.strictEqual(card1.request.payload.reason, 'Log in with your password');
    assert.strictEqual(card1.request.payload.origin, 'https://shop.example');
    assert.strictEqual(h.timer.activeCount(), 1);

    // 接管点击 (state-bar verb resolves card #1 allow).
    h.control.takeover('sess-1');
    await flush();
    assert.strictEqual(h.service.getControlState('sess-1'), 'user_in_control');
    assert.strictEqual(h.channel.cards.length, 2, 'card #2 (handback wait) is now the live card');
    assert.strictEqual(h.channel.cards[1].request.payload.phase, 'handback');

    // The user drives: fills email + password (password never leaves the page).
    h.page.extraction = userDrivenExtraction();

    // 继续点击 (verb resolves card #2 allow → handback with state diff).
    h.control.handback('sess-1');
    const result = await pending;
    assert.strictEqual(result.isError, undefined);
    const payload = resultPayload(result);
    assert.strictEqual(payload.ok, true);
    assert.strictEqual(payload.handoffCompleted, true);
    assert.ok(payload.delta, 'state delta present (R7)');
    assert.ok(payload.model, 'fresh model present');
    const delta = payload.delta as { contentChanged: boolean; fieldsChanged: number };
    assert.strictEqual(delta.contentChanged, true);
    assert.strictEqual(delta.fieldsChanged, 1, 'only the non-sensitive field value changed');

    // R7/AE1: the email value is visible; the password value is absent everywhere.
    const serialized = JSON.stringify(payload);
    assert.ok(serialized.includes('user@example.com'), 'non-sensitive filled value rides the diff');
    assert.ok(!serialized.includes('hunter2'), 'no password material anywhere');
    const model = payload.model as {
      forms: Array<{ fields: Array<{ name?: string; value?: string; sensitive: boolean }> }>;
    };
    const password = model.forms[0].fields.find((field) => field.name === 'password');
    assert.ok(password);
    assert.strictEqual('value' in password, false, 'sensitive field value absent by construction');

    // State machine returned to agent control; record and timer cleaned up.
    assert.strictEqual(h.service.getControlState('sess-1'), 'agent_in_control');
    assert.strictEqual(h.control.getHandoff('sess-1'), undefined);
    assert.strictEqual(h.timer.activeCount(), 0);

    // Every migration emitted a browser_state event (KTD-9).
    assert.deepStrictEqual(browserStateValues(h.events), [
      'agent_in_control',
      'handoff_pending',
      'user_in_control',
      'agent_in_control',
    ]);
  });

  it('takes over and hands back via the cards themselves (allow resolutions)', async () => {
    const h = track(makeHarness());
    await h.call('open', { url: 'https://shop.example/checkout' });

    const pending = h.call('requestHandoff', { reason: 'CAPTCHA' });
    await flush();
    // Card #1's own allow button = 接管.
    h.channel.cards[0].resolve({ behavior: 'allow' });
    await flush();
    assert.strictEqual(h.service.getControlState('sess-1'), 'user_in_control');
    // Card #2's own allow button = 继续.
    h.channel.lastCard().resolve({ behavior: 'allow' });
    const result = await pending;
    const payload = resultPayload(result);
    assert.strictEqual(payload.handoffCompleted, true);
    assert.strictEqual(h.service.getControlState('sess-1'), 'agent_in_control');
  });

  it('AE1: a poisoned raw extraction still cannot leak a sensitive value into the tool result', async () => {
    const h = track(makeHarness());
    await h.call('open', { url: 'https://shop.example/checkout' });

    const pending = h.call('requestHandoff', { reason: 'Log in' });
    await flush();
    h.control.takeover('sess-1');
    await flush();

    // Hostile/buggy extractor fixture: the sensitive value IS present in the
    // raw extraction (the real in-page extractor never emits this). The
    // sidecar-side ruleset mirror must drop it anyway.
    const poisoned = userDrivenExtraction();
    poisoned.forms[0].fields[1] = {
      ...poisoned.forms[0].fields[1],
      value: 'hunter2',
    };
    h.page.extraction = poisoned;

    h.control.handback('sess-1');
    const result = await pending;
    const serialized = JSON.stringify(resultPayload(result));
    assert.ok(!serialized.includes('hunter2'), 'sensitive value dropped by the sidecar ruleset');
    assert.ok(serialized.includes('user@example.com'));
  });
});

// ---------------------------------------------------------------------------
// Mutual exclusion (R6)
// ---------------------------------------------------------------------------

describe('browser-control mutual exclusion', () => {
  it('user_in_control gates act/submit with a recoverable browser_user_in_control error', async () => {
    const h = track(makeHarness());
    await h.call('open', { url: 'https://shop.example/checkout' });
    h.control.takeover('sess-1');
    assert.strictEqual(h.service.getControlState('sess-1'), 'user_in_control');

    const act = await h.call('act', { ref: 'e1-x', action: 'click' });
    assert.strictEqual(act.isError, true);
    assert.strictEqual(errorCode(act), 'browser_user_in_control');
    const actError = resultPayload(act).error as { stage: string; resolution: string };
    assert.ok(actError.resolution.length > 0, 'recoverable: carries a resolution path');

    const submit = await h.call('submit', { ref: 'e1-x' });
    assert.strictEqual(submit.isError, true);
    assert.strictEqual(errorCode(submit), 'browser_user_in_control');

    // After handback the same calls run (gate lifted — table: allow_tool_call).
    h.control.handback('sess-1');
    const snapshot = await h.call('snapshot', {});
    assert.strictEqual(snapshot.isError, undefined);
  });

  it('screenshot is hard-blocked during takeover; the sanitized model stays available', async () => {
    const h = track(makeHarness());
    await h.call('open', { url: 'https://shop.example/checkout' });

    const pending = h.call('requestHandoff', { reason: 'Log in' });
    await flush();
    h.control.takeover('sess-1');
    await flush();
    h.page.extraction = userDrivenExtraction();

    // Pixels cannot be sanitized — hard block (recoverable error, no capture).
    const shot = await h.call('snapshot', { screenshot: true });
    assert.strictEqual(shot.isError, true);
    assert.strictEqual(errorCode(shot), 'browser_user_in_control');
    assert.strictEqual(h.page.screenshots, 0, 'no pixel capture during takeover');

    // The distilled model stays available and carries no pixels/field values.
    const modelResult = await h.call('snapshot', {});
    assert.strictEqual(modelResult.isError, undefined);
    assert.strictEqual(
      modelResult.content.some((block) => block.type === 'image'),
      false,
      'no image block',
    );
    const serialized = JSON.stringify(resultPayload(modelResult));
    assert.ok(!serialized.includes('hunter2'));

    h.control.handback('sess-1');
    await pending;
  });
});

// ---------------------------------------------------------------------------
// Timeout (R8, AE4) + activity pings (KTD-6)
// ---------------------------------------------------------------------------

describe('browser-control handoff timeout (AE4)', () => {
  it('pending-phase timeout uses timeoutDeny semantics and stays recoverable; the user can take over afterwards', async () => {
    const h = track(makeHarness());
    await h.call('open', { url: 'https://shop.example/checkout' });

    const pending = h.call('requestHandoff', { reason: 'Log in' });
    await flush();
    assert.strictEqual(h.service.getControlState('sess-1'), 'handoff_pending');

    // Server-fixed timer fires: timeoutDeny on card #1 (approval_timeout + deny).
    h.timer.fireLatest();
    const result = await pending;
    assert.strictEqual(result.isError, undefined, 'recoverable — a plain result, not an error');
    const payload = resultPayload(result);
    assert.strictEqual(payload.handoffCompleted, false);
    assert.strictEqual(payload.reason, 'timeout');
    assert.ok(String(payload.detail).includes('10 minutes'), 'agent gets the chat explanation (R8)');
    assert.deepStrictEqual(h.channel.timeouts, ['browser-handoff-sess-1-1']);
    assert.strictEqual(h.service.getControlState('sess-1'), 'agent_in_control');
    assert.strictEqual(h.control.getHandoff('sess-1'), undefined);

    // The user comes back later and takes over proactively (F3) — task resumes.
    assert.strictEqual(h.control.takeover('sess-1').ok, true);
    assert.strictEqual(h.service.getControlState('sess-1'), 'user_in_control');
    h.control.handback('sess-1');
    assert.strictEqual(h.service.getControlState('sess-1'), 'agent_in_control');
  });

  it('takeover-phase timeout releases card #2 and still returns the state diff', async () => {
    const h = track(makeHarness());
    await h.call('open', { url: 'https://shop.example/checkout' });

    const pending = h.call('requestHandoff', { reason: 'Log in' });
    await flush();
    h.control.takeover('sess-1');
    await flush();
    h.page.extraction = userDrivenExtraction();

    h.timer.fireLatest();
    const result = await pending;
    assert.strictEqual(result.isError, undefined);
    const payload = resultPayload(result);
    assert.strictEqual(payload.handoffCompleted, false);
    assert.strictEqual(payload.reason, 'timeout');
    assert.deepStrictEqual(h.channel.timeouts, ['browser-handoff-sess-1-2']);
    // The user had acted before walking away: the diff still reports it (sanitized).
    assert.ok(payload.delta, 'takeover-phase timeout keeps the state diff');
    const serialized = JSON.stringify(payload);
    assert.ok(serialized.includes('user@example.com'));
    assert.ok(!serialized.includes('hunter2'));
    assert.strictEqual(h.service.getControlState('sess-1'), 'agent_in_control');
  });

  it('a content-free activity ping resets the server-fixed timer (KTD-6)', async () => {
    const h = track(makeHarness());
    await h.call('open', { url: 'https://shop.example/checkout' });

    const pending = h.call('requestHandoff', { reason: 'Log in' });
    await flush();
    assert.strictEqual(h.timer.handles.length, 1);
    assert.strictEqual(h.timer.activeCount(), 1);

    h.control.recordActivity('sess-1');
    assert.strictEqual(h.timer.handles.length, 2, 'a fresh timer was armed');
    assert.strictEqual(h.timer.handles[0].cleared, true, 'the old timer was cancelled');
    assert.strictEqual(h.timer.activeCount(), 1);

    // Only the NEW timer can fire the timeout.
    h.timer.fireLatest();
    const result = await pending;
    assert.strictEqual(resultPayload(result).reason, 'timeout');
  });
});

// ---------------------------------------------------------------------------
// Races and declines
// ---------------------------------------------------------------------------

describe('browser-control races and declines', () => {
  it('handoff requested during an F3 takeover: its card is the single active card', async () => {
    const h = track(makeHarness());
    await h.call('open', { url: 'https://shop.example/checkout' });

    // F3 proactive takeover first — no card, no timer.
    h.control.takeover('sess-1');
    assert.strictEqual(h.service.getControlState('sess-1'), 'user_in_control');

    const pending = h.call('requestHandoff', { reason: 'Please finish the login' });
    await flush();
    // State stays user_in_control; exactly ONE card (the handback wait) exists.
    assert.strictEqual(h.service.getControlState('sess-1'), 'user_in_control');
    assert.strictEqual(h.channel.cards.length, 1, 'the pending card is the single active card');
    assert.strictEqual(h.channel.cards[0].request.payload.phase, 'handback');

    h.page.extraction = userDrivenExtraction();
    h.control.handback('sess-1');
    const result = await pending;
    const payload = resultPayload(result);
    assert.strictEqual(payload.handoffCompleted, true);
    assert.ok(payload.delta);
    assert.strictEqual(h.service.getControlState('sess-1'), 'agent_in_control');
  });

  it('a second handoff request while one is pending fails recoverably', async () => {
    const h = track(makeHarness());
    await h.call('open', { url: 'https://shop.example/checkout' });

    const first = h.call('requestHandoff', { reason: 'first' });
    await flush();
    const second = await h.call('requestHandoff', { reason: 'second' });
    assert.strictEqual(second.isError, true);
    assert.strictEqual(errorCode(second), 'browser_handoff_already_pending');
    // Exactly one card exists — the first handoff is unaffected.
    assert.strictEqual(h.channel.cards.length, 1);

    h.control.takeover('sess-1');
    await flush();
    h.control.handback('sess-1');
    const firstResult = await first;
    assert.strictEqual(resultPayload(firstResult).handoffCompleted, true);
  });

  it('user denies the takeover card → declined, no diff, state restored', async () => {
    const h = track(makeHarness());
    await h.call('open', { url: 'https://shop.example/checkout' });

    const pending = h.call('requestHandoff', { reason: 'Log in' });
    await flush();
    h.channel.lastCard().resolve({ behavior: 'deny', message: 'User denied this tool call.' });
    const result = await pending;
    assert.strictEqual(result.isError, undefined);
    const payload = resultPayload(result);
    assert.strictEqual(payload.handoffCompleted, false);
    assert.strictEqual(payload.reason, 'declined');
    assert.strictEqual(payload.delta, undefined, 'no takeover happened — no diff');
    assert.strictEqual(h.service.getControlState('sess-1'), 'agent_in_control');
    assert.strictEqual(h.timer.activeCount(), 0);
  });

  it('handback click while the takeover card is still pending declines the handoff (table cell)', async () => {
    const h = track(makeHarness());
    await h.call('open', { url: 'https://shop.example/checkout' });

    const pending = h.call('requestHandoff', { reason: 'Log in' });
    await flush();
    assert.strictEqual(
      BROWSER_CONTROL_TRANSITIONS.handoff_pending.handback_click.effect,
      'decline_handoff',
    );
    h.control.handback('sess-1');
    const result = await pending;
    const payload = resultPayload(result);
    assert.strictEqual(payload.reason, 'declined');
    assert.deepStrictEqual(h.channel.resolutions, [
      {
        requestId: 'browser-handoff-sess-1-1',
        result: 'deny',
        message: 'The user continued without taking over.',
      },
    ]);
    assert.strictEqual(
      h.service.getControlState('sess-1'),
      BROWSER_CONTROL_TRANSITIONS.handoff_pending.handback_click.next,
    );
  });
});

// ---------------------------------------------------------------------------
// Crash and runtime close (KTD-5)
// ---------------------------------------------------------------------------

describe('browser-control crash and runtime close', () => {
  it('crash while the takeover card is pending releases the card and lands session_lost', async () => {
    const h = track(makeHarness());
    await h.call('open', { url: 'https://shop.example/checkout' });

    const pending = h.call('requestHandoff', { reason: 'Log in' });
    await flush();
    h.handles[0].crash();

    const result = await pending;
    assert.strictEqual(result.isError, true);
    assert.strictEqual(errorCode(result), 'browser_session_lost');
    assert.deepStrictEqual(h.channel.resolutions.map((r) => [r.requestId, r.result]), [
      ['browser-handoff-sess-1-1', 'deny'],
    ]);
    assert.ok(h.channel.resolutions[0].message?.includes('crashed'));
    assert.strictEqual(h.service.getControlState('sess-1'), 'session_lost');
    assert.strictEqual(h.control.getHandoff('sess-1'), undefined);
    assert.ok(browserStateValues(h.events).includes('session_lost'));
  });

  it('crash mid-takeover releases the handback card and lands session_lost', async () => {
    const h = track(makeHarness());
    await h.call('open', { url: 'https://shop.example/checkout' });

    const pending = h.call('requestHandoff', { reason: 'Log in' });
    await flush();
    h.control.takeover('sess-1');
    await flush();
    assert.strictEqual(h.channel.cards.length, 2);

    h.handles[0].crash();
    const result = await pending;
    assert.strictEqual(result.isError, true);
    assert.strictEqual(errorCode(result), 'browser_session_lost');
    assert.deepStrictEqual(h.channel.resolutions.map((r) => [r.requestId, r.result]), [
      ['browser-handoff-sess-1-1', 'allow'], // the takeover grant
      ['browser-handoff-sess-1-2', 'deny'], // the crash release
    ]);
    assert.strictEqual(h.service.getControlState('sess-1'), 'session_lost');
    assert.strictEqual(h.control.getHandoff('sess-1'), undefined);
  });

  it('runtime close mid-handoff resolves recoverably; the browser survives (KTD-5)', async () => {
    const h = track(makeHarness());
    await h.call('open', { url: 'https://shop.example/checkout' });

    const pending = h.call('requestHandoff', { reason: 'Log in' });
    await flush();
    // chat-service fires the chained pre-close listener BEFORE runtime.close()
    // resolves the card with its generic deny.
    h.control.handleRuntimeClosing('sess-1');
    h.channel.lastCard().resolve({
      behavior: 'deny',
      message: 'Session closed while waiting for approval: browser-handoff-sess-1-1',
    });

    const result = await pending;
    assert.strictEqual(result.isError, undefined);
    const payload = resultPayload(result);
    assert.strictEqual(payload.handoffCompleted, false);
    assert.strictEqual(payload.reason, 'runtime_closed');
    assert.strictEqual(h.service.getControlState('sess-1'), 'agent_in_control');
    assert.strictEqual(h.control.getHandoff('sess-1'), undefined);
    // The Steel process was never touched — the browser outlives the runtime.
    assert.strictEqual(h.handles.length, 1);
    assert.strictEqual(h.service.getSession('sess-1') !== undefined, true);
  });

  it('session switching keeps the server-side control state (capture release is client-side)', async () => {
    const h = track(makeHarness());
    await h.call('open', { url: 'https://shop.example/checkout' });
    h.control.takeover('sess-1');
    assert.strictEqual(h.service.getControlState('sess-1'), 'user_in_control');

    // Switching chat sessions is a client concern: NO server call happens and
    // the state machine must not move (U6 releases the key/mouse capture).
    const eventsBefore = h.events.length;
    await flush();
    assert.strictEqual(h.events.length, eventsBefore, 'no browser_state churn on a session switch');
    assert.strictEqual(h.service.getControlState('sess-1'), 'user_in_control');

    // Returning: the user hands back as usual.
    h.control.handback('sess-1');
    assert.strictEqual(h.service.getControlState('sess-1'), 'agent_in_control');
  });
});

// ---------------------------------------------------------------------------
// browser_state WebSocket channel (KTD-9)
// ---------------------------------------------------------------------------

interface FakeSocket {
  readyState: number;
  sent: Array<Record<string, unknown>>;
  send: (msg: string) => void;
}

function makeFakeSocket(): FakeSocket {
  const socket: FakeSocket = {
    readyState: WebSocket.OPEN,
    sent: [],
    send(msg: string) {
      socket.sent.push(JSON.parse(msg) as Record<string, unknown>);
    },
  };
  return socket;
}

describe('browser_state channel', () => {
  it('subscription is passive: hydrates the empty state without creating a browser session', async () => {
    const h = track(makeHarness());
    const channel = new BrowserStateChannel(h.service);
    const socket = makeFakeSocket();

    channel.subscribe('sess-1', 'ws-1', socket as unknown as WebSocket);
    assert.strictEqual(socket.sent.length, 1, 'hydration pushed on subscribe');
    const hydration = socket.sent[0] as {
      eventType: string;
      sessionId: string;
      data: { state: string; port?: number };
    };
    assert.strictEqual(hydration.eventType, 'browser_state');
    assert.strictEqual(hydration.sessionId, 'sess-1');
    assert.strictEqual(hydration.data.state, 'none');
    // Passive: no Steel process was spawned and the registry stays empty
    // (the channel structurally cannot create runtimes — it only reads
    // browser-service's registry).
    assert.strictEqual(h.service.listSessions().length, 0);
    assert.strictEqual(h.handles.length, 0);
  });

  it('hydrates the current state and forwards every state-machine migration', async () => {
    const h = track(makeHarness());
    const channel = new BrowserStateChannel(h.service);
    const socket = makeFakeSocket();

    await h.service.ensureSession({ sessionId: 'sess-1', workspaceId: 'ws-1' });
    channel.subscribe('sess-1', 'ws-1', socket as unknown as WebSocket);
    const hydration = socket.sent[0] as { data: { state: string; port?: number } };
    assert.strictEqual(hydration.data.state, 'agent_in_control');
    assert.strictEqual(typeof hydration.data.port, 'number');

    h.service.setControlState('sess-1', 'user_in_control', 'user_takeover');
    h.handles[0].crash();
    const forwarded = socket.sent.slice(1).map((msg) => (msg as { data: { state: string } }).data.state);
    assert.deepStrictEqual(forwarded, ['user_in_control', 'session_lost']);
  });

  it('forwards browser_unavailable and browser_closed on the same channel', async () => {
    const h = track(makeHarness());
    const channel = new BrowserStateChannel(h.service);
    const socket = makeFakeSocket();

    await h.service.ensureSession({ sessionId: 'sess-1', workspaceId: 'ws-1' });
    channel.subscribe('sess-1', 'ws-1', socket as unknown as WebSocket);
    await h.service.teardownSession('sess-1');
    const closed = socket.sent.find((msg) => (msg as { eventType: string }).eventType === 'browser_closed');
    assert.ok(closed, 'browser_closed forwarded to subscribers');
  });

  it('unsubscribe and disconnect cleanup stop the event flow', async () => {
    const h = track(makeHarness());
    const channel = new BrowserStateChannel(h.service);
    const socketA = makeFakeSocket();
    const socketB = makeFakeSocket();

    await h.service.ensureSession({ sessionId: 'sess-1', workspaceId: 'ws-1' });
    await h.service.ensureSession({ sessionId: 'sess-2', workspaceId: 'ws-1' });
    channel.subscribe('sess-1', 'ws-1', socketA as unknown as WebSocket);
    channel.subscribe('sess-2', 'ws-1', socketA as unknown as WebSocket);
    channel.subscribe('sess-1', 'ws-1', socketB as unknown as WebSocket);
    assert.strictEqual(channel.subscriberCount('sess-1'), 2);

    // Single-session unsubscribe: socketA still follows sess-2.
    channel.unsubscribe('sess-1', socketA as unknown as WebSocket);
    assert.strictEqual(channel.subscriberCount('sess-1'), 1);
    h.service.setControlState('sess-1', 'user_in_control');
    assert.strictEqual(socketA.sent.length, 2, 'no sess-1 events after unsubscribe (2 hydrations)');
    assert.strictEqual(socketB.sent.length, 2, 'socketB got hydration + transition');

    // Disconnect: every subscription the socket held is dropped.
    channel.unsubscribeSocket(socketA as unknown as WebSocket);
    assert.strictEqual(channel.subscriberCount('sess-2'), 0);
    h.service.setControlState('sess-2', 'user_in_control');
    assert.strictEqual(socketA.sent.length, 2, 'no events after disconnect cleanup');
  });
});
