import type { CallToolResult as CallToolResultType } from '@modelcontextprotocol/sdk/types.js';
import { createHash, randomUUID } from 'node:crypto';
import { createBrowserBinding } from '../utils/credential-crypto.js';
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
import {
  CdpError,
  connectBrowserPage,
  type BrowserCdpSession,
  type BrowserOperationReceipt,
} from './browser-cdp.js';
import {
  RefTable,
  buildPageState,
  buildInspectElementFunction,
  buildInspectElementStateFunction,
  buildActivationTargetSnapshotFunction,
  buildFileInputSnapshotFunction,
  buildSubmitSnapshotScript,
  diffPageModels,
  diffSubmitSnapshots,
  distillPageModel,
  sanitizeSubmitPayload,
  type PageModel,
  type InspectedElement,
  type RefBatchKey,
  type RefEntry,
  type ElementFingerprint,
  type ElementProvenance,
  type InteractionClass,
  sameElementFingerprint,
  sameBrowserDocumentIdentity,
  buildElementFingerprintFunction,
  type SubmitSnapshot,
  type ActivationTargetSnapshot,
  type FileInputSnapshot,
  sanitizeUntrustedPageText,
} from './browser-page-model.js';
import {
  BrowserUploadPolicyError,
  inspectBrowserUploadCandidates,
  reopenApprovedBrowserUpload,
  type BrowserUploadCandidate,
} from './browser-upload-policy.js';
import {
  browserUploadStagingService,
  type BrowserUploadStagingService,
} from './browser-upload-staging.js';
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
import { browserTaskTrace, type BrowserTaskOperationClass, type BrowserTaskTrace, type BrowserTaskTraceInput } from './browser-task-trace.js';
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
import {
  browserMutationCoordinator,
  type BrowserInvocationScope,
  type BrowserMutationCoordinator,
  type BrowserMutationRequest,
} from './browser-mutation-coordinator.js';
import {
  BrowserDecisionObservationError,
  DecisionObservationCoordinator,
  type ApplicationSensitiveRegionProvider,
  type DecisionObservationBudget,
  type DecisionObservationLimits,
  type DecisionObservationTransform,
} from './browser-decision-observation.js';
import type {
  BrowserTaskScope,
  BrowserTaskSlot,
  BrowserTaskState,
  BrowserTaskStateService,
  PopulationBucket,
} from './browser-task-state.js';

// Re-export so existing consumers of './browser-mcp.js' (chat-service, U3
// tests) keep working; the canonical home is browser-tool-names.ts (U4) so
// policy modules can match names without loading the BrowserService chain.
export { BROWSER_MCP_SERVER_KEY, BROWSER_TOOL_PREFIX };

export const BROWSER_MCP_INSTRUCTIONS = `Follow an observe-plan-act-validate loop. Mutation tools return only bounded receipts, never a page model; receipts prove local dispatch mechanics, never task or business completion. Task tools accept evidence proposals, while the server alone derives requiredness, validation, authority, readiness, and completion. After every mutation, call getPageState before using element refs. Use the embedded browser tools in this order:
1. getPageState — default page observation after an external or user-driven page change, a stale-ref error, or when reading another bounded inventory segment. It provides a page-level, text-only, token-bounded semantic view and element refs without requiring vision.
2. getDecisionObservation — only when structure is insufficient, obtain one coherent structured-and-visual bundle. Its rectangles are evidence and never executable coordinates.
3. rebindVisualCandidates — validate model-cited refs from one decision observation through trusted current geometry and hit-testing; it never accepts action coordinates.
4. getTaskState/startTask/proposeTaskEvidence — maintain the current goal-scoped checklist using current observation refs. Never infer declaration authority or task completion.
5. findElements — search the complete internal element index when the page-state inventory is truncated or the target is not obvious.
6. getElementDetails — inspect one known ref when more attributes or local context are needed.
7. act — fill/select/check editable controls. act(click) never dispatches; use activate for page-supplied controls or submit for HTML form submission.
8. upload — assign approved workspace media to a file-input ref through the shell-owned browser only.
9. activate — request a single handler-approved physical click for a page-supplied control. Its receipt is not proof of business success; observe afterward.
10. takeScreenshot — optional and only for genuinely visual questions such as layout, overlap, charts, canvas, or image content. Do not use it for routine page understanding or element discovery, and do not use it as a substitute for getPageState.`;

/**
 * browser-mcp — the first-class tool surface for the embedded controlled
 * browser (KTD-3). Fifteen tools on the `comate-browser` SDK MCP server
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
 *  - act(click) never dispatches. Page controls route to activate and form
 *    submissions route to submit, both with handler-owned approval.
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
  /** Handler-owned fixed TTL; never accepted from MCP input. */
  timeoutMs?: number;
}

export type BrowserApprovalDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; message?: string }
  | { behavior: 'later'; message?: string }
  | { behavior: 'timeout' | 'revoked'; message?: string };

/**
 * Implemented by chat-service: lazily resolves the session's live runtime and
 * drives a pending_approval round-trip through it. Lazy lookup is deliberate —
 * the runtime may be rebuilt while the browser session lives on (KTD-5).
 */
export type BrowserApprovalRequester = (
  sessionId: string,
  request: BrowserApprovalRequest,
) => Promise<BrowserApprovalDecision>;

export type BrowserTrustedOutcomeResult =
  | { status: 'insufficient' | 'conflicting' }
  | { status: 'durable'; evidenceId: string; correlatedOperationId: string };

export interface BrowserTrustedOutcomeObserver {
  recheck(input: Readonly<{
    workspaceId: string; sessionId: string; taskId: string; taskVersion: number; operationId: string;
  }>): Promise<BrowserTrustedOutcomeResult>;
}

export interface BrowserMcpDeps {
  sessionId: string;
  workspaceId: string;
  /** Canonical workspace root used by the dedicated local-file egress gate. */
  workspaceFolder?: string;
  /** Generation of the task capability authorizing this MCP invocation. */
  runtimeGeneration?: string;
  /** Request-fresh capability identity; never cached in BrowserToolContext. */
  capabilityId?: string;
  /** Stable authenticated caller identity used for operation-ID binding. */
  principalId?: string;
  /** Re-checks the exact capability/runtime immediately before dispatch. */
  isInvocationCurrent?: () => boolean | Promise<boolean>;
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
  connectPage?: (baseUrl: string) => Promise<BrowserCdpSession>;
  /** Audit sink (U8); defaults to the process singleton. */
  audit?: Pick<BrowserAuditService, 'logToolAction'>;
  /** Authenticated direct-request broker; tests may inject a deterministic one. */
  authenticatedRequestBroker?: BrowserApiBrokerExecutor;
  /**
   * Shared page-connection registry keyed by chat sessionId. Runtime rebuilds
   * mint a fresh MCP server instance (and BrowserToolContext) for the same
   * session; without a shared registry each rebuild would leak the previous
   * instance's CDP socket until the browser view died. The default is a
   * module-level map; tests inject a fresh one per harness.
   */
  pageRegistry?: Map<string, Promise<BrowserCdpSession>>;
  /** Session-owned contexts preserve refs/captures across stateless MCP POSTs. */
  contextRegistry?: Map<string, BrowserToolContext>;
  /** Injectable drain timing for focused capture tests. */
  captureOptions?: BrowserNetworkCaptureOptions;
  /** Post-action settle delay before re-distilling (0 in tests). */
  settleMs?: number;
  mutationCoordinator?: BrowserMutationCoordinator;
  uploadStaging?: BrowserUploadStagingService;
  /** U1 observation coordinator; tests may inject limits through the constructor. */
  decisionObservationCoordinator?: DecisionObservationCoordinator;
  decisionObservationLimits?: Partial<DecisionObservationLimits>;
  /** U3 supplies the task-aware implementation; absence does not invent task state. */
  decisionObservationBudget?: DecisionObservationBudget;
  applicationSensitiveRegions?: ApplicationSensitiveRegionProvider;
  /** U3 goal-scoped task authority. Task tools fail closed when it is absent. */
  taskState?: BrowserTaskStateService;
  /** Trusted application observer. Absence intentionally leaves publication outcome unknown. */
  businessOutcomeObserver?: BrowserTrustedOutcomeObserver;
  /** Read-only diagnostic sink; failures never influence task authority. */
  taskTrace?: Pick<BrowserTaskTrace, 'append'>;
}

// ---------------------------------------------------------------------------
// In-page helpers bound to an already resolved backend-node object.
// ---------------------------------------------------------------------------

function buildBackendActFunction(action: string, value: string | undefined): string {
  return `function () {
  var action = ${JSON.stringify(action)};
  var value = ${JSON.stringify(value ?? '')};
  var el = this;
  if (!el) return { ok: false, reason: 'element_not_found' };
  try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
  var tag = el.tagName ? el.tagName.toLowerCase() : '';
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
    return { ok: true, matches: el.value === opts[el.selectedIndex].value };
  }
  return { ok: false, reason: 'unknown_action' };
}`;
}

function buildBackendCheckStateFunction(): string {
  return `function () {
    var tag = this && this.tagName ? this.tagName.toLowerCase() : '';
    var type = this && this.getAttribute ? (this.getAttribute('type') || '').toLowerCase() : '';
    if (tag !== 'input' || (type !== 'checkbox' && type !== 'radio')) return { ok: false };
    return { ok: true, checked: this.checked === true };
  }`;
}

function buildBackendSubmitFunction(): string {
  return `function () {
  var form = this;
  if (!form) return { ok: false, reason: 'form_gone' };
  try {
    if (form.requestSubmit) { form.requestSubmit(); } else { form.submit(); }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'dispatch_failed: ' + (e && e.message ? e.message : String(e)) };
  }
}`;
}

function isSubmitNavigationRace(error: unknown): boolean {
  return (
    error instanceof CdpError &&
    error.method === 'Runtime.evaluate' &&
    /(?:Inspected target navigated or closed|Execution context was destroyed|Cannot find context with specified id)/i.test(
      error.message,
    )
  );
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

type Geometry = { x: number; y: number; width: number; height: number };

function sameGeometry(left: Geometry, right: Geometry): boolean {
  return Math.abs(left.x - right.x) <= 0.5 && Math.abs(left.y - right.y) <= 0.5 &&
    Math.abs(left.width - right.width) <= 0.5 && Math.abs(left.height - right.height) <= 0.5;
}

function imagePointToCss(
  point: { x: number; y: number },
  transform: DecisionObservationTransform,
): { x: number; y: number } {
  return {
    x: transform.captureCss.x + point.x / transform.cssToNormalizedScaleX,
    y: transform.captureCss.y + point.y / transform.cssToNormalizedScaleY,
  };
}

function visualEvidenceCssRect(
  candidate: { point?: { x: number; y: number }; box?: Geometry },
  transform: DecisionObservationTransform,
): Geometry | undefined {
  if (candidate.point) {
    const point = imagePointToCss(candidate.point, transform);
    return { ...point, width: 0.01, height: 0.01 };
  }
  if (candidate.box) {
    const origin = imagePointToCss(candidate.box, transform);
    return {
      ...origin,
      width: candidate.box.width / transform.cssToNormalizedScaleX,
      height: candidate.box.height / transform.cssToNormalizedScaleY,
    };
  }
  return undefined;
}

function rectsIntersect(left: Geometry, right: Geometry): boolean {
  return left.x <= right.x + right.width && right.x <= left.x + left.width &&
    left.y <= right.y + right.height && right.y <= left.y + left.height;
}

const TASK_SLOT_CATEGORIES = [
  'content_type', 'title', 'primary_content', 'description', 'topic', 'media',
  'visibility', 'declaration', 'final_activation', 'generic_text',
  'generic_choice', 'generic_file', 'generic_boolean',
] as const;
type TaskSlotCategory = typeof TASK_SLOT_CATEGORIES[number];
type TaskMutationBinding = {
  taskId: string;
  taskVersion: number;
  slotKey: string;
  observationId: string;
};

function populationBucket(field: PageModel['forms'][number]['fields'][number] | undefined): PopulationBucket {
  if (!field?.filled) return 'empty';
  const length = field.contentLength ?? field.value?.length;
  if (length === undefined) return 'present';
  if (length <= 80) return 'short';
  if (length <= 800) return 'medium';
  return 'long';
}

function mutationAuthorizationError(): CallToolResult {
  return toolError(
    'browser_mutation_cancelled',
    'dispatch',
    'The request authority changed before the browser mutation could be dispatched.',
    'Observe the current browser state and start a new operation with a new operationId.',
  );
}

function parseToolPayload(result: CallToolResult): Record<string, unknown> {
  const text = result.content.find((item) => item.type === 'text');
  if (!text || text.type !== 'text') return {};
  try { return JSON.parse(text.text) as Record<string, unknown>; } catch { return {}; }
}

function mutationDeltaKind(
  action: BrowserMutationRequest['action'],
): BrowserOperationReceipt['delta']['kind'] {
  if (action === 'fill' || action === 'select' || action === 'check' || action === 'declaration' || action === 'upload') return 'field';
  if (action === 'submit' || action === 'activation') return 'activation';
  return 'none';
}

function mutationReceiptForResult(
  action: BrowserMutationRequest['action'],
  result: CallToolResult,
  dispatchAuthorized: boolean,
): BrowserOperationReceipt {
  const payload = parseToolPayload(result);
  if (payload.receipt && typeof payload.receipt === 'object') {
    return payload.receipt as BrowserOperationReceipt;
  }
  if (!dispatchAuthorized) {
    const denied = payload.submitted === false || payload.activated === false || payload.uploaded === false || payload.closed === false || payload.handoffCompleted === false;
    return {
      outcome: 'not_dispatched', dispatchState: 'not_dispatched', verified: denied,
      retrySafe: true, reason: denied ? 'user_denied' : 'target_unavailable',
      delta: { kind: 'none', changed: false },
    };
  }
  if (result.isError) {
    return unknownMutationReceipt(mutationDeltaKind(action));
  }
  const clearlySucceeded = action === 'open'
    ? payload.ok === true && typeof payload.model === 'object'
    : action === 'submit' ? payload.submitted === true
      : action === 'close' ? payload.closed === true
        : action === 'control' ? payload.handoffCompleted === true
          : payload.ok === true;
  if (!clearlySucceeded) {
    return unknownMutationReceipt(mutationDeltaKind(action));
  }
  return {
    outcome: 'dispatched_verified', dispatchState: 'dispatched', verified: true,
    retrySafe: false, delta: { kind: mutationDeltaKind(action), changed: true },
  };
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

function publicEditorSummary(snapshot: ActivationTargetSnapshot): Record<string, number> {
  return {
    editorCount: snapshot.editorSummary.count,
    filledEditorCount: snapshot.editorSummary.filledCount,
    totalEditorLength: snapshot.editorSummary.totalLength,
  };
}

function activationClassificationError(target: RefEntry): CallToolResult | undefined {
  if (target.interactionClass === 'human-only') {
    return toolError('browser_handoff_required', 'dispatch', 'This page control is human-only.', 'Call requestHandoff so the user can complete it directly.');
  }
  if (target.submitSemantics) {
    return toolError('browser_use_submit_tool', 'ref_resolve', 'This page control submits an HTML form.', 'Call submit with this ref or its owning form ref.');
  }
  if (target.interactionClass === 'file-egress') {
    return toolError('browser_use_upload_tool', 'ref_resolve', 'File-input refs cannot be activated through a generic page click.', 'Use the dedicated approved workspace upload tool when it is available.');
  }
  if (target.kind !== 'action' || target.interactionClass !== 'ambiguous-activation' ||
      typeof target.backendNodeId !== 'number') {
    return toolError(
      'browser_activation_unsupported',
      'ref_resolve',
      'This ref is not an ambiguous page action and cannot use generic activation.',
      target.kind === 'field'
        ? 'Use act with fill, select, or check for editable field refs.'
        : 'Choose an action ref from getPageState or findElements.',
    );
  }
  return undefined;
}

function activationApprovalTarget(entry: RefEntry, details: InspectedElement): Record<string, unknown> {
  const target: Record<string, unknown> = {
    role: sanitizeUntrustedPageText(details.role ?? entry.role, 80),
    name: sanitizeUntrustedPageText(details.name ?? entry.name, 160),
  };
  const nearby = sanitizeUntrustedPageText(details.nearbyText ?? '', 240);
  if (nearby.text) target.nearbyContext = nearby;
  return target;
}

function activationSafeDifferences(
  approved: ActivationTargetSnapshot,
  current: ActivationTargetSnapshot,
): string[] {
  const differences: string[] = [];
  if (JSON.stringify(approved.geometry) !== JSON.stringify(current.geometry)) differences.push('target_geometry_changed');
  if (
    approved.editorSummary.count !== current.editorSummary.count ||
    approved.editorSummary.filledCount !== current.editorSummary.filledCount ||
    approved.editorSummary.totalLength !== current.editorSummary.totalLength ||
    approved.editorSummary.privateDigest !== current.editorSummary.privateDigest
  ) differences.push('editor_summary_changed');
  return differences;
}

function activationHighRiskDrift(
  approved: ActivationTargetSnapshot,
  current: ActivationTargetSnapshot,
): string | undefined {
  if (!current.connected) return 'target_disconnected';
  if (!current.enabled) return 'target_disabled';
  if (!current.visible || !current.inViewport) return 'target_not_visible';
  if (current.occluded) return 'target_occluded';
  if (current.origin !== approved.origin) return 'origin_changed';
  return undefined;
}

function fileInputUnsafe(snapshot: FileInputSnapshot | null): string | undefined {
  if (!snapshot?.connected || !snapshot.fileInput) return 'target_changed';
  if (!snapshot.enabled) return 'target_disabled';
  if (snapshot.directory) return 'directory_input_unsupported';
  if (!snapshot.associatedVisible) return 'target_not_user_visible';
  return undefined;
}

function sameFileInputContract(left: FileInputSnapshot, right: FileInputSnapshot): boolean {
  return left.origin === right.origin && left.fileInput === right.fileInput && left.enabled === right.enabled &&
    left.multiple === right.multiple && left.accept === right.accept && left.directory === right.directory &&
    left.associatedVisible === right.associatedVisible;
}

function uploadPolicyResult(error: unknown): CallToolResult {
  if (error instanceof BrowserUploadPolicyError) {
    return toolError(error.code, 'approval', error.message, 'Choose approved media files inside the workspace and start a new upload operation.');
  }
  return toolError('browser_upload_failed', 'dispatch', 'The approved upload could not be prepared safely.', 'Observe the file input and start a new upload operation.');
}

const UNAVAILABLE_RESOLUTIONS: Record<string, string> = {
  browser_limit_reached:
    'The concurrent browser limit is reached. Close another chat session\'s browser and retry.',
  browser_start_failed:
    'The embedded browser failed to start. Retry the call; check /api/health/browser if it persists. Outside the desktop app, the browser needs an external CDP endpoint (COMATE_BROWSER_CDP_TARGET).',
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
  browser_closed:
    'The browser was closed while the handoff was pending, so the takeover ended without a handback. Reopen the browser and re-request the handoff if it is still needed.',
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

interface FindElementsArgs {
  text?: string;
  regex?: string;
  role?: string;
  exact?: boolean;
  limit?: number;
}

interface FoundElement {
  ref: string;
  kind: 'action' | 'field' | 'form';
  role: string;
  name: string;
  context?: string;
  submitSemantics?: boolean;
  provenance?: ElementProvenance;
  interactionClass?: InteractionClass;
}

function unknownMutationReceipt(
  kind: 'none' | 'activation' | 'field',
  changed = false,
): BrowserOperationReceipt {
  return {
    outcome: 'outcome_unknown',
    dispatchState: 'dispatched',
    verified: false,
    retrySafe: false,
    reason: 'dispatch_failed',
    delta: { kind, changed },
  };
}

function verificationMismatchReceipt(changed: boolean): BrowserOperationReceipt {
  return {
    outcome: 'outcome_unknown',
    dispatchState: 'dispatched',
    verified: false,
    retrySafe: false,
    matchesRequested: false,
    reason: 'verification_mismatch',
    delta: { kind: 'field', changed },
  };
}

async function forEachWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await task(item);
    }
  });
  await Promise.all(workers);
}

