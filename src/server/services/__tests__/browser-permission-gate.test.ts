import '../../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Options, PermissionResult, Query, SDKSessionInfo, SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { SessionRuntime } from '../session-runtime.js';
import type { SdkClient } from '../sdk-client.js';
import type { SseEvent } from '../../types/message.js';
import type { Provider } from '../../models/provider.js';
import {
  clearBrowserGateSession,
  commitSessionNavigation,
  evaluateSessionNavigation,
  getVisitedDomains,
  isBrowserSubmitClassified,
  redactSubmitGateInput,
  registrableDomain,
  setSubmitSemanticsRefs,
} from '../browser-gate-state.js';
import { BROWSER_TOOL_NAMES, BROWSER_TOOL_PREFIX } from '../browser-tool-names.js';
import {
  ALLOW_ALL_PRESET,
  SAFE_PRESET,
} from '../tool-permission-policy.js';
import { evaluateBotToolPermission } from '../bot-policy.js';
import { ChatService } from '../chat-service.js';
import { SdkClient as RealSdkClient } from '../sdk-client.js';
import { store as workspaceStore } from '../../storage/sqlite-store.js';
import { botService } from '../bot-service.js';
import type { ChatSession } from '../../models/session.js';
import type { Workspace } from '../../models/workspace.js';
import {
  createCorsOriginCallback,
  hostHeaderGuard,
  stateChangingRequestGuard,
} from '../security/request-origin-guard.js';

/**
 * U4: browser permission gates.
 *  - canUseTool-layer submit classification (first gate + UI entry, KTD-4 ②)
 *  - auto-mode first-cross-domain navigation confirmation + audit markers
 *  - readonly-mode snapshot/extract auto-approval
 *  - bot triple defense: explicit deny on BOTH bot canUseTool paths (dynamic
 *    bot-level + legacy workspace-level), admin included; category backstop
 *  - U9-dependent drive-by fixture: cross-origin POST resolving an approval
 */

// ---------------------------------------------------------------------------
// Pure gate-state: registrableDomain + navigation ledger + classification
// ---------------------------------------------------------------------------

describe('registrableDomain (eTLD+1 heuristic; U8 swaps in tldts)', () => {
  it('collapses subdomains to the registrable domain', () => {
    assert.strictEqual(registrableDomain(new URL('https://example.com/x')), 'example.com');
    assert.strictEqual(registrableDomain(new URL('https://a.b.example.com')), 'example.com');
    assert.strictEqual(registrableDomain(new URL('https://EXAMPLE.com.')), 'example.com');
  });

  it('respects well-known second-level suffixes', () => {
    assert.strictEqual(registrableDomain(new URL('https://shop.example.co.uk')), 'example.co.uk');
    assert.strictEqual(registrableDomain(new URL('https://example.co.uk')), 'example.co.uk');
    assert.strictEqual(registrableDomain(new URL('https://a.com.au')), 'a.com.au');
  });

  it('keeps the port for localhost, single-label, and IP hosts', () => {
    assert.strictEqual(registrableDomain(new URL('http://localhost:3000')), 'localhost:3000');
    assert.strictEqual(registrableDomain(new URL('http://localhost:8080')), 'localhost:8080');
    assert.strictEqual(registrableDomain(new URL('http://127.0.0.1:3000/x')), '127.0.0.1:3000');
    assert.strictEqual(registrableDomain(new URL('http://intranet:9000')), 'intranet:9000');
  });

  it('is port-insensitive for multi-label hosts', () => {
    assert.strictEqual(registrableDomain(new URL('https://example.com:8443')), 'example.com');
  });
});

