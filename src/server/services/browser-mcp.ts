import type { CallToolResult as CallToolResultType } from '@modelcontextprotocol/sdk/types.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z, type ZodRawShape, type ZodType } from 'zod';
import {
  CONTRACT_VERSION,
  brokerRequestSchema,
  sanitizedCandidateSchema,
  type SanitizedCandidate,
} from '@comate/api-contracts';

/**
 * Backend-agnostic browser tool definition (U6): identical in shape to the
 * claude SDK's SdkMcpToolDefinition so existing definitions port unchanged,
 * but constructible without the claude SDK — the HTTP MCP host (U6) serves
 * them via @modelcontextprotocol/sdk to BOTH backends.
 */
export interface BrowserToolDefinitionShape {
  name: string;
  description: string;
  inputSchema: ZodRawShape | ZodType;
  annotations?: ToolAnnotations;
  handler: (args: never, extra: unknown) => Promise<CallToolResultType>;
}

function defineBrowserTool(
  name: string,
  description: string,
  inputSchema: ZodRawShape | ZodType,
  handler: BrowserToolDefinitionShape['handler'],
  options?: { annotations?: ToolAnnotations },
): BrowserToolDefinitionShape {
  return { name, description, inputSchema, annotations: options?.annotations, handler };
}

const tool = defineBrowserTool;
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  BrowserService,
  BrowserUnavailableError,
  browserService,
} from './browser-service.js';
import {
  BrowserControlService,
  BrowserHandoffError,
  browserControlService,
  gatesAgentToolCall,
  type BrowserHandoffCompletion,
  type HandoffEndReason,
  type HandoffPhase,
} from './browser-control.js';
import { connectSteelPage, type SteelCdpSession } from './browser-cdp.js';
import {
  READ_PROBE_SCRIPT,
  RefTable,
  buildInspectElementFunction,
  buildInspectElementScript,
  buildSubmitSnapshotScript,
  diffPageModels,
  diffSubmitSnapshots,
  distillPageModel,
  sanitizeSubmitPayload,
  type PageModel,
  type InspectedElement,
  type RefBatchKey,
  type RefEntry,
  type SubmitSnapshot,
} from './browser-page-model.js';
import {
  BrowserNetworkCaptureError,
  BrowserNetworkCaptureManager,
  type BrowserNetworkCaptureOptions,
  type BrowserNetworkCaptureResult,
  type CapturedNetworkChain,
  type CapturedNetworkHop,
} from './browser-network-capture.js';
import {
  sanitizeBody,
  sanitizeHeaders,
  sanitizeUrl,
} from './browser-api-sanitizer.js';
import { diagLog, diagWarn } from '../utils/diag-logger.js';
import {
  BROWSER_MCP_SERVER_KEY,
  BROWSER_TOOL_NAMES,
  BROWSER_TOOL_PREFIX,
} from './browser-tool-names.js';
import { parseHttpUrlDetailed } from './browser-site-key.js';
import {
  clearSubmitSemanticsRefs,
  setSubmitSemanticsRefs,
} from './browser-gate-state.js';
import { browserAuditService, type BrowserAuditService } from './browser-audit.js';
import { buildStorageInitScript } from './browser-site-auth.js';
import { originOf } from './browser-origin.js';
import { browserApiBrokerService, type BrowserApiBrokerExecutor } from './browser-api-broker-service.js';

// Re-export so existing consumers of './browser-mcp.js' (chat-service, U3
// tests) keep working; the canonical home is browser-tool-names.ts (U4) so
// policy modules can match names without loading the BrowserService chain.
export { BROWSER_MCP_SERVER_KEY, BROWSER_TOOL_PREFIX };

/**
 * browser-mcp — the first-class tool surface for the embedded controlled
 * browser (KTD-3). Eleven tools on the `comate-browser` SDK MCP server
 * (tool names `mcp__comate-browser__*`), injected into GUI chat sessions
 * only (KTD-4 ③: bot sessions never get this server).
 *
 * Security posture:
 *  - The submit tool's hard gate lives HERE, inside the handler (KTD-4 ②):
 *    a workspace's `.claude/settings.json` `permissions.allow` can short-
 *    circuit the SDK's canUseTool evaluation, so the confirmation round-trip
 *    cannot depend on the interception layer. The handler calls the injected
 *    ApprovalRequester directly; when no requester is wired the tool fails
 *    closed. TOCTOU: after approval and before dispatch the form's action +
 *    field values are re-read over CDP and diffed against the approved
 *    snapshot — any mismatch aborts and re-confirms once, then fails.
 *  - act on submit-semantics controls (type=submit / in-form buttons) is
 *    refused here and routed to the submit tool, so the obvious gate bypass
 *    is closed at the handler level too (U4 adds the canUseTool twin).
 *  - Confirmation payloads pass through the KTD-8 sanitization ruleset:
 *    sensitive fields are listed by name only; values never enter the
 *    pending_approval event stream.
 *  - requestHandoff's pending_approval round-trips live HERE in the handler
 *    (KTD-6 — same settings.json short-circuit argument as submit). The
 *    browser-control state machine drives the takeover/handback phases with
 *    a server-fixed 10-minute timeout; the handback result carries the
 *    KTD-8-sanitized state diff (sensitive field values are absent by
 *    construction — the distiller never reads them out of the page).
 */

export const BROWSER_MCP_SERVER_VERSION = '0.1.0';

// SDK MCP handler round-trips (submit approval) can wait on a human far past
// the 60s default stream-close timeout; chat-service writes this into
// options.env per-session (KTD-3 — never process-global).
export const BROWSER_STREAM_CLOSE_TIMEOUT_MS = '600000';

// ---------------------------------------------------------------------------
// Approval injection point (handler-level hard gate).
// ---------------------------------------------------------------------------

export interface BrowserApprovalRequest {
  toolName: string;
  /**
   * Caller-minted requestId for the pending card. The handoff controller
   * mints its own ids so its verbs/timeout/crash paths can resolve the exact
   * live card; other callers leave this unset and chat-service mints one.
   */
  requestId?: string;
  /** Short card title (e.g. "Submit form 'login' to https://example.com"). */
  title: string;
  description?: string;
  /** KTD-8-sanitized payload — sensitive values are absent by construction. */
  payload: Record<string, unknown>;
  /** Turn-abort propagation from the MCP handler extra. */
  signal?: AbortSignal;
}

export type BrowserApprovalDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; message?: string };

/**
 * Implemented by chat-service: lazily resolves the session's live runtime and
 * drives a pending_approval round-trip through it. Lazy lookup is deliberate —
 * the runtime may be rebuilt while the browser session lives on (KTD-5).
 */
export type BrowserApprovalRequester = (
  sessionId: string,
  request: BrowserApprovalRequest,
) => Promise<BrowserApprovalDecision>;

export interface BrowserMcpDeps {
  sessionId: string;
  workspaceId: string;
  /** Generation of the task capability authorizing this MCP invocation. */
  runtimeGeneration?: string;
  /** Whether this invocation's task capability also has the API-broker audience. */
  apiBrokerAuthorized?: boolean;
  browserService?: BrowserService;
  /**
   * Handoff/control state machine driver (U5). Defaults to the process
   * singleton; tests inject a fresh instance per harness.
   */
  handoffControl?: BrowserControlService;
  approvalRequester?: BrowserApprovalRequester;
  /** CDP dial-out (tests inject a fake page). */
  connectPage?: (baseUrl: string) => Promise<SteelCdpSession>;
  /** Audit sink (U8); defaults to the process singleton. */
  audit?: Pick<BrowserAuditService, 'logToolAction'>;
  /** Authenticated direct-request broker; tests may inject a deterministic one. */
  authenticatedRequestBroker?: BrowserApiBrokerExecutor;
  /**
   * Shared page-connection registry keyed by chat sessionId. Runtime rebuilds
   * mint a fresh MCP server instance (and BrowserToolContext) for the same
   * session; without a shared registry each rebuild would leak the previous
   * instance's CDP socket until the Steel process died. The default is a
   * module-level map; tests inject a fresh one per harness.
   */
  pageRegistry?: Map<string, Promise<SteelCdpSession>>;
  /** Session-owned contexts preserve refs/captures across stateless MCP POSTs. */
  contextRegistry?: Map<string, BrowserToolContext>;
  /** Injectable drain timing for focused capture tests. */
  captureOptions?: BrowserNetworkCaptureOptions;
  /** Post-action settle delay before re-distilling (0 in tests). */
  settleMs?: number;
}

// ---------------------------------------------------------------------------
// In-page action scripts (XPath-ref resolution; backend-node clicks go
// through DOM.resolveNode in browser-cdp).
// ---------------------------------------------------------------------------