function parseFindRegex(source: string): RegExp {
  const literal = /^\/(.*)\/([dgimsuvy]*)$/.exec(source);
  const pattern = literal ? literal[1] : source;
  const flags = literal ? literal[2].replace(/[gy]/g, '') : 'i';
  // Native RegExp runs on the server event loop. Keep this query surface to a
  // linear-time subset: no groups, repetition, lookarounds, or backreferences.
  // Literal metacharacters remain available when escaped.
  let escaped = false;
  let inClass = false;
  for (const char of pattern) {
    if (escaped) {
      if (/[1-9k]/.test(char)) throw new Error('backreferences are not supported');
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (!inClass && /[()*+?{}]/.test(char)) throw new Error('repetition and groups are not supported');
  }
  return new RegExp(pattern, flags);
}

function findElementsInModel(model: PageModel, args: FindElementsArgs, regex?: RegExp): FoundElement[] {
  const candidates: FoundElement[] = [];
  for (const form of model.forms) {
    const formName = form.name ?? `form ${form.formIndex}`;
    candidates.push({ ref: form.ref, kind: 'form', role: 'form', name: formName, interactionClass: form.interactionClass });
    for (const field of form.fields) {
      candidates.push({
        ref: field.ref,
        kind: 'field',
        role: field.role,
        name: field.label || field.name || field.type,
        context: formName,
        ...(field.submitSemantics ? { submitSemantics: true } : {}),
        interactionClass: field.interactionClass,
      });
    }
  }
  for (const action of model.actions) {
    candidates.push({
      ref: action.ref,
      kind: 'action',
      role: action.role,
      name: action.name,
      ...(action.context ? { context: action.context } : model.title ? { context: model.title } : {}),
      provenance: action.provenance,
      interactionClass: action.interactionClass,
    });
  }

  const text = args.text?.trim();
  const normalizedText = text?.toLocaleLowerCase();
  const role = args.role?.trim().toLowerCase();
  return candidates.filter((candidate) => {
    if (role && candidate.role.toLowerCase() !== role) return false;
    const name = candidate.name.trim();
    const haystack = [name, candidate.context].filter(Boolean).join('\n');
    if (text) {
      return args.exact === true
        ? name.localeCompare(text, undefined, { sensitivity: 'accent' }) === 0
        : haystack.toLocaleLowerCase().includes(normalizedText!);
    }
    return regex
      ? regex.test(name) || (candidate.context !== undefined && regex.test(candidate.context))
      : true;
  });
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

const defaultPageRegistry = new Map<string, Promise<BrowserCdpSession>>();
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
  private pageStateCache: PageModel | null = null;
  private readonly svc: BrowserService;
  private readonly handoffCtl: BrowserControlService;
  private readonly connectPage: (baseUrl: string) => Promise<BrowserCdpSession>;
  private readonly pageRegistry: Map<string, Promise<BrowserCdpSession>>;
  private readonly settleMs: number;
  private readonly audit: Pick<BrowserAuditService, 'logToolAction'>;
  private readonly authenticatedRequestBroker: BrowserApiBrokerExecutor;
  private readonly uploadStaging: BrowserUploadStagingService;
  private networkCapture?: BrowserNetworkCaptureManager;
  private capturePrimarySessionId?: string;
  private captureAction = 'One explicitly bracketed browser action';
  private readonly decisionObservations: DecisionObservationCoordinator;
  private latestDecisionObservation?: {
    observationId: string; observationEpoch: number; transform: DecisionObservationTransform;
    documentIdentityDigest: string; structuralChecksum: string; controlEpoch: string;
  };
  private readonly taskEvidenceRefs = new Map<string, string>();

  private trace(event: BrowserTaskTraceInput): void {
    try { (this.deps.taskTrace ?? browserTaskTrace).append(event); } catch { /* diagnostic only */ }
  }

  constructor(private readonly deps: BrowserMcpDeps) {
    this.svc = deps.browserService ?? browserService;
    this.handoffCtl = deps.handoffControl ?? browserControlService;
    // U7 (AE2): the dispatcher routes the __comate-cdp__ convention to the
    // native shell/external CDP target.
    this.connectPage = deps.connectPage ?? connectBrowserPage;
    this.pageRegistry = deps.pageRegistry ?? defaultPageRegistry;
    this.settleMs = deps.settleMs ?? 300;
    this.audit = deps.audit ?? browserAuditService;
    this.authenticatedRequestBroker = deps.authenticatedRequestBroker ?? browserApiBrokerService;
    this.uploadStaging = deps.uploadStaging ?? browserUploadStagingService;
    this.decisionObservations = deps.decisionObservationCoordinator ??
      new DecisionObservationCoordinator(deps.decisionObservationLimits);
    this.handoffCtl.configureObservationCancellation((sessionId) => {
      deps.contextRegistry?.get(sessionId)?.cancelDecisionObservation();
    });
  }

  cancelDecisionObservation(): void { this.decisionObservations.cancel(); }

  /** Abort task-owned capture state without closing the shared browser page. */
  disposeTask(reason: 'connection_closed' = 'connection_closed'): void {
    this.decisionObservations.cancel();
    this.networkCapture?.abort(reason);
    this.networkCapture = undefined;
    this.capturePrimarySessionId = undefined;
    this.refTable.clear();
    this.latestDecisionObservation = undefined;
    this.lastModel = null;
    this.pageStateCache = null;
    clearSubmitSemanticsRefs(this.deps.sessionId);
    void this.uploadStaging.releaseSession(this.deps.sessionId);
  }

  private async ensurePage(): Promise<BrowserCdpSession> {
    // Every caller reaching the page counts as browser activity. handleClose
    // intentionally bypasses this method, so closing does not reset the idle
    // clock it is ending.
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
      page.onDocumentChange?.(() => { void this.uploadStaging.releaseSession(this.deps.sessionId); });
      page.onClose(() => {
        this.decisionObservations.cancel();
        if (this.pageRegistry.get(key) === connecting) {
          this.pageRegistry.delete(key);
        }
        // This context's refs/model describe the dead page — drop them so the
        // next call re-distills against the rebuilt browser. The canUseTool
        // gate's ref view (U4) is cleared too; navigation memory survives
        // (session-level, KTD-4 ②).
        this.refTable.clear();
        this.latestDecisionObservation = undefined;
        this.lastModel = null;
        void this.uploadStaging.releaseSession(this.deps.sessionId);
        this.pageStateCache = null;
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

  private taskScope(): BrowserTaskScope {
    return {
      workspaceId: this.deps.workspaceId,
      sessionId: this.deps.sessionId,
      principalId: this.deps.principalId ?? `${this.deps.workspaceId}:${this.deps.sessionId}`,
      runtimeGeneration: this.deps.runtimeGeneration ?? 'unscoped',
      capabilityId: this.deps.capabilityId ?? 'unscoped',
    };
  }

  private taskUnavailable(): CallToolResult {
    return toolError(
      'browser_task_state_unavailable', 'control',
      'Goal-scoped browser task state is unavailable for this runtime.',
      'Reload the task runtime before creating or updating browser task state.',
    );
  }

  private taskResult(task: ReturnType<BrowserTaskStateService['getActive']>): CallToolResult {
    if (!task) return toolJson({ ok: true, task: null });
    const projection = this.deps.taskState!.projection(task.workspaceId, task.sessionId);
    return toolJson({
      ok: true,
      task: {
        taskId: task.taskId,
        version: task.version,
        lifecycle: task.lifecycle,
        projection,
        slots: task.slots.map((slot) => ({
          slotKey: slot.slotKey,
          discovery: slot.discovery,
          required: slot.required,
          population: slot.population,
          validation: slot.validation,
          authority: slot.authority,
          populationBucket: slot.populationBucket,
          evidenceId: slot.evidenceId,
        })),
      },
    });
  }

  async handleGetTaskState(): Promise<CallToolResult> {
    if (!this.deps.taskState) return this.taskUnavailable();
    try {
      return this.taskResult(this.deps.taskState.getActive(this.taskScope()));
    } catch (error) {
      return toolError('browser_task_state_failed', 'control', error instanceof Error ? error.message : String(error), 'Reload the task runtime.');
    }
  }

  private finalTask(binding: TaskMutationBinding | undefined) {
    if (!binding?.slotKey.startsWith('final_activation_') || !this.deps.taskState) return null;
    const task = this.deps.taskState.getActive(this.taskScope());
    return task && task.taskId === binding.taskId && task.version === binding.taskVersion && task.lifecycle === 'ready'
      ? task : null;
  }

  private publicationReview(task: BrowserTaskState) {
    const slots = task.slots.map((slot) => ({
      source: 'derived_metadata' as const,
      category: slot.slotKey.replace(/_\d+$/, ''),
      required: slot.required,
      disposition: slot.authority === 'confirmed' ? 'authority_confirmed'
        : slot.validation === 'verified' ? 'verified'
          : slot.population === 'populated' ? 'pending_validation' : 'empty',
      populationBucket: slot.populationBucket,
    }));
    return {
      source: 'user_intent' as const,
      taskVersion: task.version,
      slots,
      mediaCount: task.slots.filter((slot) => slot.slotKey.startsWith('media_') && slot.population === 'populated').length,
      declarationDisposition: task.slots.some((slot) => slot.slotKey.startsWith('declaration_'))
        ? task.slots.every((slot) => !slot.slotKey.startsWith('declaration_') || slot.authority === 'confirmed')
          ? 'confirmed' : 'unresolved'
        : 'not_present',
      visibilityDisposition: task.slots.some((slot) => slot.slotKey.startsWith('visibility_') && slot.validation === 'verified')
        ? 'verified' : 'not_present',
    };
  }

  private prepareFinalAction(operationId: string, binding: TaskMutationBinding | undefined, ref: string): boolean {
    const task = this.finalTask(binding);
    const tasks = this.deps.taskState;
    const entry = this.refTable.get(ref);
    const observation = this.latestDecisionObservation;
    if (!task || !tasks || !entry || !observation) return false;
    const targetBindingDigest = createHash('sha256').update(JSON.stringify({
      documentIdentity: entry.batch, backendNodeId: entry.backendNodeId, fingerprint: entry.fingerprint,
    })).digest('hex');
    const reviewBinding = createBrowserBinding('browser-final-review', {
      taskId: task.taskId, taskVersion: task.version, operationId, slotKey: binding!.slotKey,
      runtimeGeneration: this.taskScope().runtimeGeneration, capabilityId: this.taskScope().capabilityId,
      controlEpoch: observation.controlEpoch, documentIdentity: observation.documentIdentityDigest,
      targetBindingDigest, review: this.publicationReview(task),
    });
    const outcomePredicate = createBrowserBinding('browser-final-outcome', {
      taskId: task.taskId, taskVersion: task.version, operationId, targetBindingDigest,
      evidenceClass: 'business_completion', predicate: 'durable_correlated_record',
    });
    tasks.prepareFinalAction(this.taskScope(), task.taskId, task.version, {
      operationId, slotKey: binding!.slotKey, targetBindingDigest, controlEpoch: observation.controlEpoch,
      reviewBinding, outcomePredicate,
    });
    return true;
  }

  async handleRecheckTaskOutcome(args: { taskId: string; expectedTaskVersion: number }): Promise<CallToolResult> {
    const tasks = this.deps.taskState;
    if (!tasks) return this.taskUnavailable();
    const task = tasks.getActive(this.taskScope());
    const action = task ? tasks.getFinalAction(task.taskId) : null;
    if (!task || task.taskId !== args.taskId || task.version !== args.expectedTaskVersion ||
        task.lifecycle !== 'outcome-unknown' || !action || action.state !== 'outcome_unknown') {
      return toolError('browser_task_outcome_stale', 'control', 'Outcome reconciliation is not bound to the current unknown publication.', 'Read current task state.');
    }
    const result = this.deps.businessOutcomeObserver
      ? await this.deps.businessOutcomeObserver.recheck({ workspaceId: task.workspaceId, sessionId: task.sessionId,
          taskId: task.taskId, taskVersion: task.version, operationId: action.operationId })
      : { status: 'insufficient' as const };
    try {
      const updated = tasks.recordOutcomeCheck(this.taskScope(), task.taskId, task.version, action.operationId, result);
      this.trace({ kind: 'transition', taskId: updated.taskId, taskVersion: updated.version,
        from: task.lifecycle, to: updated.lifecycle, reason: 'outcome' });
      if (updated.lifecycle === 'complete') this.trace({ kind: 'terminal', taskId: updated.taskId,
        taskVersion: updated.version, lifecycle: 'complete' });
      return this.taskResult(updated);
    } catch {
      return toolError('browser_task_outcome_evidence_rejected', 'control', 'The trusted outcome evidence was stale or uncorrelated.', 'Keep the task outcome unknown and recheck later.');
    }
  }

  async handleResolveUnknownOutcome(args: { taskId: string; expectedTaskVersion: number; action: 'abandon' | 'acknowledge_duplicate_risk' }, extra?: unknown): Promise<CallToolResult> {
    const tasks = this.deps.taskState;
    if (!tasks) return this.taskUnavailable();
    const task = tasks.getActive(this.taskScope());
    const finalAction = task ? tasks.getFinalAction(task.taskId) : null;
    if (!task || task.taskId !== args.taskId || task.version !== args.expectedTaskVersion ||
        task.lifecycle !== 'outcome-unknown' || !finalAction || finalAction.state !== 'outcome_unknown') {
      return toolError('browser_task_outcome_stale', 'control', 'The unknown outcome changed before reconciliation.', 'Read current task state.');
    }
    const decision = await this.requestApproval({
      toolName: args.action === 'abandon' ? BROWSER_TOOL_NAMES.abandonOutcomeTracking : BROWSER_TOOL_NAMES.acknowledgeDuplicateRisk,
      title: args.action === 'abandon' ? 'Abandon publication outcome tracking' : 'Acknowledge duplicate publication risk',
      description: args.action === 'abandon'
        ? 'This closes tracking without claiming publication success.'
        : 'This does not retry publication. It only permits a new task version and fresh review.',
      payload: { kind: 'browser_outcome_reconciliation', action: args.action,
        taskVersion: task.version, possibleDispatch: true },
    }, (extra as { signal?: AbortSignal } | undefined)?.signal);
    if (!isApprovalDecision(decision)) return decision;
    this.trace({ kind: 'approval', taskId: task.taskId, taskVersion: task.version,
      approved: decision.behavior === 'allow' });
    if (decision.behavior !== 'allow') return toolJson({ ok: false, reason: decision.behavior });
    try {
      const updated = args.action === 'abandon'
        ? tasks.abandonOutcomeTracking(this.taskScope(), task.taskId, task.version, finalAction.operationId)
        : tasks.acknowledgeDuplicateRisk(this.taskScope(), task.taskId, task.version, finalAction.operationId);
      this.trace({ kind: 'transition', taskId: updated.taskId, taskVersion: updated.version,
        from: task.lifecycle, to: updated.lifecycle, reason: 'user' });
      if (updated.lifecycle === 'abandoned') this.trace({ kind: 'terminal', taskId: updated.taskId,
        taskVersion: updated.version, lifecycle: 'abandoned' });
      return this.taskResult(updated);
    } catch {
      return toolError('browser_task_outcome_stale', 'control', 'Another reconciliation decision already won.', 'Read current task state.');
    }
  }

  validateTaskMutationBinding(binding: TaskMutationBinding | undefined, targetRef: string): CallToolResult | null {
    const tasks = this.deps.taskState;
    if (!binding) {
      return tasks?.getActive(this.taskScope())
        ? toolError('browser_task_mutation_binding_required', 'control', 'An active task mutation must cite its current task, slot, observation, and ref binding.', 'Propose fresh task evidence before acting.')
        : null;
    }
    if (!tasks) return this.taskUnavailable();
    const task = tasks.getActive(this.taskScope());
    if (!task || task.taskId !== binding.taskId || task.version !== binding.taskVersion ||
        !task.slots.some((slot) => slot.slotKey === binding.slotKey)) {
      return toolError('browser_task_mutation_binding_stale', 'control', 'The mutation is not bound to the current task, version, and slot.', 'Read getTaskState and propose current evidence before acting.');
    }
    if (!this.latestDecisionObservation || this.latestDecisionObservation.observationId !== binding.observationId) {
      return toolError('browser_task_observation_stale', 'control', 'The mutation is not bound to the current coherent observation.', 'Capture a new decision observation before acting.');
    }
    const evidenceKey = `${binding.taskId}:${binding.taskVersion}:${binding.slotKey}:${binding.observationId}`;
    if (this.taskEvidenceRefs.get(evidenceKey) !== targetRef ||
        this.refTable.getObservationBinding(targetRef)?.observationId !== binding.observationId) {
      return toolError('browser_task_target_binding_stale', 'control', 'The target ref is not the trusted ref proposed for this task slot and observation.', 'Propose fresh task evidence for this exact target before acting.');
    }
    return null;
  }

  prepareTaskMutation(operationId: string, binding: TaskMutationBinding | undefined, targetRef: string | undefined, operationClass: BrowserTaskOperationClass = 'unclassified'):
    { binding: TaskMutationBinding; pendingVersion: number; targetBindingDigest: string; backendNodeId: number; fingerprint: ElementFingerprint; finalAction?: boolean } | null {
    if (!binding || !targetRef || !this.deps.taskState || !this.latestDecisionObservation) return null;
    const entry = this.refTable.get(targetRef);
    const observationBinding = this.refTable.getObservationBinding(targetRef);
    if (!entry || !observationBinding) throw new Error('browser_task_target_binding_stale');
    const targetBindingDigest = createHash('sha256').update(JSON.stringify({
      documentIdentity: observationBinding.documentIdentity,
      backendNodeId: entry.backendNodeId,
      fingerprint: entry.fingerprint,
    })).digest('hex');
    const finalAction = this.deps.taskState.getFinalAction(binding.taskId);
    if (binding.slotKey.startsWith('final_activation_') && finalAction?.operationId === operationId && finalAction.state === 'reviewed') {
      const current = this.deps.taskState.getActive(this.taskScope());
      if (!current || current.taskId !== binding.taskId) throw new Error('browser_task_final_action_stale');
      return { binding, pendingVersion: current.version, targetBindingDigest, backendNodeId: entry.backendNodeId,
        fingerprint: entry.fingerprint, finalAction: true };
    }
    const pending = this.deps.taskState.recordMutationPending(this.taskScope(), binding.taskId, binding.taskVersion, {
      slotKey: binding.slotKey, operationId,
      baselineObservationEpoch: this.latestDecisionObservation.observationEpoch,
      baselineObservationId: binding.observationId,
      baselineDocumentIdentity: this.latestDecisionObservation.documentIdentityDigest,
      baselineStructuralChecksum: this.latestDecisionObservation.structuralChecksum,
      targetBindingDigest,
      controlEpoch: this.latestDecisionObservation.controlEpoch,
      evidenceClass: 'target_local',
    });
    this.trace({ kind: 'operation_intent', taskId: binding.taskId, taskVersion: binding.taskVersion,
      operationId, slotKey: binding.slotKey, operationClass });
    return { binding, pendingVersion: pending.version, targetBindingDigest, backendNodeId: entry.backendNodeId, fingerprint: entry.fingerprint };
  }

  async settleTaskMutation(pending: ReturnType<BrowserToolContext['prepareTaskMutation']>, operationId: string,
    receipt: BrowserOperationReceipt): Promise<void> {
    if (!pending || !this.deps.taskState) return;
    if (pending.finalAction) {
      try {
        if (receipt.dispatchState === 'dispatched') {
          this.deps.taskState.recordFinalDispatch(this.taskScope(), pending.binding.taskId, pending.pendingVersion, operationId);
          this.trace({ kind: 'terminal', taskId: pending.binding.taskId, taskVersion: pending.pendingVersion,
            lifecycle: 'outcome-unknown' });
        } else {
          this.deps.taskState.cancelPreparedFinalAction(this.taskScope(), pending.binding.taskId, pending.pendingVersion, operationId);
        }
      } catch { /* stale final-action transitions fail closed */ }
      return;
    }
    if (receipt.outcome === 'outcome_unknown' && receipt.delta.kind === 'activation') {
      this.deps.taskState.markOutcomeUnknown(this.taskScope(), pending.binding.taskId, pending.pendingVersion);
      this.trace({ kind: 'terminal', taskId: pending.binding.taskId, taskVersion: pending.pendingVersion,
        lifecycle: 'outcome-unknown' });
      return;
    }
    if (receipt.dispatchState !== 'dispatched') {
      this.cancelTaskMutation(pending, operationId);
      return;
    }
    const observed = await this.handleGetDecisionObservation();
    if (observed.isError || !this.latestDecisionObservation) return;
    const currentEntry = this.refTable.currentEntries().find((entry) => entry.backendNodeId === pending.backendNodeId &&
      sameElementFingerprint(entry.fingerprint, pending.fingerprint));
    const currentField = currentEntry
      ? this.lastModel?.forms.flatMap((form) => form.fields).find((field) => field.ref === currentEntry.ref)
      : undefined;
    const currentTargetBindingDigest = currentEntry ? createHash('sha256').update(JSON.stringify({
      documentIdentity: currentEntry.batch, backendNodeId: currentEntry.backendNodeId, fingerprint: currentEntry.fingerprint,
    })).digest('hex') : 'target-changed';
    const active = this.deps.taskState.getActive(this.taskScope());
    if (!active || active.taskId !== pending.binding.taskId) return;
    try {
      this.deps.taskState.validateFromObservation(this.taskScope(), pending.binding.taskId, active.version, {
        slotKey: pending.binding.slotKey, operationId,
        observationId: this.latestDecisionObservation.observationId,
        observationEpoch: this.latestDecisionObservation.observationEpoch,
        documentIdentity: this.latestDecisionObservation.documentIdentityDigest,
        structuralChecksum: this.latestDecisionObservation.structuralChecksum,
        targetBindingDigest: currentTargetBindingDigest,
        controlEpoch: this.latestDecisionObservation.controlEpoch,
        predicateMatched: receipt.matchesRequested === true && currentField?.filled === true,
      });
      this.trace({ kind: 'validation', taskId: pending.binding.taskId, taskVersion: active.version,
        slotKey: pending.binding.slotKey, accepted: true });
    } catch {
      // A fresh but non-causal or predicate-mismatching observation remains
      // descriptive; it never authorizes retry or advances the task.
      this.trace({ kind: 'validation', taskId: pending.binding.taskId, taskVersion: active.version,
        slotKey: pending.binding.slotKey, accepted: false });
    }
  }

  cancelTaskMutation(pending: ReturnType<BrowserToolContext['prepareTaskMutation']>, operationId: string): void {
    if (!pending || !this.deps.taskState) return;
    try {
      if (pending.finalAction) {
        this.deps.taskState.cancelPreparedFinalAction(this.taskScope(), pending.binding.taskId,
          pending.pendingVersion, operationId);
        return;
      }
      this.deps.taskState.cancelMutationPending(this.taskScope(), pending.binding.taskId,
        pending.pendingVersion, pending.binding.slotKey, operationId);
    } catch { /* stale task transitions fail closed */ }
  }

  async handleRecoverTarget(binding: TaskMutationBinding, targetRef: string): Promise<CallToolResult> {
    const bindingError = this.validateTaskMutationBinding(binding, targetRef);
    if (bindingError) return bindingError;
    const tasks = this.deps.taskState;
    if (!tasks) return this.taskUnavailable();
    const entry = this.refTable.get(targetRef);
    const observationBinding = this.refTable.getObservationBinding(targetRef);
    if (!entry || !observationBinding) {
      return toolError('browser_recovery_binding_stale', 'control', 'Recovery requires the exact trusted target binding from the cited observation.', 'Capture a new decision observation.');
    }
    const page = await this.ensurePage();
    const state = await page.inspectBackendNodeState?.(entry.backendNodeId).catch(() => undefined);
    // No overlay attestation exists yet. Unknown occlusion is never promoted
    // to a same-task overlay and therefore fails closed.
    if (state?.status !== 'off_viewport') {
      return toolError('browser_recovery_blocked', 'control', 'The trusted target is not eligible for the bounded off-viewport reveal.', 'Hand control to the user or capture a fresh coherent observation.');
    }
    const targetBindingDigest = createHash('sha256').update(JSON.stringify({
      documentIdentity: observationBinding.documentIdentity,
      backendNodeId: entry.backendNodeId,
      fingerprint: entry.fingerprint,
    })).digest('hex');
    const claimed = tasks.claimRecovery(this.taskScope(), binding.taskId, binding.taskVersion,
      targetBindingDigest, 'off_viewport');
    this.trace({ kind: 'recovery', taskId: binding.taskId, taskVersion: binding.taskVersion,
      category: 'off_viewport', claimed });
    if (!claimed) {
      try { tasks.blockRecoveryExhausted(this.taskScope(), binding.taskId, binding.taskVersion, binding.slotKey); } catch { /* stale task */ }
      return toolError('browser_recovery_exhausted', 'control', 'The one safe reveal attempt for this task version and target is already exhausted.', 'Hand control to the user.');
    }
    const revealed = await page.revealBackendNode?.(entry.backendNodeId).catch(() => undefined);
    this.refTable.clear();
    this.taskEvidenceRefs.clear();
    this.latestDecisionObservation = undefined;
    this.lastModel = null;
    this.pageStateCache = null;
    if (!revealed?.revealed) {
      return toolError('browser_recovery_target_changed', 'control', 'The trusted target changed during the non-activating reveal.', 'Capture a fresh coherent observation; do not replay the mutation.');
    }
    return toolJson({ ok: true, recovery: 'off_viewport', revealed: true, requiresReobservation: true });
  }

  async handleStartTask(args: { replaceTaskId?: string; expectedTaskVersion?: number }, extra?: { signal?: AbortSignal }): Promise<CallToolResult> {
    const tasks = this.deps.taskState;
    if (!tasks) return this.taskUnavailable();
    if (!await (this.deps.isInvocationCurrent ?? (() => true))()) return mutationAuthorizationError();
    const scope = this.taskScope();
    const active = tasks.getActive(scope);
    if (active && (!args.replaceTaskId || args.replaceTaskId !== active.taskId || args.expectedTaskVersion !== active.version)) {
      return toolError('browser_task_replace_binding_required', 'control', 'An active task already exists.', 'Pass its exact taskId and version to request replacement, or continue that task.');
    }
    if (active) {
      if (!this.deps.approvalRequester) return toolError('browser_approval_unavailable', 'approval', 'Task replacement requires a live application approval channel.', 'Retry from a live GUI task.');
      const decision = await this.deps.approvalRequester(this.deps.sessionId, {
        toolName: BROWSER_TOOL_NAMES.startTask,
        title: 'Replace the active browser task?',
        description: 'Replacing the task abandons its current evidence and authority.',
        payload: { kind: 'browser_task_replace', taskId: active.taskId, taskVersion: active.version },
        signal: extra?.signal,
      });
      if (decision.behavior !== 'allow') return toolJson({ ok: false, replaced: false, reason: 'user_denied' });
      if (!await (this.deps.isInvocationCurrent ?? (() => true))()) return mutationAuthorizationError();
    } else if (args.replaceTaskId !== undefined || args.expectedTaskVersion !== undefined) {
      return toolError('browser_task_replace_stale', 'control', 'The task selected for replacement is no longer active.', 'Read getTaskState before proposing a replacement.');
    }
    try {
      const task = tasks.createOrReplace(scope, [], active ? { replaceTaskId: active.taskId } : {});
      this.trace({ kind: 'transition', taskId: task.taskId, taskVersion: task.version,
        from: active?.lifecycle ?? 'active', to: task.lifecycle, reason: active ? 'user' : 'discovery' });
      return this.taskResult(task);
    } catch (error) {
      return toolError('browser_task_transition_rejected', 'control', error instanceof Error ? error.message : String(error), 'Read getTaskState and retry only against the current version.');
    }
  }

  async handleProposeTaskEvidence(args: {
    taskId: string;
    expectedTaskVersion: number;
    observationId: string;
    proposals: Array<{ category: TaskSlotCategory; ordinal: number; ref: string; confidence: number; evidence: string[] }>;
  }): Promise<CallToolResult> {
    const tasks = this.deps.taskState;
    if (!tasks) return this.taskUnavailable();
    if (!await (this.deps.isInvocationCurrent ?? (() => true))()) return mutationAuthorizationError();
    const observation = this.latestDecisionObservation;
    if (!observation || observation.observationId !== args.observationId || !this.lastModel) {
      return toolError('browser_task_observation_stale', 'control', 'The evidence proposal is not bound to the current coherent observation.', 'Capture a new decision observation and cite its refs.');
    }
    const fields = this.lastModel.forms.flatMap((form) => form.fields);
    const discovered: BrowserTaskSlot[] = [];
    for (const proposal of args.proposals) {
      const binding = this.refTable.getObservationBinding(proposal.ref);
      const entry = this.refTable.get(proposal.ref);
      if (!entry || !binding || binding.observationId !== args.observationId) {
        return toolError('browser_task_evidence_stale', 'control', 'A proposed ref is not part of the cited coherent observation.', 'Capture a new decision observation and cite only its refs.');
      }
      const field = fields.find((candidate) => candidate.ref === proposal.ref);
      const bucket = populationBucket(field);
      discovered.push({
        slotKey: `${proposal.category}_${proposal.ordinal}`,
        discovery: 'available',
        required: field?.required === true,
        population: bucket === 'empty' ? 'empty' : 'populated',
        validation: 'unverified',
        authority: 'not_required',
        populationBucket: bucket,
        evidenceId: observation.observationId,
        observationEpoch: observation.observationEpoch,
      });
    }
    try {
      const previous = tasks.getActive(this.taskScope());
      const task = tasks.recordTrustedDiscovery(this.taskScope(), args.taskId, args.expectedTaskVersion, discovered);
      this.taskEvidenceRefs.clear();
      for (const proposal of args.proposals) {
        this.taskEvidenceRefs.set(
          `${task.taskId}:${task.version}:${proposal.category}_${proposal.ordinal}:${args.observationId}`,
          proposal.ref,
        );
      }
      this.trace({ kind: 'transition', taskId: task.taskId, taskVersion: task.version,
        from: previous?.lifecycle ?? 'active', to: task.lifecycle, reason: 'discovery' });
      return this.taskResult(task);
    } catch (error) {
      return toolError('browser_task_transition_rejected', 'control', error instanceof Error ? error.message : String(error), 'Read getTaskState and use a fresh coherent observation.');
    }
  }

  async handleAbandonTask(args: { taskId: string; expectedTaskVersion: number }, extra?: { signal?: AbortSignal }): Promise<CallToolResult> {
    const tasks = this.deps.taskState;
    if (!tasks) return this.taskUnavailable();
    const active = tasks.getActive(this.taskScope());
    if (!active || active.taskId !== args.taskId || active.version !== args.expectedTaskVersion) {
      return toolError('browser_task_transition_rejected', 'control', 'The task identity or version is stale.', 'Read getTaskState before abandoning the task.');
    }
    if (!this.deps.approvalRequester) return toolError('browser_approval_unavailable', 'approval', 'Task abandonment requires a live application approval channel.', 'Retry from a live GUI task.');
    const decision = await this.deps.approvalRequester(this.deps.sessionId, {
      toolName: BROWSER_TOOL_NAMES.abandonTask,
      title: 'Abandon the active browser task?',
      payload: { kind: 'browser_task_abandon', taskId: active.taskId, taskVersion: active.version },
      signal: extra?.signal,
    });
    this.trace({ kind: 'approval', taskId: active.taskId, taskVersion: active.version,
      approved: decision.behavior === 'allow' });
    if (decision.behavior !== 'allow') return toolJson({ ok: false, abandoned: false, reason: 'user_denied' });
    if (!await (this.deps.isInvocationCurrent ?? (() => true))()) return mutationAuthorizationError();
    try {
      const ok = tasks.abandon(this.taskScope(), args.taskId, args.expectedTaskVersion);
      this.trace({ kind: 'transition', taskId: active.taskId, taskVersion: active.version + 1,
        from: active.lifecycle, to: 'abandoned', reason: 'user' });
      this.trace({ kind: 'terminal', taskId: active.taskId, taskVersion: active.version + 1,
        lifecycle: 'abandoned' });
      return toolJson({ ok, abandoned: true });
    } catch (error) {
      return toolError('browser_task_transition_rejected', 'control', error instanceof Error ? error.message : String(error), 'Read getTaskState before abandoning the task.');
    }
  }

  private readDocumentIdentity(page: BrowserCdpSession): RefBatchKey | null {
    return page.getDocumentIdentity?.() ?? null;
  }

  private async distill(
    page: BrowserCdpSession,
    options: { maxContentChars?: number; maxActions?: number } = {},
  ): Promise<PageModel> {
    this.pageStateCache = null;
    this.latestDecisionObservation = undefined;
    const model = await distillPageModel(page, this.refTable, options);
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

  private async resolveCurrentRef(
    page: BrowserCdpSession,
    ref: string,
  ): Promise<RefEntry | CallToolResult> {
    const entry = this.refTable.get(ref);
    if (!entry) {
      return toolError(
        'browser_ref_unknown',
        'ref_resolve',
        `Unknown element ref "${ref}". Refs come from the most recent open/getPageState/findElements/act page model.`,
        'Call getPageState for a fresh text-only page state and current refs.',
      );
    }
    const identity = this.readDocumentIdentity(page);
    if (!identity) {
      return toolError(
        'browser_document_identity_unavailable',
        'ref_resolve',
        'The browser could not verify the current document identity for this element ref.',
        'Call getPageState to rebuild the page model; if this persists, reopen the browser session.',
      );
    }
    if (!this.refTable.isCurrent(ref, identity)) {
      return toolError(
        'browser_ref_stale',
        'ref_resolve',
        `Element ref "${ref}" (${entry.role} "${entry.name}") was invalidated by a page change.`,
        'Call getPageState, then retry with the fresh ref.',
      );
    }
    if (!page.callBackendNode) {
      return toolError('browser_ref_unresolvable', 'ref_resolve', 'The browser runtime cannot re-resolve this backend node.', 'Reopen the browser session and refresh the page model.');
    }
    let current: ElementFingerprint | null = null;
    try {
      current = await page.callBackendNode<ElementFingerprint>(entry.backendNodeId, buildElementFingerprintFunction());
    } catch {
      current = null;
    }
    if (!current || !sameElementFingerprint(entry.fingerprint, current)) {
      return toolError(
        'browser_ref_stale', 'ref_resolve',
        `Element ref "${ref}" (${entry.role} "${entry.name}") no longer resolves to the same semantic element.`,
        'Call getPageState, then retry with the fresh ref.',
      );
    }
    const visualBinding = this.refTable.getObservationBinding(ref);
    if (visualBinding) {
      const probe = await page.probeBackendNode?.(entry.backendNodeId);
      if (!probe || !probe.hitTested || !probe.connected || !probe.visible || !probe.inViewport ||
          probe.occluded || !probe.enabled || !sameGeometry(visualBinding.geometry, probe.geometry)) {
        return toolError(
          'browser_visual_binding_stale', 'ref_resolve',
          `Visual binding for ref "${ref}" no longer matches current trusted geometry and hit-testing.`,
          'Call getDecisionObservation and rebind the current candidate before acting.',
        );
      }
    }
    return entry;
  }

  // -- element discovery + selected element details ------------------------

  async handleGetPageState(args: {
    offset?: number;
    limit?: number;
    includeContent?: boolean;
  }): Promise<CallToolResult> {
    try {
      const page = await this.ensurePage();
      const documentIdentity = args.offset && args.offset > 0 ? this.readDocumentIdentity(page) : null;
      const cachedBatch = this.refTable.batchKey;
      const canReuseCache =
        this.pageStateCache !== null &&
        documentIdentity !== null &&
        cachedBatch !== null &&
        sameBrowserDocumentIdentity(cachedBatch, documentIdentity);
      const model = canReuseCache
        ? this.pageStateCache!
        : await this.distill(page, {
            maxContentChars: args.includeContent === false ? 200 : 1200,
            maxActions: 1000,
          });
      this.pageStateCache = model;
      const state = buildPageState(model, args);
      if (page.inspectBackendNode) {
        await forEachWithConcurrency(state.elements, 8, async (element) => {
          if (element.kind !== 'action') return;
          const entry = this.refTable.get(element.ref);
          if (typeof entry?.backendNodeId !== 'number') return;
          const details = await page
            .inspectBackendNode!(entry.backendNodeId, buildInspectElementStateFunction())
            .catch(() => null);
          if (!details) return;
          if (details.visible !== undefined) element.visible = details.visible;
          if (details.inViewport !== undefined) element.inViewport = details.inViewport;
          if (details.occluded !== undefined) element.occluded = details.occluded;
        });
      }
      return toolJson({ ok: true, state });
    } catch (err) {
      return this.toErrorResult(err, 'distill');
    }
  }

  async handleGetDecisionObservation(extra?: { signal?: AbortSignal }): Promise<CallToolResult> {
    const gate = this.controlGate('control');
    if (gate) return gate;
    try {
      const page = await this.ensurePage();
      const controlState = this.svc.getControlState(this.deps.sessionId) ?? 'agent_in_control';
      const observation = await this.decisionObservations.observe({
        page,
        refTable: this.refTable,
        signal: extra?.signal ?? new AbortController().signal,
        isCurrent: this.deps.isInvocationCurrent ?? (() => true),
        isAgentInControl: () => (this.svc.getControlState(this.deps.sessionId) ?? 'agent_in_control') === 'agent_in_control',
        controlEpoch: `${this.deps.runtimeGeneration ?? 'unscoped'}:${controlState}`,
        capabilityEpoch: this.deps.capabilityId ?? 'unscoped',
        budget: this.deps.decisionObservationBudget,
        applicationSensitiveRegions: this.deps.applicationSensitiveRegions,
      });
      this.lastModel = observation.model;
      this.pageStateCache = observation.model;
      this.latestDecisionObservation = {
        observationId: observation.observationId,
        observationEpoch: observation.revision.domEpoch,
        transform: observation.transform,
        documentIdentityDigest: createHash('sha256').update(JSON.stringify(observation.revision.documentIdentity)).digest('hex'),
        structuralChecksum: observation.revision.checksum,
        controlEpoch: observation.revision.controlEpoch,
      };
      const activeTask = this.deps.taskState?.getActive(this.taskScope());
      if (activeTask) this.trace({ kind: 'observation', taskId: activeTask.taskId,
        taskVersion: activeTask.version, observationId: observation.observationId, accepted: true });
      const { image, ...metadata } = observation;
      return {
        content: [
          { type: 'image', data: image.data, mimeType: image.mimeType },
          { type: 'text', text: JSON.stringify({ ok: true, observation: metadata }) },
        ],
      };
    } catch (error) {
      return this.toErrorResult(error, 'capture');
    }
  }

  async handleRebindVisualCandidates(args: {
    observationId: string;
    candidates: Array<{
      ref: string;
      confidence: number;
      evidence: string[];
      point?: { x: number; y: number };
      box?: { x: number; y: number; width: number; height: number };
    }>;
  }): Promise<CallToolResult> {
    const gate = this.controlGate('control');
    if (gate) return gate;
    const observation = this.latestDecisionObservation;
    if (!observation || observation.observationId !== args.observationId) {
      return toolJson({
        ok: false, status: 'structured_only', reason: 'visual_observation_unavailable',
        next: 'Use getPageState or getDecisionObservation; request handoff if structure remains ambiguous.',
      });
    }
    const page = await this.ensurePage();
    const viable: Array<{ entry: RefEntry; binding: NonNullable<ReturnType<RefTable['getObservationBinding']>> }> = [];
    for (const candidate of args.candidates) {
      const entry = this.refTable.get(candidate.ref);
      const binding = this.refTable.getObservationBinding(candidate.ref);
      if (!entry || !binding || binding.observationId !== args.observationId || binding.occluded ||
          !binding.visible || !binding.inViewport || !binding.enabled) continue;
      const evidenceRect = visualEvidenceCssRect(candidate, observation.transform);
      if (evidenceRect && !rectsIntersect(binding.geometry, evidenceRect)) continue;
      const probePoint = candidate.point ? imagePointToCss(candidate.point, observation.transform) : undefined;
      const probe = await page.probeBackendNode?.(entry.backendNodeId, probePoint);
      if (!probe || !probe.connected || !probe.hitTested || probe.occluded || !probe.visible || !probe.inViewport ||
          !probe.enabled || !sameGeometry(binding.geometry, probe.geometry) || probe.editable !== binding.editable) {
        if (args.candidates.length === 1) {
          return toolError(
            'browser_visual_binding_stale', 'ref_resolve',
            'The candidate changed since the cited decision observation.',
            'Capture a fresh decision observation and rebind again.',
          );
        }
        continue;
      }
      viable.push({ entry, binding });
    }
    if (viable.length !== 1) {
      return toolJson({ ok: false, status: 'ambiguous', viableCandidates: viable.length });
    }
    const { entry, binding } = viable[0];
    return toolJson({
      ok: true,
      status: 'bound',
      binding: {
        ref: entry.ref,
        observationId: binding.observationId,
        pageRevision: binding.pageRevision,
        role: entry.role,
        kind: entry.kind,
        structuralChecksum: binding.structuralChecksum,
      },
    });
  }

  async handleFindElements(args: FindElementsArgs): Promise<CallToolResult> {
    try {
      const text = args.text?.trim();
      const regex = args.regex?.trim();
      const role = args.role?.trim();
      if ((!text && !regex && !role) || (text && regex)) {
        return toolError(
          'browser_find_invalid_query',
          'distill',
          'findElements requires text, regex, or role; text and regex cannot be combined.',
          'Provide text or regex, optionally narrowed by role.',
        );
      }
      let compiledRegex: RegExp | undefined;
      try {
        compiledRegex = regex ? parseFindRegex(regex) : undefined;
      } catch {
        return toolError(
          'browser_find_invalid_query',
          'distill',
          `Invalid regular expression "${regex ?? ''}".`,
          'Provide a valid JavaScript regular expression, optionally in /pattern/flags form.',
        );
      }
      const model = await this.distill(await this.ensurePage(), {
        maxContentChars: 200,
        maxActions: 5000,
      });
      const matches = findElementsInModel(model, { ...args, text, regex, role }, compiledRegex);
      const limit = Math.min(Math.max(Math.floor(args.limit ?? 20), 1), 100);
      return toolJson({
        ok: true,
        url: model.url,
        title: model.title,
        matches: matches.slice(0, limit),
        total: matches.length,
        truncated: matches.length > limit,
      });
    } catch (err) {
      return this.toErrorResult(err, 'distill');
    }
  }

  async handleGetElementDetails(args: { ref: string }): Promise<CallToolResult> {
    const gate = this.controlGate('control');
    if (gate) return gate;
    try {
      const page = await this.ensurePage();
      const resolved = await this.resolveCurrentRef(page, args.ref);
      if (!isRefEntry(resolved)) return resolved;
      if (!page.inspectBackendNode) {
        return toolError(
          'browser_ref_unresolvable', 'ref_resolve',
          `Ref "${args.ref}" cannot be inspected by backend identity in this browser runtime.`,
          'Reopen the browser session and refresh the page model.',
        );
      }
      const raw = await page.inspectBackendNode(resolved.backendNodeId, buildInspectElementFunction());
      if (!raw) {
        return toolError(
          'browser_ref_unresolvable',
          'ref_resolve',
          `Element ref "${args.ref}" could not be resolved in the current document.`,
          'Call getPageState to refresh the page model and retry with a current ref.',
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
      // Fail closed: no approval channel means no handler-owned external write.
      return toolError(
        'browser_approval_unavailable',
        'approval',
        'No approval channel is wired for this session, so this browser mutation is not permitted.',
        'This is an internal wiring issue — the chat session must provide an approval requester.',
      );
    }
    try {
      return await requester(this.deps.sessionId, {
        ...request,
        requestId: request.requestId ?? randomUUID(),
        signal,
      });
    } catch (err) {
      diagWarn(`[browser-mcp] approval round-trip failed type=${err instanceof Error ? err.name : 'unknown'}`);
      return toolError(
        'browser_approval_failed',
        'approval',
        'The approval round-trip failed before a decision was recorded.',
        'Observe the current browser state; if the approval channel is available, start a new operation.',
      );
    }
  }

  // -- open -----------------------------------------------------------------

  async handleOpen(args: { url: string }, authorizeDispatch?: () => Promise<boolean>): Promise<CallToolResult> {
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
      if (authorizeDispatch && !await authorizeDispatch()) return mutationAuthorizationError();
      await this.uploadStaging.releaseSession(this.deps.sessionId);
      // Remembered-site injection (U8, KTD-8): exactly once per browser
      // view, on the first open() whose site key has a stored context —
      // BEFORE the first navigation so the initial request already carries
      // the cookies. Injection happens over our own CDP channel
      // (Network.setCookies + addScriptToEvaluateOnNewDocument), with zero
      // session mutation on the hosting browser.
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
   * lands before any page script can read the stores (no framenavigated
   * injection race).
   */
  private async injectSiteContext(
    page: BrowserCdpSession,
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

  // -- optional visual observation -------------------------------------------

  async handleTakeScreenshot(): Promise<CallToolResult> {
    const gate = this.controlGate('control');
    if (gate) return gate;
    try {
      const page = await this.ensurePage();
      const [screenshot, currentUrl] = await Promise.all([
        page.captureScreenshot(),
        page.evaluate<string>('(() => window.location.href)()'),
      ]);
      // Image exfil point toward the model — the FACT is audited; the image
      // bytes never touch the audit table (KTD-9). Taking a screenshot does
      // not distill a new model, so it cannot invalidate existing refs.
      this.audit.logToolAction({
        workspaceId: this.deps.workspaceId,
        sessionId: this.deps.sessionId,
        toolName: BROWSER_TOOL_NAMES.takeScreenshot,
        url: String(currentUrl).slice(0, 2048),
        outcome: 'ok',
        detail: 'screenshot',
      });
      return {
        content: [
          { type: 'image', data: screenshot, mimeType: 'image/jpeg' },
          { type: 'text', text: JSON.stringify({ ok: true }) },
        ],
      };
    } catch (err) {
      return this.toErrorResult(err, 'capture');
    }
  }

  // -- act --------------------------------------------------------------------

  async handleAct(
    args: { ref: string; action: 'click' | 'fill' | 'select' | 'check'; value?: string },
    authorizeDispatch?: () => Promise<boolean>,
  ): Promise<CallToolResult> {
    const gate = this.controlGate('control');
    if (gate) return gate;
    if (args.action === 'click') {
      const knownEntry = this.refTable.get(args.ref);
      if (knownEntry?.submitSemantics) {
        return toolError(
          'browser_use_submit_tool',
          'ref_resolve',
          `Ref "${args.ref}" submits a form and cannot be clicked through act.`,
          'Call submit with this ref (or its owning form ref); submit always asks for handler-level approval.',
        );
      }
      return toolError(
        'browser_use_activation_tool',
        'ref_resolve',
        `Ref "${args.ref}" is page-supplied and cannot be clicked through act.`,
        'Call activate with a new caller-stable operationId and this ref; activate always asks for handler-level approval.',
      );
    }
    if (args.action === 'check' && this.deps.taskState?.getActive(this.taskScope())) {
      return toolError(
        'browser_task_boolean_authority_required', 'approval',
        'Boolean controls are ambiguous while a goal-scoped task is active.',
        'Use the application-owned declaration flow or wait until trusted task evidence proves a non-authority control.',
      );
    }
    try {
      const page = await this.ensurePage();
      const resolved = await this.resolveCurrentRef(page, args.ref);
      if (!isRefEntry(resolved)) return resolved;
      const entry = resolved;

      if (entry.interactionClass === 'human-only') {
        return toolError(
          'browser_handoff_required',
          'dispatch',
          `Ref "${args.ref}" is a human-only control and cannot be automated.`,
          'Call requestHandoff so the user can complete this control directly.',
        );
      }

      if (entry.kind === 'action') {
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

      let receipt: BrowserOperationReceipt;
      if (args.action === 'fill') {
        if (!page.fillBackendNode) {
          return toolError(
            'browser_ref_unresolvable',
            'ref_resolve',
            `Field ref "${args.ref}" cannot be filled through trusted browser input.`,
            'Reopen the browser session and refresh the page model.',
          );
        }
        if (authorizeDispatch && !await authorizeDispatch()) return mutationAuthorizationError();
        receipt = await page.fillBackendNode(entry.backendNodeId, args.value ?? '');
      } else if (args.action === 'check') {
        if (!page.callBackendNode) {
          return toolError('browser_ref_unresolvable', 'ref_resolve', `Field ref "${args.ref}" cannot be checked by backend identity.`, 'Reopen the browser session and refresh the page model.');
        }
        const before = await page.callBackendNode<{ ok: boolean; checked?: boolean }>(
          entry.backendNodeId, buildBackendCheckStateFunction(),
        );
        if (!before?.ok || typeof before.checked !== 'boolean') {
          return toolError('browser_action_failed', 'dispatch', `Action check on "${entry.name}" failed: not_checkable`, 'Call getPageState and choose a checkbox or radio field.');
        }
        const requested = args.value ?? '';
        const desired = requested === '' ? !before.checked : ['true', '1', 'on'].includes(requested.toLowerCase());
        if (before.checked === desired) {
          receipt = {
            outcome: 'not_dispatched', dispatchState: 'not_dispatched', verified: true,
            retrySafe: true, matchesRequested: true, delta: { kind: 'none', changed: false },
          };
        } else {
          receipt = await page.clickBackendNode(entry.backendNodeId, authorizeDispatch);
          if (receipt.outcome === 'dispatched_verified') {
            try {
              const after = await page.callBackendNode<{ ok: boolean; checked?: boolean }>(
                entry.backendNodeId, buildBackendCheckStateFunction(),
              );
              const matches = after?.ok === true && after.checked === desired;
              receipt = matches
                ? { ...receipt, matchesRequested: true, delta: { kind: 'field', changed: true } }
                : verificationMismatchReceipt(true);
            } catch {
              receipt = verificationMismatchReceipt(true);
            }
          }
        }
      } else {
        if (!page.callBackendNode) {
          return toolError(
            'browser_ref_unresolvable',
            'ref_resolve',
            `Field ref "${args.ref}" cannot be dispatched by backend identity.`,
            'Reopen the browser session and refresh the page model.',
          );
        }
        let result: { ok: boolean; reason?: string; matches?: boolean } | null = null;
        let uncertainReceipt: BrowserOperationReceipt | undefined;
        try {
          if (authorizeDispatch && !await authorizeDispatch()) return mutationAuthorizationError();
          result = await page.callBackendNode<{ ok: boolean; reason?: string; matches?: boolean }>(
            entry.backendNodeId, buildBackendActFunction(args.action, args.value),
          );
        } catch {
          uncertainReceipt = unknownMutationReceipt('field');
        }
        if (uncertainReceipt) {
          // A select Runtime command may have delivered input/change before
          // its response was lost. Preserve the unknown receipt; never retry.
          receipt = uncertainReceipt;
        } else if (!result?.ok || result.matches !== true) {
          return toolError(
            'browser_action_failed',
            'dispatch',
            `Action ${args.action} on "${entry.name}" failed: ${result?.reason ?? 'unknown'}`,
            'Call getPageState to re-read the page, verify the field state, and retry.',
          );
        } else {
          receipt = {
            outcome: 'dispatched_verified',
            dispatchState: 'dispatched',
            verified: true,
            retrySafe: false, matchesRequested: true,
            delta: { kind: 'field', changed: true },
          };
        }
      }
      diagLog(`[browser-mcp] act session=${this.deps.sessionId} ref=${args.ref} action=${args.action}`);
      this.audit.logToolAction({
        workspaceId: this.deps.workspaceId,
        sessionId: this.deps.sessionId,
        toolName: BROWSER_TOOL_NAMES.act,
        url: this.lastModel?.url ?? '',
        fieldNames: [entry.name],
        outcome: receipt.verified ? 'ok' : 'error',
        detail: `action=${args.action};outcome=${receipt.outcome}`,
      });
      return toolJson({
        ok: receipt.verified && receipt.matchesRequested !== false,
        ref: args.ref,
        action: args.action,
        receipt,
      });
    } catch (err) {
      return this.toErrorResult(err, 'dispatch');
    }
  }

  // -- declaration (application-owned factual/rights authority) ------------

  async handleSetDeclaration(
    args: { operationId: string; ref: string; intendedState: boolean; taskBinding: TaskMutationBinding },
    extra?: unknown,
    authorizeDispatch?: () => Promise<boolean>,
    recordApproved?: () => Promise<boolean>,
  ): Promise<CallToolResult> {
    const gate = this.controlGate('control');
    if (gate) return gate;
    const tasks = this.deps.taskState;
    if (!tasks) return this.taskUnavailable();
    const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
    const initialTask = tasks.getActive(this.taskScope());
    const slot = initialTask?.slots.find((candidate) => candidate.slotKey === args.taskBinding.slotKey);
    if (!initialTask || initialTask.taskId !== args.taskBinding.taskId ||
        initialTask.version !== args.taskBinding.taskVersion || !slot ||
        !slot.slotKey.startsWith('declaration_')) {
      return toolError('browser_declaration_binding_stale', 'control', 'Declaration authority requires the current declaration task slot.', 'Read task state and propose fresh declaration evidence.');
    }
    const page = await this.ensurePage();
    const resolved = await this.resolveCurrentRef(page, args.ref);
    if (!isRefEntry(resolved)) return resolved;
    const target = resolved;
    if (target.kind !== 'field' || !['checkbox', 'radio'].includes(target.fingerprint.type) || !page.callBackendNode) {
      return toolError('browser_declaration_target_invalid', 'ref_resolve', 'The declaration target is not a trusted checkbox or radio field.', 'Use a declaration field ref from the current coherent observation.');
    }
    const observationBinding = this.refTable.getObservationBinding(args.ref);
    const initialObservation = this.latestDecisionObservation;
    if (!observationBinding || !initialObservation || initialObservation.observationId !== args.taskBinding.observationId) {
      return toolError('browser_declaration_binding_stale', 'control', 'The declaration ref has no current observation binding.', 'Capture a fresh decision observation.');
    }
    const trustedProbe = await page.inspectBackendNodeState?.(target.backendNodeId).catch(() => undefined);
    if (trustedProbe?.status !== 'ready') {
      return toolError('browser_declaration_target_unsafe', 'toctou', `The declaration target is not safely actionable: ${trustedProbe?.status ?? 'unavailable'}.`, 'Observe a visible, enabled, unobscured declaration control.');
    }
    const before = await page.callBackendNode<{ ok: boolean; checked?: boolean }>(target.backendNodeId, buildBackendCheckStateFunction());
    if (!before?.ok || typeof before.checked !== 'boolean') {
      return toolError('browser_declaration_target_invalid', 'ref_resolve', 'The declaration target is no longer checkable.', 'Capture fresh declaration evidence.');
    }
    const initialDetails = await page.inspectBackendNode?.(target.backendNodeId, buildInspectElementFunction());
    if (!initialDetails) return toolError('browser_declaration_target_invalid', 'ref_resolve', 'The declaration context is unavailable.', 'Capture fresh declaration evidence.');
    const trustedDeclarationRaw = [initialDetails.role, initialDetails.name, initialDetails.nearbyText]
      .filter((value): value is string => typeof value === 'string' && value.length > 0).join('\0').slice(0, 1800);
    const declarationDigest = createHash('sha256').update(trustedDeclarationRaw.normalize('NFC')).digest('hex');
    const declaration = sanitizeUntrustedPageText(trustedDeclarationRaw.replace(/\0/g, ' · '), 600);
    const targetBinding = {
      document: target.batch, backendNodeId: target.backendNodeId, fingerprint: target.fingerprint,
      observationId: observationBinding.observationId, controlEpoch: observationBinding.controlEpoch,
      capabilityEpoch: observationBinding.capabilityEpoch,
    };
    const requestId = `browser-declaration-${randomUUID()}`;
    const requestBindingValue = {
      requestId, taskId: initialTask.taskId, taskVersion: initialTask.version,
      slotKey: slot.slotKey, declarationDigest, intendedState: args.intendedState,
      target: targetBinding, capabilityId: this.taskScope().capabilityId,
      runtimeGeneration: this.taskScope().runtimeGeneration, operationId: args.operationId,
      documentIdentity: initialObservation.documentIdentityDigest,
      structuralChecksum: initialObservation.structuralChecksum,
      controlEpoch: initialObservation.controlEpoch,
    };
    const requestBinding = createBrowserBinding('declaration-request', requestBindingValue);
    let awaiting;
    try {
      awaiting = tasks.beginDeclarationRequest(this.taskScope(), initialTask.taskId, initialTask.version, slot.slotKey, requestBinding);
    } catch {
      return toolError('browser_declaration_binding_stale', 'control', 'The declaration request raced with another task transition.', 'Read current task state before asking again.');
    }
    const revoke = (decision: 'approved' | 'denied' | 'later' | 'revoked') => {
      const current = tasks.getActive(this.taskScope());
      if (!current || current.taskId !== awaiting.taskId) return null;
      try {
        return tasks.consumeDeclarationRequest(this.taskScope(), current.taskId, current.version, slot.slotKey, requestBinding, decision);
      } catch { return null; }
    };
    const decision = await this.requestApproval({
      requestId,
      toolName: BROWSER_TOOL_NAMES.setDeclaration,
      title: 'Confirm declaration authority',
      description: 'Review the exact declaration. This single-use confirmation cannot be inferred from page state or chat text.',
      timeoutMs: 10 * 60_000,
      payload: {
        kind: 'browser_declaration', origin: originOf(this.lastModel?.url ?? ''), intendedState: args.intendedState,
        declaration,
        taskSummary: {
          source: 'derived_metadata', taskVersion: initialTask.version,
          populatedSlots: initialTask.slots.filter((item) => item.population === 'populated').length,
          verifiedSlots: initialTask.slots.filter((item) => item.validation === 'verified').length,
          mediaSlots: initialTask.slots.filter((item) => item.slotKey.startsWith('media_')).length,
        },
      },
    }, signal);
    if (!isApprovalDecision(decision)) { revoke('revoked'); return decision; }
    const terminal = decision.behavior === 'allow' ? 'approved'
      : decision.behavior === 'later' ? 'later'
        : decision.behavior === 'deny' ? 'denied' : 'revoked';
    const consumed = revoke(terminal);
    if (!consumed) return toolError('browser_declaration_request_consumed', 'approval', 'This declaration request is no longer pending.', 'Read task state and create a fresh declaration request if needed.');
    if (decision.behavior !== 'allow') {
      this.audit.logToolAction({ workspaceId: this.deps.workspaceId, sessionId: this.deps.sessionId,
        toolName: BROWSER_TOOL_NAMES.setDeclaration, url: this.lastModel?.url, outcome: 'denied',
        detail: `declaration=${terminal}` });
      return toolJson({ ok: false, declarationSet: false, reason: terminal });
    }
    if (!await (this.deps.isInvocationCurrent ?? (() => true))() || this.controlGate('control')) return mutationAuthorizationError();
    const freshObservation = await this.handleGetDecisionObservation({ signal });
    if (freshObservation.isError || !this.latestDecisionObservation ||
        this.latestDecisionObservation.documentIdentityDigest !== initialObservation.documentIdentityDigest ||
        this.latestDecisionObservation.structuralChecksum !== initialObservation.structuralChecksum ||
        this.latestDecisionObservation.controlEpoch !== initialObservation.controlEpoch) {
      return toolError('browser_declaration_content_changed', 'toctou', 'Task-relevant page content changed while declaration approval was pending.', 'The approval was consumed; review current content and request again.');
    }
    const currentResolved = this.refTable.currentEntries().find((entry) =>
      entry.backendNodeId === targetBinding.backendNodeId && sameElementFingerprint(entry.fingerprint, targetBinding.fingerprint));
    const currentTask = tasks.getActive(this.taskScope());
    if (!currentResolved || !currentTask || currentTask.taskId !== consumed.taskId || currentTask.version !== consumed.version ||
        !sameBrowserDocumentIdentity(currentResolved.batch, targetBinding.document) ||
        currentResolved.backendNodeId !== targetBinding.backendNodeId ||
        !sameElementFingerprint(currentResolved.fingerprint, targetBinding.fingerprint)) {
      return toolError('browser_declaration_target_changed', 'toctou', 'The approved declaration target or task changed.', 'The approval was consumed; observe and request again.');
    }
    const currentProbe = await page.inspectBackendNodeState?.(target.backendNodeId).catch(() => undefined);
    const currentState = await page.callBackendNode<{ ok: boolean; checked?: boolean }>(target.backendNodeId, buildBackendCheckStateFunction()).catch(() => null);
    const currentDetails = await page.inspectBackendNode?.(target.backendNodeId, buildInspectElementFunction());
    const currentDeclarationRaw = currentDetails ? [currentDetails.role, currentDetails.name, currentDetails.nearbyText]
      .filter((value): value is string => typeof value === 'string' && value.length > 0).join('\0').slice(0, 1800) : '';
    const currentDeclarationDigest = createHash('sha256').update(currentDeclarationRaw.normalize('NFC')).digest('hex');
    if (currentProbe?.status !== 'ready' || !currentState?.ok || typeof currentState.checked !== 'boolean' ||
        currentDeclarationDigest !== declarationDigest) {
      return toolError('browser_declaration_target_changed', 'toctou', 'The approved declaration is no longer safely actionable.', 'The approval was consumed; observe and request again.');
    }
    if (recordApproved && !await recordApproved()) return mutationAuthorizationError();
    let validationObservation = this.latestDecisionObservation;
    let receipt: BrowserOperationReceipt;
    if (currentState.checked === args.intendedState) {
      receipt = { outcome: 'not_dispatched', dispatchState: 'not_dispatched', verified: true,
        retrySafe: true, matchesRequested: true, delta: { kind: 'none', changed: false } };
    } else {
      receipt = await page.clickBackendNode(target.backendNodeId, authorizeDispatch);
      if (receipt.outcome !== 'dispatched_verified') return toolJson({ ok: false, declarationSet: false, receipt });
      const postObservationResult = await this.handleGetDecisionObservation({ signal });
      validationObservation = this.latestDecisionObservation;
      if (postObservationResult.isError || !validationObservation ||
          validationObservation.documentIdentityDigest !== initialObservation.documentIdentityDigest ||
          validationObservation.controlEpoch !== initialObservation.controlEpoch) {
        return toolError('browser_declaration_post_observation_changed', 'toctou', 'The page changed before the declaration click could be coherently verified.', 'The click may have occurred, but no declaration authority was recorded; review the current page.');
      }
      const postTarget = this.refTable.currentEntries().find((entry) =>
        entry.backendNodeId === targetBinding.backendNodeId &&
        sameElementFingerprint(entry.fingerprint, targetBinding.fingerprint) &&
        sameBrowserDocumentIdentity(entry.batch, targetBinding.document));
      const [postProbe, after, postDetails] = await Promise.all([
        page.inspectBackendNodeState?.(target.backendNodeId).catch(() => undefined),
        page.callBackendNode<{ ok: boolean; checked?: boolean }>(target.backendNodeId, buildBackendCheckStateFunction()).catch(() => null),
        page.inspectBackendNode?.(target.backendNodeId, buildInspectElementFunction()).catch(() => null),
      ]);
      const postDeclarationRaw = postDetails ? [postDetails.role, postDetails.name, postDetails.nearbyText]
        .filter((value): value is string => typeof value === 'string' && value.length > 0).join('\0').slice(0, 1800) : '';
      const postDeclarationDigest = createHash('sha256').update(postDeclarationRaw.normalize('NFC')).digest('hex');
      if (!postTarget || postProbe?.status !== 'ready' || !after?.ok || after.checked !== args.intendedState ||
          postDeclarationDigest !== declarationDigest) {
        return toolError('browser_declaration_post_observation_changed', 'toctou', 'The declaration target or checked state changed before coherent verification completed.', 'The click may have occurred, but no declaration authority was recorded; review the current page.');
      }
      receipt = { ...receipt, matchesRequested: true, delta: { kind: 'field', changed: true } };
    }
    if (!validationObservation) {
      return toolError('browser_declaration_observation_unavailable', 'toctou', 'No coherent observation is available to validate the declaration.', 'Review the current page and request declaration authority again.');
    }
    const authorityBinding = createBrowserBinding('declaration-authority', {
      taskId: requestBindingValue.taskId, taskVersion: consumed.version, slotKey: requestBindingValue.slotKey,
      declarationDigest: requestBindingValue.declarationDigest, intendedState: requestBindingValue.intendedState,
      target: requestBindingValue.target, capabilityId: requestBindingValue.capabilityId,
      runtimeGeneration: requestBindingValue.runtimeGeneration, operationId: requestBindingValue.operationId,
      documentIdentity: validationObservation.documentIdentityDigest,
      structuralChecksum: validationObservation.structuralChecksum,
      observationId: validationObservation.observationId,
      observationEpoch: validationObservation.observationEpoch,
      controlEpoch: validationObservation.controlEpoch,
    });
    let confirmed;
    try {
      confirmed = tasks.confirmDeclarationAuthority(
        this.taskScope(), consumed.taskId, consumed.version, slot.slotKey, authorityBinding,
        { observationId: validationObservation.observationId, observationEpoch: validationObservation.observationEpoch },
      );
    } catch {
      return toolError('browser_declaration_authority_persist_failed', 'toctou', 'The declaration state was checked but authority could not be persisted.', 'Do not proceed to final review; observe task state and ask again.');
    }
    this.audit.logToolAction({ workspaceId: this.deps.workspaceId, sessionId: this.deps.sessionId,
      toolName: BROWSER_TOOL_NAMES.setDeclaration, url: this.lastModel?.url, outcome: 'ok',
      detail: `declaration=confirmed;dispatch=${receipt.dispatchState}` });
    return toolJson({ ok: true, declarationSet: true, authority: 'confirmed', taskVersion: confirmed.version, receipt });
  }

  // -- upload (workspace-contained, handler-approved file egress) ----------

  async handleUpload(
    args: { operationId: string; ref: string; paths: string[] },
    extra?: unknown,
    authorizeDispatch?: () => Promise<boolean>,
    recordApproved?: () => Promise<boolean>,
  ): Promise<CallToolResult> {
    const gate = this.controlGate('control');
    if (gate) return gate;
    const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
    const workspaceFolder = this.deps.workspaceFolder;
    if (!workspaceFolder) {
      return toolError('browser_upload_workspace_unavailable', 'approval', 'The browser invocation is not bound to a workspace folder.', 'Reload the task before uploading local files.');
    }
    let staged = false;
    try {
      const page = await this.ensurePage();
      if (this.svc.getSession(this.deps.sessionId)?.targetKind !== 'shell') {
        return toolError('browser_upload_target_untrusted', 'approval', 'Local file upload is available only in the shell-owned embedded browser.', 'Open this task in the desktop app embedded browser.');
      }
      const resolved = await this.resolveCurrentRef(page, args.ref);
      if (!isRefEntry(resolved)) return resolved;
      const target = resolved;
      if (target.kind !== 'field' || target.interactionClass !== 'file-egress' || !target.fingerprint.fileInput ||
          typeof target.backendNodeId !== 'number' || !page.callBackendNode || !page.setFileInputFiles) {
        return toolError('browser_upload_target_invalid', 'ref_resolve', 'Upload requires a current file-input ref.', 'Choose the file-egress field ref from getPageState or findElements.');
      }
      const initial = await page.callBackendNode<FileInputSnapshot>(target.backendNodeId, buildFileInputSnapshotFunction());
      const initialUnsafe = fileInputUnsafe(initial);
      if (!initial || initialUnsafe) {
        return toolError('browser_upload_target_unsafe', 'toctou', `The file input is unsafe: ${initialUnsafe ?? 'target_changed'}.`, 'Choose a visible enabled file input or its visible associated label.');
      }
      if (!initial.multiple && args.paths.length !== 1) {
        return toolError('browser_upload_multiple_rejected', 'approval', 'This file input accepts exactly one file.', 'Choose one workspace media file.');
      }
      let candidates: BrowserUploadCandidate[];
      try {
        candidates = await inspectBrowserUploadCandidates(workspaceFolder, args.paths, initial.accept);
      } catch (error) {
        return uploadPolicyResult(error);
      }
      const parsedOrigin = originOf(initial.origin);
      if (!parsedOrigin) {
        return toolError('browser_upload_origin_invalid', 'toctou', 'The page origin could not be verified.', 'Navigate to a valid http(s) page and obtain a fresh file-input ref.');
      }
      const decision = await this.requestApproval({
        toolName: BROWSER_TOOL_NAMES.upload,
        title: `Share workspace media with ${parsedOrigin}`,
        description: 'These local file bytes will become readable by the remote page through this file input.',
        payload: {
          kind: 'browser_upload',
          warning: 'Uploading shares local workspace file bytes with the remote site.',
          origin: parsedOrigin,
          target: { role: { source: 'app', text: 'file input' }, accept: sanitizeUntrustedPageText(initial.accept, 200), multiple: initial.multiple },
          files: candidates.map((candidate) => ({
            source: 'workspace_file',
            name: sanitizeUntrustedPageText(candidate.basename, 160).text,
            mediaType: candidate.mimeType,
            size: candidate.size,
          })),
          totalBytes: candidates.reduce((sum, candidate) => sum + candidate.size, 0),
        },
      }, signal);
      if (!isApprovalDecision(decision)) return decision;
      if (decision.behavior !== 'allow') return toolJson({ uploaded: false, reason: 'user_denied' });

      const postGate = this.controlGate('control');
      if (postGate) return postGate;
      const currentResolved = await this.resolveCurrentRef(page, args.ref);
      if (!isRefEntry(currentResolved) || !sameBrowserDocumentIdentity(currentResolved.batch, target.batch) ||
          currentResolved.backendNodeId !== target.backendNodeId ||
          !sameElementFingerprint(currentResolved.fingerprint, target.fingerprint) ||
          currentResolved.interactionClass !== 'file-egress') {
        return toolError('browser_upload_target_changed', 'toctou', 'The approved file input changed before assignment.', 'Observe the page and start a new upload operation.');
      }
      const current = await page.callBackendNode<FileInputSnapshot>(target.backendNodeId, buildFileInputSnapshotFunction());
      if (!current || fileInputUnsafe(current) || !sameFileInputContract(initial, current)) {
        return toolError('browser_upload_target_changed', 'toctou', 'The approved file-input contract changed before assignment.', 'Observe the page and start a new upload operation.');
      }
      if (recordApproved && !await recordApproved()) return mutationAuthorizationError();

      const opened: Array<{ candidate: BrowserUploadCandidate; handle: Awaited<ReturnType<typeof reopenApprovedBrowserUpload>> }> = [];
      let stagedUpload: Awaited<ReturnType<BrowserUploadStagingService['stage']>>;
      try {
        for (const candidate of candidates) {
          opened.push({ candidate, handle: await reopenApprovedBrowserUpload(workspaceFolder, candidate) });
        }
        stagedUpload = await this.uploadStaging.stage(this.deps.sessionId, args.operationId, opened);
        staged = true;
      } catch (error) {
        return uploadPolicyResult(error);
      } finally {
        await Promise.all(opened.map(({ handle }) => handle.close().catch(() => undefined)));
      }
      const finalResolved = await this.resolveCurrentRef(page, args.ref);
      const finalSnapshot = await page.callBackendNode<FileInputSnapshot>(target.backendNodeId, buildFileInputSnapshotFunction());
      if (!isRefEntry(finalResolved) || !sameBrowserDocumentIdentity(finalResolved.batch, target.batch) ||
          finalResolved.backendNodeId !== target.backendNodeId ||
          !sameElementFingerprint(finalResolved.fingerprint, target.fingerprint) || !finalSnapshot ||
          fileInputUnsafe(finalSnapshot) || !sameFileInputContract(initial, finalSnapshot) ||
          !await this.uploadStaging.verify(stagedUpload)) {
        await this.uploadStaging.releaseOperation(this.deps.sessionId, args.operationId);
        staged = false;
        return toolError('browser_upload_target_changed', 'toctou', 'The approved upload changed while preparing file bytes.', 'Observe the page and start a new upload operation.');
      }
      if (authorizeDispatch && !await authorizeDispatch()) {
        await this.uploadStaging.releaseOperation(this.deps.sessionId, args.operationId);
        staged = false;
        return mutationAuthorizationError();
      }
      const receipt = await page.setFileInputFiles(target.backendNodeId, stagedUpload.paths);
      if (receipt.outcome === 'not_dispatched') {
        await this.uploadStaging.releaseOperation(this.deps.sessionId, args.operationId);
        staged = false;
      }
      this.audit.logToolAction({
        workspaceId: this.deps.workspaceId,
        sessionId: this.deps.sessionId,
        toolName: BROWSER_TOOL_NAMES.upload,
        url: parsedOrigin,
        outcome: receipt.outcome === 'dispatched_verified' ? 'ok' : 'error',
        detail: `upload=${receipt.outcome};count=${candidates.length};bytes=${stagedUpload.totalBytes}`,
      });
      return toolJson({
        ok: receipt.outcome === 'dispatched_verified',
        ref: args.ref,
        receipt,
        fileCount: candidates.length,
        totalBytes: stagedUpload.totalBytes,
        note: 'File assignment is not proof that the remote application finished reading or uploading the bytes.',
      });
    } catch (error) {
      if (staged) await this.uploadStaging.releaseOperation(this.deps.sessionId, args.operationId);
      return uploadPolicyResult(error);
    }
  }

  // -- activate (single-use handler-level approval, KTD5-KTD7) -------------

  async handleActivate(
    args: { ref: string; operationId?: string; taskBinding?: TaskMutationBinding },
    extra?: unknown,
    authorizeDispatch?: () => Promise<boolean>,
    recordApproved?: () => Promise<boolean>,
  ): Promise<CallToolResult> {
    const gate = this.controlGate('control');
    if (gate) return gate;
    const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
    try {
      const finalTask = this.finalTask(args.taskBinding);
      const activeTask = this.deps.taskState?.getActive(this.taskScope());
      if ((activeTask?.lifecycle === 'ready' && !finalTask) ||
          (args.taskBinding?.slotKey.startsWith('final_activation_') && (!finalTask || !args.operationId))) {
        return toolError('browser_final_action_classification_required', 'control', 'The final action is not bound to the current ready task and operation.', 'Capture fresh task evidence and request a new publication review.');
      }
      // Reject known non-action classes before live resolution. This cannot
      // grant authority: it only keeps field/file refs out of the generic
      // activation path (and preserves their specialized guidance).
      const knownTarget = this.refTable.get(args.ref);
      const knownClassificationError = knownTarget && activationClassificationError(knownTarget);
      if (knownClassificationError) return knownClassificationError;

      const page = await this.ensurePage();
      const resolved = await this.resolveCurrentRef(page, args.ref);
      if (!isRefEntry(resolved)) return resolved;
      const target = resolved;
      const classificationError = activationClassificationError(target);
      if (classificationError) return classificationError;
      if (!page.callBackendNode) {
        return toolError('browser_activation_unsupported', 'ref_resolve', 'The current browser cannot safely inspect this action for activation.', 'Observe the page in a browser runtime with trusted backend-node inspection.');
      }

      const details = await page.inspectBackendNode?.(target.backendNodeId, buildInspectElementFunction());
      const initial = await page.callBackendNode<ActivationTargetSnapshot>(
        target.backendNodeId,
        buildActivationTargetSnapshotFunction(),
      );
      if (!details || !initial) {
        return toolError('browser_ref_unresolvable', 'ref_resolve', 'The activation target no longer resolves.', 'Call getPageState and choose a fresh ref.');
      }
      if (details.actions.includes('submit')) {
        return toolError('browser_use_submit_tool', 'ref_resolve', 'This page control resolves to an HTML form submission.', 'Call submit with the control ref or its owning form ref.');
      }
      const initialRisk = activationHighRiskDrift(initial, initial);
      if (initialRisk) {
        return toolError('browser_activation_target_unsafe', 'toctou', `Activation target is unsafe: ${initialRisk}.`, 'Observe the page and choose a visible, enabled, unobscured control.');
      }
      const parsedOrigin = originOf(initial.origin);
      if (!parsedOrigin) {
        return toolError('browser_activation_origin_invalid', 'toctou', 'The page origin could not be verified.', 'Navigate with open to a valid http(s) page and obtain a fresh ref.');
      }

      // Single-use in-memory approval authority. The durable ledger binds the
      // operationId to the private `{ref}` digest; this stricter runtime-only
      // binding carries page state that must never enter approval/audit/MCP.
      const approvalBinding = Object.freeze({
        document: Object.freeze({ ...target.batch }),
        backendNodeId: target.backendNodeId,
        fingerprint: Object.freeze({ ...target.fingerprint }),
        actionClass: target.interactionClass ?? 'ambiguous-activation',
        origin: parsedOrigin,
      });

      let approvedSnapshot = initial;
      let approvedDetails = details;
      let differences: string[] = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const reconfirmation = attempt > 0;
        const payload: Record<string, unknown> = {
          kind: 'browser_activation',
          warning: 'This control is supplied by the remote page and may cause an external change.',
          origin: parsedOrigin,
          target: activationApprovalTarget(target, approvedDetails),
          editorSummary: publicEditorSummary(approvedSnapshot),
          ...(finalTask ? { finalReview: this.publicationReview(finalTask) } : {}),
        };
        if (reconfirmation) {
          payload.reconfirmation = true;
          payload.differences = differences;
        }
        const decision = await this.requestApproval({
          toolName: BROWSER_TOOL_NAMES.activate,
          title: reconfirmation ? `Confirm updated page activation on ${parsedOrigin}` : `Confirm page activation on ${parsedOrigin}`,
          description: reconfirmation
            ? 'The non-sensitive page summary changed. Review the updated manifest before activating once.'
            : 'Review this single-use activation. Page-provided labels are shown as untrusted data.',
          payload,
        }, signal);
        if (!isApprovalDecision(decision)) return decision;
        if (decision.behavior !== 'allow') {
          if (finalTask) {
            try { this.deps.taskState?.awaitFinalReview(this.taskScope(), finalTask.taskId, finalTask.version); } catch { /* stale */ }
          }
          this.audit.logToolAction({
            workspaceId: this.deps.workspaceId,
            sessionId: this.deps.sessionId,
            toolName: BROWSER_TOOL_NAMES.activate,
            url: parsedOrigin,
            outcome: 'denied',
            detail: 'activation=user_denied',
          });
          return toolJson({ activated: false, reason: 'user_denied' });
        }

        const postGate = this.controlGate('control');
        if (postGate) return postGate;
        const currentResolved = await this.resolveCurrentRef(page, args.ref);
        if (!isRefEntry(currentResolved) ||
            !sameBrowserDocumentIdentity(currentResolved.batch, approvalBinding.document) ||
            currentResolved.backendNodeId !== approvalBinding.backendNodeId ||
            !sameElementFingerprint(currentResolved.fingerprint, approvalBinding.fingerprint) ||
            (currentResolved.interactionClass ?? 'ambiguous-activation') !== approvalBinding.actionClass) {
          return toolError('browser_activation_target_changed', 'toctou', 'The approved page target changed before dispatch.', 'The approval was consumed. Observe the page and start a new operation.');
        }
        const current = await page.callBackendNode<ActivationTargetSnapshot>(
          approvalBinding.backendNodeId,
          buildActivationTargetSnapshotFunction(),
        );
        if (!current) {
          return toolError('browser_activation_target_changed', 'toctou', 'The approved page target disappeared before dispatch.', 'The approval was consumed. Observe the page and start a new operation.');
        }
        const currentDetails = await page.inspectBackendNode?.(approvalBinding.backendNodeId, buildInspectElementFunction());
        if (!currentDetails || currentDetails.actions.includes('submit')) {
          return toolError('browser_activation_target_changed', 'toctou', 'The approved page target semantics changed before dispatch.', 'The approval was consumed. Observe the page and start a new operation.');
        }
        const highRisk = activationHighRiskDrift(approvedSnapshot, current);
        if (highRisk) {
          return toolError('browser_activation_target_changed', 'toctou', `The approved page target is no longer safe: ${highRisk}.`, 'The approval was consumed. Observe the page and start a new operation.');
        }
        differences = activationSafeDifferences(approvedSnapshot, current);
        if (JSON.stringify(activationApprovalTarget(target, approvedDetails)) !==
            JSON.stringify(activationApprovalTarget(target, currentDetails))) {
          differences.push('target_summary_changed');
        }
        if (differences.length === 0) break;
        if (attempt > 0) {
          return toolError('browser_activation_toctou', 'toctou', 'The activation summary kept changing after reconfirmation.', 'The approval was consumed. Observe the stable page and start a new operation.');
        }
        approvedSnapshot = current;
        approvedDetails = currentDetails;
      }

      if (recordApproved && !await recordApproved()) return mutationAuthorizationError();
      if (finalTask && !this.prepareFinalAction(args.operationId!, args.taskBinding, args.ref)) {
        return toolError('browser_final_action_binding_stale', 'toctou', 'The publication review could not be bound to the current task and target.', 'The approval was consumed; observe and request a fresh review.');
      }
      const receipt = await page.clickBackendNode(target.backendNodeId, authorizeDispatch);
      await this.uploadStaging.releaseSession(this.deps.sessionId);
      this.audit.logToolAction({
        workspaceId: this.deps.workspaceId,
        sessionId: this.deps.sessionId,
        toolName: BROWSER_TOOL_NAMES.activate,
        url: parsedOrigin,
        outcome: receipt.outcome === 'dispatched_verified' ? 'ok' : 'error',
        detail: `activation=${receipt.outcome}`,
      });
      return toolJson({
        ok: receipt.outcome === 'dispatched_verified',
        ref: args.ref,
        receipt,
        note: 'Activation dispatch is not proof that the remote application completed its business action. Observe the page before concluding success.',
      });
    } catch (err) {
      return this.toErrorResult(err, 'dispatch');
    }
  }

  // -- submit (handler-level hard gate + TOCTOU, KTD-4 ②) ---------------------

  async handleSubmit(
    args: { ref: string; fields?: Record<string, string>; operationId?: string; taskBinding?: TaskMutationBinding },
    extra?: unknown,
    authorizeDispatch?: () => Promise<boolean>,
    recordApproved?: () => Promise<boolean>,
  ): Promise<CallToolResult> {
    const gate = this.controlGate('control');
    if (gate) return gate;
    const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
    try {
      const finalTask = this.finalTask(args.taskBinding);
      if (this.deps.taskState?.getActive(this.taskScope()) && (!finalTask || !args.operationId)) {
        return toolError('browser_final_action_classification_required', 'control', 'Submission is not bound to the current ready final-action slot.', 'Use the exact final activation task binding and request a publication review.');
      }
      const page = await this.ensurePage();
      const resolved = await this.resolveCurrentRef(page, args.ref);
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
            'Call getPageState for the current form field list.',
          );
        }
        if (!page.fillBackendNode) {
          return toolError(
            'browser_ref_unresolvable',
            'ref_resolve',
            `Field "${key}" cannot be filled through trusted browser input.`,
            'Reopen the browser session and refresh the page model.',
          );
        }
        const fillResult = await page.fillBackendNode(fieldEntry.backendNodeId, value);
        if (fillResult.outcome !== 'dispatched_verified' || fillResult.matchesRequested !== true) {
          return toolError(
            'browser_action_failed',
            'dispatch',
            `Failed to fill field "${key}": ${fillResult.outcome}`,
            fillResult.retrySafe
              ? 'Call getPageState to verify the field state and retry.'
              : 'Do not retry automatically; call getPageState to determine whether the field changed.',
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
          'Call getPageState to re-read the page and retry.',
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
        const submitPayload = sanitizeSubmitPayload({
          url: this.lastModel?.url ?? '',
          formName,
          snapshot: approvedSnapshot,
        });
        const payload: Record<string, unknown> = finalTask ? {
          kind: 'browser_activation',
          warning: 'This final action may publish content externally.',
          origin: String(submitPayload.actionOrigin ?? ''),
          target: { name: { source: 'untrusted_page', text: sanitizeUntrustedPageText(formName, 200) } },
          editorSummary: {
            editorCount: approvedSnapshot.fields.length,
            filledEditorCount: approvedSnapshot.fields.length,
            totalEditorLength: 0,
          },
          finalReview: this.publicationReview(finalTask),
        } : submitPayload;
        if (reconfirm) {
          payload.reconfirmation = true;
          // Field names + change kinds only (values never leave the page).
          payload.differences = pendingDiffs;
        }
        const origin = String(payload.origin ?? payload.actionOrigin ?? '');
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
          if (finalTask) {
            try { this.deps.taskState?.awaitFinalReview(this.taskScope(), finalTask.taskId, finalTask.version); } catch { /* stale */ }
          }
          diagLog(`[browser-mcp] submit denied session=${this.deps.sessionId} form=${formName}`);
          this.audit.logToolAction({
            workspaceId: this.deps.workspaceId,
            sessionId: this.deps.sessionId,
            toolName: BROWSER_TOOL_NAMES.submit,
            url: origin,
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
            'Call getPageState to re-read the page and retry.',
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
            'Call getPageState, verify the page is stable, and retry the submission.',
          );
        }
        approvedSnapshot = current;
        pendingDiffs = diffs;
      }

      if (recordApproved && !await recordApproved()) return mutationAuthorizationError();
      if (finalTask && !this.prepareFinalAction(args.operationId!, args.taskBinding, args.ref)) {
        return toolError('browser_final_action_binding_stale', 'toctou', 'The publication review could not be bound to the stable form and task.', 'The approval was consumed; observe and request a fresh review.');
      }

      // Dispatch: click the approved submit control when given, else
      // requestSubmit() so validation + submit events fire.
      const dispatchBackendNodeId = controlEntry?.backendNodeId ?? target.backendNodeId;
      const dispatchFailure = controlEntry
        ? 'Failed to activate the submit control'
        : 'Form dispatch failed';
      try {
        if (controlEntry) {
          const dispatchResult = await page.clickBackendNode(dispatchBackendNodeId, authorizeDispatch);
          if (dispatchResult?.outcome !== 'dispatched_verified') {
            return toolError(
              'browser_action_failed',
              'dispatch',
              `${dispatchFailure}: ${dispatchResult?.outcome ?? 'unknown'}`,
              dispatchResult?.retrySafe === false
                ? 'Do not retry automatically; call getPageState to determine whether the activation occurred.'
                : 'Call getPageState to re-read the page and retry.',
            );
          }
        } else {
          if (authorizeDispatch && !await authorizeDispatch()) return mutationAuthorizationError();
          const dispatchResult = await page.callBackendNode?.<{ ok: boolean; reason?: string }>(
            dispatchBackendNodeId, buildBackendSubmitFunction(),
          );
          if (!dispatchResult?.ok) {
            return toolError(
              'browser_action_failed',
              'dispatch',
              `${dispatchFailure}: ${dispatchResult?.reason ?? 'unknown'}`,
              'Call getPageState to re-read the page and retry.',
            );
          }
        }
      } catch (error) {
        if (!isSubmitNavigationRace(error)) throw error;
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
  async handleRequestHandoff(
    args: { reason: string },
    extra?: unknown,
    authorizeDispatch?: () => Promise<boolean>,
    recordApproved?: () => Promise<boolean>,
  ): Promise<CallToolResult> {
    const sessionId = this.deps.sessionId;
    const ctl = this.handoffCtl;
    const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
    diagLog(`[browser-mcp] handoff requested session=${sessionId} reason=${args.reason}`);
    const traceTask = this.deps.taskState?.getActive(this.taskScope());
    if (traceTask) this.trace({ kind: 'handoff', taskId: traceTask.taskId, taskVersion: traceTask.version,
      disposition: 'requested' });

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
            if (recordApproved && !await recordApproved()) return mutationAuthorizationError();
            if (authorizeDispatch && !await authorizeDispatch()) return mutationAuthorizationError();
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

      const result = await this.handoffCompletionResult(completion);
      if (traceTask) this.trace({ kind: 'handoff', taskId: traceTask.taskId, taskVersion: traceTask.version,
        disposition: completion?.reason === 'handed_back' ? 'returned' : 'cancelled' });
      return result;
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
  async handleClose(
    args: { reason?: string },
    extra?: unknown,
    authorizeDispatch?: () => Promise<boolean>,
    recordApproved?: () => Promise<boolean>,
  ): Promise<CallToolResult> {
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

    if (recordApproved && !await recordApproved()) return mutationAuthorizationError();
    if (authorizeDispatch && !await authorizeDispatch()) return mutationAuthorizationError();

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

    // A closed browser is never re-distilled: ensurePage would transparently
    // respawn the session the human just closed.
    const includeDiff =
      completion.reason !== 'browser_closed' &&
      (completion.reason === 'handed_back' || completion.phase === 'in_takeover');
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
    if (err instanceof BrowserDecisionObservationError) {
      return toolError(
        err.code,
        stage,
        err.message,
        'Request a fresh decision observation; if coherence cannot be proven, stop or hand control to the user.',
      );
    }
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
      'Call getPageState to re-read the page; if the failure persists, the browser session may need to be reopened.',
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
  const mutations = deps.mutationCoordinator ?? browserMutationCoordinator;
  const traceOperationClass = (action: BrowserMutationRequest['action']): BrowserTaskOperationClass => {
    if (action === 'fill' || action === 'select' || action === 'check') return 'field';
    if (action === 'upload') return 'file';
    if (action === 'declaration') return 'declaration';
    if (action === 'activation') return 'activation';
    if (action === 'submit') return 'submit';
    if (action === 'open') return 'navigation';
    if (action === 'close' || action === 'control') return 'control';
    return 'unclassified';
  };
  const executeMutation = async (
    operationId: string,
    action: BrowserMutationRequest['action'],
    privateParameters: unknown,
    extra: unknown,
    handler: (
      signal: AbortSignal,
      authorizeDispatch: () => Promise<boolean>,
      recordApproved: () => Promise<boolean>,
    ) => Promise<CallToolResult>,
  ): Promise<CallToolResult> => {
    const privateRecord = privateParameters && typeof privateParameters === 'object'
      ? privateParameters as { taskBinding?: TaskMutationBinding; ref?: string }
      : {};
    let taskPending: ReturnType<BrowserToolContext['prepareTaskMutation']> = null;
    const invocation: BrowserInvocationScope = Object.freeze({
      workspaceId: deps.workspaceId,
      sessionId: deps.sessionId,
      runtimeGeneration: deps.runtimeGeneration ?? 'unscoped',
      capabilityId: deps.capabilityId ?? 'unscoped',
      principalId: deps.principalId ?? `${deps.workspaceId}:${deps.sessionId}`,
      operationId,
      signal: (extra as { signal?: AbortSignal } | undefined)?.signal ?? new AbortController().signal,
      isCurrent: deps.isInvocationCurrent ?? (() => true),
    });
    const approvalRequired = action === 'declaration' || action === 'activation' || action === 'upload' || action === 'submit' || action === 'close' || action === 'control';
    const receipt = await mutations.execute(invocation, {
      action,
      privateParameters,
      deferredDispatchIntent: true,
      approvalRequired,
      prepareDispatch: action === 'declaration' ? undefined : () => {
        taskPending = ctx.prepareTaskMutation(operationId, privateRecord.taskBinding, privateRecord.ref, traceOperationClass(action));
        return true;
      },
      rollbackPreparedDispatch: action === 'declaration' ? undefined : () => ctx.cancelTaskMutation(taskPending, operationId),
      dispatch: async (signal, authorizeDispatch, recordApproved) => {
        let dispatchAuthorized = false;
        const trackedAuthorize = async (): Promise<boolean> => {
          const authorized = await authorizeDispatch();
          if (authorized) dispatchAuthorized = true;
          return authorized;
        };
        const handlerResult = await handler(signal, trackedAuthorize, recordApproved);
        return mutationReceiptForResult(action, handlerResult, dispatchAuthorized);
      },
    });
    if (privateRecord.taskBinding) {
      try { (deps.taskTrace ?? browserTaskTrace).append({ kind: 'receipt',
        taskId: privateRecord.taskBinding.taskId, taskVersion: privateRecord.taskBinding.taskVersion,
        operationId, outcome: receipt.outcome }); } catch { /* diagnostic only */ }
    }
    if (action !== 'declaration') await ctx.settleTaskMutation(taskPending, operationId, receipt);
    return toolJson({ receipt });
  };
  const operationIdSchema = z.string().min(1).max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
    .describe('Caller-stable idempotency key for this mutation');
  const taskMutationBindingSchema = z.object({
    taskId: z.string().uuid(),
    taskVersion: z.number().int().min(0),
    slotKey: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    observationId: z.string().uuid(),
  }).strict().describe('Optional binding to one current task slot and coherent observation; it grants no authority');

  const openDef = tool(
    'open',
    'Navigate the embedded browser to an http(s) URL and return a bounded mutation receipt. ' +
      'Starts the browser session on first use. Call getPageState explicitly after navigation ' +
      'to observe page content and receive fresh refs.',
    { operationId: operationIdSchema, url: z.string().describe('Full http(s) URL to navigate to') },
    async (args: { operationId?: string; url: string }, extra) => args.operationId
      ? executeMutation(args.operationId, 'open', { url: args.url }, extra, (_signal, authorize) => ctx.handleOpen({ url: args.url }, authorize))
      : toolError('browser_operation_id_required', 'dispatch', 'Mutation tools require an operationId.', 'Retry once with a new caller-stable operationId.'),
  );

  const getPageStateDef = tool(
    'getPageState',
    'Return a fresh, text-only semantic view of the current page without raw HTML or a screenshot. ' +
      'The result combines a pruned accessibility outline with DOM-derived forms and fields, ' +
      'fresh element refs, control states, a page revision, and bounded content. Use this as the ' +
      'default observation when no fresh model was just returned, especially after external page ' +
      'changes or stale-ref errors. Do not take a screenshot for ' +
      'routine page understanding. Use findElements for targeted discovery when the ' +
      'inventory is truncated.',
    {
      offset: z.number().int().min(0).optional().describe('Element offset for reading the next bounded inventory segment (default 0)'),
      limit: z.number().int().min(1).max(100).optional().describe('Maximum elements to return (default 60, max 100)'),
      includeContent: z.boolean().optional().describe('Include up to 1,200 characters of main page text (default true)'),
    },
    async (args) => ctx.handleGetPageState(args),
    { annotations: { readOnlyHint: true, openWorldHint: true } },
  );

  const getDecisionObservationDef = tool(
    'getDecisionObservation',
    'Return one revision-coherent decision observation containing bounded structured evidence, ' +
      'trusted CSS/image viewport transforms, and a normalized sensitive-masked image. Use it only ' +
      'when structure alone cannot answer the current decision. Image coordinates are evidence, never action parameters.',
    {},
    async (_args, extra) => ctx.handleGetDecisionObservation(extra as { signal?: AbortSignal }),
    { annotations: { readOnlyHint: true, openWorldHint: true } },
  );

  const visualPointSchema = z.object({
    x: z.number().finite().min(0).max(2000),
    y: z.number().finite().min(0).max(2000),
  }).strict();
  const visualBoxSchema = z.object({
    x: z.number().finite().min(0).max(2000),
    y: z.number().finite().min(0).max(2000),
    width: z.number().finite().positive().max(2000),
    height: z.number().finite().positive().max(2000),
  }).strict();
  const visualCandidateSchema = z.object({
    ref: z.string().min(1).max(128),
    confidence: z.number().finite().min(0).max(1),
    evidence: z.array(z.enum(['visual', 'relationship', 'geometry', 'state'])).min(1).max(8),
    point: visualPointSchema.optional(),
    box: visualBoxSchema.optional(),
  }).strict().refine((candidate) => !(candidate.point && candidate.box), {
    message: 'A candidate may cite a point or box, not both',
  });
  const rebindVisualCandidatesDef = tool(
    'rebindVisualCandidates',
    'Read-only validation for candidate refs cited from one decision observation. Image points or boxes are bounded evidence only; this tool returns a trusted ref or ambiguity and never dispatches input.',
    z.object({
      observationId: z.string().uuid(),
      candidates: z.array(visualCandidateSchema).min(1).max(20),
    }).strict(),
    async (args) => ctx.handleRebindVisualCandidates(args),
    { annotations: { readOnlyHint: true, openWorldHint: true } },
  );

  const taskIdSchema = z.string().uuid().describe('Server-minted active browser task identity');
  const taskVersionSchema = z.number().int().min(0).describe('Exact active task version for compare-and-set');
  const getTaskStateDef = tool(
    'getTaskState',
    'Return the positive-shape projection of the active goal-scoped browser task. It contains state categories and evidence identities, never authored values or page prose.',
    z.object({}).strict(),
    async () => ctx.handleGetTaskState(),
    { annotations: { readOnlyHint: true, openWorldHint: true } },
  );
  const startTaskBase = tool(
    'startTask',
    'Mint a goal-scoped browser task for this session. If a task already exists, pass its exact id and version; replacement requires application-owned user approval and revokes prior evidence and authority.',
    z.object({
      replaceTaskId: taskIdSchema.optional(),
      expectedTaskVersion: taskVersionSchema.optional(),
    }).strict().refine((value) => (value.replaceTaskId === undefined) === (value.expectedTaskVersion === undefined), {
      message: 'replaceTaskId and expectedTaskVersion must be supplied together',
    }),
    async (args, extra) => ctx.handleStartTask(args, extra as { signal?: AbortSignal }),
    { annotations: { destructiveHint: true, openWorldHint: true } },
  );
  const startTaskDef = { ...startTaskBase, _meta: { 'anthropic/requiresUserInteraction': true } };
  const proposalSchema = z.object({
    category: z.enum(TASK_SLOT_CATEGORIES),
    ordinal: z.number().int().min(0).max(31),
    ref: z.string().min(1).max(128),
    confidence: z.number().finite().min(0).max(1),
    evidence: z.array(z.enum(['structure', 'relationship', 'geometry', 'state', 'visual'])).min(1).max(8),
  }).strict();
  const proposeTaskEvidenceDef = tool(
    'proposeTaskEvidence',
    'Propose generic semantic slot categories using refs from one current coherent observation. The server derives requiredness and population and never accepts verified, complete, authority, success, labels, or values from the caller.',
    z.object({
      taskId: taskIdSchema,
      expectedTaskVersion: taskVersionSchema,
      observationId: z.string().uuid(),
      proposals: z.array(proposalSchema).min(1).max(64),
    }).strict(),
    async (args) => ctx.handleProposeTaskEvidence(args),
    { annotations: { readOnlyHint: false, openWorldHint: true } },
  );
  const recoverTargetDef = tool(
    'recoverTarget',
    'Perform the one server-classified, non-activating reveal allowed for an exact trusted task target. It never accepts coordinates, selectors, overlay claims, or a caller-selected failure category.',
    z.object({
      ref: z.string().min(1).max(128),
      taskBinding: taskMutationBindingSchema,
    }).strict(),
    async (args: { ref: string; taskBinding: TaskMutationBinding }) => ctx.handleRecoverTarget(args.taskBinding, args.ref),
    { annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
  );
  const abandonTaskBase = tool(
    'abandonTask',
    'Abandon the exact active browser task version. This is an application-owned terminal transition requiring user approval.',
    z.object({ taskId: taskIdSchema, expectedTaskVersion: taskVersionSchema }).strict(),
    async (args, extra) => ctx.handleAbandonTask(args, extra as { signal?: AbortSignal }),
    { annotations: { destructiveHint: true, openWorldHint: true } },
  );
  const abandonTaskDef = { ...abandonTaskBase, _meta: { 'anthropic/requiresUserInteraction': true } };
  const outcomeBindingSchema = z.object({ taskId: taskIdSchema, expectedTaskVersion: taskVersionSchema }).strict();
  const recheckTaskOutcomeDef = tool(
    'recheckTaskOutcome',
    'Read-only reconciliation of the current unknown final action. Caller evidence, success text, URLs, and predicates are never accepted.',
    outcomeBindingSchema,
    async (args) => ctx.handleRecheckTaskOutcome(args),
    { annotations: { readOnlyHint: true, openWorldHint: true } },
  );
  const abandonOutcomeTrackingBase = tool(
    'abandonOutcomeTracking',
    'Close outcome tracking without claiming publication success. Requires application-owned confirmation.',
    outcomeBindingSchema,
    async (args: { taskId: string; expectedTaskVersion: number }, extra) =>
      ctx.handleResolveUnknownOutcome({ taskId: args.taskId, expectedTaskVersion: args.expectedTaskVersion, action: 'abandon' }, extra),
    { annotations: { destructiveHint: true, openWorldHint: true } },
  );
  const abandonOutcomeTrackingDef = { ...abandonOutcomeTrackingBase, _meta: { 'anthropic/requiresUserInteraction': true } };
  const acknowledgeDuplicateRiskBase = tool(
    'acknowledgeDuplicateRisk',
    'Acknowledge possible duplicate risk and require a new task version and review. This never dispatches publication.',
    outcomeBindingSchema,
    async (args: { taskId: string; expectedTaskVersion: number }, extra) =>
      ctx.handleResolveUnknownOutcome({ taskId: args.taskId, expectedTaskVersion: args.expectedTaskVersion, action: 'acknowledge_duplicate_risk' }, extra),
    { annotations: { destructiveHint: true, openWorldHint: true } },
  );
  const acknowledgeDuplicateRiskDef = { ...acknowledgeDuplicateRiskBase, _meta: { 'anthropic/requiresUserInteraction': true } };

  const findElementsDef = tool(
    'findElements',
    'After getPageState, search the complete internal accessibility index by text or regular ' +
      'expression, optionally narrowed by role. Returns fresh refs that can be passed to ' +
      'getElementDetails, act (editing only), activate, or submit; arbitrary selectors and raw HTML are never accepted.',
    {
      text: z.string().max(300).optional().describe('Case-insensitive text to find in element names or nearby context'),
      regex: z.string().max(200).optional().describe('Safe JavaScript regex subset without groups, repetition, lookarounds, or backreferences; optionally /pattern/flags; cannot be combined with text'),
      role: z.string().max(80).optional().describe('Exact accessibility role filter, such as button or link'),
      exact: z.boolean().optional().describe('With text, require an exact element-name match instead of a substring match'),
      limit: z.number().int().min(1).max(100).optional().describe('Maximum matches to return (default 20)'),
    },
    async (args) => ctx.handleFindElements(args),
    { annotations: { readOnlyHint: true, openWorldHint: true } },
  );

  const getElementDetailsDef = tool(
    'getElementDetails',
    'After getPageState or findElements identifies a ref, return bounded details for that one element: ' +
      'tag, role/name, safe attributes, nearby text, limited descendants, owning-form ' +
      'structure, and possible actions. This tool does not search for elements; selectors and raw ' +
      'HTML are never accepted.',
    { ref: z.string().describe('Element ref from the latest open/getPageState/findElements/act model') },
    async (args) => ctx.handleGetElementDetails(args),
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
    'After choosing a ref with getPageState, findElements, and optionally getElementDetails, ' +
      'perform one editing interaction (fill/select/check). click is intentionally non-dispatching: ' +
      'every page-supplied click must use activate, while HTML submit controls use submit. The result ' +
      'includes a text-free bounded receipt; call getPageState explicitly to observe the page.',
    {
      operationId: operationIdSchema,
      ref: z.string().describe('Element ref from the latest page model (e.g. "e7")'),
      action: z.enum(['click', 'fill', 'select', 'check']),
      value: z
        .string()
        .optional()
        .describe('fill: text to enter; select: option value or label; check: "true"/"false" (omit to toggle)'),
      taskBinding: taskMutationBindingSchema.optional(),
    },
    async (args: { operationId?: string; ref: string; action: 'click' | 'fill' | 'select' | 'check'; value?: string; taskBinding?: TaskMutationBinding }, extra) => {
      const taskError = ctx.validateTaskMutationBinding(args.taskBinding, args.ref);
      if (taskError) return taskError;
      return args.operationId ? executeMutation(
          args.operationId,
          args.action === 'click' ? 'activation' : args.action,
          { ref: args.ref, action: args.action, value: args.value, taskBinding: args.taskBinding },
          extra,
          (_signal, authorize) => ctx.handleAct({ ref: args.ref, action: args.action, value: args.value }, authorize),
        ) : toolError('browser_operation_id_required', 'dispatch', 'Mutation tools require an operationId.', 'Retry once with a new caller-stable operationId.');
    },
  );

  const setDeclarationBase = tool(
    'setDeclaration',
    'Request application-owned user authority for one current declaration checkbox or radio. The declaration text is derived by the server from the trusted current ref; callers cannot provide page text, selectors, coordinates, or authority. A page-default checked state still requires confirmation.',
    z.object({
      operationId: operationIdSchema,
      ref: z.string().min(1).max(128),
      intendedState: z.boolean(),
      taskBinding: taskMutationBindingSchema,
    }).strict(),
    async (args: { operationId?: string; ref: string; intendedState: boolean; taskBinding: TaskMutationBinding }, extra) => {
      const taskError = ctx.validateTaskMutationBinding(args.taskBinding, args.ref);
      if (taskError) return taskError;
      return args.operationId ? executeMutation(
        args.operationId, 'declaration',
        { ref: args.ref, intendedState: args.intendedState, taskBinding: args.taskBinding }, extra,
        (signal, authorize, recordApproved) => ctx.handleSetDeclaration(
          { operationId: args.operationId!, ref: args.ref, intendedState: args.intendedState, taskBinding: args.taskBinding },
          { ...(extra as object), signal }, authorize, recordApproved,
        ),
      ) : toolError('browser_operation_id_required', 'dispatch', 'Mutation tools require an operationId.', 'Retry once with a new caller-stable operationId.');
    },
    { annotations: { destructiveHint: true, openWorldHint: true } },
  );
  const setDeclarationDef = { ...setDeclarationBase, _meta: { 'anthropic/requiresUserInteraction': true } };

  const activateBase = tool(
    'activate',
    'Activate one page-supplied control with a trusted physical click. ALWAYS requires handler-level ' +
      'user approval, including in auto mode and for anchors, safe-looking hrefs, or local-looking labels. ' +
      'The approval binds a sanitized origin, target identity, and non-sensitive editor summary; the target ' +
      'is revalidated before at most one dispatch. The receipt never claims business success.',
    {
      operationId: operationIdSchema,
      ref: z.string().describe('Page action ref from the latest page model'),
      taskBinding: taskMutationBindingSchema.optional(),
    },
    async (args: { operationId?: string; ref: string; taskBinding?: TaskMutationBinding }, extra) => {
      const taskError = ctx.validateTaskMutationBinding(args.taskBinding, args.ref);
      if (taskError) return taskError;
      return args.operationId ? executeMutation(
          args.operationId,
          'activation',
          { ref: args.ref, taskBinding: args.taskBinding },
          extra,
          (signal, authorize, recordApproved) => ctx.handleActivate(
            { ref: args.ref, operationId: args.operationId!, taskBinding: args.taskBinding },
            { ...(extra as object), signal },
            authorize,
            recordApproved,
          ),
        ) : toolError('browser_operation_id_required', 'dispatch', 'Mutation tools require an operationId.', 'Retry once with a new caller-stable operationId.');
    },
    { annotations: { destructiveHint: true, openWorldHint: true } },
  );
  const activateDef = {
    ...activateBase,
    _meta: { 'anthropic/requiresUserInteraction': true },
  };

  const uploadBase = tool(
    'upload',
    'Assign approved image/video files from the current workspace to one file-input ref. ALWAYS ' +
      'requires handler-level approval, rejects external CDP targets and unsafe paths, and returns only ' +
      'a bounded assignment receipt. Paths must be workspace-relative; never pass absolute paths.',
    {
      operationId: operationIdSchema,
      ref: z.string().describe('File-input field ref from the latest page model'),
      paths: z.array(z.string().min(1).max(500)).min(1).max(18).describe('Workspace-relative approved media paths'),
      taskBinding: taskMutationBindingSchema.optional(),
    },
    async (args: { operationId?: string; ref: string; paths: string[]; taskBinding?: TaskMutationBinding }, extra) => {
      const taskError = ctx.validateTaskMutationBinding(args.taskBinding, args.ref);
      if (taskError) return taskError;
      return args.operationId ? executeMutation(
          args.operationId,
          'upload',
          { ref: args.ref, paths: args.paths, taskBinding: args.taskBinding },
          extra,
          (signal, authorize, recordApproved) => ctx.handleUpload(
            { operationId: args.operationId!, ref: args.ref, paths: args.paths },
            { ...(extra as object), signal },
            authorize,
            recordApproved,
          ),
        ) : toolError('browser_operation_id_required', 'dispatch', 'Mutation tools require an operationId.', 'Retry once with a new caller-stable operationId.');
    },
    { annotations: { destructiveHint: true, openWorldHint: true } },
  );
  const uploadDef = { ...uploadBase, _meta: { 'anthropic/requiresUserInteraction': true } };

  const takeScreenshotDef = tool(
    'takeScreenshot',
    'Capture a viewport JPEG only for genuinely visual questions such as layout, overlap, charts, ' +
      'canvas, or image content. This is optional and only useful to a vision-capable model. Never ' +
      'use it for routine page understanding or element discovery; use getPageState first. Taking ' +
      'a screenshot does not refresh element refs.',
    {},
    async () => ctx.handleTakeScreenshot(),
    { annotations: { readOnlyHint: true, openWorldHint: true } },
  );

  const submitBase = tool(
    'submit',
    'Submit a form. ALWAYS requires explicit user confirmation: the form action, method and ' +
      'fields (sensitive values redacted) are shown to the user, and the form state is re-verified ' +
      'before dispatch. Pass a form ref or a submit-button ref. Fill fields first with act, using ' +
      'one operationId per field mutation.',
    {
      operationId: operationIdSchema,
      ref: z.string().describe('Form ref or submit-button ref from the latest page model'),
      fields: z
        .record(z.string(), z.string())
        .optional()
        .describe('Field values to fill before submitting, keyed by field ref or field name'),
      taskBinding: taskMutationBindingSchema.optional(),
    },
    async (args: { operationId?: string; ref: string; fields?: Record<string, string>; taskBinding?: TaskMutationBinding }, extra) => {
      const taskError = ctx.validateTaskMutationBinding(args.taskBinding, args.ref);
      if (taskError) return taskError;
      return !args.operationId ? toolError('browser_operation_id_required', 'dispatch', 'Mutation tools require an operationId.', 'Retry once with a new caller-stable operationId.')
      : args.fields && Object.keys(args.fields).length > 0
        ? toolError('browser_submit_fields_separate', 'dispatch', 'Coordinated submit does not fill fields inside the submit operation.', 'Fill each field with act and its own operationId, then submit without fields.')
        : executeMutation(
          args.operationId, 'submit', { ref: args.ref, fields: args.fields, taskBinding: args.taskBinding }, extra,
          (signal, authorize, recordApproved) => ctx.handleSubmit(
            { ref: args.ref, operationId: args.operationId!, taskBinding: args.taskBinding },
            { ...(extra as object), signal },
            authorize,
            recordApproved,
          ),
        );
    },
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
      operationId: operationIdSchema,
      reason: z.string().describe('Why the user needs to take over (shown in the handoff card)'),
    },
    async (args: { operationId?: string; reason: string }, extra) => args.operationId
      ? executeMutation(
          args.operationId, 'control', { reason: args.reason }, extra,
          (signal, authorize, recordApproved) => ctx.handleRequestHandoff({ reason: args.reason }, { ...(extra as object), signal }, authorize, recordApproved),
        )
      : toolError('browser_operation_id_required', 'dispatch', 'Mutation tools require an operationId.', 'Retry once with a new caller-stable operationId.'),
  );

  const closeDef = tool(
    'close',
    'Close the embedded browser for this session, releasing its resources. The user must ' +
      'confirm before it closes. Call this when the browsing task is done and the page is no ' +
      'longer needed — do not leave a browser running idle. Any remembered login is preserved ' +
      'and re-applied on the next open. The call blocks until the user confirms, declines, or ' +
      'the request times out recoverably.',
    {
      operationId: operationIdSchema,
      reason: z
        .string()
        .optional()
        .describe('Why the browser is being closed (shown in the confirmation card)'),
    },
    async (args: { operationId?: string; reason?: string }, extra) => args.operationId
      ? executeMutation(
          args.operationId, 'close', { reason: args.reason }, extra,
          (signal, authorize, recordApproved) => ctx.handleClose({ reason: args.reason }, { ...(extra as object), signal }, authorize, recordApproved),
        )
      : toolError('browser_operation_id_required', 'dispatch', 'Mutation tools require an operationId.', 'Retry once with a new caller-stable operationId.'),
  );

  // The cast reconciles handler-parameter variance: each tool definition is
  // generic over its own zod shape, while BrowserToolDefinition erases it.
  return [
    openDef,
    getPageStateDef,
    getDecisionObservationDef,
    rebindVisualCandidatesDef,
    getTaskStateDef,
    startTaskDef,
    proposeTaskEvidenceDef,
    recoverTargetDef,
    abandonTaskDef,
    recheckTaskOutcomeDef,
    abandonOutcomeTrackingDef,
    acknowledgeDuplicateRiskDef,
    findElementsDef,
    getElementDetailsDef,
    actDef,
    setDeclarationDef,
    uploadDef,
    activateDef,
    takeScreenshotDef,
    startNetworkCaptureDef,
    stopNetworkCaptureDef,
    authenticatedRequestDef,
    submitDef,
    extractDef,
    handoffDef,
    closeDef,
  ] as BrowserToolDefinition[];
}