describe('session navigation ledger', () => {
  const SESSION = 'nav-ledger-test';
  afterEach(() => clearBrowserGateSession(SESSION));

  it('first visit → allow+firstVisit; first crossing → needs-confirm; later crossings → audit-allow', () => {
    const first = evaluateSessionNavigation(SESSION, 'https://home.example.com');
    assert.deepStrictEqual(first, {
      kind: 'allow',
      domain: 'example.com',
      firstVisit: true,
      auditCrossing: false,
    });
    commitSessionNavigation(SESSION, 'example.com');

    // Same domain again → allow, no firstVisit, no audit.
    const revisit = evaluateSessionNavigation(SESSION, 'https://home.example.com/other');
    assert.deepStrictEqual(revisit, {
      kind: 'allow',
      domain: 'example.com',
      firstVisit: false,
      auditCrossing: false,
    });

    // First crossing → needs-confirm (nothing committed yet).
    const cross = evaluateSessionNavigation(SESSION, 'https://other.example.org');
    assert.deepStrictEqual(cross, { kind: 'needs-confirm', domain: 'example.org' });

    // Re-evaluating before the confirmation resolves still asks.
    assert.strictEqual(
      evaluateSessionNavigation(SESSION, 'https://other.example.org').kind,
      'needs-confirm',
    );

    commitSessionNavigation(SESSION, 'example.org', { confirmedCrossing: true });

    // The confirmed domain is now visited.
    assert.strictEqual(
      evaluateSessionNavigation(SESSION, 'https://other.example.org/more').kind,
      'allow',
    );

    // A further new domain passes with an audit marker (no more confirmations).
    const third = evaluateSessionNavigation(SESSION, 'https://third.example.net');
    assert.deepStrictEqual(third, {
      kind: 'allow',
      domain: 'example.net',
      firstVisit: false,
      auditCrossing: true,
    });
    commitSessionNavigation(SESSION, 'example.net');
    assert.deepStrictEqual(
      getVisitedDomains(SESSION).sort(),
      ['example.com', 'example.net', 'example.org'],
    );
  });

  it('treats unparseable and non-http(s) URLs as invalid (caller falls through)', () => {
    assert.strictEqual(evaluateSessionNavigation(SESSION, 'not a url').kind, 'invalid');
    assert.strictEqual(evaluateSessionNavigation(SESSION, 'file:///etc/passwd').kind, 'invalid');
  });
});

describe('submit classification (canUseTool-layer rules)', () => {
  const SESSION = 'classification-test';
  afterEach(() => clearBrowserGateSession(SESSION));

  it('submit tool is always submit-classified', () => {
    assert.ok(isBrowserSubmitClassified(SESSION, BROWSER_TOOL_NAMES.submit, { ref: 'e1-aa' }));
    assert.ok(isBrowserSubmitClassified(SESSION, BROWSER_TOOL_NAMES.submit, {}));
  });

  it('act click is classified only for refs with submit semantics', () => {
    setSubmitSemanticsRefs(SESSION, ['e5-ab', 'e9-cd']);
    assert.ok(isBrowserSubmitClassified(SESSION, BROWSER_TOOL_NAMES.act, { ref: 'e5-ab', action: 'click' }));
    assert.ok(!isBrowserSubmitClassified(SESSION, BROWSER_TOOL_NAMES.act, { ref: 'e2-zz', action: 'click' }));
    // fill/select/check never submit through act.
    assert.ok(!isBrowserSubmitClassified(SESSION, BROWSER_TOOL_NAMES.act, { ref: 'e5-ab', action: 'fill', value: 'x' }));
    // Other tools never classify.
    assert.ok(!isBrowserSubmitClassified(SESSION, BROWSER_TOOL_NAMES.open, { url: 'https://x.example' }));
    assert.ok(!isBrowserSubmitClassified(SESSION, 'Bash', { command: 'ls' }));
  });

  it('ref updates and clears are reflected immediately', () => {
    setSubmitSemanticsRefs(SESSION, ['e5-ab']);
    assert.ok(isBrowserSubmitClassified(SESSION, BROWSER_TOOL_NAMES.act, { ref: 'e5-ab', action: 'click' }));
    setSubmitSemanticsRefs(SESSION, []);
    assert.ok(!isBrowserSubmitClassified(SESSION, BROWSER_TOOL_NAMES.act, { ref: 'e5-ab', action: 'click' }));
  });

  it('redactSubmitGateInput strips field values but keeps field names', () => {
    const redacted = redactSubmitGateInput(BROWSER_TOOL_NAMES.submit, {
      ref: 'e3-aa',
      fields: { username: 'alice', password: 's3cret' },
    });
    assert.deepStrictEqual(Object.keys(redacted.fields as Record<string, string>).sort(), ['password', 'username']);
    for (const value of Object.values(redacted.fields as Record<string, string>)) {
      assert.ok(!value.includes('s3cret') && !value.includes('alice'), 'values must be redacted');
    }
    assert.strictEqual(redacted.ref, 'e3-aa');
    // Non-submit input passes through untouched.
    const passthrough = { ref: 'e1', action: 'click' };
    assert.strictEqual(redactSubmitGateInput(BROWSER_TOOL_NAMES.act, passthrough), passthrough);
  });
});