function buildActScript(xpath: string, action: string, value: string | undefined): string {
  return `(() => {
  var xpath = ${JSON.stringify(xpath)};
  var action = ${JSON.stringify(action)};
  var value = ${JSON.stringify(value ?? '')};
  var el = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
  if (!el) return { ok: false, reason: 'element_not_found' };
  try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
  var tag = el.tagName ? el.tagName.toLowerCase() : '';
  if (action === 'click') { el.click(); return { ok: true }; }
  if (action === 'fill') {
    if (tag !== 'input' && tag !== 'textarea') return { ok: false, reason: 'not_fillable' };
    var proto = tag === 'input' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) { desc.set.call(el, value); } else { el.value = value; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }
  if (action === 'select') {
    if (tag !== 'select') return { ok: false, reason: 'not_a_select' };
    var opts = el.options, found = false;
    for (var i = 0; i < opts.length; i++) {
      var label = (opts[i].innerText || opts[i].textContent || '').trim();
      if (opts[i].value === value || label === value) { el.selectedIndex = i; found = true; break; }
    }
    if (!found) return { ok: false, reason: 'option_not_found' };
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }
  if (action === 'check') {
    var type = (el.getAttribute('type') || '').toLowerCase();
    if (tag !== 'input' || (type !== 'checkbox' && type !== 'radio')) return { ok: false, reason: 'not_checkable' };
    var desired = value === '' ? !el.checked : (value === 'true' || value === '1' || value === 'on');
    if (el.checked !== desired) el.click();
    return { ok: true };
  }
  return { ok: false, reason: 'unknown_action' };
})()`;
}

function buildRequestSubmitScript(formIndex: number): string {
  return `(() => {
  var form = document.forms[${JSON.stringify(formIndex)}];
  if (!form) return { ok: false, reason: 'form_gone' };
  try {
    if (form.requestSubmit) { form.requestSubmit(); } else { form.submit(); }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'dispatch_failed: ' + (e && e.message ? e.message : String(e)) };
  }
})()`;
}

export interface ExtractFieldSpec {
  source: 'text' | 'title' | 'url' | 'meta' | 'selector' | 'links' | 'forms';
  selector?: string;
  attribute?: string;
  name?: string;
  all?: boolean;
  pattern?: string;
  limit?: number;
}

function buildExtractScript(specs: Array<{ key: string } & ExtractFieldSpec>): string {
  return `(() => {
  var specs = ${JSON.stringify(specs)};
  var out = {};
  for (var s = 0; s < specs.length; s++) {
    var spec = specs[s];
    try {
      if (spec.source === 'meta') {
        var metas = document.querySelectorAll('meta[name], meta[property]');
        for (var m = 0; m < metas.length; m++) {
          var key = metas[m].getAttribute('name') || metas[m].getAttribute('property');
          if (key === spec.name) { out[spec.key] = metas[m].getAttribute('content') || ''; break; }
        }
      } else if (spec.source === 'selector') {
        if (spec.all) {
          var els = document.querySelectorAll(spec.selector);
          var arr = [];
          for (var i = 0; i < els.length && arr.length < 100; i++) {
            arr.push(spec.attribute ? (els[i].getAttribute(spec.attribute) || '') : ((els[i].innerText || els[i].textContent || '').trim()));
          }
          out[spec.key] = arr;
        } else {
          var el = document.querySelector(spec.selector);
          if (el) {
            out[spec.key] = spec.attribute ? (el.getAttribute(spec.attribute) || '') : ((el.innerText || el.textContent || '').trim());
          }
        }
      } else if (spec.source === 'links') {
        var pattern = spec.pattern ? new RegExp(spec.pattern, 'i') : null;
        var limit = Math.min(Math.max(spec.limit || 20, 1), 100);
        var links = [];
        var anchors = document.querySelectorAll('a[href]');
        for (var a = 0; a < anchors.length && links.length < limit; a++) {
          var href = anchors[a].href;
          var text = (anchors[a].innerText || anchors[a].textContent || '').trim().slice(0, 120);
          if (pattern && !pattern.test(href) && !pattern.test(text)) continue;
          links.push({ text: text, href: href });
        }
        out[spec.key] = links;
      }
    } catch (e) {
      out[spec.key] = undefined;
    }
  }
  return out;
})()`;
}

// ---------------------------------------------------------------------------
// Tool-result helpers — loud, structured, actionable (KTD-3).
// ---------------------------------------------------------------------------

type ToolStage =
  | 'session_start'
  | 'control'
  | 'navigate'
  | 'distill'
  | 'ref_resolve'
  | 'approval'
  | 'toctou'
  | 'dispatch'
  | 'extract'
  | 'capture';

function toolError(
  code: string,
  stage: ToolStage,
  message: string,
  resolution: string,
): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: { code, stage, message, resolution } }),
      },
    ],
  };
}

function toolJson(payload: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/**
 * Type guards for the `RefEntry | CallToolResult` / decision unions.
 * `CallToolResult` carries an index signature (`[x: string]: unknown`), so
 * `'kind' in value` / `'behavior' in value` cannot narrow it away — these
 * predicates do the discriminating explicitly.
 */
function isRefEntry(value: RefEntry | CallToolResult): value is RefEntry {
  return typeof (value as RefEntry).ref === 'string';
}

function isApprovalDecision(
  value: BrowserApprovalDecision | CallToolResult,
): value is BrowserApprovalDecision {
  return typeof (value as BrowserApprovalDecision).behavior === 'string';
}

const UNAVAILABLE_RESOLUTIONS: Record<string, string> = {
  browser_limit_reached:
    'The concurrent browser limit is reached. Close another chat session\'s browser and retry.',
  browser_chromium_missing:
    'No Chromium executable is available. The bundled Chrome for Testing is missing — reinstall the app, set COMATE_CHROMIUM_PATH, or set COMATE_USE_SYSTEM_CHROME=1 to use your installed Chrome, then retry.',
  browser_start_failed:
    'The embedded browser process failed to start. Retry the call; check /api/health/browser if it persists.',
};

/**
 * Recoverable handoff endings (R8/AE4): the agent gets an actionable
 * explanation it can relay to the chat; the task is never left blocked.
 */
const HANDOFF_END_DETAILS: Partial<Record<HandoffEndReason, string>> = {
  declined:
    'The user declined the takeover request. Continue without the manual step if possible, or ask the user how to proceed.',
  timeout:
    'The handoff timed out after 10 minutes without a response. Explain in the chat that the task is paused and can resume whenever the user is ready — they can take over from the browser panel or you can request a new handoff.',
  runtime_closed:
    'The chat session was rebuilt while the handoff was pending. The browser session is unaffected; re-request the handoff if it is still needed.',
};

const INSPECT_ATTRIBUTE_ALLOWLIST = new Set([
  'href', 'action', 'method', 'type', 'name', 'role', 'aria-label',
  'aria-expanded', 'aria-controls', 'placeholder', 'title', 'target',
]);

function boundedSafeText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const sanitized = sanitizeBody({ contentType: 'text/plain; charset=utf-8', body: value, limits: { maxStringLength: max } });
  return sanitized.receipt.disclosed && typeof sanitized.value === 'string'
    ? sanitized.value.slice(0, max)
    : undefined;
}

function sanitizeInspectableUrl(value: string): string | undefined {
  try {
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(value);
    const sanitized = sanitizeUrl(new URL(value, 'https://comate.invalid').toString()).value;
    if (absolute) return sanitized.slice(0, 600);
    const parsed = new URL(sanitized);
    return `${parsed.pathname}${parsed.search}`.slice(0, 600);
  } catch {
    return undefined;
  }
}

/** Defensive server-side reconstruction: page-script output never passes through wholesale. */
function sanitizeInspectedElement(raw: InspectedElement): InspectedElement {
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw.attributes ?? {})) {
    if (!INSPECT_ATTRIBUTE_ALLOWLIST.has(key) || typeof value !== 'string') continue;
    const safe = key === 'href' || key === 'action'
      ? sanitizeInspectableUrl(value)
      : boundedSafeText(value, 300);
    if (safe !== undefined) attributes[key] = safe;
  }
  const descendants = (Array.isArray(raw.descendants) ? raw.descendants : []).slice(0, 12).map((child) => ({
    tag: boundedSafeText(child.tag, 40) ?? 'unknown',
    ...(boundedSafeText(child.role, 80) ? { role: boundedSafeText(child.role, 80) } : {}),
    ...(boundedSafeText(child.name, 160) ? { name: boundedSafeText(child.name, 160) } : {}),
    ...(boundedSafeText(child.text, 180) ? { text: boundedSafeText(child.text, 180) } : {}),
  }));
  const form = raw.form ? {
    ...(boundedSafeText(raw.form.name, 160) ? { name: boundedSafeText(raw.form.name, 160) } : {}),
    method: boundedSafeText(raw.form.method, 16)?.toLowerCase() ?? 'get',
    ...(raw.form.action && sanitizeInspectableUrl(raw.form.action)
      ? { action: sanitizeInspectableUrl(raw.form.action) }
      : {}),
    fields: (Array.isArray(raw.form.fields) ? raw.form.fields : []).slice(0, 20).map((field) => ({
      ...(boundedSafeText(field.name, 160) ? { name: boundedSafeText(field.name, 160) } : {}),
      ...(boundedSafeText(field.label, 160) ? { label: boundedSafeText(field.label, 160) } : {}),
      tag: boundedSafeText(field.tag, 40) ?? 'unknown',
      ...(boundedSafeText(field.type, 40) ? { type: boundedSafeText(field.type, 40) } : {}),
      required: field.required === true,
      sensitive: field.sensitive === true,
      filled: field.filled === true,
    })),
    truncated: raw.form.truncated === true || raw.form.fields.length > 20,
  } : undefined;
  return {
    tag: boundedSafeText(raw.tag, 40) ?? 'unknown',
    ...(boundedSafeText(raw.role, 80) ? { role: boundedSafeText(raw.role, 80) } : {}),
    ...(boundedSafeText(raw.name, 160) ? { name: boundedSafeText(raw.name, 160) } : {}),
    attributes,
    ...(boundedSafeText(raw.nearbyText, 600) ? { nearbyText: boundedSafeText(raw.nearbyText, 600) } : {}),
    descendants,
    descendantsTruncated: raw.descendantsTruncated === true || raw.descendants.length > 12,
    ...(form ? { form } : {}),
    actions: (Array.isArray(raw.actions) ? raw.actions : [])
      .filter((action): action is string => ['click', 'fill', 'select', 'check', 'submit'].includes(action))
      .slice(0, 5),
  };
}

function normalizedHeaders(raw: Record<string, unknown> | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw ?? {})) {
    if (typeof value === 'string') output[name] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) output[name] = value.join(', ');
    else if (typeof value === 'number' || typeof value === 'boolean') output[name] = String(value);
  }
  return output;
}

function headerValue(headers: Record<string, unknown> | undefined, name: string): string | undefined {
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return entry && typeof entry[1] === 'string' ? entry[1] : undefined;
}

function captureSecrets(result: BrowserNetworkCaptureResult): string[] {
  const secrets = new Set<string>();
  const sensitive = /authorization|cookie|token|secret|api[-_]?key/i;
  for (const chain of result.chains) {
    for (const hop of chain.hops) {
      for (const headers of [hop.request.headers, hop.requestExtraHeaders, hop.response?.headers, hop.responseExtraHeaders]) {
        for (const [name, value] of Object.entries(headers ?? {})) {
          if (!sensitive.test(name) || typeof value !== 'string') continue;
          secrets.add(value);
          const credential = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value)?.[1];
          if (credential) secrets.add(credential);
          for (const cookie of value.split(';')) {
            const cookieValue = cookie.slice(cookie.indexOf('=') + 1).trim();
            if (cookie.includes('=') && cookieValue) secrets.add(cookieValue);
          }
        }
      }
    }
  }
  return [...secrets];
}

function candidateScore(hop: CapturedNetworkHop): number {
  let score = 0;
  const resource = hop.resourceType?.toLowerCase();
  if (resource === 'fetch' || resource === 'xhr') score += 4;
  if (resource && ['document', 'image', 'font', 'stylesheet', 'media'].includes(resource)) score -= 3;
  if (/\/(?:api|graphql|v\d+)(?:\/|$|\?)/i.test(hop.request.url)) score += 2;
  const contentType = headerValue(hop.response?.headers, 'content-type')?.toLowerCase() ?? '';
  if (contentType.includes('json') || contentType.includes('graphql')) score += 3;
  if (hop.responseBody && !hop.incompleteReasons.includes('body_unavailable')) score += 1;
  return score;
}

function candidateFromChain(
  result: BrowserNetworkCaptureResult,
  chain: CapturedNetworkChain,
  index: number,
  action: string,
  exactSecrets: string[],
  primarySessionId: string | undefined,
): { candidate: SanitizedCandidate; score: number; bearerToken?: string } | undefined {
  const hop = chain.hops[chain.hops.length - 1];
  if (!hop?.response || hop.response.status < 100 || hop.response.status > 599) return undefined;
  let url;
  try {
    url = sanitizeUrl(hop.request.url, { exactSecrets });
    if (!url.value.startsWith('https://')) return undefined;
  } catch {
    return undefined;
  }
  const requestHeaders = sanitizeHeaders(normalizedHeaders(hop.request.headers), { exactSecrets }).value;
  const responseHeaders = sanitizeHeaders(normalizedHeaders(hop.response.headers), { exactSecrets }).value;
  const requestType = headerValue(hop.request.headers, 'content-type');
  const responseType = headerValue(hop.response.headers, 'content-type') ?? hop.response.mimeType;
  const requestBody = hop.request.postData !== undefined
    ? sanitizeBody({ contentType: requestType, body: hop.request.postData, exactSecrets })
    : undefined;
  let responseRaw: string | Buffer = '';
  if (hop.responseBody) {
    responseRaw = hop.responseBody.base64Encoded
      ? Buffer.from(hop.responseBody.body, 'base64')
      : hop.responseBody.body;
  }
  const responseBody = sanitizeBody({ contentType: responseType, body: responseRaw, exactSecrets });
  const score = candidateScore(hop);
  const confidence = score >= 7 ? 'high' : score >= 3 ? 'medium' : 'low';
  const missing: string[] = [];
  if (!hop.responseBody) missing.push('response_body');
  missing.push(...hop.incompleteReasons);
  const candidate = {
    version: CONTRACT_VERSION,
    candidateId: `cand_${result.captureId.slice(4, 20)}_${String(index).padStart(2, '0')}`,
    captureId: result.captureId,
    method: hop.request.method.toUpperCase().slice(0, 16),
    url: url.value,
    headers: requestHeaders,
    query: url.query,
    ...(requestBody ? { requestBody } : {}),
    response: { status: hop.response.status, headers: responseHeaders, body: responseBody },
    evidence: {
      action: `${action.slice(0, 800)} (temporal association only; causality not proven)`,
      targetType: chain.sessionId === primarySessionId
        ? 'page'
        : hop.resourceType?.toLowerCase().includes('worker') ? 'worker' : 'iframe',
      confidence,
    },
    completeness: {
      requestComplete: hop.terminal && !hop.incompleteReasons.includes('loading_failed'),
      responseComplete: hop.terminal && missing.length === 0,
      missing: [...new Set(missing)].slice(0, 32),
    },
  };
  const parsed = sanitizedCandidateSchema.safeParse(candidate);
  const authorization = headerValue(hop.requestExtraHeaders, 'authorization')
    ?? headerValue(hop.request.headers, 'authorization');
  const bearerToken = /^Bearer\s+(.+)$/i.exec(authorization ?? '')?.[1];
  return parsed.success
    ? { candidate: parsed.data, score, ...(bearerToken ? { bearerToken } : {}) }
    : undefined;
}

function buildSanitizedCandidates(
  result: BrowserNetworkCaptureResult,
  action: string,
  primarySessionId?: string,
): Array<{ candidate: SanitizedCandidate; bearerToken?: string }> {
  const exactSecrets = captureSecrets(result);
  return result.chains
    .map((chain, index) => candidateFromChain(result, chain, index, action, exactSecrets, primarySessionId))
    .filter((entry): entry is { candidate: SanitizedCandidate; score: number; bearerToken?: string } => entry !== undefined)
    .sort((left, right) => right.score - left.score)
    .slice(0, 50)
    .map(({ candidate, bearerToken }) => ({ candidate, ...(bearerToken ? { bearerToken } : {}) }));
}

// ---------------------------------------------------------------------------
// Session context — one per SDK MCP server instance (per chat session).
// Holds the ref table and last model; the CDP page is shared per sessionId
// through the registry so runtime rebuilds rebind without leaking sockets
// (KTD-5). Browser lifecycle itself stays with browserService.
// ---------------------------------------------------------------------------

const defaultPageRegistry = new Map<string, Promise<SteelCdpSession>>();
const defaultContextRegistries = new WeakMap<BrowserService, Map<string, BrowserToolContext>>();

function contextRegistryFor(service: BrowserService): Map<string, BrowserToolContext> {
  let registry = defaultContextRegistries.get(service);
  if (!registry) {
    registry = new Map();
    defaultContextRegistries.set(service, registry);
  }
  return registry;
}

export class BrowserToolContext {
  private readonly refTable = new RefTable();
  private lastModel: PageModel | null = null;
  private readonly svc: BrowserService;
  private readonly handoffCtl: BrowserControlService;
  private readonly connectPage: (baseUrl: string) => Promise<SteelCdpSession>;
  private readonly pageRegistry: Map<string, Promise<SteelCdpSession>>;
  private readonly settleMs: number;
  private readonly audit: Pick<BrowserAuditService, 'logToolAction'>;
  private readonly authenticatedRequestBroker: BrowserApiBrokerExecutor;
  private networkCapture?: BrowserNetworkCaptureManager;
  private capturePrimarySessionId?: string;
  private captureAction = 'One explicitly bracketed browser action';

  constructor(private readonly deps: BrowserMcpDeps) {
    this.svc = deps.browserService ?? browserService;
    this.handoffCtl = deps.handoffControl ?? browserControlService;
    this.connectPage = deps.connectPage ?? connectSteelPage;
    this.pageRegistry = deps.pageRegistry ?? defaultPageRegistry;
    this.settleMs = deps.settleMs ?? 300;
    this.audit = deps.audit ?? browserAuditService;
    this.authenticatedRequestBroker = deps.authenticatedRequestBroker ?? browserApiBrokerService;
  }

  /** Abort task-owned capture state without closing the shared browser page. */
  disposeTask(reason: 'connection_closed' = 'connection_closed'): void {
    this.networkCapture?.abort(reason);
    this.networkCapture = undefined;
    this.capturePrimarySessionId = undefined;
    this.refTable.clear();
    this.lastModel = null;
    clearSubmitSemanticsRefs(this.deps.sessionId);
  }