// ---------------------------------------------------------------------------
// SessionRuntime canUseTool gates
// ---------------------------------------------------------------------------

type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    suggestions?: unknown[];
    title?: string;
    description?: string;
    toolUseID: string;
    decisionReasonType?: string;
    requestId: string;
  },
) => Promise<PermissionResult | null>;

function createCapturingSdkClient(): {
  sdkClient: SdkClient;
  captured: { canUseTool?: CanUseToolFn };
} {
  const captured: { canUseTool?: CanUseToolFn } = {};
  const mockQuery = {
    interrupt: () => Promise.resolve(),
    close: () => {},
  } as unknown as Query;
  const sdkClient = {
    createStreamingQuery: (_input: unknown, options: Options) => {
      captured.canUseTool = options.canUseTool as unknown as CanUseToolFn;
      return { query: mockQuery, messages: (async function* () {})() };
    },
  } as unknown as SdkClient;
  return { sdkClient, captured };
}

const KIMI_PROVIDER: Provider = {
  id: 'p-kimi',
  name: 'Kimi',
  baseUrl: 'https://api.moonshot.cn',
  authToken: 'test',
  model: 'kimi-k2',
  isDefault: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('session-runtime browser gates', { concurrency: false }, () => {
  const SESSION = 'gate-runtime-test';
  let runtime: SessionRuntime | undefined;
  let captured: { canUseTool?: CanUseToolFn };
  let events: SseEvent[];

  beforeEach(() => {
    clearBrowserGateSession(SESSION);
    events = [];
  });

  afterEach(async () => {
    if (runtime && !runtime.isClosed()) {
      await runtime.close();
    }
    runtime = undefined;
    clearBrowserGateSession(SESSION);
  });

  function openRuntime(provider?: Provider): void {
    const { sdkClient, captured: cap } = createCapturingSdkClient();
    captured = cap;
    runtime = SessionRuntime.open(
      SESSION,
      'ws-1',
      'nonce',
      {} as Options,
      sdkClient,
      undefined,
      undefined,
      undefined,
      undefined,
      provider,
    );
    runtime.addWebEventHandler((_id, event) => {
      events.push(event);
    });
    assert.ok(captured.canUseTool, 'runtime must install a canUseTool callback');
  }

  function callTool(
    toolName: string,
    input: Record<string, unknown>,
    requestId: string,
  ): Promise<PermissionResult | null> {
    return captured.canUseTool!(toolName, input, {
      signal: new AbortController().signal,
      toolUseID: `tu-${requestId}`,
      requestId,
    });
  }

  function pendingApprovalEvents(): Array<Extract<SseEvent, { type: 'pending_approval' }>> {
    return events.filter(
      (e): e is Extract<SseEvent, { type: 'pending_approval' }> => e.type === 'pending_approval',
    );
  }

  it('AE2 first gate: auto mode + submit tool → per-call confirmation, not auto-approval', async () => {
    openRuntime();
    runtime!.setApprovalMode('auto');
    const promise = callTool(BROWSER_TOOL_NAMES.submit, { ref: 'e3-aa', fields: { user: 'alice' } }, 'r-submit');
    // The call must NOT resolve by itself — it waits on the user.
    const pending = pendingApprovalEvents();
    assert.strictEqual(pending.length, 1, 'submit must emit a pending approval in auto mode');
    assert.strictEqual(pending[0].toolName, BROWSER_TOOL_NAMES.submit);
    assert.strictEqual(events.some((e) => e.type === 'auto_approval'), false, 'no auto-approval for submits');
    runtime!.resolveApproval('r-submit', { behavior: 'allow' });
    const result = await promise;
    assert.strictEqual(result?.behavior, 'allow');
  });

  it('first gate redacts submit field values in the pending card input (KTD-8)', async () => {
    openRuntime();
    runtime!.setApprovalMode('auto');
    const promise = callTool(
      BROWSER_TOOL_NAMES.submit,
      { ref: 'e3-aa', fields: { username: 'alice', password: 's3cret-value' } },
      'r-redact',
    );
    const pending = pendingApprovalEvents();
    assert.strictEqual(pending.length, 1);
    const cardInput = pending[0].input as { fields?: Record<string, string> };
    assert.deepStrictEqual(Object.keys(cardInput.fields ?? {}).sort(), ['password', 'username']);
    const serialized = JSON.stringify(cardInput);
    assert.ok(!serialized.includes('s3cret-value'), 'password value must not enter the approval stream');
    assert.ok(!serialized.includes('alice'), 'field values must not enter the approval stream');
    runtime!.resolveApproval('r-redact', { behavior: 'deny', message: 'no' });
    const result = await promise;
    assert.strictEqual(result?.behavior, 'deny');
  });

  it('submit is gated in manual and readonly modes too (not only auto)', async () => {
    openRuntime();
    runtime!.setApprovalMode('readonly');
    const promise = callTool(BROWSER_TOOL_NAMES.submit, { ref: 'e3-aa' }, 'r-readonly-submit');
    assert.strictEqual(pendingApprovalEvents().length, 1);
    runtime!.resolveApproval('r-readonly-submit', { behavior: 'allow' });
    assert.strictEqual((await promise)?.behavior, 'allow');
  });

  it('classification: act click on a submit-semantics ref is gated; ordinary link click follows the mode', async () => {
    openRuntime();
    runtime!.setApprovalMode('auto');
    setSubmitSemanticsRefs(SESSION, ['e5-ab']);

    const gatedPromise = callTool(BROWSER_TOOL_NAMES.act, { ref: 'e5-ab', action: 'click' }, 'r-act-submit');
    assert.strictEqual(pendingApprovalEvents().length, 1, 'submit-semantics click must ask in auto mode');
    runtime!.resolveApproval('r-act-submit', { behavior: 'allow' });
    assert.strictEqual((await gatedPromise)?.behavior, 'allow');

    const linkResult = await callTool(BROWSER_TOOL_NAMES.act, { ref: 'e7-zz', action: 'click' }, 'r-act-link');
    assert.strictEqual(linkResult?.behavior, 'allow', 'ordinary click auto-approves');
    assert.strictEqual(pendingApprovalEvents().length, 1, 'no extra card for ordinary clicks');

    const fillResult = await callTool(BROWSER_TOOL_NAMES.act, { ref: 'e5-ab', action: 'fill', value: 'x' }, 'r-act-fill');
    assert.strictEqual(fillResult?.behavior, 'allow', 'fill follows the approval mode even on submit-semantics refs');
  });

  it('readonly mode auto-approves snapshot/extract but not act/open/submit', async () => {
    openRuntime();
    runtime!.setApprovalMode('readonly');

    const snapshot = await callTool(BROWSER_TOOL_NAMES.snapshot, {}, 'r-snap');
    assert.strictEqual(snapshot?.behavior, 'allow');
    const extract = await callTool(BROWSER_TOOL_NAMES.extract, { schema: { t: { source: 'text' } } }, 'r-extract');
    assert.strictEqual(extract?.behavior, 'allow');
    const readonlyEvents = events.filter((e) => e.type === 'auto_approval');
    assert.strictEqual(readonlyEvents.length, 2);

    const actPromise = callTool(BROWSER_TOOL_NAMES.act, { ref: 'e1-aa', action: 'click' }, 'r-act-ro');
    assert.strictEqual(pendingApprovalEvents().length, 1, 'act must ask in readonly mode');
    runtime!.resolveApproval('r-act-ro', { behavior: 'deny', message: 'no' });
    assert.strictEqual((await actPromise)?.behavior, 'deny');
  });

  it('hard gate lives in the base callback (Kimi wrapper cannot skip it)', async () => {
    openRuntime(KIMI_PROVIDER);
    runtime!.setApprovalMode('auto');
    const promise = callTool(BROWSER_TOOL_NAMES.submit, { ref: 'e3-aa' }, 'r-kimi-submit');
    assert.strictEqual(pendingApprovalEvents().length, 1, 'submit must still be gated under the Kimi wrapper');
    runtime!.resolveApproval('r-kimi-submit', { behavior: 'allow' });
    assert.strictEqual((await promise)?.behavior, 'allow');
  });

  it('auto mode navigation: first visit passes, first crossing asks once, later crossings pass with an audit marker', async () => {
    // U8: the audit markers are now real browser_audit rows (the U4 diagLog
    // placeholders are gone). The runtime's workspaceId is 'ws-1'.
    workspaceStore.deleteBrowserAuditForWorkspace('ws-1');
    openRuntime();
    runtime!.setApprovalMode('auto');

    // First navigation establishes the home domain — no card.
    const first = await callTool(BROWSER_TOOL_NAMES.open, { url: 'https://home.example.com' }, 'r-nav-1');
    assert.strictEqual(first?.behavior, 'allow');
    assert.strictEqual(pendingApprovalEvents().length, 0);

    // Same-domain navigation passes silently.
    const sameDomain = await callTool(BROWSER_TOOL_NAMES.open, { url: 'https://home.example.com/page2' }, 'r-nav-2');
    assert.strictEqual(sameDomain?.behavior, 'allow');
    assert.strictEqual(pendingApprovalEvents().length, 0);

    // First cross-domain navigation → one confirmation with the navigation payload.
    const crossPromise = callTool(BROWSER_TOOL_NAMES.open, { url: 'https://other.example.org/login' }, 'r-nav-3');
    const pending = pendingApprovalEvents();
    assert.strictEqual(pending.length, 1, 'first cross-domain navigation must ask');
    const navInput = pending[0].input as { kind?: string; domain?: string; url?: string };
    assert.strictEqual(navInput.kind, 'browser_navigation');
    assert.strictEqual(navInput.domain, 'example.org');
    runtime!.resolveApproval('r-nav-3', { behavior: 'allow' });
    assert.strictEqual((await crossPromise)?.behavior, 'allow');
    const confirmedRow = workspaceStore
      .listBrowserAudit('ws-1')
      .find((row) => row.category === 'navigation' && row.action === 'first-cross-confirmed');
    assert.ok(confirmedRow, 'confirmed crossing must leave an audit row');
    assert.strictEqual(confirmedRow!.siteKey, 'example.org');
    assert.strictEqual(confirmedRow!.outcome, 'ok');

    // Revisiting the confirmed domain passes silently.
    const revisit = await callTool(BROWSER_TOOL_NAMES.open, { url: 'https://other.example.org/more' }, 'r-nav-4');
    assert.strictEqual(revisit?.behavior, 'allow');
    assert.strictEqual(pendingApprovalEvents().length, 1, 'no second card for a visited domain');

    // A further new domain passes without a card but leaves an audit marker.
    const third = await callTool(BROWSER_TOOL_NAMES.open, { url: 'https://third.example.net' }, 'r-nav-5');
    assert.strictEqual(third?.behavior, 'allow');
    assert.strictEqual(pendingApprovalEvents().length, 1, 'later crossings do not ask again');
    const laterRow = workspaceStore
      .listBrowserAudit('ws-1')
      .find((row) => row.category === 'navigation' && row.action === 'cross-domain-auto');
    assert.ok(laterRow, 'later crossings must leave an audit row');
    assert.strictEqual(laterRow!.siteKey, 'example.net');
  });

  it('denied first-cross confirmation does not mark the domain visited', async () => {
    openRuntime();
    runtime!.setApprovalMode('auto');
    await callTool(BROWSER_TOOL_NAMES.open, { url: 'https://home.example.com' }, 'r-deny-1');
    const crossPromise = callTool(BROWSER_TOOL_NAMES.open, { url: 'https://evil.example.org' }, 'r-deny-2');
    assert.strictEqual(pendingApprovalEvents().length, 1);
    runtime!.resolveApproval('r-deny-2', { behavior: 'deny', message: 'no' });
    assert.strictEqual((await crossPromise)?.behavior, 'deny');
    assert.deepStrictEqual(getVisitedDomains(SESSION), ['example.com']);
    // Next crossing to the same domain asks again.
    const retryPromise = callTool(BROWSER_TOOL_NAMES.open, { url: 'https://evil.example.org' }, 'r-deny-3');
    assert.strictEqual(pendingApprovalEvents().length, 2, 'a denied domain must ask again');
    runtime!.resolveApproval('r-deny-3', { behavior: 'deny', message: 'no' });
    await retryPromise;
  });

  it('manual mode navigation asks through the generic card and records approved visits', async () => {
    openRuntime();
    runtime!.setApprovalMode('manual');
    const first = callTool(BROWSER_TOOL_NAMES.open, { url: 'https://home.example.com' }, 'r-man-1');
    assert.strictEqual(pendingApprovalEvents().length, 1, 'manual mode always asks');
    runtime!.resolveApproval('r-man-1', { behavior: 'allow' });
    assert.strictEqual((await first)?.behavior, 'allow');
    assert.deepStrictEqual(getVisitedDomains(SESSION), ['example.com']);
  });
});

// ---------------------------------------------------------------------------
// Bot canUseTool paths: explicit browser deny (triple defense, KTD-4 ③)
// ---------------------------------------------------------------------------

describe('bot-policy browser backstop', () => {
  it('owner/admin bypass does not apply to browser tools', () => {
    for (const role of ['owner', 'admin', 'normal'] as const) {
      assert.strictEqual(
        evaluateBotToolPermission(ALLOW_ALL_PRESET, role, `${BROWSER_TOOL_PREFIX}open`),
        'deny',
        `${role} must not reach browser tools`,
      );
    }
    // Sanity: owner still bypasses for ordinary categories.
    assert.strictEqual(evaluateBotToolPermission(SAFE_PRESET, 'owner', 'Bash'), 'allow');
  });
});

class GateMockSdkClient extends RealSdkClient {
  override async getSessionInfo(): Promise<SDKSessionInfo | undefined> {
    return {
      sessionId: 's1',
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

class GateTestChatService extends ChatService {
  constructor() {
    super(new GateMockSdkClient());
  }
  protected override async testClaudeBinary(): Promise<void> {}
}

function createMockRuntimeForBotPath(): SessionRuntime {
  return {
    isClosed: () => false,
    getStatus: () => ({ pendingCount: 0, isProcessing: false, workspaceId: 'ws-1' }),
    close: () => Promise.resolve(),
    subscribe: () => {},
    unsubscribe: () => {},
    pushMessage: () => {},
    resolveApproval: () => {},
    requestToolApproval: () => Promise.resolve({ behavior: 'allow' as const }),
    requestToolQuestion: () => Promise.resolve({ behavior: 'allow' as const }),
    interrupt: () => Promise.resolve(),
    addBotEventHandler: () => {},
    clearBotEventHandlers: () => {},
    removeBotEventHandler: () => {},
    setApprovalMode: () => {},
    getApprovalMode: () => 'manual' as const,
  } as unknown as SessionRuntime;
}

describe('bot canUseTool browser deny — legacy workspace-level path', { concurrency: false }, () => {
  let service: ChatService;
  const originalOpen = SessionRuntime.open;
  const originalGet = workspaceStore.get.bind(workspaceStore);
  const originalGetLocalSession = workspaceStore.getLocalSession.bind(workspaceStore);
  const originalGetDefaultProvider = workspaceStore.getDefaultProvider.bind(workspaceStore);
  const originalGetSessionUsers = workspaceStore.getSessionUsers.bind(workspaceStore);
  const originalGetBotUser = workspaceStore.getBotUser.bind(workspaceStore);
  const originalGetBotChannel = workspaceStore.getBotChannel.bind(workspaceStore);
  const originalListChannelUsers = botService.listChannelUsersForWorkspace.bind(botService);

  beforeEach(() => {
    service = new GateTestChatService();
  });

  afterEach(async () => {
    await service.closeAllRuntimes();
    SessionRuntime.open = originalOpen;
    workspaceStore.get = originalGet;
    workspaceStore.getLocalSession = originalGetLocalSession;
    workspaceStore.getDefaultProvider = originalGetDefaultProvider;
    workspaceStore.getSessionUsers = originalGetSessionUsers;
    workspaceStore.getBotUser = originalGetBotUser;
    workspaceStore.getBotChannel = originalGetBotChannel;
    botService.listChannelUsersForWorkspace = originalListChannelUsers;
  });

  async function captureLegacyCanUseTool(settings: Record<string, unknown>): Promise<NonNullable<Options['canUseTool']>> {
    const mockWorkspace = {
      id: 'ws-1',
      name: 'Test',
      description: '',
      folderPath: '/tmp/test',
      settings: { ...settings },
      skills: [],
      mcpServers: [],
      hooks: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Workspace;
    workspaceStore.get = async () => mockWorkspace;
    workspaceStore.getLocalSession = () =>
      ({
        id: 's1',
        workspaceId: 'ws-1',
        name: 'Test Session',
        isDraft: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }) as ChatSession;
    workspaceStore.getDefaultProvider = () =>
      ({
        id: 'p1',
        name: 'Test Provider',
        baseUrl: 'http://test',
        authToken: 'test',
        model: 'test-model',
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }) as Provider;
    workspaceStore.getSessionUsers = () => ['user-1'];
    workspaceStore.getBotUser = (userId: string) =>
      (userId === 'user-1'
        ? ({
            id: 'user-1',
            botId: 'bot-1',
            channelId: 'chan-1',
            roleId: 'role-1',
            channelKey: 'wecom',
            channelUserId: 'wecom-user-1',
            plaintextUserId: 'user1',
            createdAt: '',
            updatedAt: '',
            roleKey: 'normal',
            resolutionStatus: 'resolved',
          } as unknown as import('../../models/bot-user.js').BotUser)
        : null);
    workspaceStore.getBotChannel = (channelId: string) =>
      (channelId === 'chan-1'
        ? ({ id: 'chan-1', channelKey: 'wecom' } as unknown as import('../../models/bot.js').BotChannel)
        : null);
    botService.listChannelUsersForWorkspace = () => [];

    let capturedOptions: Options | undefined;
    SessionRuntime.open = (...args: unknown[]) => {
      capturedOptions = args[3] as Options;
      return createMockRuntimeForBotPath();
    };
    await service.getOrCreateRuntime('s1', 'ws-1', true);
    assert.ok(capturedOptions?.canUseTool, 'canUseTool must be set for bot sessions');
    return capturedOptions.canUseTool;
  }

  it('denies every browser tool with the generic anti-probing message', async () => {
    const canUseTool = await captureLegacyCanUseTool({ wecomBotEnabled: true });
    for (const toolName of Object.values(BROWSER_TOOL_NAMES)) {
      const result = await canUseTool(toolName, { url: 'https://x.example' });
      assert.strictEqual(result?.behavior, 'deny', `${toolName} must be denied`);
      assert.strictEqual(result?.message, "I can't do that in this workspace.");
      assert.ok(!result?.message?.toLowerCase().includes('browser'), 'message must not name the capability');
    }
    // Sanity: an unrelated MCP tool still falls through to allow (R10).
    const other = await canUseTool('mcp__other__tool', {});
    assert.strictEqual(other?.behavior, 'allow');
  });

  it('denies browser tools for workspace admins too (admin bypass void)', async () => {
    const canUseTool = await captureLegacyCanUseTool({
      wecomBotEnabled: true,
      wecomBotIsolation: { adminUserIds: ['user1'] },
    });
    const result = await canUseTool(BROWSER_TOOL_NAMES.submit, { ref: 'e1' });
    assert.strictEqual(result?.behavior, 'deny');
    assert.strictEqual(result?.message, "I can't do that in this workspace.");
  });

  it('denies browser tools even under an explicit allow-all workspace policy', async () => {
    const canUseTool = await captureLegacyCanUseTool({
      wecomBotEnabled: true,
      wecomToolPermissions: ALLOW_ALL_PRESET,
    });
    const result = await canUseTool(BROWSER_TOOL_NAMES.open, { url: 'https://x.example' });
    assert.strictEqual(result?.behavior, 'deny');
  });
});

describe('bot canUseTool browser deny — dynamic bot-level path (WeCom + Feishu)', { concurrency: false }, () => {
  let service: ChatService;
  const originalOpen = SessionRuntime.open;
  const tmpFolders: string[] = [];

  beforeEach(() => {
    service = new GateTestChatService();
  });

  afterEach(async () => {
    await service.closeAllRuntimes();
    SessionRuntime.open = originalOpen;
    for (const folder of tmpFolders) {
      try {
        fs.rmSync(folder, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    tmpFolders.length = 0;
  });

  async function setupDynamicBotSession(
    channel: 'wecom' | 'feishu',
    role: 'normal' | 'admin' | 'owner',
  ): Promise<NonNullable<Options['canUseTool']>> {
    workspaceStore.resetData();
    const folderPath = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-gate-bot-'));
    tmpFolders.push(folderPath);
    const workspace = await workspaceStore.create({
      name: 'Browser Gate Workspace',
      folderPath,
      settings: {},
    });
    const provider = workspaceStore.createProvider({
      name: 'Test Provider',
      baseUrl: 'http://test',
      authToken: 'test',
      model: 'test-model',
      isDefault: true,
    });
    const bot = botService.createBot({ name: 'Gate Bot', activeWorkspaceId: workspace.id });
    botService.updateChannelSettings(
      bot.id,
      channel,
      channel === 'feishu'
        ? { enabled: true, appId: 'cli-test', appSecret: 'secret' }
        : { enabled: true, botId: 'bot-wecom', botSecret: 'secret' },
    );
    botService.updateRolePolicy(bot.id, {
      normalToolPolicy: SAFE_PRESET,
      skillAllowlist: [],
      bashWhitelist: [],
    });
    const channelUserId = role === 'normal' ? 'user-1' : role === 'admin' ? 'admin-1' : 'owner-1';
    botService.addMember(bot.id, { channelKey: channel, channelUserId, roleKey: role });

    const session = workspaceStore.createLocalSession(
      workspace.id,
      'Bot Session',
      undefined,
      provider.id,
      channel,
      undefined,
      bot.id,
    );

    let capturedOptions: Options | undefined;
    SessionRuntime.open = (...args: unknown[]) => {
      capturedOptions = args[3] as Options;
      return createMockRuntimeForBotPath();
    };
    await service.getOrCreateRuntime(session.id, workspace.id, true, undefined, channelUserId);
    assert.ok(capturedOptions?.canUseTool, 'canUseTool must be set for bot sessions');
    return capturedOptions.canUseTool;
  }

  for (const channel of ['wecom', 'feishu'] as const) {
    for (const role of ['normal', 'owner'] as const) {
      it(`denies browser tools on the ${channel} path for role=${role}`, async () => {
        const canUseTool = await setupDynamicBotSession(channel, role);
        const result = await canUseTool(BROWSER_TOOL_NAMES.open, { url: 'https://x.example' });
        assert.strictEqual(result?.behavior, 'deny');
        assert.strictEqual(result?.message, "I can't do that in this workspace.");
        const submit = await canUseTool(BROWSER_TOOL_NAMES.submit, { ref: 'e1' });
        assert.strictEqual(submit?.behavior, 'deny');
      });
    }
  }
});

// ---------------------------------------------------------------------------
// U9-dependent drive-by fixture: a cross-origin webpage must not be able to
// resolve a pending browser approval.
// ---------------------------------------------------------------------------

describe('cross-origin approval-resolution fixture (U9 stack)', { concurrency: false }, () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    const app = express();
    const getSelfPort = (): number | undefined => port;
    app.use(hostHeaderGuard());
    app.use(cors({ origin: createCorsOriginCallback({ getSelfPort }) }));
    app.use(stateChangingRequestGuard({ getSelfPort }));
    app.use(express.json());
    app.post('/api/workspaces/:id/sessions/:sessionId/approvals/:requestId', (req, res) => {
      res.json({ resolved: true, requestId: req.params.requestId });
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    port = typeof address === 'object' && address ? address.port : 0;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function rawPost(headers: Record<string, string>, body: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/workspaces/ws-1/sessions/s-1/approvals/browser-req-1',
          headers,
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  it('rejects a drive-by form POST resolving a browser approval (no preflight needed)', async () => {
    const status = await rawPost(
      {
        Origin: 'https://evil.example',
        'Sec-Fetch-Site': 'cross-site',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      'decision=approve',
    );
    assert.strictEqual(status, 403);
  });

  it('rejects a cross-origin JSON POST resolving a browser approval', async () => {
    const status = await rawPost(
      { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      '{"decision":"approve"}',
    );
    assert.strictEqual(status, 403);
  });

  it('still allows the legit app origin', async () => {
    const status = await rawPost(
      { Origin: 'tauri://localhost', 'Content-Type': 'application/json' },
      '{"decision":"approve"}',
    );
    assert.strictEqual(status, 200);
  });
});