  private async ensurePage(): Promise<SteelCdpSession> {
    // Any page-touching tool call (open/snapshot/act/submit/extract) plus
    // requestHandoff counts as browser activity — reset the idle-reclaim
    // timer (U3). handleClose does not route through here, so closing does
    // not reset the clock it is ending.
    this.svc.resetIdle(this.deps.sessionId);
    const key = this.deps.sessionId;
    const existing = this.pageRegistry.get(key);
    if (existing) {
      const page = await existing.catch(() => null);
      if (page && !page.closed) {
        return page;
      }
      this.pageRegistry.delete(key);
    }
    const info = await this.svc.ensureSession({
      sessionId: this.deps.sessionId,
      workspaceId: this.deps.workspaceId,
    });
    const connecting = this.connectPage(info.baseUrl);
    this.pageRegistry.set(key, connecting);
    try {
      const page = await connecting;
      page.onClose(() => {
        if (this.pageRegistry.get(key) === connecting) {
          this.pageRegistry.delete(key);
        }
        // This context's refs/model describe the dead page — drop them so the
        // next call re-distills against the rebuilt browser. The canUseTool
        // gate's ref view (U4) is cleared too; navigation memory survives
        // (session-level, KTD-4 ②).
        this.refTable.clear();
        this.lastModel = null;
        clearSubmitSemanticsRefs(key);
        this.networkCapture?.abort('connection_closed');
        this.networkCapture = undefined;
        this.capturePrimarySessionId = undefined;
        this.deps.contextRegistry?.delete(key);
      });
      return page;
    } catch (err) {
      if (this.pageRegistry.get(key) === connecting) {
        this.pageRegistry.delete(key);
      }
      throw err;
    }
  }

  private controlGate(stage: ToolStage): CallToolResult | null {
    const state = this.svc.getControlState(this.deps.sessionId);
    // The transition table (browser-control) owns the gating rule.
    if (state && gatesAgentToolCall(state)) {
      return toolError(
        'browser_user_in_control',
        stage,
        'The user is currently in control of the browser; agent actions are suspended.',
        'Wait for the user to hand control back (the browser_state event flips to agent_in_control), then retry.',
      );
    }
    return null;
  }

  private async readProbe(page: SteelCdpSession): Promise<RefBatchKey | null> {
    try {
      return await page.evaluate<RefBatchKey | null>(READ_PROBE_SCRIPT);
    } catch {
      return null;
    }
  }

  private async distill(page: SteelCdpSession): Promise<PageModel> {
    const model = await distillPageModel(page, this.refTable);
    this.lastModel = model;
    // Publish the session's submit-semantics refs for the canUseTool-layer
    // classification gate (U4, KTD-4 ② — the runtime has no ref table of its
    // own; this module-level registry is the bridge, rewritten per distill).
    setSubmitSemanticsRefs(
      this.deps.sessionId,
      model.forms.flatMap((form) =>
        form.fields.filter((field) => field.submitSemantics).map((field) => field.ref),
      ),
    );
    return model;
  }

  private resolveCurrentRef(ref: string, probe: RefBatchKey | null): RefEntry | CallToolResult {
    const entry = this.refTable.get(ref);
    if (!entry) {
      return toolError(
        'browser_ref_unknown',
        'ref_resolve',
        `Unknown element ref "${ref}". Refs come from the most recent open/snapshot/act page model.`,
        'Call the snapshot tool to get a fresh page model with current refs.',
      );
    }
    if (!probe || !this.refTable.isCurrent(ref, probe)) {
      return toolError(
        'browser_ref_stale',
        'ref_resolve',
        `Element ref "${ref}" (${entry.role} "${entry.name}") was invalidated by a page change.`,
        'Call the snapshot tool to re-read the page, then retry with the fresh ref.',
      );
    }
    return entry;
  }

  // -- selected element inspection -----------------------------------------

  async handleInspectElement(args: { ref: string }): Promise<CallToolResult> {
    const gate = this.controlGate('control');
    if (gate) return gate;
    try {
      const page = await this.ensurePage();
      const resolved = this.resolveCurrentRef(args.ref, await this.readProbe(page));
      if (!isRefEntry(resolved)) return resolved;
      let raw: InspectedElement | null;
      if (resolved.kind === 'action' && typeof resolved.backendNodeId === 'number') {
        if (!page.inspectBackendNode) {
          return toolError(
            'browser_ref_unresolvable',
            'ref_resolve',
            `Action ref "${args.ref}" cannot be inspected by this browser runtime.`,
            'Call snapshot for a fresh model or inspect the owning form/field ref instead.',
          );
        }
        raw = await page.inspectBackendNode(resolved.backendNodeId, buildInspectElementFunction());
      } else {
        raw = await page.evaluate<InspectedElement | null>(buildInspectElementScript(resolved));
      }
      if (!raw) {
        return toolError(
          'browser_ref_unresolvable',
          'ref_resolve',
          `Element ref "${args.ref}" could not be resolved in the current document.`,
          'Call snapshot to refresh the page model and retry with a current ref.',
        );
      }
      return toolJson({ ok: true, ref: args.ref, element: sanitizeInspectedElement(raw) });
    } catch (err) {
      return this.toErrorResult(err, 'distill');
    }
  }

  // -- action-scoped network capture --------------------------------------

  async handleStartNetworkCapture(args: { action?: string }): Promise<CallToolResult> {
    const gate = this.controlGate('control');
    if (gate) return gate;
    try {
      const page = await this.ensurePage();
      const transport = page.createNetworkCaptureTransport?.();
      if (!transport) {
        return toolError(
          'browser_capture_unavailable',
          'capture',
          'This browser connection does not expose passive network capture.',
          'Reopen the controlled browser and retry the capture.',
        );
      }
      this.networkCapture ??= new BrowserNetworkCaptureManager(transport, this.deps.captureOptions);
      this.capturePrimarySessionId = transport.primarySessionId;
      this.captureAction = args.action?.trim().slice(0, 500) || 'One explicitly bracketed browser action';
      const started = await this.networkCapture.start();
      return toolJson({ ok: true, ...started, note: 'Capture is recording new request chains until stopNetworkCapture closes admission.' });
    } catch (err) {
      if (err instanceof BrowserNetworkCaptureError) {
        return toolError(err.code, 'capture', err.message, 'Stop the active capture before starting another one.');
      }
      return this.toErrorResult(err, 'capture');
    }
  }

  async handleStopNetworkCapture(): Promise<CallToolResult> {
    if (!this.networkCapture) {
      return toolError(
        'capture_not_active',
        'capture',
        'No network capture is active for this browser session.',
        'Call startNetworkCapture immediately before the page action you want to inspect.',
      );
    }
    try {
      const result = await this.networkCapture.stop();
      if (result.state === 'aborted') {
        return toolError(
          'capture_aborted',
          'capture',
          'The browser connection closed before capture draining completed.',
          'Reopen the browser, start a new capture, repeat one action, and stop it again.',
        );
      }
      const candidateEntries = buildSanitizedCandidates(result, this.captureAction, this.capturePrimarySessionId);
      const authBindings = await this.svc.captureCandidateAuthBindings(
        this.deps.sessionId,
        candidateEntries.map(({ candidate, bearerToken }) => ({
          url: candidate.url,
          ...(bearerToken ? { bearerToken } : {}),
        })),
      ).catch(() => candidateEntries.map(() => undefined));
      const candidates = candidateEntries.map(({ candidate }, index) => {
        const authBinding = authBindings[index];
        return { ...candidate, ...(authBinding ? { authBinding } : {}) };
      });
      return toolJson({
        ok: true,
        captureId: result.captureId,
        state: result.state,
        candidates,
        incompleteReasons: result.incompleteReasons,
        note: 'Candidates are ranked by API-like evidence and are temporally associated with the bracketed action; this is not proof of causality. Validate the selected candidate with authenticatedRequest before the user chooses Remember this site. Generated shell or Python artifacts can call `comate api request --stdin --json` while this task remains live.',
      });
    } catch (err) {
      if (err instanceof BrowserNetworkCaptureError) {
        return toolError(err.code, 'capture', err.message, 'Call startNetworkCapture, perform one browser action, then stop it.');
      }
      return this.toErrorResult(err, 'capture');
    }
  }

  // -- authenticated direct request ---------------------------------------

  async handleAuthenticatedRequest(
    raw: unknown,
    runtimeGeneration: string,
    apiBrokerAuthorized: boolean,
    extra?: { signal?: AbortSignal },
  ): Promise<CallToolResult> {
    if (!apiBrokerAuthorized) {
      return toolError(
        'browser_broker_unauthorized',
        'approval',
        'This task capability is not authorized for direct API requests.',
        'Rebuild the GUI task runtime to obtain an API-broker capability.',
      );
    }
    const result = await this.authenticatedRequestBroker.execute({
      taskId: this.deps.sessionId,
      workspaceId: this.deps.workspaceId,
      grantScope: runtimeGeneration,
      signal: extra?.signal,
    }, raw);
    return toolJson(result);
  }

  private async requestApproval(request: Omit<BrowserApprovalRequest, 'signal'>, signal?: AbortSignal): Promise<BrowserApprovalDecision | CallToolResult> {
    const requester = this.deps.approvalRequester;
    if (!requester) {
      // Fail closed: no approval channel means NO submit, ever.
      return toolError(
        'browser_approval_unavailable',
        'approval',
        'No approval channel is wired for this session, so form submission is not permitted.',
        'This is an internal wiring issue — the chat session must provide an approval requester.',
      );
    }
    try {
      return await requester(this.deps.sessionId, { ...request, signal });
    } catch (err) {
      diagWarn('[browser-mcp] approval round-trip failed:', err);
      return toolError(
        'browser_approval_failed',
        'approval',
        `The approval round-trip failed: ${err instanceof Error ? err.message : String(err)}`,
        'Retry the submit; if it persists, reload the chat session.',
      );
    }
  }

  // -- open -----------------------------------------------------------------

  async handleOpen(args: { url: string }): Promise<CallToolResult> {
    const parsedResult = parseHttpUrlDetailed(args.url);
    if (!parsedResult.ok) {
      if (parsedResult.reason === 'invalid') {
        return toolError(
          'browser_url_invalid',
          'navigate',
          `Unparseable URL: ${args.url}`,
          'Pass a full http(s) URL, e.g. https://example.com.',
        );
      }
      return toolError(
        'browser_url_scheme',
        'navigate',
        `Refusing to navigate to a ${parsedResult.protocol}// URL.`,
        'Only http:// and https:// URLs are allowed.',
      );
    }
    const parsed = parsedResult.url;
    try {
      const page = await this.ensurePage();
      // Remembered-site injection (U8, KTD-8): exactly once per Steel
      // process, on the first open() whose site key has a stored context —
      // BEFORE the first navigation so the initial request already carries
      // the cookies. Adaptation note: the plan called for Steel's
      // POST /v1/sessions sessionContext path, but the vendored build's
      // isSimilarConfig (deviceConfig/timezone equality) can answer a full
      // browser RELAUNCH mid-flow, killing this page session; the same
      // effect is achieved over our own CDP channel (Network.setCookies +
      // addScriptToEvaluateOnNewDocument), with zero Steel session mutation.
      const injection = await this.svc.prepareSiteAuthInjection(
        this.deps.sessionId,
        parsed.toString(),
      );
      if (injection) {
        await this.injectSiteContext(page, injection.context);
      }
      await page.navigate(parsed.toString());
      const model = await this.distill(page);
      diagLog(`[browser-mcp] open session=${this.deps.sessionId} url=${model.url}`);
      this.audit.logToolAction({
        workspaceId: this.deps.workspaceId,
        sessionId: this.deps.sessionId,
        toolName: BROWSER_TOOL_NAMES.open,
        url: model.url,
        outcome: 'ok',
      });
      return toolJson({ ok: true, model });
    } catch (err) {
      return this.toErrorResult(err, 'navigate');
    }
  }

  /**
   * Replay a remembered context into the fresh browser (U8): cookies via
   * Network.setCookies (first request carries them), web storage via an
   * init script keyed by page hostname — registered before navigation, so it
   * lands before any page script can read the stores (Steel's own
   * framenavigated injection races page scripts; this does not).
   */
  private async injectSiteContext(
    page: SteelCdpSession,
    context: { cookies: Array<Record<string, unknown>>; localStorage?: Record<string, Record<string, string>>; sessionStorage?: Record<string, Record<string, string>> },
  ): Promise<void> {
    if (context.cookies.length > 0) {
      await page.setCookies(context.cookies);
    }
    const initScript = buildStorageInitScript(context);
    if (initScript) {
      await page.evaluateOnNewDocument(initScript);
    }
  }

  // -- snapshot ---------------------------------------------------------------

  async handleSnapshot(args: { screenshot?: boolean }): Promise<CallToolResult> {
    try {
      const page = await this.ensurePage();
      // The control gate runs before dispatching either CDP call.
      if (args.screenshot) {
        const gate = this.controlGate('control');
        if (gate) return gate;
      }
      // Distill and screenshot are independent CDP round-trips — run them
      // concurrently instead of serializing the screenshot behind the model.
      const [model, screenshot] = await Promise.all([
        this.distill(page),
        args.screenshot ? page.captureScreenshot() : Promise.resolve(undefined),
      ]);
      const content: CallToolResult['content'] = [];
      if (screenshot !== undefined) {
        content.push({ type: 'image', data: screenshot, mimeType: 'image/jpeg' });
        // Image exfil point toward the model — the FACT is audited; the
        // image bytes never touch the audit table (KTD-9).
        this.audit.logToolAction({
          workspaceId: this.deps.workspaceId,
          sessionId: this.deps.sessionId,
          toolName: BROWSER_TOOL_NAMES.snapshot,
          url: model.url,
          outcome: 'ok',
          detail: 'screenshot',
        });
      }
      content.push({ type: 'text', text: JSON.stringify({ ok: true, model }) });
      return { content };
    } catch (err) {
      return this.toErrorResult(err, 'distill');
    }
  }

  // -- act --------------------------------------------------------------------

  async handleAct(args: { ref: string; action: 'click' | 'fill' | 'select' | 'check'; value?: string }): Promise<CallToolResult> {
    const gate = this.controlGate('control');
    if (gate) return gate;
    try {
      const page = await this.ensurePage();
      const probe = await this.readProbe(page);
      const resolved = this.resolveCurrentRef(args.ref, probe);
      if (!isRefEntry(resolved)) return resolved;
      const entry = resolved;

      // Submit-semantics controls are routed to the submit tool so its
      // handler-level confirmation gate cannot be bypassed via act (KTD-4 ②;
      // U4 adds the canUseTool twin of this classification).
      if (args.action === 'click' && entry.submitSemantics) {
        return toolError(
          'browser_use_submit_tool',
          'ref_resolve',
          `Ref "${args.ref}" (${entry.role} "${entry.name}") submits a form, so it requires user confirmation.`,
          'Call the submit tool with this ref (or its form ref) instead — it will ask the user to confirm.',
        );
      }
      if (entry.kind === 'action' && args.action !== 'click') {
        return toolError(
          'browser_action_unsupported',
          'ref_resolve',
          `Ref "${args.ref}" is a ${entry.role}; only click is supported on action refs.`,
          'Fill/select/check apply to form field refs from the page model.',
        );
      }
      if (entry.kind === 'form') {
        return toolError(
          'browser_action_unsupported',
          'ref_resolve',
          `Ref "${args.ref}" is a form; act works on its field refs (or use submit for the whole form).`,
          'Pick a field ref from the form in the page model, or call submit with this form ref.',
        );
      }

      if (entry.kind === 'action') {
        if (typeof entry.backendNodeId !== 'number') {
          return toolError(
            'browser_ref_unresolvable',
            'ref_resolve',
            `Action ref "${args.ref}" has no backend node.`,
            'Call snapshot for a fresh page model.',
          );
        }
        await page.clickBackendNode(entry.backendNodeId);
      } else {
        if (!entry.xpath) {
          return toolError(
            'browser_ref_unresolvable',
            'ref_resolve',
            `Field ref "${args.ref}" has no locator.`,
            'Call snapshot for a fresh page model.',
          );
        }
        const result = await page.evaluate<{ ok: boolean; reason?: string }>(
          buildActScript(entry.xpath, args.action, args.value),
        );
        if (!result.ok) {
          return toolError(
            'browser_action_failed',
            'dispatch',
            `Action ${args.action} on "${entry.name}" failed: ${result.reason ?? 'unknown'}`,
            'Call snapshot to re-read the page, verify the field state, and retry.',
          );
        }
      }

      await this.settle();
      const prevModel = this.lastModel;
      const model = await this.distill(page);
      const delta = diffPageModels(prevModel, model);
      diagLog(`[browser-mcp] act session=${this.deps.sessionId} ref=${args.ref} action=${args.action}`);
      // RISK-1: a click that cannot be proven harmless (not submit-semantics,
      // so no confirmation gate) followed by a navigation is flagged as a
      // POTENTIAL submit — the navigation is the observable proxy; a POST
      // without navigation (fetch/XHR) remains unobservable and is the
      // documented residual.
      this.audit.logToolAction({
        workspaceId: this.deps.workspaceId,
        sessionId: this.deps.sessionId,
        toolName: BROWSER_TOOL_NAMES.act,
        url: model.url,
        fieldNames: [entry.name],
        outcome: 'ok',
        potentialSubmit:
          args.action === 'click' && !entry.submitSemantics && prevModel?.url !== model.url,
        detail: `action=${args.action}`,
      });
      return toolJson({ ok: true, ref: args.ref, action: args.action, delta, model });
    } catch (err) {
      return this.toErrorResult(err, 'dispatch');
    }
  }

  // -- submit (handler-level hard gate + TOCTOU, KTD-4 ②) ---------------------

  async handleSubmit(
    args: { ref: string; fields?: Record<string, string> },
    extra?: unknown,
  ): Promise<CallToolResult> {
    const gate = this.controlGate('control');
    if (gate) return gate;
    const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
    try {
      const page = await this.ensurePage();
      const probe = await this.readProbe(page);
      const resolved = this.resolveCurrentRef(args.ref, probe);
      if (!isRefEntry(resolved)) return resolved;
      const target = resolved;

      // Resolve the form + optional dispatch control.
      let formIndex: number;
      let controlEntry: RefEntry | null = null;
      if (target.kind === 'form') {
        if (typeof target.formIndex !== 'number' || target.formIndex < 0) {
          return toolError(
            'browser_submit_needs_form',
            'ref_resolve',
            'Standalone page controls are not part of a submittable form.',
            'Submit requires a form ref (or a submit-button ref inside a form) from the page model.',
          );
        }
        formIndex = target.formIndex;
      } else if (target.kind === 'field' && target.submitSemantics && typeof target.formIndex === 'number' && target.formIndex >= 0) {
        formIndex = target.formIndex;
        controlEntry = target;
      } else {
        return toolError(
          'browser_submit_needs_form',
          'ref_resolve',
          `Ref "${args.ref}" (${target.role} "${target.name}") is not a form or a submit control.`,
          'Pass the form ref or a submit-button ref from the page model.',
        );
      }

      // Fill requested fields (keys: field refs or field names).
      const fields = args.fields ?? {};
      for (const [key, value] of Object.entries(fields)) {
        const fieldEntry = this.resolveSubmitField(formIndex, key);
        if (!fieldEntry) {
          return toolError(
            'browser_field_unknown',
            'ref_resolve',
            `No field "${key}" in form ${formIndex}. Keys must be field refs (e5) or field names from the page model.`,
            'Call snapshot for the current form field list.',
          );
        }
        if (!fieldEntry.xpath) {
          return toolError(
            'browser_ref_unresolvable',
            'ref_resolve',
            `Field "${key}" has no locator.`,
            'Call snapshot for a fresh page model.',
          );
        }
        const fillResult = await page.evaluate<{ ok: boolean; reason?: string }>(
          buildActScript(fieldEntry.xpath, 'fill', value),
        );
        if (!fillResult.ok) {
          return toolError(
            'browser_action_failed',
            'dispatch',
            `Failed to fill field "${key}": ${fillResult.reason ?? 'unknown'}`,
            'Call snapshot to verify the field state and retry.',
          );
        }
      }

      // Raw submit snapshot (sensitive values are hashed in-page — KTD-8).
      const initialSnapshot = await page.evaluate<SubmitSnapshot | null>(
        buildSubmitSnapshotScript(formIndex),
      );
      if (!initialSnapshot) {
        return toolError(
          'browser_form_gone',
          'toctou',
          'The form disappeared before its state could be captured.',
          'Call snapshot to re-read the page and retry.',
        );
      }

      // Handler-level confirmation gate. This runs REGARDLESS of approval
      // mode or workspace settings.json allow rules — those only affect the
      // SDK's canUseTool evaluation, which this gate deliberately does not
      // rely on (KTD-4 ②).
      const formName = target.kind === 'form' ? target.name : controlEntry?.name ?? `form ${formIndex}`;
      let approvedSnapshot = initialSnapshot;
      let pendingDiffs: ReturnType<typeof diffSubmitSnapshots> = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const reconfirm = attempt > 0;
        const payload = sanitizeSubmitPayload({
          url: this.lastModel?.url ?? '',
          formName,
          snapshot: approvedSnapshot,
        });
        if (reconfirm) {
          payload.reconfirmation = true;
          // Field names + change kinds only (values never leave the page).
          payload.differences = pendingDiffs;
        }
        const origin = String(payload.actionOrigin ?? '');
        const decision = await this.requestApproval(
          {
            toolName: BROWSER_TOOL_NAMES.submit,
            title: `Submit form "${formName}" to ${origin}`,
            description: reconfirm
              ? 'The form changed after the previous approval — confirm the updated submission.'
              : undefined,
            payload,
          },
          signal,
        );
        if (!isApprovalDecision(decision)) return decision;
        if (decision.behavior !== 'allow') {
          diagLog(`[browser-mcp] submit denied session=${this.deps.sessionId} form=${formName}`);
          this.audit.logToolAction({
            workspaceId: this.deps.workspaceId,
            sessionId: this.deps.sessionId,
            toolName: BROWSER_TOOL_NAMES.submit,
            url: String(payload.actionOrigin ?? ''),
            fieldNames: approvedSnapshot.fields.map((field) => field.name),
            outcome: 'denied',
            detail: `form=${formName}`,
          });
          return toolJson({
            submitted: false,
            reason: 'user_denied',
            detail: decision.message ?? 'The user denied the form submission.',
          });
        }

        // TOCTOU: re-read and diff against the approved snapshot BEFORE
        // dispatching. Any drift (page JS rewrote action/values post-
        // approval) aborts and re-confirms once, then fails loudly.
        const current = await page.evaluate<SubmitSnapshot | null>(
          buildSubmitSnapshotScript(formIndex),
        );
        if (!current) {
          return toolError(
            'browser_form_gone',
            'toctou',
            'The form disappeared between approval and dispatch.',
            'Call snapshot to re-read the page and retry.',
          );
        }
        const diffs = diffSubmitSnapshots(approvedSnapshot, current);
        if (diffs.length === 0) {
          break;
        }
        diagWarn(
          `[browser-mcp] submit TOCTOU drift session=${this.deps.sessionId} ` +
            `diffs=${diffs.map((d) => `${d.kind}${d.field ? `:${d.field}` : ''}`).join(',')}`,
        );
        if (attempt >= 1) {
          return toolError(
            'browser_submit_toctou',
            'toctou',
            'The form kept changing after re-confirmation; submission aborted.',
            'Call snapshot, verify the page is stable, and retry the submission.',
          );
        }
        approvedSnapshot = current;
        pendingDiffs = diffs;
      }

      // Dispatch: click the approved submit control when given, else
      // requestSubmit() so validation + submit events fire.
      if (controlEntry?.xpath) {
        const clickResult = await page.evaluate<{ ok: boolean; reason?: string }>(
          buildActScript(controlEntry.xpath, 'click', undefined),
        );
        if (!clickResult.ok) {
          return toolError(
            'browser_action_failed',
            'dispatch',
            `Failed to activate the submit control: ${clickResult.reason ?? 'unknown'}`,
            'Call snapshot to re-read the page and retry.',
          );
        }
      } else {
        const dispatchResult = await page.evaluate<{ ok: boolean; reason?: string }>(
          buildRequestSubmitScript(formIndex),
        );
        if (!dispatchResult.ok) {
          return toolError(
            'browser_action_failed',
            'dispatch',
            `Form dispatch failed: ${dispatchResult.reason ?? 'unknown'}`,
            'Call snapshot to re-read the page and retry.',
          );
        }
      }

      await this.settle();
      const prevModel = this.lastModel;
      const model = await this.distill(page);
      const delta = diffPageModels(prevModel, model);
      diagLog(`[browser-mcp] submit session=${this.deps.sessionId} form=${formName} action=${approvedSnapshot.action}`);
      this.audit.logToolAction({
        workspaceId: this.deps.workspaceId,
        sessionId: this.deps.sessionId,
        toolName: BROWSER_TOOL_NAMES.submit,
        url: approvedSnapshot.action,
        fieldNames: approvedSnapshot.fields.map((field) => field.name),
        outcome: 'ok',
        detail: `form=${formName} method=${approvedSnapshot.method.toUpperCase()}`,
      });
      return toolJson({
        submitted: true,
        form: formName,
        action: approvedSnapshot.action,
        method: approvedSnapshot.method.toUpperCase(),
        delta,
        model,
      });
    } catch (err) {
      return this.toErrorResult(err, 'dispatch');
    }
  }

  private resolveSubmitField(formIndex: number, key: string): RefEntry | null {
    const byRef = this.refTable.get(key);
    if (byRef && byRef.kind === 'field' && byRef.formIndex === formIndex) {
      return byRef;
    }
    const modelForm = this.lastModel?.forms.find((form) => form.formIndex === formIndex);
    const modelField = modelForm?.fields.find(
      (field) => field.name === key || field.ref === key || field.label === key,
    );
    if (!modelField) return null;
    const entry = this.refTable.get(modelField.ref);
    return entry && entry.kind === 'field' ? entry : null;
  }

  // -- extract ----------------------------------------------------------------

  async handleExtract(args: { schema: Record<string, ExtractFieldSpec> }): Promise<CallToolResult> {
    try {
      const page = await this.ensurePage();
      const model = await this.distill(page);
      const keys = Object.keys(args.schema);
      if (keys.length === 0) {
        return toolError(
          'browser_extract_empty',
          'extract',
          'The extraction schema has no fields.',
          'Provide a schema mapping output keys to extraction specs ({source: "text"|"title"|"url"|"meta"|"selector"|"links"|"forms", ...}).',
        );
      }
      const data: Record<string, unknown> = {};
      const extracted: string[] = [];
      const missing: string[] = [];
      const truncated: string[] = [];

      const pageBackedSpecs: Array<{ key: string } & ExtractFieldSpec> = [];
      for (const key of keys) {
        const spec = args.schema[key];
        switch (spec.source) {
          case 'text':
            data[key] = model.content.text;
            extracted.push(key);
            if (model.content.truncated) truncated.push(key);
            break;
          case 'title':
            data[key] = model.title;
            extracted.push(key);
            break;
          case 'url':
            data[key] = model.url;
            extracted.push(key);
            break;
          case 'forms':
            // Form summary is already KTD-8 sanitized (no sensitive values).
            data[key] = model.forms;
            extracted.push(key);
            break;
          case 'meta':
          case 'selector':
          case 'links':
            pageBackedSpecs.push({ key, ...spec });
            break;
          default:
            missing.push(key);
            break;
        }
      }

      if (pageBackedSpecs.length > 0) {
        const result = await page.evaluate<Record<string, unknown>>(
          buildExtractScript(pageBackedSpecs),
        );
        for (const spec of pageBackedSpecs) {
          const value = result[spec.key];
          if (value === undefined || value === null || value === '') {
            missing.push(spec.key);
          } else {
            data[spec.key] = value;
            extracted.push(spec.key);
          }
        }
      }

      diagLog(`[browser-mcp] extract session=${this.deps.sessionId} fields=${extracted.length}`);
      this.audit.logToolAction({
        workspaceId: this.deps.workspaceId,
        sessionId: this.deps.sessionId,
        toolName: BROWSER_TOOL_NAMES.extract,
        url: model.url,
        fieldNames: extracted,
        outcome: 'ok',
      });
      return toolJson({
        ok: true,
        data,
        receipt: {
          url: model.url,
          title: model.title,
          extractedFields: extracted,
          missingFields: missing,
          truncatedFields: truncated,
        },
      });
    } catch (err) {
      return this.toErrorResult(err, 'extract');
    }
  }

  // -- requestHandoff (KTD-6: handler-body round-trips + state machine) ------

  /**
   * Full handoff flow (U5):
   *   request → card #1 (takeover) → user_in_control → card #2 (handback
   *   wait) → agent receives the sanitized state diff.
   * Both cards are issued from this handler (settings.json allow rules can
   * short-circuit canUseTool — KTD-6) and share the controller's server-fixed
   * 10-minute timer; panel activity pings reset it content-free. A handoff
   * requested while the user is already driving (F3 race) skips card #1 —
   * its card #2 is the session's single active card.
   */
  async handleRequestHandoff(args: { reason: string }, extra?: unknown): Promise<CallToolResult> {
    const sessionId = this.deps.sessionId;
    const ctl = this.handoffCtl;
    const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
    diagLog(`[browser-mcp] handoff requested session=${sessionId} reason=${args.reason}`);

    // The browser must exist for a takeover; ensurePage also transparently
    // rebuilds a session_lost browser (transition table: tool call → rebuild).
    try {
      await this.ensurePage();
    } catch (err) {
      return this.toErrorResult(err, 'control');
    }

    let phase: HandoffPhase;
    try {
      phase = ctl.beginHandoff(sessionId, args.reason).phase;
    } catch (err) {
      if (err instanceof BrowserHandoffError) {
        return toolError(
          err.code,
          'control',
          err.message,
          err.code === 'browser_handoff_already_pending'
            ? 'Wait for the current handoff to complete (or for its timeout), then retry.'
            : 'Retry the tool call; if it persists, check /api/health/browser.',
        );
      }
      throw err;
    }

    let completion: BrowserHandoffCompletion | null = null;
    try {
      if (phase === 'awaiting_takeover') {
        // Card #1: ask the user to take over.
        const cardId = ctl.beginCard(sessionId);
        if (!cardId) {
          completion = { reason: ctl.endedReason(sessionId) ?? 'crash', phase };
        } else {
          const origin = this.pageOrigin();
          const decision = await this.requestApproval(
            {
              requestId: cardId,
              toolName: BROWSER_TOOL_NAMES.requestHandoff,
              title: 'Claude is asking you to take control of the browser',
              description: args.reason,
              payload: {
                kind: 'browser_handoff',
                phase: 'takeover',
                reason: args.reason,
                ...(origin !== undefined && { origin }),
              },
            },
            signal,
          );
          if (!isApprovalDecision(decision)) return decision;
          if (decision.behavior !== 'allow') {
            completion = { reason: ctl.classifyDeny(sessionId), phase, detail: decision.message };
          } else {
            ctl.noteTakeoverApproved(sessionId);
            phase = 'in_takeover';
          }
        }
      }

      if (!completion) {
        // Card #2: the user is driving; wait for the handback ("继续").
        const cardId = ctl.beginCard(sessionId);
        if (!cardId) {
          completion = { reason: ctl.endedReason(sessionId) ?? 'crash', phase };
        } else {
          const decision = await this.requestApproval(
            {
              requestId: cardId,
              toolName: BROWSER_TOOL_NAMES.requestHandoff,
              title: 'You are in control of the browser',
              description:
                'Claude is waiting while you drive. Click continue when you are done to hand control back with a summary of what changed.',
              payload: {
                kind: 'browser_handoff',
                phase: 'handback',
                reason: args.reason,
              },
            },
            signal,
          );
          if (!isApprovalDecision(decision)) return decision;
          if (decision.behavior === 'allow') {
            completion = { reason: 'handed_back', phase };
          } else {
            completion = { reason: ctl.classifyDeny(sessionId), phase, detail: decision.message };
          }
        }
      }

      return await this.handoffCompletionResult(completion);
    } finally {
      ctl.completeHandoff(sessionId, completion?.reason ?? 'declined');
    }
  }

  private pageOrigin(): string | undefined {
    return originOf(this.lastModel?.url) ?? undefined;
  }

  /**
   * Agent-initiated close (U2): asks the human to confirm closing the
   * browser, then tears it down via closeSession (teardown + audit). Closing
   * never persists credentials; that requires a separate explicit Remember.
   * A single approval card — no two-phase takeover/handback and no
   * controlGate: asking to close is always allowed, and the approval card is
   * the human-consent gate (KTD-2). Resolution (allow / deny / timeout /
   * channel-failure) mirrors requestHandoff. A no-live-browser close is an
   * ok-noop rather than an error.
   */
  async handleClose(args: { reason?: string }, extra?: unknown): Promise<CallToolResult> {
    const sessionId = this.deps.sessionId;
    const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;

    if (!this.svc.getSession(sessionId)) {
      return toolJson({ ok: true, closed: false, note: 'No live browser to close.' });
    }

    const reason = args.reason?.trim() || 'The browsing task is complete.';
    const origin = this.pageOrigin();
    // Mark the close card in flight so the idle prompt defers (R10 dedup —
    // the two "close?" prompts must not stack). Cleared in finally: on allow
    // closeSession tears down; on deny/timeout setCloseCardPending(false)
    // resumes idle counting.
    this.svc.setCloseCardPending(sessionId, true);
    let decision: BrowserApprovalDecision | CallToolResult;
    try {
      decision = await this.requestApproval(
        {
          toolName: BROWSER_TOOL_NAMES.close,
          title: 'Claude is asking to close the browser',
          description: reason,
          payload: {
            kind: 'browser_close',
            reason,
            ...(origin !== undefined && { origin }),
          },
        },
        signal,
      );
    } finally {
      this.svc.setCloseCardPending(sessionId, false);
    }
    if (!isApprovalDecision(decision)) return decision;
    if (decision.behavior !== 'allow') {
      return toolJson({ ok: true, closed: false, note: 'User declined to close the browser.' });
    }

    const result = await this.svc.closeSession(sessionId, 'agent');
    if (result.closed) {
      this.disposeTask('connection_closed');
      this.deps.contextRegistry?.delete(sessionId);
    }
    return toolJson({
      ok: true,
      closed: result.closed,
      note: 'Browser closed. Only sites explicitly remembered before closing remain available.',
    });
  }


  /**
   * Shape the handoff outcome (R7/R8/AE4): a handed-back (or takeover-phase)
   * completion carries the state diff — the distilled model omits sensitive
   * field values by construction (KTD-8 ruleset, AE1). All non-crash endings
   * are recoverable plain results so the agent can explain and continue.
   */
  private async handoffCompletionResult(
    completion: BrowserHandoffCompletion,
  ): Promise<CallToolResult> {
    if (completion.reason === 'crash') {
      return toolError(
        'browser_session_lost',
        'control',
        'The browser process crashed during the handoff; the takeover ended and in-progress page state was lost.',
        'Retry the tool call — the browser session rebuilds automatically on the next call — then re-request the handoff if it is still needed.',
      );
    }

    const includeDiff = completion.reason === 'handed_back' || completion.phase === 'in_takeover';
    let delta: ReturnType<typeof diffPageModels> | undefined;
    let model: PageModel | undefined;
    if (includeDiff) {
      try {
        const page = await this.ensurePage();
        const prev = this.lastModel;
        model = await this.distill(page);
        delta = diffPageModels(prev, model);
      } catch (err) {
        // The diff is best-effort on non-happy paths; never mask the outcome.
        diagWarn(
          `[browser-mcp] handback state diff failed session=${this.deps.sessionId}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    if (completion.reason === 'handed_back') {
      diagLog(`[browser-mcp] handoff handed back session=${this.deps.sessionId}`);
      return toolJson({
        ok: true,
        handoffCompleted: true,
        ...(delta !== undefined && { delta }),
        ...(model !== undefined && { model }),
        note: 'State diff follows the sanitization ruleset: sensitive field values (passwords, card numbers, one-time codes) are never included.',
      });
    }

    diagLog(
      `[browser-mcp] handoff ended session=${this.deps.sessionId} reason=${completion.reason}`,
    );
    // Controller-driven endings (timeout/runtime close) get the actionable
    // explanation for the chat (R8); a user decline carries its own message.
    const detail =
      completion.reason === 'declined'
        ? (completion.detail ?? HANDOFF_END_DETAILS.declined)
        : (HANDOFF_END_DETAILS[completion.reason] ?? completion.detail);
    return toolJson({
      ok: true,
      handoffCompleted: false,
      reason: completion.reason,
      ...(detail !== undefined && { detail }),
      ...(delta !== undefined && { delta }),
      ...(model !== undefined && { model }),
    });
  }

  // ---------------------------------------------------------------------------

  private async settle(): Promise<void> {
    if (this.settleMs <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, this.settleMs));
  }

  private toErrorResult(err: unknown, stage: ToolStage): CallToolResult {
    if (err instanceof BrowserUnavailableError) {
      return toolError(
        err.code,
        'session_start',
        err.message,
        UNAVAILABLE_RESOLUTIONS[err.code] ?? 'Retry the call; check /api/health/browser if it persists.',
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    diagWarn(`[browser-mcp] ${stage} failure session=${this.deps.sessionId}:`, message);
    return toolError(
      'browser_cdp_error',
      stage,
      `Browser operation failed at stage "${stage}": ${message}`,
      'Call snapshot to re-read the page; if the failure persists, the browser session may need to be reopened.',
    );
  }
}

// ---------------------------------------------------------------------------
// Tool definitions + server factory
// ---------------------------------------------------------------------------

export type BrowserToolDefinition = BrowserToolDefinitionShape;

/** Dispose the process-default MCP context owned by one task/runtime. */
export function disposeBrowserToolContext(
  sessionId: string,
  service: BrowserService = browserService,
): void {
  const registry = contextRegistryFor(service);
  const context = registry.get(sessionId);
  context?.disposeTask('connection_closed');
  registry.delete(sessionId);
}

export function buildBrowserToolDefinitions(deps: BrowserMcpDeps): BrowserToolDefinition[] {
  const service = deps.browserService ?? browserService;
  const contextRegistry = deps.contextRegistry ?? contextRegistryFor(service);
  let ctx = contextRegistry.get(deps.sessionId);
  if (!ctx) {
    ctx = new BrowserToolContext({
      ...deps,
      browserService: service,
      contextRegistry,
    });
    contextRegistry.set(deps.sessionId, ctx);
  }

  const openDef = tool(
    'open',
    'Navigate the embedded browser to an http(s) URL and return the distilled page model ' +
      '(forms, actions with element refs, main content). Starts the browser session on first use. ' +
      'Use snapshot afterwards to refresh; use act/submit with the returned refs to interact.',
    { url: z.string().describe('Full http(s) URL to navigate to') },
    async (args) => ctx.handleOpen(args),
  );

  const snapshotDef = tool(
    'snapshot',
    'Re-read the current page and return a fresh distilled page model with new element refs. ' +
      'Refs from earlier models are invalidated by page changes — always snapshot after navigation ' +
      'or when act/submit report stale refs. Optionally include a viewport screenshot.',
    {
      screenshot: z
        .boolean()
        .optional()
        .describe('Include a JPEG screenshot image block (default false)'),
    },
    async (args) => ctx.handleSnapshot(args),
    { annotations: { readOnlyHint: true, openWorldHint: true } },
  );

  const inspectElementDef = tool(
    'inspectElement',
    'Inspect one current element ref and return a bounded safe summary: tag, role/name, safe ' +
      'attributes, nearby text, limited descendants, owning-form structure, and possible actions. ' +
      'Only refs from the latest page model are accepted; selectors and raw HTML are never returned.',
    { ref: z.string().describe('Element ref from the latest open/snapshot/act model') },
    async (args) => ctx.handleInspectElement(args),
    { annotations: { readOnlyHint: true, openWorldHint: true } },
  );

  const startNetworkCaptureDef = tool(
    'startNetworkCapture',
    'Start passive action-scoped network recording for this browser session. Call immediately ' +
      'before one browser action, then call stopNetworkCapture. Recording observes traffic but ' +
      'does not intercept, pause, or modify requests.',
    {
      action: z.string().max(500).optional().describe('Short description of the one action being bracketed'),
    },
    async (args) => ctx.handleStartNetworkCapture(args),
    { annotations: { readOnlyHint: true, openWorldHint: true } },
  );

  const stopNetworkCaptureDef = tool(
    'stopNetworkCapture',
    'Close admission for the active action-scoped capture, drain admitted requests, and return ' +
      'ranked sanitized API candidates. Ranking is evidence-based temporal association, not a ' +
      'claim that a request was caused by the action.',
    {},
    async () => ctx.handleStopNetworkCapture(),
    { annotations: { readOnlyHint: true, openWorldHint: true } },
  );

  const authenticatedRequestDef = tool(
    'authenticatedRequest',
    'Perform a sanitized HTTP request directly with an opaque authentication binding captured ' +
      'from this task. GET/HEAD requests do not ask for approval; other methods are authorized ' +
      'inside this handler before dispatch and can receive an exact task-local validation grant.',
    brokerRequestSchema,
    async (args, extra) => ctx.handleAuthenticatedRequest(
      args,
      deps.runtimeGeneration ?? 'unscoped',
      deps.apiBrokerAuthorized === true,
      extra as { signal?: AbortSignal },
    ),
    { annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
  );

  const actDef = tool(
    'act',
    'Perform a single interaction (click/fill/select/check) on an element ref from the page ' +
      'model, then return the resulting page delta and fresh model. Submitting a form is NOT ' +
      'possible through act — submit-semantics controls require the submit tool (user confirmation).',
    {
      ref: z.string().describe('Element ref from the latest page model (e.g. "e7")'),
      action: z.enum(['click', 'fill', 'select', 'check']),
      value: z
        .string()
        .optional()
        .describe('fill: text to enter; select: option value or label; check: "true"/"false" (omit to toggle)'),
    },
    async (args) => ctx.handleAct(args),
  );

  const submitBase = tool(
    'submit',
    'Submit a form. ALWAYS requires explicit user confirmation: the form action, method and ' +
      'fields (sensitive values redacted) are shown to the user, and the form state is re-verified ' +
      'before dispatch. Pass a form ref or a submit-button ref; optionally fill fields first.',
    {
      ref: z.string().describe('Form ref or submit-button ref from the latest page model'),
      fields: z
        .record(z.string(), z.string())
        .optional()
        .describe('Field values to fill before submitting, keyed by field ref or field name'),
    },
    async (args, extra) => ctx.handleSubmit(args, extra),
    { annotations: { destructiveHint: true, openWorldHint: true } },
  );
  // Auxiliary hint only — the security property is guaranteed by the
  // handler-level approval gate above, not by SDK meta (plan review fix).
  const submitDef = {
    ...submitBase,
    _meta: { 'anthropic/requiresUserInteraction': true },
  };

  const extractDef = tool(
    'extract',
    'Extract structured data from the current page per a schema of extraction specs, and ' +
      'return the data with a receipt (extracted/missing/truncated fields). Sources: "text" ' +
      '(main content), "title", "url", "meta" (name), "selector" (css + optional attribute/all), ' +
      '"links" (optional pattern/limit), "forms" (sanitized form summary).',
    {
      schema: z
        .record(
          z.string(),
          z.object({
            source: z.enum(['text', 'title', 'url', 'meta', 'selector', 'links', 'forms']),
            selector: z.string().optional(),
            attribute: z.string().optional(),
            name: z.string().optional(),
            all: z.boolean().optional(),
            pattern: z.string().optional(),
            limit: z.number().optional(),
          }),
        )
        .describe('Map of output key -> extraction spec'),
    },
    async (args) => ctx.handleExtract(args),
    { annotations: { readOnlyHint: true, openWorldHint: true } },
  );

  const handoffDef = tool(
    'requestHandoff',
    'Ask the user to take control of the embedded browser (e.g. for a login, CAPTCHA, or ' +
      'payment step the agent cannot or should not complete). Describe why control is needed. ' +
      'The call blocks until the user hands control back (with a sanitized summary of what ' +
      'changed), declines, or the request times out recoverably.',
    {
      reason: z.string().describe('Why the user needs to take over (shown in the handoff card)'),
    },
    async (args, extra) => ctx.handleRequestHandoff(args, extra),
  );

  const closeDef = tool(
    'close',
    'Close the embedded browser for this session, releasing its resources. The user must ' +
      'confirm before it closes. Call this when the browsing task is done and the page is no ' +
      'longer needed — do not leave a browser running idle. Any remembered login is preserved ' +
      'and re-applied on the next open. The call blocks until the user confirms, declines, or ' +
      'the request times out recoverably.',
    {
      reason: z
        .string()
        .optional()
        .describe('Why the browser is being closed (shown in the confirmation card)'),
    },
    async (args, extra) => ctx.handleClose(args, extra),
  );

  // The cast reconciles handler-parameter variance: each tool definition is
  // generic over its own zod shape, while BrowserToolDefinition erases it.
  return [
    openDef,
    snapshotDef,
    inspectElementDef,
    startNetworkCaptureDef,
    stopNetworkCaptureDef,
    authenticatedRequestDef,
    actDef,
    submitDef,
    extractDef,
    handoffDef,
    closeDef,
  ] as BrowserToolDefinition[];
}
