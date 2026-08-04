import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import type { HookCallback, Query, SDKMessage, SDKSessionInfo, SessionMessage, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { ChatSession, CreateSessionInput, UpdateSessionInput } from '../models/session.js';
import type { Workspace } from '../models/workspace.js';
import { store as workspaceStore, type BotEscalationEntry } from '../storage/sqlite-store.js';
import type {
  ChatMessage,
  SubagentState,
  TaskItem,
  SseEvent,
  WorkflowState,
  SessionActivitySnapshot,
  QuestionPayload,
} from '../types/message.js';
import { normalizeSessionMessage, scanSdkMessagesForTasks } from './message-normalizer.js';
import { SdkClient } from './sdk-client.js';
import {
  getBackendAvailability,
  resolveDefaultBackend,
  type BackendId,
} from './agent-backends.js';
import { OpencodeBackendDriver, buildServeConfig } from './opencode-adapter.js';
import { SessionRuntime, APPROVAL_TIMEOUT_DENY_MESSAGE, type ApprovalResolutionProvenance } from './session-runtime.js';
import { reconstructSubagentState } from './subagent-loader.js';
import { opencodeServerManager, opencodeFetch } from './opencode-server-manager.js';
import {
  opencodeMessagesToSessionMessages,
  pairTaskToolCallsWithChildren,
  type OpencodeRestMessage,
} from './opencode-transcript.js';
import type { SlashCommandDto } from '../types/initialization.js';
import { resolveTranscriptDir } from './analytics-transcript-path.js';
import { listWorkflowAgentIds, listWorkflowRunIds, loadWorkflowState } from './workflow-loader.js';
import { resolveSdkBinary } from '../utils/resolve-sdk-binary.js';
import { resolveWecomCliPath } from '../utils/resolve-wecom-cli.js';
import { resolveComateCliPath } from '../utils/resolve-comate-cli.js';
import { sidecarLog } from '../utils/sidecar-logger.js';
import { diagLog } from '../utils/diag-logger.js';
import { normalizeWindowsPath } from '../utils/normalize-windows-path.js';
import { loadClaudeSettings } from '../utils/claude-settings.js';
import { buildClaudeEnv, prependEnvPath, getPathEnvKey } from '../utils/sdk-env.js';
import { pluginSettingsService } from './plugin-settings-service.js';
import { evaluateToolPermission, getToolPermissionDenialReason, resolveEffectivePolicy } from './tool-permission-policy.js';
import { createPathPolicyContext, validateToolInput, verifyBotFileToolAccess, canonicalizeBotPath } from './bot-path-policy.js';
import { evaluateSkill, evaluateSkillDisabled, compileSkillFilter, compileSkillDenyRules } from './bot-skill-policy.js';
import { botService } from './bot-service.js';
import { botAuditLogger } from './bot-audit-logger.js';
import { botEscalationLedger, escalationApprovalTtlMs } from './bot-escalation-ledger.js';
import { notifyEscalationPending, notifyEscalationResolved } from './bot-escalation-notifier.js';
import {
  ESCALATION_GLOBAL_PENDING_CAP,
  ESCALATION_PER_USER_HOURLY_CAP,
  ESCALATION_USER_CAP_WINDOW_MS,
  OVERRIDE_DENY_CAP_PER_TURN,
  computeAlwaysAllowRules,
  generalizedEscalationSignature,
  type BotEscalationReason,
} from './bot-escalation-guard.js';
import type { BotActor } from './bot-service.js';
import { evaluateBotToolPermission, evaluateBotSkill, isOwnerOrAdmin } from './bot-policy.js';
import type { BotPersona, BotRoleKey, BotRolePolicy } from '../models/bot.js';
import { SAFE_PRESET } from './tool-permission-policy.js';
import { createDefaultBotRolePolicy, deriveBotAccess, validateUserDirName, capabilityDirForPath, type BotAccessDerivation } from './bot-access-policy.js';
import {
  classifyMcpTool,
  parseMcpToolName,
  type McpToolAnnotations,
  type McpToolAnnotationMap,
} from './mcp-tool-classification.js';
import { ensureSandboxProbe, isSandboxDegraded } from './sandbox-probe.js';
import type { Provider } from '../models/provider.js';
import {
  BROWSER_MCP_SERVER_KEY,
  BROWSER_STREAM_CLOSE_TIMEOUT_MS,
  disposeBrowserToolContext,
  type BrowserApprovalRequester,
} from './browser-mcp.js';
import { BROWSER_TOOL_NAMES, isBrowserToolName } from './browser-tool-names.js';
import { browserApiBrokerService } from './browser-api-broker-service.js';
import { browserService } from './browser-service.js';

import { browserControlService } from './browser-control.js';
import { sanitizeSubprocessEnv } from '../utils/sanitize-env.js';
import { getSidecarBaseUrl } from '../utils/self-port.js';
import { SCHEDULED_TASKS_MCP_KEY, getScheduledTasksMcpToken } from './scheduled-tasks-mcp.js';
import { makeScheduledRunStopHook } from './goal-stop-hook.js';
import {
  SESSION_TOKEN_ENV,
  WECOM_CONTEXT_FILE_ENV,
  sessionCapabilityService,
  writeSessionWecomContext,
} from './session-capability-service.js';

const FILE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit']);
const IDENTITY_SENSITIVE_TOOLS = new Set([...FILE_TOOLS, 'Bash', 'Skill']);
/** Write-class file tools: capability-dir writes by these are audited (U6). */
const CAPABILITY_WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

/**
 * Explicit model fallback for bot sessions (U1, KTD-25). When the resolved
 * provider has no model configured, bot sessions must NOT inherit the CLI's
 * default model: CLI 2.1.219 changed the default Opus from Opus 4.8 to Opus 5,
 * which would silently drift bot behavior (cost, latency, policy-relevant
 * capability) on upgrade. Pinned to the pre-upgrade default, verified two ways
 * against CLI 2.1.217 (the version shipped with SDK 0.3.217, our pre-upgrade
 * pin): the bundled binary labels "Opus 4.8 - best for everyday, complex
 * tasks" as its default-tier model and contains no `claude-opus-5` reference;
 * the 2.1.219 release notes name Opus 4.8 as the superseded default. GUI
 * sessions intentionally keep inheriting the CLI default (undefined).
 */
export const BOT_SESSION_PINNED_MODEL = 'claude-opus-4-8';

function sanitizeBotEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return sanitizeSubprocessEnv(env);
}

/**
 * Browser tools never run in bot sessions (U4, KTD-4 ③): the browser MCP
 * server is not injected for bot sessions at all, so this explicit deny is
 * the second line of defense (covers spoofed/legacy tool names) and must
 * precede the 'unknown' fall-through in the canUseTool closures. It applies
 * to admins too — the admin bypass is void for the browser category. The
 * message is generic: naming the capability would let an attacker probe the
 * policy surface. Returns null for non-browser tools.
 */
function denyBrowserToolInBotSession(
  sessionId: string,
  toolName: string,
  toolUseID: string | undefined,
): { behavior: 'deny'; message: string } | null {
  if (!isBrowserToolName(toolName)) return null;
  diagLog(
    `[ChatService.botDeny] session=${sessionId} tool=${toolName} toolUseId=${toolUseID ?? 'none'} reason=browser-tool-bot-session`,
  );
  return {
    behavior: 'deny',
    message: "I can't do that in this workspace.",
  };
}

// ---------------------------------------------------------------------------
// Bot sandbox permission model (U3) — shared helpers
// ---------------------------------------------------------------------------

/**
 * Model-facing denial routing classes (KTD-12). Denial messages carry ONLY
 * the routing class — never a capability name, so an attacker probing the
 * policy surface learns nothing about which capability denied them.
 * - final:               hard boundary (sensitive paths, missing identity,
 *                        category denies) — no escalation exists.
 * - escalatable:         out-of-sandbox requests by regular members — phase 1
 *                        denies them, phase 2 routes them to owner/admin
 *                        approval; the class tells the model a human channel
 *                        is the way forward, not a retry.
 * - sandbox-unavailable: the host sandbox probe failed; regular members'
 *                        unmatched bash denies until the probe passes (R5).
 * - policy-rebuilding:   a role demotion forced an immediate runtime rebuild
 *                        (KTD-11); identity-sensitive tools deny in the window.
 */
export type BotDenialClass = 'final' | 'escalatable' | 'sandbox-unavailable' | 'policy-rebuilding';

const BOT_DENIAL_MESSAGES: Record<BotDenialClass, string> = {
  final:
    'Denied (routing: final). This action is outside the approved boundaries for this channel. Do not retry it.',
  escalatable:
    'Denied (routing: escalatable). This action needs a channel owner or admin to approve or perform it. Do not keep retrying; tell the user an owner or admin must handle it.',
  'sandbox-unavailable':
    'Denied (routing: sandbox-unavailable). The execution sandbox is unavailable on this host, so this action cannot run safely. Tell the user a desktop administrator must repair sandboxing first.',
  'policy-rebuilding':
    'Denied (routing: policy-rebuilding). The permission policy for this session is being rebuilt right now. Wait a moment and retry the action.',
};

export function botDenialMessage(routingClass: BotDenialClass): string {
  return BOT_DENIAL_MESSAGES[routingClass];
}

/** Role rank for demotion detection (KTD-11): owner > admin > normal > none. */
function botRoleRank(role: BotRoleKey | null | undefined): number {
  if (role === 'owner') return 3;
  if (role === 'admin') return 2;
  if (role === 'normal') return 1;
  return 0;
}

/**
 * Capability preamble + persona composition (KTD-12). The preamble always
 * reaches the session: concatenated with a persona append, composed
 * independently when the persona replaces the system prompt, and injected as
 * a preset append when no persona is configured.
 */
function composeBotSystemPrompt(
  persona: BotPersona | undefined,
  preamble: string,
): import('@anthropic-ai/claude-agent-sdk').Options['systemPrompt'] {
  if (!persona) {
    return { type: 'preset', preset: 'claude_code', append: preamble };
  }
  if (persona.mode === 'append') {
    return { type: 'preset', preset: 'claude_code', append: `${persona.prompt}\n\n${preamble}` };
  }
  return `${persona.prompt}\n\n${preamble}`;
}

/**
 * Legacy bash-whitelist prefix matcher (string-prefix semantics). Retained
 * ONLY for the workspace kill switch (botPermissionSandboxDisabled), whose
 * purpose is to reproduce the pre-sandbox permission model verbatim for
 * canary rollback — including its prefix semantics. The sandbox permission
 * model never uses this: passlist matching is the SDK structural rule
 * engine's job (U4, KTD-13).
 */
function legacyBashWhitelistPrefixMatch(
  bashWhitelist: string[],
  role: BotRoleKey | null | undefined,
  command: string,
): boolean {
  if (isOwnerOrAdmin(role)) {
    return true;
  }
  const whitelist = bashWhitelist;
  if (whitelist.length === 0) {
    return false;
  }
  const trimmed = command.trim();
  return whitelist.some((allowed) => allowed !== '' && (trimmed === allowed || trimmed.startsWith(`${allowed} `)));
}

/** Compact tool-input rendering for the audit hook (never throws). */
function summarizeToolInput(input: unknown): string {
  try {
    const json = JSON.stringify(input);
    if (json === undefined) return '[unserializable]';
    return json.length <= 200 ? json : `${json.slice(0, 200)}…`;
  } catch {
    return '[unserializable]';
  }
}

/** First string among the common tool-input path fields (audit rendering). */
function auditPathFromToolInput(input: Record<string, unknown>): string | undefined {
  for (const key of ['file_path', 'notebook_path', 'pattern', 'path'] as const) {
    const value = input[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/** Normalize an AskUserQuestion tool input into question payloads. */
function mapAskUserQuestionInput(input: Record<string, unknown>): QuestionPayload[] {
  return (input.questions as unknown[] ?? []).map((q: unknown) => {
    const qx = q as Record<string, unknown>;
    return {
      question: typeof qx.question === 'string' ? qx.question : '',
      header: typeof qx.header === 'string' ? qx.header : undefined,
      options: Array.isArray(qx.options)
        ? qx.options.map((o: unknown) => {
            const ox = o as Record<string, unknown>;
            return {
              label: typeof ox.label === 'string' ? ox.label : '',
              description: typeof ox.description === 'string' ? ox.description : undefined,
              preview: typeof ox.preview === 'string' ? ox.preview : undefined,
            };
          })
        : [],
      multiSelect: qx.multiSelect === true,
    };
  });
}

/** Positive finite tool-input timeout, or undefined. */
function extractToolTimeout(input: Record<string, unknown>): number | undefined {
  return typeof input.timeout === 'number' && Number.isFinite(input.timeout) && input.timeout > 0 ? input.timeout : undefined;
}

/**
 * Map a resolution-provenance approver (structural, from the runtime) onto a
 * BotActor for the audit trail (U8). Unknown actor types fail closed to
 * 'system'; absent provenance keeps the caller's fallback (phase-1: the
 * requester — self-approval).
 */
function provenanceApprover(
  provenance: ApprovalResolutionProvenance | undefined,
  fallback: BotActor,
): BotActor {
  const candidate = provenance?.approver;
  if (!candidate) return fallback;
  const type = (['system', 'user', 'wecom', 'feishu'] as const).includes(candidate.type as 'system')
    ? (candidate.type as BotActor['type'])
    : 'system';
  return {
    type,
    ...(candidate.channelKey !== undefined && { channelKey: candidate.channelKey as BotActor['channelKey'] }),
    ...(candidate.channelUserId !== undefined && { channelUserId: candidate.channelUserId }),
  };
}

/**
 * PreToolUse audit hook (KTD-1): the SDK evaluates hooks before rules and
 * before canUseTool, so this hook sees EVERY tool call — including the
 * built-in read-only commands and allow-rule hits that never reach the gate.
 * Audit-only: it never blocks, and a logging failure must never break a turn.
 */
function makeBotPreToolUseAuditHook(sessionId: string, botId: string): HookCallback {
  return async (input, toolUseID) => {
    try {
      if (input.hook_event_name === 'PreToolUse') {
        diagLog(
          `[ChatService.botToolCall] session=${sessionId} bot=${botId} tool=${input.tool_name} toolUseId=${toolUseID ?? 'none'} input=${summarizeToolInput(input.tool_input)}`,
        );
      }
    } catch {
      // audit-only: never interfere with the session
    }
    return {};
  };
}

export interface MessageStream {
  messages: AsyncGenerator<SDKMessage>;
  rawQuery: Query;
  wasDraft: boolean;
}

type RuntimeContext = {
  workspaceId: string;
  isBotSession?: boolean;
  botUserId?: string;
};

let RUNTIME_IDLE_GRACE_PERIOD_MS = 10 * 60 * 1000; // 10 minutes

export function __setIdleGracePeriodForTesting(ms: number): void {
  RUNTIME_IDLE_GRACE_PERIOD_MS = ms;
}

export function __restoreIdleGracePeriod(): void {
  RUNTIME_IDLE_GRACE_PERIOD_MS = 10 * 60 * 1000;
}

let REBUILD_POLL_INTERVAL_MS = 500;

export function __setRebuildPollIntervalForTesting(ms: number): void {
  REBUILD_POLL_INTERVAL_MS = ms;
}

export function __restoreRebuildPollInterval(): void {
  REBUILD_POLL_INTERVAL_MS = 500;
}

let SESSION_VERIFY_TIMEOUT_MS = 10000;

export function __setSessionVerifyTimeoutForTesting(ms: number): void {
  SESSION_VERIFY_TIMEOUT_MS = ms;
}

export function __restoreSessionVerifyTimeout(): void {
  SESSION_VERIFY_TIMEOUT_MS = 10000;
}

let opencodeFetchForTesting: typeof import('./opencode-server-manager.js').opencodeFetch | undefined;
export function __setOpencodeFetchForTesting(
  fetchImpl: typeof import('./opencode-server-manager.js').opencodeFetch | undefined,
): void {
  opencodeFetchForTesting = fetchImpl;
}

class SessionVerifyTimeoutError extends Error {
  constructor() {
    super('SDK getSessionInfo timeout');
  }
}

export class ChatService {
  private sdkClient: SdkClient;
  private runtimes = new Map<string, SessionRuntime>();
  private creatingRuntimes = new Map<string, Promise<SessionRuntime>>();
  private idleTimeouts = new Map<string, NodeJS.Timeout>();
  private runtimeContexts = new Map<string, RuntimeContext>();
  private pendingRebuilds = new Map<string, RuntimeContext>();
  private rebuildPollers = new Map<string, NodeJS.Timeout>();
  /**
   * Spawn-frozen role per bot session (KTD-11): sandbox config and permission
   * rules are frozen at spawn, so the gate compares the freshly resolved role
   * against this snapshot on every call. A lower fresh role means a demotion
   * happened after spawn — the gate denies identity-sensitive tools with the
   * policy-rebuilding routing class and forces an immediate rebuild.
   */
  private sessionSpawnRoles = new Map<string, BotRoleKey | null>();
  /** Sessions with a demotion-triggered immediate rebuild in flight (dedupe). */
  private demotionRebuilds = new Set<string>();
  /**
   * Per-turn out-of-sandbox deny counter (U11, KTD-19): reset on every
   * pushMessage, incremented on each deny outcome of the escape branch
   * (immediate dedupe/cap denies AND resolved approver-denies/expiries).
   * Reaching OVERRIDE_DENY_CAP_PER_TURN short-circuits the branch with an
   * explicit stop-retry instruction — the breaker for model retry loops.
   */
  private sessionOverrideDenies = new Map<string, number>();
  /**
   * U9 (KTD-20): per-runtime MCP tool annotation fetch, cached as a Promise
   * so concurrent first calls dedupe. Keyed by sessionId; cleared wherever
   * the other per-runtime gate bookkeeping is cleared (annotations are
   * static per server connection, so a runtime rebuild re-fetches). Fetch
   * failures cache an EMPTY map — missing annotations classify unknown
   * (fail-closed ask), never allow.
   */
  private sessionMcpToolAnnotations = new Map<string, Promise<McpToolAnnotationMap>>();
  private onRuntimeClose?: (sessionId: string) => void;
  private historyTimestampBases = new Map<string, number>();
  /**
   * Chained PRE-close listeners (KTD-5): the single-slot onRuntimeClose stays
   * with the WS server; services that must react to a runtime close (the
   * browser handoff controller) subscribe here instead of overwriting it.
   * Fired BEFORE runtime.close() so a listener can mark its own state before
   * close() resolves the session's pending cards with its generic deny.
   */
  private readonly runtimeClosingListeners = new Set<(sessionId: string) => void>();
  readonly serverNonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  constructor(sdkClient?: SdkClient) {
    this.sdkClient = sdkClient ?? new SdkClient();
    browserApiBrokerService.configureApprovalRequester(async ({
      taskId,
      method,
      siteKey,
      destination,
      bodySummary,
      correlationId,
      validationRequested,
      signal,
    }) => {
      const decision = await this.browserApprovalRequester(taskId, {
        toolName: BROWSER_TOOL_NAMES.authenticatedRequest,
        title: `Authorize ${method} request to ${siteKey}`,
        description: validationRequested
          ? 'Review the sanitized destination and body below. The request will be validated as non-mutating; a successful validation grants exact task-local reuse.'
          : 'Review the sanitized destination and body below. This authenticated request can change data on the destination site.',
        payload: {
          kind: 'authenticated_request',
          method,
          siteKey,
          destination,
          ...(bodySummary ? { bodySummary } : {}),
          correlationId,
          validationRequested,
        },
        signal,
      });
      return { behavior: decision.behavior };
    });
    // Wire the browser handoff controller's runtime channel (U5, KTD-6): the
    // controller resolves/timeouts the session's live browser card through
    // whatever runtime currently owns the session (lazy lookup — the runtime
    // may be rebuilt while the browser lives on, KTD-5; a missing runtime
    // no-ops, which the crash path relies on).
    browserControlService.configureRuntimeChannel({
      resolveApprovalCard: (sessionId, requestId, result, message) => {
        const runtime = this.getRuntimeIfExists(sessionId);
        if (!runtime) return;
        runtime.resolveApproval(
          requestId,
          result === 'allow'
            ? { behavior: 'allow' }
            : { behavior: 'deny', message: message ?? 'The browser handoff was ended.' },
        );
      },
      timeoutApprovalCard: (sessionId, requestId) => {
        this.getRuntimeIfExists(sessionId)?.timeoutDenyApproval(requestId);
      },
    });
    this.addOnRuntimeClosing((sessionId) => {
      browserControlService.handleRuntimeClosing(sessionId);
    });
  }

  /**
   * Handler-level approval channel for the browser MCP tools (U3, KTD-4 ②).
   * The submit tool calls this from INSIDE its handler — a workspace's
   * `.claude/settings.json` `permissions.allow` can short-circuit the SDK's
   * canUseTool evaluation, so the confirmation round-trip must not depend on
   * the interception layer. Lazy runtime lookup is deliberate: the runtime
   * may be rebuilt while the browser session lives on (KTD-5), and the lookup
   * rebinds to whatever runtime currently owns the session. Fails closed when
   * no runtime is live (the tool handler only runs during a runtime turn, so
   * this is a defensive path).
   */
  private readonly browserApprovalRequester: BrowserApprovalRequester = async (
    sessionId,
    request,
  ) => {
    const runtime = this.getRuntimeIfExists(sessionId);
    if (!runtime) {
      return {
        behavior: 'deny' as const,
        message: 'No live runtime is available for the browser approval round-trip.',
      };
    }
    const requestId = request.requestId ?? `browser-${randomUUID()}`;
    const result = await runtime.requestToolApproval(
      requestId,
      request.toolName,
      requestId,
      request.payload,
      {
        title: request.title,
        ...(request.description !== undefined && { description: request.description }),
        ...(request.signal !== undefined && { signal: request.signal }),
      },
    );
    return result.behavior === 'allow'
      ? { behavior: 'allow' as const }
      : { behavior: 'deny' as const, message: result.message };
  };

  /**
   * Per-session deps for the HTTP-hosted browser MCP (U6): resolves the
   * session's workspace and shares this service's approval requester so
   * browser approval cards keep flowing through the unified flow regardless
   * of which backend drives the session.
   */
  async resolveBrowserMcpDeps(sessionId: string): Promise<{
    workspaceId: string;
    approvalRequester: BrowserApprovalRequester;
  } | null> {
    const workspace = await this.findWorkspaceForSession(sessionId);
    if (!workspace) return null;
    return {
      workspaceId: workspace.id,
      approvalRequester: this.browserApprovalRequester,
    };
  }

  setOnRuntimeClose(callback: (sessionId: string) => void): void {
    this.onRuntimeClose = callback;
  }

  /**
   * Chained pre-close listener subscription (KTD-5): complements the WS
   * server's single-slot onRuntimeClose — listeners run BEFORE runtime.close()
   * in closeRuntime. Returns an unsubscribe function.
   */
  addOnRuntimeClosing(listener: (sessionId: string) => void): () => void {
    this.runtimeClosingListeners.add(listener);
    return () => {
      this.runtimeClosingListeners.delete(listener);
    };
  }

  getActiveSessionCount(): number {
    return this.runtimes.size;
  }

  /** Server-side idleness seam for the Todo night queue. A selected tab or an
   * open-but-idle runtime must not block the queue; an executing turn does. */
  hasExecutingRuntime(): boolean {
    for (const runtime of this.runtimes.values()) {
      const status = runtime.getStatus();
      if (status.isProcessing || this.runtimeActivity(runtime).active) return true;
    }
    return false;
  }

  /** Diagnostic: test-run the Claude binary in the workspace cwd to capture stderr. */
  protected async testClaudeBinary(claudePath: string | undefined, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
    if (!claudePath) {
      sidecarLog('[ChatService.testClaudeBinary] no binary path, skipping test');
      return;
    }
    sidecarLog(`[ChatService.testClaudeBinary] testing binary: ${claudePath} in cwd: ${cwd}`);
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return false;
        settled = true;
        return true;
      };
      const proc = spawn(claudePath, ['--version'], { cwd, env });
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (d) => { stdout += String(d); });
      proc.stderr?.on('data', (d) => { stderr += String(d); });
      const timeout = setTimeout(() => {
        if (!finish()) return;
        sidecarLog('[ChatService.testClaudeBinary] timeout after 10s');
        proc.kill();
        resolve();
      }, 10000);
      proc.on('close', (code) => {
        if (!finish()) return;
        clearTimeout(timeout);
        sidecarLog(`[ChatService.testClaudeBinary] exit code=${code} stdout=${stdout.trim()} stderr=${stderr.trim()}`);
        resolve();
      });
      proc.on('error', (err) => {
        if (!finish()) return;
        clearTimeout(timeout);
        sidecarLog(`[ChatService.testClaudeBinary] spawn error: ${err.message}`);
        resolve();
      });
    });
  }

  // Session management

  async listSessions(workspaceId: string, options: { archiveThresholdDays?: number } = {}): Promise<ChatSession[]> {
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) {
      throw new ChatError('Workspace not found', 'WORKSPACE_NOT_FOUND', 404);
    }

    // Discover SDK sessions for this workspace directory and sync into local DB
    try {
      const sessions = await this.sdkClient.listSessions({ dir: workspace.folderPath });
      for (const sdkSession of sessions) {
        const session = this.mapSdkSessionInfo(sdkSession, workspaceId);
        workspaceStore.syncSdkSession(session);
      }
    } catch (err) {
      console.error('Failed to list SDK sessions:', err);
      // Continue with local sessions even if SDK listing fails
    }

    // Load merged sessions from local DB (drafts + synced SDK sessions)
    const allSessions = workspaceStore.listLocalSessions(workspaceId);

    // Identify bot sessions from the unified user_sessions / bot_users tables.
    const botSessions = workspaceStore.listBotSessionsForWorkspace(workspaceId);
    for (const session of allSessions) {
      const botSession = botSessions.find((m) => m.sessionId === session.id);
      if (botSession) {
        session.source = botSession.channelKey;
      }
    }

    // Auto-archive stale non-WIP sessions when a threshold is provided
    const thresholdDays = options.archiveThresholdDays;
    if (typeof thresholdDays === 'number' && thresholdDays > 0) {
      const thresholdMs = thresholdDays * 86400_000;
      const now = Date.now();
      for (const session of allSessions) {
        if (session.isArchived || session.isWip) continue;
        const lastActive = session.lastModified ?? Date.parse(session.updatedAt);
        if (typeof lastActive !== 'number' || isNaN(lastActive)) continue;
        if (now - lastActive > thresholdMs) {
          workspaceStore.updateLocalSession(session.id, { isArchived: true });
          session.isArchived = true;
        }
      }
    }

    return allSessions;
  }

  async createSession(input: CreateSessionInput): Promise<ChatSession> {
    return workspaceStore.createLocalSession(
      input.workspaceId,
      input.name,
      input.approvalMode,
      input.providerId,
      input.source,
      input.customTitle,
      input.botId,
    );
  }

  async getSession(id: string, workspaceId: string): Promise<ChatSession | null> {
    const localSession = workspaceStore.getLocalSession(id);
    if (localSession && localSession.workspaceId !== workspaceId) {
      return null;
    }

    // Try SDK first for freshest data
    const workspace = await workspaceStore.get(workspaceId);
    if (workspace) {
      try {
        const sdkSession = await this.sdkClient.getSessionInfo(id, { dir: workspace.folderPath });
        if (sdkSession) {
          const session = this.mapSdkSessionInfo(sdkSession, workspaceId);
          // Preserve providerId, backend identity, and local-only booleans from
          // local DB — the SDK doesn't know about them (review P1: dropping
          // backend here let a default change silently rebind a locked session).
          session.providerId = localSession?.providerId;
          session.backend = localSession?.backend;
          session.backendSessionId = localSession?.backendSessionId;
          session.isWip = localSession?.isWip;
          session.isArchived = localSession?.isArchived;
          session.approvalMode = localSession?.approvalMode;
          session.fastMode = localSession?.fastMode;
          session.botId = localSession?.botId;
          session.source = localSession?.source;
          workspaceStore.syncSdkSession(session);
          return session;
        }
      } catch {
        // Ignore SDK errors, fall back to local DB
      }
    }

    // Fall back to local DB
    return localSession;
  }

  async updateSession(id: string, input: UpdateSessionInput, workspaceId: string): Promise<ChatSession | null> {
    // Persist isWip to DB (applies to both drafts and SDK sessions)
    if (input.isWip !== undefined) {
      workspaceStore.setSessionMetadata(id, input.isWip);
    }

    // Persist isArchived to DB (applies to both drafts and SDK sessions)
    if (input.isArchived !== undefined) {
      workspaceStore.updateLocalSession(id, { isArchived: input.isArchived });
    }

    // Check local DB for current provider before update
    const localSession = workspaceStore.getLocalSession(id);
    const previousProviderId = localSession?.providerId;

    // Backend changes are free while the session is a draft (R4: the lock
    // lands at the first message). Once the conversation has started, a
    // different backend is a conflict, not a silent no-op. A change with a
    // live runtime closes it so the next use rebuilds on the new backend.
    if (input.backend !== undefined) {
      if (input.backend !== 'claude' && input.backend !== 'opencode') {
        throw new ChatError(`Unknown agent backend '${input.backend}'`, 'INVALID_BACKEND', 400);
      }
      if (!localSession?.isDraft && localSession?.backend && localSession.backend !== input.backend) {
        throw new ChatError(
          `Session backend is locked to '${localSession.backend}' and cannot be changed`,
          'BACKEND_LOCKED',
          409,
        );
      }
      workspaceStore.updateSessionBackend(id, input.backend);
      if (localSession?.backend !== input.backend) {
        const existing = this.getRuntimeIfExists(id);
        if (existing) {
          diagLog(`[ChatService] session ${id} backend changed to '${input.backend}' — closing runtime for rebuild`);
          await this.closeRuntime(id);
        }
      }
    }

    if (localSession && localSession.isDraft) {
      const draftInput: Parameters<typeof workspaceStore.updateLocalSession>[1] = {};
      if (input.name !== undefined) draftInput.name = input.name;
      if (input.providerId !== undefined) draftInput.providerId = input.providerId;
      if (input.isArchived !== undefined) draftInput.isArchived = input.isArchived;
      if (input.fastMode !== undefined) draftInput.fastMode = input.fastMode;
      const updated = workspaceStore.updateLocalSession(id, draftInput);

      // Schedule rebuild if provider changed so next message creates a fresh runtime
      if (input.providerId !== undefined && input.providerId !== previousProviderId) {
        const runtime = this.getRuntimeIfExists(id);
        if (runtime) {
          sidecarLog(`[ChatService] scheduling rebuild for runtime ${id} due to provider change`);
          this.scheduleRuntimeRebuild(id, this.runtimeContexts.get(id));
        }
      }

      return updated;
    }

    // Otherwise rename the SDK session
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) {
      throw new ChatError('Workspace not found', 'WORKSPACE_NOT_FOUND', 404);
    }

    const isOpencodeBackend = localSession?.backend === 'opencode';

    if (input.name) {
      if (isOpencodeBackend) {
        // opencode stores its own session title in its sqlite store; route the
        // rename through the opencode serve's PATCH /session/{id} so the title
        // is persisted on the backend side (and survives a Comate restart).
        // The claude-flavored SDK renameSession would fail here because the
        // session id has no matching .jsonl transcript.
        await this.renameOpencodeSession(id, localSession, input.name, workspace);
      } else {
        await this.sdkClient.renameSession(id, input.name, { dir: workspace.folderPath });
      }
    }

    // Also update local DB for providerId and isArchived changes on non-draft sessions
    const localUpdates: Parameters<typeof workspaceStore.updateLocalSession>[1] = {};
    if (input.providerId !== undefined) localUpdates.providerId = input.providerId;
    if (input.isArchived !== undefined) localUpdates.isArchived = input.isArchived;
    if (input.fastMode !== undefined) localUpdates.fastMode = input.fastMode;
    // For opencode sessions the title lives on the backend; mirror it locally
    // (name + custom_title) so the UI reflects the change without a round-trip.
    if (input.name && isOpencodeBackend) {
      localUpdates.name = input.name;
      localUpdates.customTitle = input.name;
    }
    if (Object.keys(localUpdates).length > 0) {
      workspaceStore.updateLocalSession(id, localUpdates);
    }

    // Close runtime if provider changed so next message creates a fresh one
    if (input.providerId !== undefined && input.providerId !== previousProviderId) {
      const runtime = this.getRuntimeIfExists(id);
      if (runtime) {
        sidecarLog(`[ChatService] closing runtime ${id} due to provider change`);
        this.closeRuntime(id).catch((err) => {
          console.error(`Failed to close runtime ${id} during provider switch:`, err);
        });
      }
    }

    // opencode sessions have no claude .jsonl transcript, so getSessionInfo
    // (which scans project dirs for {id}.jsonl) would throw — return the
    // locally-mirrored session instead.
    if (isOpencodeBackend) {
      const local = workspaceStore.getLocalSession(id);
      if (local) return local;
    }

    // Return updated session info
    const sdkSession = await this.sdkClient.getSessionInfo(id, { dir: workspace.folderPath });
    if (sdkSession) {
      const session = this.mapSdkSessionInfo(sdkSession, workspaceId);
      workspaceStore.syncSdkSession(session);
      const localSession = workspaceStore.getLocalSession(id);
      session.isWip = localSession?.isWip;
      session.isArchived = localSession?.isArchived;
      session.approvalMode = localSession?.approvalMode;
      session.fastMode = localSession?.fastMode;
      session.providerId = localSession?.providerId;
      return session;
    }
    return workspaceStore.getLocalSession(id);
  }

  /**
   * Rename an opencode-backed session by PATCHing its serve's
   * /session/{backendSessionId} with `{ title }`. Spawns a serve for a closed
   * session when none is live (mirrors loadOpencodeSessionMessages) — the
   * opencode store is the source of truth for the title and must be updated
   * even when the runtime is cold.
   */
  private async renameOpencodeSession(
    comateSessionId: string,
    localSession: { backendSessionId?: string } | null | undefined,
    title: string,
    workspace: Workspace,
  ): Promise<void> {
    const backendSessionId = localSession?.backendSessionId;
    if (!backendSessionId) {
      throw new ChatError(
        'opencode session has no backend session id yet; cannot rename',
        'BACKEND_SESSION_MISSING',
        409,
      );
    }
    const instance = await this.ensureOpencodeServe(comateSessionId, workspace);
    if (!instance) {
      throw new ChatError(
        'opencode serve unavailable; cannot rename session',
        'OPENCODE_SERVE_UNAVAILABLE',
        503,
      );
    }
    const res = await this.ocFetch(instance, `/session/${backendSessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    });
    if (!res.ok) {
      throw new ChatError(
        `opencode rename failed: ${res.status} ${await res.text().catch(() => '')}`.trim(),
        'OPENCODE_RENAME_FAILED',
        502,
      );
    }
  }

  async deleteSession(id: string, workspaceId: string): Promise<boolean> {
    const localSession = workspaceStore.getLocalSession(id);
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) {
      throw new ChatError('Workspace not found', 'WORKSPACE_NOT_FOUND', 404);
    }
    if (localSession && localSession.workspaceId !== workspaceId) {
      throw new ChatError('Session not found', 'SESSION_NOT_FOUND', 404);
    }
    // Deletion is terminal even when the runtime still exists. closeRuntime
    // deterministically drains runtime-owned browser API state first.
    await this.closeRuntime(id);
    if (localSession && localSession.isDraft) {
      sessionCapabilityService.revokeForSession(id);
      return workspaceStore.deleteLocalSession(id);
    }

    try {
      // Import deleteSession from SDK
      const { deleteSession } = await import('@anthropic-ai/claude-agent-sdk');
      await deleteSession(id, { dir: workspace.folderPath });
    } catch (err) {
      console.error('Failed to delete SDK session:', err);
      // Still delete from local DB even if SDK deletion fails
    }

    // U12: the session's loopback capability dies with the session.
    const revokedOnDelete = sessionCapabilityService.revokeForSession(id);
    // U6 (KTD-22): token lifecycle audit (before the row disappears).
    if (revokedOnDelete > 0) {
      const botId = workspaceStore.getLocalSession(id)?.botId;
      if (botId) {
        botAuditLogger.logCapabilityTokenRevoked(botId, { type: 'system' }, {
          sessionId: id,
          revokedCount: revokedOnDelete,
          reason: 'session-delete',
        });
      }
    }
    return workspaceStore.deleteLocalSession(id);
  }

  async forkSession(id: string, workspaceId: string): Promise<{ sessionId: string }> {
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) {
      throw new ChatError('Workspace not found', 'WORKSPACE_NOT_FOUND', 404);
    }

    const result = await this.sdkClient.forkSession(id, { dir: normalizeWindowsPath(workspace.folderPath) });
    return result;
  }

  async clearDraftFlag(id: string): Promise<boolean> {
    return workspaceStore.clearDraftFlag(id);
  }

  // Message history loading

  async loadWorkflowsForSession(sessionId: string, workspaceId: string): Promise<WorkflowState[]> {
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) {
      return [];
    }

    const runIds = await listWorkflowRunIds(workspace.folderPath, sessionId);
    const workflows: WorkflowState[] = [];
    for (const runId of runIds) {
      const state = await loadWorkflowState({
        folderPath: workspace.folderPath,
        sessionId,
        runId,
      });
      if (state) {
        workflows.push(state);
      }
    }
    return workflows;
  }

  /** opencode REST read honoring the test hook (review P1 fixes). */
  private ocFetch(
    instance: Parameters<typeof opencodeFetch>[0],
    path: string,
    init?: Parameters<typeof opencodeFetch>[2],
  ) {
    return (opencodeFetchForTesting ?? opencodeFetch)(instance, path, init);
  }

  /** Shared serve lookup/spawn for opencode history + subagent loading. */
  private async ensureOpencodeServe(
    comateSessionId: string,
    workspace: Workspace,
  ) {
    const existing = opencodeServerManager.getInstance(comateSessionId);
    if (existing) return existing;
    const localSession = workspaceStore.getLocalSession(comateSessionId);
    const provider = localSession?.providerId
      ? workspaceStore.getProvider(localSession.providerId)
      : workspaceStore.getDefaultProvider();
    if (!provider) return undefined;
    return opencodeServerManager.ensureServer(comateSessionId, workspace.folderPath, {
      config: { ...buildServeConfig(provider, provider.model ?? ''), mcp: {} },
      env: process.env,
    });
  }

  /**
   * opencode history loading (review P1): fetch the backend session's REST
   * message history from its serve and translate to claude-shaped
   * SessionMessage. Spawns a serve for a closed session when none is live.
   */
  private async loadOpencodeSessionMessages(
    comateSessionId: string,
    backendSessionId: string,
    workspace: Workspace,
  ): Promise<SessionMessage[]> {
    const instance = await this.ensureOpencodeServe(comateSessionId, workspace);
    if (!instance) return [];
    const messages = (await (
      await this.ocFetch(instance, `/session/${backendSessionId}/message`)
    ).json()) as OpencodeRestMessage[];
    return opencodeMessagesToSessionMessages(messages);
  }

  /**
   * opencode subagent loading (U7): children of the backend session on the
   * session's serve, translated from opencode REST history into claude-shaped
   * SessionMessage and reconstructed through the same panel path. Spawns a
   * serve for historical viewing when none is live.
   */
  private async loadOpencodeSubagents(
    comateSessionId: string,
    backendSessionId: string,
    workspace: Workspace,
  ): Promise<SubagentState[]> {
    const instance = await this.ensureOpencodeServe(comateSessionId, workspace);
    if (!instance) return [];

    const children = (await (
      await this.ocFetch(instance, `/session/${backendSessionId}/children`)
    ).json()) as Array<{ id: string; title?: string }>;
    if (children.length === 0) return [];

    const parentMessages = (await (
      await this.ocFetch(instance, `/session/${backendSessionId}/message`)
    ).json()) as OpencodeRestMessage[];
    const pairings = pairTaskToolCallsWithChildren(parentMessages, children.length);

    // Fetch child transcripts concurrently; a single failure never blocks the rest.
    const subagents: SubagentState[] = [];
    await Promise.all(
      children.map(async (child, index) => {
        try {
          const childMessages = (await (
            await this.ocFetch(instance, `/session/${child.id}/message`)
          ).json()) as OpencodeRestMessage[];
          const subMessages = opencodeMessagesToSessionMessages(childMessages);
          const pairing = pairings[index];
          const reconstructed = reconstructSubagentState(
            pairing?.parentToolUseId ?? child.id,
            subMessages,
            pairing?.description ?? child.title ?? `Agent ${child.id.slice(-6)}`,
            {},
          );
          if (reconstructed) {
            subagents.push(reconstructed);
          }
        } catch (err) {
          console.error(`Failed to load opencode subagent ${child.id}:`, err);
        }
      }),
    );
    return subagents;
  }

  /**
   * Slash commands advertised by an opencode session's serve (U7). Empty
   * when no serve is live for the session (rather than claude-flavored
   * builtins, which differ between runtimes).
   */
  async getSessionBackendCommands(sessionId: string): Promise<SlashCommandDto[]> {
    const instance = opencodeServerManager.getInstance(sessionId);
    if (!instance) return [];
    const res = await opencodeFetch(instance, '/command');
    if (!res.ok) return [];
    const commands = (await res.json()) as Array<{
      name: string;
      description?: string;
      template?: string;
    }>;
    return commands.map((command) => ({
      name: command.name,
      description: command.description ?? '',
      argumentHint: command.template?.includes('$ARGUMENTS') ? 'arguments' : undefined,
    }));
  }

  async loadSubagentsForSession(
    sessionId: string,
    workspaceId: string,
    mainSdkMessages: SessionMessage[] = [],
  ): Promise<SubagentState[]> {
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) {
      return [];
    }

    const dir = normalizeWindowsPath(workspace.folderPath);

    // Backend-aware loading (U7): opencode subagents are child sessions on
    // the session's serve, translated into the same SubagentState shape.
    const localSession = workspaceStore.getLocalSession(sessionId);
    if (localSession?.backend === 'opencode' && localSession.backendSessionId) {
      return this.loadOpencodeSubagents(sessionId, localSession.backendSessionId, workspace);
    }

    let agentIds: string[] = [];
    try {
      agentIds = await this.sdkClient.listSubagents(sessionId, { dir });
    } catch (err) {
      console.error(`Failed to list subagents for ${sessionId}:`, err);
      return [];
    }

    if (agentIds.length === 0) {
      return [];
    }

    // Workflow subagents live under subagents/workflows/<runId>/ and are loaded
    // by workflow-loader with synthetic parentToolUseIds. Skip them here so they
    // are not treated as orphaned top-level subagents.
    const workflowAgentIds = await listWorkflowAgentIds(workspace.folderPath, sessionId);
    const filteredAgentIds = agentIds.filter((id) => !workflowAgentIds.has(id));
    const parentToolUseIdByAgentId = new Map<string, string>();
    const descriptionByToolUseId = new Map<string, string>();
    const toolUseIndexByToolUseId = new Map<string, number>();
    const toolResultIndexByToolUseId = new Map<string, number>();
    const now = Date.now();

    // Pre-scan the main transcript for Agent tool_use blocks to learn the
    // parent toolUseId, the human-readable description, and the message index
    // so we can approximate startTime when the SDK omits timestamps.
    for (const [msgIdx, msg] of mainSdkMessages.entries()) {
      if (msg.type !== 'assistant') continue;
      const raw = msg.message as { content?: unknown } | undefined;
      const content = raw?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const typed = block as { type?: unknown; name?: unknown; id?: unknown; input?: unknown };
        if (typed.type === 'tool_use' && typed.name === 'Agent') {
          const toolUseId = typeof typed.id === 'string' ? typed.id : '';
          const input = typed.input as Record<string, unknown> | undefined;
          const desc = typeof input?.description === 'string' ? input.description : '';
          if (toolUseId) {
            descriptionByToolUseId.set(toolUseId, desc);
            toolUseIndexByToolUseId.set(toolUseId, msgIdx);
          }
        }
      }
    }

    // Try the SDK's subagent meta file for the parent toolUseId mapping.
    const transcriptDir = resolveTranscriptDir(workspace.folderPath);
    for (const agentId of filteredAgentIds) {
      if (parentToolUseIdByAgentId.has(agentId)) continue;
      const metaPath = transcriptDir
        ? path.join(transcriptDir, sessionId, 'subagents', `agent-${agentId}.meta.json`)
        : null;
      if (metaPath && existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
            toolUseId?: unknown;
            description?: unknown;
          };
          if (typeof meta.toolUseId === 'string') {
            parentToolUseIdByAgentId.set(agentId, meta.toolUseId);
            if (typeof meta.description === 'string' && meta.description) {
              descriptionByToolUseId.set(meta.toolUseId, meta.description);
            }
          }
        } catch (err) {
          console.error(`Failed to parse subagent meta for ${agentId}:`, err);
        }
      }
    }

    // Fallback: scan main transcript tool_result blocks that mention the agentId.
    for (const agentId of filteredAgentIds) {
      if (parentToolUseIdByAgentId.has(agentId)) continue;
      for (const [msgIdx, msg] of mainSdkMessages.entries()) {
        if (msg.type !== 'user') continue;
        const raw = msg.message as { content?: unknown } | undefined;
        const content = raw?.content;
        const haystack = JSON.stringify(content ?? '');
        if (!haystack.includes(agentId)) continue;
        const arr = Array.isArray(content) ? content : [];
        for (const block of arr) {
          if (!block || typeof block !== 'object') continue;
          const typed = block as { type?: unknown; tool_use_id?: unknown };
          if (typed.type === 'tool_result') {
            const toolUseId = typeof typed.tool_use_id === 'string' ? typed.tool_use_id : '';
            if (toolUseId) {
              parentToolUseIdByAgentId.set(agentId, toolUseId);
              toolResultIndexByToolUseId.set(toolUseId, msgIdx);
              const toolUseResult = (msg as Record<string, unknown>).toolUseResult as
                | Record<string, unknown>
                | undefined;
              if (typeof toolUseResult?.description === 'string') {
                descriptionByToolUseId.set(toolUseId, toolUseResult.description);
              }
            }
          }
        }
        break;
      }
    }

    // Capture tool_result indexes for subagents that were mapped via meta or the
    // first scan, so completed subagents can get an approximate endTime.
    for (const [msgIdx, msg] of mainSdkMessages.entries()) {
      if (msg.type !== 'user') continue;
      const raw = msg.message as { content?: unknown } | undefined;
      const content = raw?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const typed = block as { type?: unknown; tool_use_id?: unknown };
        if (typed.type === 'tool_result' && typeof typed.tool_use_id === 'string') {
          toolResultIndexByToolUseId.set(typed.tool_use_id, msgIdx);
        }
      }
    }

    const subagents: SubagentState[] = [];
    for (const agentId of filteredAgentIds) {
      const parentToolUseId = parentToolUseIdByAgentId.get(agentId);
      if (!parentToolUseId) {
        console.warn(`Could not map subagent ${agentId} to a parent toolUseId`);
        continue;
      }

      try {
        const subMessages = await this.sdkClient.getSubagentMessages(sessionId, agentId, { dir });
        const description = descriptionByToolUseId.get(parentToolUseId) || `Agent ${agentId}`;
        const toolUseIdx = toolUseIndexByToolUseId.get(parentToolUseId);
        const toolResultIdx = toolResultIndexByToolUseId.get(parentToolUseId);
        const fallbackStartTime =
          toolUseIdx !== undefined
            ? now - (mainSdkMessages.length - toolUseIdx) * 1000
            : undefined;
        const fallbackEndTime =
          toolResultIdx !== undefined
            ? now - (mainSdkMessages.length - toolResultIdx) * 1000
            : undefined;
        const reconstructed = reconstructSubagentState(parentToolUseId, subMessages, description, {
          fallbackStartTime,
          fallbackEndTime,
        });
        if (reconstructed) {
          subagents.push(reconstructed);
        }
      } catch (err) {
        console.error(`Failed to load subagent ${agentId} for ${sessionId}:`, err);
      }
    }

    return subagents;
  }

  async loadMessages(
    sessionId: string,
    workspaceId: string,
  ): Promise<{ messages: ChatMessage[]; tasks: TaskItem[]; subagents: SubagentState[]; workflows: WorkflowState[]; total: number }> {
    const startedAt = Date.now();
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) {
      throw new ChatError('Workspace not found', 'WORKSPACE_NOT_FOUND', 404);
    }

    const options: import('@anthropic-ai/claude-agent-sdk').GetSessionMessagesOptions = {
      dir: normalizeWindowsPath(workspace.folderPath),
    };
    const sdkLoadStartedAt = Date.now();

    // Backend-aware history (review P1): opencode sessions load from their
    // serve's REST history and translate into the same SessionMessage shape —
    // asking the claude SDK for them always returned empty and lost history on
    // refresh.
    const localSession = workspaceStore.getLocalSession(sessionId);
    let sdkMessages: SessionMessage[];
    if (localSession?.backend === 'opencode' && localSession.backendSessionId) {
      sdkMessages = await this.loadOpencodeSessionMessages(
        sessionId,
        localSession.backendSessionId,
        workspace,
      );
    } else {
      sdkMessages = await this.sdkClient.getSessionMessages(sessionId, options);
    }
    const sdkLoadMs = Date.now() - sdkLoadStartedAt;

    // If we successfully loaded messages from SDK, the session is real — sync it
    if (sdkMessages.length > 0 && localSession?.backend !== 'opencode') {
      try {
        const sdkSession = await this.sdkClient.getSessionInfo(sessionId, { dir: workspace.folderPath });
        if (sdkSession) {
          const session = this.mapSdkSessionInfo(sdkSession, workspaceId);
          workspaceStore.syncSdkSession(session);
        }
      } catch {
        // Ignore sync errors
      }
    }

    const normalizeStartedAt = Date.now();
    const normalized: ChatMessage[] = [];
    const timestampBase = this.historyTimestampBases.get(sessionId) ??
      Date.now() - sdkMessages.length * 1000;
    this.historyTimestampBases.set(sessionId, timestampBase);
    sdkMessages.forEach((msg: SessionMessage, index: number) => {
      const chatMessage = normalizeSessionMessage(msg);
      if (chatMessage) {
        // Approximate ordering by index — SDK does not surface a per-message
        // timestamp on the historical read path. U7 verifies ordering matches
        // the JSONL transcript order.
        chatMessage.timestamp = timestampBase + index * 1000;
        normalized.push(chatMessage);
      }
    });
    const normalizeMs = Date.now() - normalizeStartedAt;
    const total = normalized.length;
    const derivedStateStartedAt = Date.now();
    const tasks = scanSdkMessagesForTasks(sdkMessages);
    const subagents = await this.loadSubagentsForSession(sessionId, workspaceId, sdkMessages);
    const workflows = await this.loadWorkflowsForSession(sessionId, workspaceId);
    diagLog('[chat-history] complete load', {
      sessionId,
      workspaceId,
      sdkMessageCount: sdkMessages.length,
      normalizedMessageCount: total,
      sdkLoadMs,
      normalizeMs,
      derivedStateMs: Date.now() - derivedStateStartedAt,
      totalMs: Date.now() - startedAt,
    });
    return { messages: normalized, tasks, subagents, workflows, total };
  }

  async loadMessagesAfter(
    sessionId: string,
    workspaceId: string,
    afterMessageId?: string,
  ): Promise<{ messages: ChatMessage[]; tasks: TaskItem[]; subagents: SubagentState[]; workflows: WorkflowState[] }> {
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) {
      throw new ChatError('Workspace not found', 'WORKSPACE_NOT_FOUND', 404);
    }

    const options: import('@anthropic-ai/claude-agent-sdk').GetSessionMessagesOptions = {
      dir: normalizeWindowsPath(workspace.folderPath),
    };

    const sdkMessages = await this.sdkClient.getSessionMessages(sessionId, options);

    let sliceStart = 0;
    if (afterMessageId) {
      const idx = sdkMessages.findIndex((msg: SessionMessage) => msg.uuid === afterMessageId);
      if (idx >= 0) {
        sliceStart = idx + 1;
      }
    }

    const sliced = sdkMessages.slice(sliceStart);

    const normalized: ChatMessage[] = [];
    const timestampBase = this.historyTimestampBases.get(sessionId) ??
      Date.now() - sdkMessages.length * 1000;
    this.historyTimestampBases.set(sessionId, timestampBase);
    sliced.forEach((msg: SessionMessage, index: number) => {
      const chatMessage = normalizeSessionMessage(msg);
      if (chatMessage) {
        chatMessage.timestamp = timestampBase + (sliceStart + index) * 1000;
        normalized.push(chatMessage);
      }
    });
    const tasks = scanSdkMessagesForTasks(sliced);
    const subagents = await this.loadSubagentsForSession(sessionId, workspaceId, sdkMessages);
    const workflows = await this.loadWorkflowsForSession(sessionId, workspaceId);
    return { messages: normalized, tasks, subagents, workflows };
  }

  // Session runtime management

  /**
   * Resolve the agent backend for a session (KTD-5/KTD-9). A locked session
   * reuses its stored backend; a draft resolves now, and the result is
   * persisted only after the runtime actually starts (review P2 — persisting
   * on a failed first attempt cemented a failed lock). Bot sessions always
   * resolve to claude regardless of the app default (R14).
   */
  private async resolveSessionBackend(
    session: ChatSession,
    isBotSession?: boolean,
  ): Promise<BackendId> {
    if (session.backend) {
      return session.backend as BackendId;
    }
    return isBotSession ? 'claude' : (await resolveDefaultBackend()).backend;
  }

  async getOrCreateRuntime(
    sessionId: string,
    workspaceId: string,
    isBotSession?: boolean,
    botEventHandler?: (id: number, event: import('../types/message.js').SseEvent) => void,
    botUserId?: string,
  ): Promise<SessionRuntime> {
    const runtimeContext: RuntimeContext = { workspaceId, isBotSession, botUserId };
    const existing = this.runtimes.get(sessionId);
    if (existing && !existing.isClosed()) {
      this.cancelIdleClose(sessionId);
      if (botEventHandler) {
        existing.clearBotEventHandlers();
        existing.addBotEventHandler(botEventHandler);
      }
      this.runtimeContexts.set(sessionId, runtimeContext);
      sidecarLog(`[ChatService] reusing existing runtime ${sessionId}`);
      return existing;
    }
    if (existing) {
      // Clean up a dead runtime
      this.runtimes.delete(sessionId);
    }

    const pending = this.creatingRuntimes.get(sessionId);
    if (pending) {
      diagLog(`[ChatService] awaiting pending runtime creation ${sessionId}`);
      const runtime = await pending;
      if (botEventHandler) {
        runtime.clearBotEventHandlers();
        runtime.addBotEventHandler(botEventHandler);
      }
      this.runtimeContexts.set(sessionId, runtimeContext);
      return runtime;
    }

    const promise = (async () => {
      const startedAt = Date.now();
      diagLog(`[ChatService] creating runtime ${sessionId} workspaceId=${workspaceId} isBotSession=${!!isBotSession}`);

      const workspace = await workspaceStore.get(workspaceId);
      if (!workspace) {
        throw new ChatError('Workspace not found', 'WORKSPACE_NOT_FOUND', 404);
      }

      const session = await this.getSession(sessionId, workspaceId);
      if (!session) {
        throw new ChatError('Session not found', 'SESSION_NOT_FOUND', 404);
      }
      diagLog(`[ChatService] runtime ${sessionId} session loaded elapsed=${Date.now() - startedAt}ms isDraft=${!!session.isDraft}`);

      const backend = await this.resolveSessionBackend(session, isBotSession);
      if (backend === 'opencode') {
        const availability = await getBackendAvailability(backend);
        if (availability.status !== 'available') {
          throw new ChatError(
            `Agent backend 'opencode' is not available${availability.reason ? `: ${availability.reason}` : ''}`,
            'BACKEND_UNAVAILABLE',
            409,
          );
        }
      } else if (backend !== 'claude') {
        throw new ChatError(`Unknown agent backend '${backend}'`, 'BACKEND_UNAVAILABLE', 409);
      }

      // Verify non-draft sessions actually exist in SDK before resuming.
      // If the SDK has lost track of the session, fall back to sessionId mode
      // so the conversation can be recreated rather than failing with
      // "No conversation found with session ID".
      if (!session.isDraft && backend === 'claude') {
        try {
          const verifyStart = Date.now();
          diagLog(`[ChatService] runtime ${sessionId} verifying session in SDK`);
          let verifyTimeout: ReturnType<typeof setTimeout> | undefined;
          const sdkSession = await Promise.race([
            this.sdkClient
              .getSessionInfo(sessionId, { dir: workspace.folderPath })
              .finally(() => {
                if (verifyTimeout) clearTimeout(verifyTimeout);
              }),
            new Promise<never>((_, reject) => {
              verifyTimeout = setTimeout(
                () => reject(new SessionVerifyTimeoutError()),
                SESSION_VERIFY_TIMEOUT_MS,
              );
            }),
          ]);
          diagLog(`[ChatService] runtime ${sessionId} getSessionInfo elapsed=${Date.now() - verifyStart}ms found=${!!sdkSession}`);
          if (!sdkSession) {
            sidecarLog(`[ChatService] Session ${sessionId} not found in SDK, falling back to draft mode`);
            workspaceStore.setSessionDraft(sessionId, true);
            session.isDraft = true;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sidecarLog(`[ChatService] Failed to verify session ${sessionId} in SDK: ${message}`);
          // Only treat a hang as fatal. Other SDK errors are transient; fall
          // through and let the runtime start attempt fail later with a clearer
          // error instead of blocking the subscribe request forever.
          if (err instanceof SessionVerifyTimeoutError) {
            throw new ChatError(
              `Failed to verify session with Claude Code: ${message}`,
              'SESSION_VERIFY_FAILED',
              500,
            );
          }
        }
      }

      const optionsStart = Date.now();
      const provider = session.providerId
        ? workspaceStore.getProvider(session.providerId)
        : workspaceStore.getDefaultProvider();

      if (!provider) {
        throw new ChatError(
          'No LLM provider configured. Add a provider in Settings.',
          'PROVIDER_NOT_FOUND',
          500,
        );
      }

      // U3 (KTD-24): spawn probe for sandboxed bot sessions. The probe's
      // negative assertions decide the failIfUnavailable pin and the gate's
      // degraded role-routing; it is cached process-wide with a short TTL so
      // only the first runtime creation in a window pays the spawn cost.
      if (isBotSession && session.botId && workspace.settings.botPermissionSandboxDisabled !== true) {
        await ensureSandboxProbe();
      }

      const options = this.buildSdkOptions(workspace, session, isBotSession, botUserId, provider);
      if (session.source === 'scheduled' && backend === 'claude') {
        // U4 (KTD-3, path B): scheduled runs get the completion evaluator —
        // a programmatic Stop hook that continues the session until the goal
        // prompt's status marker appears or the turn cap hits.
        options.hooks = {
          ...options.hooks,
          Stop: [...(options.hooks?.Stop ?? []), { hooks: [makeScheduledRunStopHook(session.id)] }],
        };
      }
      diagLog(`[ChatService] runtime ${sessionId} buildSdkOptions elapsed=${Date.now() - optionsStart}ms pathToClaudeCodeExecutable=${options.pathToClaudeCodeExecutable || 'undefined'}`);

      const testStart = Date.now();
      if (backend === 'claude') {
        await this.testClaudeBinary(options.pathToClaudeCodeExecutable, normalizeWindowsPath(workspace.folderPath), options.env || process.env);
        diagLog(`[ChatService] runtime ${sessionId} testClaudeBinary elapsed=${Date.now() - testStart}ms`);
      }

      const driver =
        backend === 'opencode'
          ? new OpencodeBackendDriver({
              directory: normalizeWindowsPath(workspace.folderPath),
              comateSessionId: sessionId,
              backendSessionId: session.backendSessionId,
              provider,
              env: (options.env ?? process.env) as NodeJS.ProcessEnv,
              onBackendSessionId: (backendSessionId) =>
                workspaceStore.updateSessionBackendSessionId(sessionId, backendSessionId),
            })
          : undefined;

      diagLog(`[ChatService] runtime ${sessionId} calling SessionRuntime.open`);
      const openStart = Date.now();
      const runtime = SessionRuntime.open(
        sessionId,
        workspaceId,
        this.serverNonce,
        options,
        this.sdkClient,
        botEventHandler,
        () => this.reconcileIdleClose(sessionId),
        () => this.reconcileIdleClose(sessionId),
        () => this.reconcileIdleClose(sessionId),
        provider,
        driver,
      );
      diagLog(`[ChatService] runtime ${sessionId} SessionRuntime.open elapsed=${Date.now() - openStart}ms`);
      this.runtimes.set(sessionId, runtime);
      this.runtimeContexts.set(sessionId, runtimeContext);
      this.reconcileIdleClose(sessionId);

      // Set initial approval mode from session data
      if (!isBotSession && session.approvalMode) {
        runtime.setApprovalMode(session.approvalMode);
      }

      return runtime;
    })();

    this.creatingRuntimes.set(sessionId, promise);
    try {
      return await promise;
    } finally {
      this.creatingRuntimes.delete(sessionId);
      // A failed creation never registered a runtime, so closeRuntime
      // early-returns and would never clear the bot-gate bookkeeping
      // (sessionSpawnRoles is set inside buildSdkOptions) — drop it here.
      if (!this.runtimes.has(sessionId)) {
        this.sessionSpawnRoles.delete(sessionId);
        this.demotionRebuilds.delete(sessionId);
        this.sessionOverrideDenies.delete(sessionId);
        this.sessionMcpToolAnnotations.delete(sessionId);
      }
    }
  }

  async closeRuntime(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    // Runtime replacement is terminal for capture drains, opaque auth handles,
    // and exact-operation approvals. The browser process/page may stay alive.
    this.disposeBrowserTaskState(sessionId);
    if (!runtime) return;
    this.clearPendingRebuild(sessionId);
    this.runtimeContexts.delete(sessionId);
    this.sessionSpawnRoles.delete(sessionId);
    this.demotionRebuilds.delete(sessionId);
    this.sessionOverrideDenies.delete(sessionId);
    this.sessionMcpToolAnnotations.delete(sessionId);
    this.cancelIdleClose(sessionId);
    this.runtimes.delete(sessionId);
    sidecarLog(`[ChatService] closing runtime ${sessionId}`);
    // U12: the session's loopback capability dies with its runtime (the
    // rebuild path immediately re-mints in buildSdkOptions = rotation).
    const revoked = sessionCapabilityService.revokeForSession(sessionId);
    // U6 (KTD-22): token lifecycle audit. Rotation (rebuild) re-mints
    // immediately, so a close-revoke followed by a mint reads as rotation.
    if (revoked > 0) {
      const botId = workspaceStore.getLocalSession(sessionId)?.botId;
      if (botId) {
        botAuditLogger.logCapabilityTokenRevoked(botId, { type: 'system' }, {
          sessionId,
          revokedCount: revoked,
          reason: 'session-close',
        });
      }
    }
    // Pre-close chained listeners (KTD-5): run BEFORE close() resolves the
    // session's pending cards, so listeners can classify their own pendings
    // (the browser handoff controller marks its cards runtime_closed here).
    for (const listener of this.runtimeClosingListeners) {
      try {
        listener(sessionId);
      } catch (err) {
        diagLog(`[ChatService] runtime-closing listener threw for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await runtime.close();
    this.onRuntimeClose?.(sessionId);
  }

  private disposeBrowserTaskState(sessionId: string): void {
    disposeBrowserToolContext(sessionId);
    browserService.disposeAuthBindings(sessionId);
    browserApiBrokerService.revokeTask(sessionId);
  }

  getRuntimeIfExists(sessionId: string): SessionRuntime | undefined {
    const runtime = this.runtimes.get(sessionId);
    if (runtime && !runtime.isClosed()) return runtime;
    return undefined;
  }

  scheduleRuntimeRebuild(sessionId: string, context?: RuntimeContext, options?: { immediate?: boolean }): Promise<void> | undefined {
    const runtime = this.getRuntimeIfExists(sessionId);
    if (!runtime) return undefined;
    const ctx = context ?? this.runtimeContexts.get(sessionId);
    if (!ctx) return undefined;

    this.pendingRebuilds.set(sessionId, ctx);
    if (!options?.immediate && runtime.isProcessingTurn()) {
      this.startRebuildPoller(sessionId);
      return undefined;
    }
    return this.performRebuild(sessionId, ctx);
  }

  /**
   * KTD-11: a role demotion bypasses the in-turn rebuild deferral — the
   * spawn-frozen (wider) sandbox and rule set must not survive the demotion.
   * Forces an immediate rebuild; the gate denies identity-sensitive tools
   * with the policy-rebuilding routing class until the rebuilt runtime's
   * spawn role matches. Promotions stay lazy (the caller never reaches this
   * path). Deduped per session while a demotion rebuild is in flight.
   */
  private triggerDemotionRebuild(sessionId: string): void {
    if (this.demotionRebuilds.has(sessionId)) return;
    const ctx = this.runtimeContexts.get(sessionId);
    if (!ctx) return;
    this.demotionRebuilds.add(sessionId);
    diagLog(`[ChatService] role demotion detected for session=${sessionId}; forcing immediate runtime rebuild (KTD-11)`);
    const rebuild = this.scheduleRuntimeRebuild(sessionId, ctx, { immediate: true });
    if (rebuild) {
      void rebuild.finally(() => {
        this.demotionRebuilds.delete(sessionId);
      });
    } else {
      this.demotionRebuilds.delete(sessionId);
    }
  }

  /**
   * U9 (KTD-20): per-session MCP tool annotations, fetched lazily from the
   * SDK control channel on the first MCP-tool gate call and cached for the
   * runtime's lifetime. Fail-soft: any error resolves to an empty map —
   * missing annotations classify as unknown (fail-closed ask), never allow.
   * The `?.` chain tolerates partial runtime test doubles that do not
   * implement the annotation channel (same contract as
   * consumeResolutionProvenance).
   */
  private getSessionMcpToolAnnotations(sessionId: string): Promise<McpToolAnnotationMap> {
    let cached = this.sessionMcpToolAnnotations.get(sessionId);
    if (!cached) {
      const runtime = this.runtimes.get(sessionId);
      const empty: McpToolAnnotationMap = new Map<string, McpToolAnnotations>();
      cached = (runtime?.getMcpToolAnnotations?.() ?? Promise.resolve(empty)).catch((err) => {
        diagLog(
          `[ChatService] session=${sessionId} MCP annotation fetch failed: ${err instanceof Error ? err.message : String(err)} — MCP tools classify unknown`,
        );
        return new Map<string, McpToolAnnotations>();
      });
      this.sessionMcpToolAnnotations.set(sessionId, cached);
    }
    return cached;
  }

  scheduleRebuildsForBot(botId: string): void {
    let count = 0;
    for (const [sessionId, context] of this.runtimeContexts.entries()) {
      try {
        const session = workspaceStore.getLocalSession(sessionId);
        if (session && session.botId === botId) {
          this.scheduleRuntimeRebuild(sessionId, context);
          count++;
        }
      } catch {
        // ignore stale sessions
      }
    }
    if (count > 0) {
      sidecarLog(`[ChatService] scheduled ${count} runtime rebuilds for bot ${botId}`);
    }
  }

  scheduleRebuildsForProvider(providerId: string): void {
    let count = 0;
    for (const [sessionId, context] of this.runtimeContexts.entries()) {
      try {
        const session = workspaceStore.getLocalSession(sessionId);
        if (session && session.providerId === providerId) {
          this.scheduleRuntimeRebuild(sessionId, context);
          count++;
        }
      } catch {
        // ignore stale sessions
      }
    }
    if (count > 0) {
      sidecarLog(`[ChatService] scheduled ${count} runtime rebuilds for provider ${providerId}`);
    }
  }

  scheduleRebuildsForWorkspaceLegacyPolicy(workspaceId: string): void {
    let count = 0;
    for (const [sessionId, context] of this.runtimeContexts.entries()) {
      if (context.workspaceId !== workspaceId || !context.isBotSession) continue;
      try {
        const session = workspaceStore.getLocalSession(sessionId);
        if (session && !session.botId) {
          this.scheduleRuntimeRebuild(sessionId, context);
          count++;
        }
      } catch {
        // ignore stale sessions
      }
    }
    if (count > 0) {
      sidecarLog(`[ChatService] scheduled ${count} legacy-policy runtime rebuilds for workspace ${workspaceId}`);
    }
  }

  /**
   * Rebuild every live bot runtime in a workspace (U3): used when the
   * permission-model kill switch (`botPermissionSandboxDisabled`) toggles —
   * the gate, sandbox, and settingSources pin all change shape, so live
   * runtimes must not keep the previous model's frozen configuration.
   */
  scheduleRebuildsForWorkspaceBotSessions(workspaceId: string): void {
    let count = 0;
    for (const [sessionId, context] of this.runtimeContexts.entries()) {
      if (context.workspaceId !== workspaceId || !context.isBotSession) continue;
      this.scheduleRuntimeRebuild(sessionId, context);
      count++;
    }
    if (count > 0) {
      sidecarLog(`[ChatService] scheduled ${count} bot runtime rebuilds for workspace ${workspaceId} (permission model toggle)`);
    }
  }

  private startRebuildPoller(sessionId: string): void {
    if (this.rebuildPollers.has(sessionId)) return;
    const interval = setInterval(() => {
      const runtime = this.getRuntimeIfExists(sessionId);
      if (!runtime || runtime.isClosed() || !runtime.isProcessingTurn()) {
        const ctx = this.pendingRebuilds.get(sessionId);
        if (ctx && runtime && !runtime.isClosed()) {
          this.performRebuild(sessionId, ctx);
        } else {
          this.clearPendingRebuild(sessionId);
        }
      }
    }, REBUILD_POLL_INTERVAL_MS);
    this.rebuildPollers.set(sessionId, interval);
  }

  private async performRebuild(sessionId: string, context: RuntimeContext): Promise<void> {
    this.clearPendingRebuild(sessionId);
    try {
      sidecarLog(`[ChatService] rebuilding runtime ${sessionId}`);
      await this.closeRuntime(sessionId);
    } catch (err) {
      sidecarLog(
        `[ChatService] failed to close runtime ${sessionId} during rebuild: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      await this.getOrCreateRuntime(sessionId, context.workspaceId, context.isBotSession, undefined, context.botUserId);
    } catch (err) {
      sidecarLog(
        `[ChatService] failed to pre-create runtime ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private clearPendingRebuild(sessionId: string): void {
    this.pendingRebuilds.delete(sessionId);
    const poller = this.rebuildPollers.get(sessionId);
    if (poller) {
      clearInterval(poller);
      this.rebuildPollers.delete(sessionId);
    }
  }

  private scheduleIdleClose(sessionId: string): void {
    if (this.idleTimeouts.has(sessionId)) return;
    const scheduledRuntime = this.runtimes.get(sessionId);
    if (!scheduledRuntime) return;
    const timeout = setTimeout(() => {
      this.idleTimeouts.delete(sessionId);
      const runtime = this.runtimes.get(sessionId);
      if (
        runtime !== scheduledRuntime ||
        runtime.isClosed() ||
        this.runtimeActivity(runtime).active ||
        this.runtimeHasSubscribers(runtime)
      ) {
        sidecarLog(`[ChatService] idle close skipped for ${sessionId}: runtime retained`);
        return;
      }
      sidecarLog(`[ChatService] idle close fired for ${sessionId}`);
      this.closeRuntime(sessionId).catch((err) => {
        console.error(`Failed to idle-close runtime ${sessionId}:`, err);
      });
    }, RUNTIME_IDLE_GRACE_PERIOD_MS);
    this.idleTimeouts.set(sessionId, timeout);
    sidecarLog(`[ChatService] idle close scheduled for ${sessionId} (${RUNTIME_IDLE_GRACE_PERIOD_MS}ms)`);
  }

  private reconcileIdleClose(sessionId: string): void {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime || runtime.isClosed()) {
      this.cancelIdleClose(sessionId);
      return;
    }
    if (this.runtimeActivity(runtime).active || this.runtimeHasSubscribers(runtime)) {
      this.cancelIdleClose(sessionId);
      return;
    }
    this.scheduleIdleClose(sessionId);
  }

  private runtimeActivity(runtime: SessionRuntime): SessionActivitySnapshot {
    const activity = (runtime as SessionRuntime & {
      getActivitySnapshot?: () => SessionActivitySnapshot;
    }).getActivitySnapshot?.();
    if (activity) return activity;
    const isProcessing = (runtime as SessionRuntime & {
      isProcessingTurn?: () => boolean;
    }).isProcessingTurn?.() ?? false;
    return {
      phase: isProcessing ? 'foreground' : 'idle',
      active: isProcessing,
      backgroundTasks: [],
    };
  }

  private runtimeHasSubscribers(runtime: SessionRuntime): boolean {
    return (runtime as SessionRuntime & { hasSubscribers?: () => boolean }).hasSubscribers?.() ?? false;
  }

  private cancelIdleClose(sessionId: string): void {
    const timeout = this.idleTimeouts.get(sessionId);
    if (timeout) {
      clearTimeout(timeout);
      this.idleTimeouts.delete(sessionId);
      sidecarLog(`[ChatService] idle close cancelled for ${sessionId}`);
    }
  }

  async closeAllRuntimes(): Promise<void> {
    const entries = Array.from(this.runtimes.entries());
    if (entries.length === 0) return;
    sidecarLog(`[ChatService] closing ${entries.length} runtimes on shutdown`);
    for (const [sessionId] of entries) {
      this.cancelIdleClose(sessionId);
    }
    await Promise.all(
      entries.map(async ([sessionId, runtime]) => {
        try {
          await runtime.close();
        } catch (err) {
          console.error(`Failed to close runtime ${sessionId} during shutdown:`, err);
        }
      }),
    );
    this.runtimes.clear();
    this.idleTimeouts.clear();
  }

  /**
   * Close all cached runtimes belonging to a workspace. Called when the workspace
   * is deleted so that idle bot runtimes do not keep answering inbound messages
   * against a workspace whose settings row is gone.
   */
  async closeRuntimesForWorkspace(workspaceId: string): Promise<void> {
    const targets: string[] = [];
    for (const [sessionId, runtime] of this.runtimes.entries()) {
      try {
        if (runtime.getStatus().workspaceId === workspaceId) {
          targets.push(sessionId);
        }
      } catch {
        // ignore — getStatus can throw on closed runtimes; not relevant here
      }
    }
    if (targets.length === 0) return;
    sidecarLog(`[ChatService] closing ${targets.length} runtimes for deleted workspace ${workspaceId}`);
    await Promise.all(
      targets.map((sessionId) =>
        this.closeRuntime(sessionId).catch((err) => {
          console.error(`Failed to close runtime ${sessionId} during workspace deletion:`, err);
        }),
      ),
    );
  }

  /**
   * Close all cached runtimes that belong to a specific Bot. Called when the
   * bot's persona, member roles, or role policy change so the next user turn
   * recreates the runtime with the updated configuration.
   */
  async closeRuntimesForBot(botId: string): Promise<void> {
    const targets: string[] = [];
    for (const sessionId of this.runtimes.keys()) {
      try {
        const session = workspaceStore.getLocalSession(sessionId);
        if (session && session.botId === botId) {
          targets.push(sessionId);
        }
      } catch {
        // ignore — getLocalSession can fail for stale sessions
      }
    }
    if (targets.length === 0) return;
    sidecarLog(`[ChatService] closing ${targets.length} runtimes for bot ${botId}`);
    await Promise.all(
      targets.map((sessionId) =>
        this.closeRuntime(sessionId).catch((err) => {
          console.error(`Failed to close runtime ${sessionId} during bot invalidation:`, err);
        }),
      ),
    );
  }

  async pushMessage(
    sessionId: string,
    workspaceId: string,
    message: string,
    isBotSession?: boolean,
    botEventHandler?: (id: number, event: SseEvent) => void,
    botUserId?: string,
  ): Promise<void> {
    const runtime = await this.getOrCreateRuntime(sessionId, workspaceId, isBotSession, botEventHandler, botUserId);

    // U11 (KTD-19): a new turn resets the per-turn override-deny cap.
    this.sessionOverrideDenies.delete(sessionId);

    // Promote a draft session to a real SDK session on first message. The SDK
    // creates the persistent session when this message is pushed, so clear the
    // draft flag now so future renames go through sdkClient.renameSession instead
    // of only updating the local SQLite row.
    const localSession = workspaceStore.getLocalSession(sessionId);
    if (localSession?.isDraft) {
      // The backend lock lands HERE — at the first message (R4), not at
      // runtime creation: a draft may be re-selected any time before this
      // point (a runtime created by merely viewing the session never locks).
      if (!localSession.backend) {
        const backend = runtime.getBackendId();
        workspaceStore.updateSessionBackend(sessionId, backend);
        diagLog(`[ChatService] session ${sessionId} backend locked to '${backend}' at first message`);
      }
      workspaceStore.clearDraftFlag(sessionId);
    }

    runtime.pushMessage(message);
  }

  getSessionsStatus(workspaceId: string): Record<
    string,
    { pendingCount: number; isProcessing: boolean; activity: SessionActivitySnapshot }
  > {
    const statuses: Record<
      string,
      { pendingCount: number; isProcessing: boolean; activity: SessionActivitySnapshot }
    > = {};
    for (const [sessionId, runtime] of this.runtimes) {
      const status = runtime.getStatus();
      if (status.workspaceId === workspaceId) {
        statuses[sessionId] = {
          pendingCount: status.pendingCount,
          isProcessing: status.isProcessing,
          activity: status.activity ?? this.runtimeActivity(runtime),
        };
      }
    }
    return statuses;
  }

  // Legacy message streaming (preserved during migration; removed after U5)

  async sendMessage(sessionId: string, message: string): Promise<MessageStream> {
    const workspace = await this.findWorkspaceForSession(sessionId);
    if (!workspace) {
      throw new ChatError('Workspace not found for session', 'WORKSPACE_NOT_FOUND', 404);
    }

    const session = await this.getSession(sessionId, workspace.id);
    if (!session) {
      throw new ChatError('Session not found', 'SESSION_NOT_FOUND', 404);
    }

    const options = this.buildSdkOptions(workspace, session);
    await this.testClaudeBinary(options.pathToClaudeCodeExecutable, workspace.folderPath, options.env || process.env);
    const { query, messages: rawMessages } = this.sdkClient.createQuery(message, options);

    const messages = this.wrapStream(rawMessages);

    return { messages, rawQuery: query, wasDraft: !!session.isDraft };
  }

  private async findWorkspaceForSession(sessionId: string): Promise<Workspace | null> {
    // Check local DB first
    const localSession = workspaceStore.getLocalSession(sessionId);
    if (localSession) {
      return workspaceStore.get(localSession.workspaceId);
    }

    // Search all workspaces for SDK session
    const workspaces = await workspaceStore.list();
    for (const ws of workspaces) {
      try {
        const info = await this.sdkClient.getSessionInfo(sessionId, { dir: normalizeWindowsPath(ws.folderPath) });
        if (info) return ws;
      } catch {
        // Continue searching
      }
    }

    return null;
  }

  private isCommandOnPath(command: string): boolean {
    if (path.isAbsolute(command)) {
      return existsSync(command);
    }
    const pathEnv = process.env.PATH || '';
    const pathDirs = pathEnv.split(process.platform === 'win32' ? ';' : ':');
    const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
    for (const dir of pathDirs) {
      for (const ext of extensions) {
        const fullPath = path.join(dir, command + ext);
        if (existsSync(fullPath)) {
          return true;
        }
      }
    }
    return false;
  }

  private loadPluginMcpServers(
    workspacePath: string,
  ): Record<string, import('@anthropic-ai/claude-agent-sdk').McpServerConfig> {
    const result: Record<string, import('@anthropic-ai/claude-agent-sdk').McpServerConfig> = {};

    try {
      // Get enabled plugins from all three scopes
      // Order matters: local takes precedence over project over user
      const userPlugins = pluginSettingsService.getInstalledPlugins('user');
      const projectPlugins = pluginSettingsService.getInstalledPlugins('project', workspacePath);
      const localPlugins = pluginSettingsService.getInstalledPlugins('local', workspacePath);
      const enabledPlugins = [
        ...localPlugins.filter((p) => p.enabled),
        ...projectPlugins.filter((p) => p.enabled),
        ...userPlugins.filter((p) => p.enabled),
      ];
      const seenPlugins = new Set<string>();

      for (const plugin of enabledPlugins) {
        if (seenPlugins.has(plugin.id)) continue;
        seenPlugins.add(plugin.id);

        const cachePath = pluginSettingsService.resolvePluginCachePath(plugin.id);
        const mcpPath = path.join(cachePath, '.mcp.json');
        const altMcpPath = path.join(cachePath, '.claude-plugin', '.mcp.json');

        for (const mcpFile of [mcpPath, altMcpPath]) {
          if (!existsSync(mcpFile)) continue;

          try {
            const content = readFileSync(mcpFile, 'utf-8');
            const parsed = JSON.parse(content) as Record<string, unknown>;
            const servers = parsed.mcpServers as Record<
              string,
              { type?: string; command: string; args?: string[]; env?: Record<string, string> }
            >;

            if (!servers || typeof servers !== 'object') continue;

            for (const [name, config] of Object.entries(servers)) {
              if (!config || typeof config !== 'object') continue;
              if (!config.command) continue;

              // Resolve ${CLAUDE_PLUGIN_ROOT} placeholder
              const resolvedCommand = config.command.replace(
                /\$\{CLAUDE_PLUGIN_ROOT\}/g,
                cachePath,
              );
              const resolvedArgs = (config.args || []).map((arg) =>
                arg.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, cachePath),
              );
              const resolvedEnv: Record<string, string> = {};
              if (config.env) {
                for (const [key, value] of Object.entries(config.env)) {
                  resolvedEnv[key] = value.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, cachePath);
                }
              }

              // Validate that the command binary exists (absolute path or on PATH)
              const binaryExists = this.isCommandOnPath(resolvedCommand);
              if (!binaryExists) {
                sidecarLog(`[ChatService] MCP server binary not found for plugin ${plugin.id}: ${resolvedCommand}`);
                continue;
              }

              result[name] = {
                type: (config.type as 'stdio') || 'stdio',
                command: resolvedCommand,
                args: resolvedArgs,
                ...(Object.keys(resolvedEnv).length > 0 ? { env: resolvedEnv } : {}),
              };
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            sidecarLog(`[ChatService] Failed to parse .mcp.json for plugin ${plugin.id}: ${message}`);
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sidecarLog(`[ChatService] Plugin MCP discovery failed: ${message}`);
    }

    return result;
  }

  private getWecomBotUserForSession(sessionId: string): import('../models/bot-user.js').BotUser | null {
    for (const userId of workspaceStore.getSessionUsers(sessionId)) {
      const botUser = workspaceStore.getBotUser(userId);
      if (!botUser) continue;
      const channel = workspaceStore.getBotChannel(botUser.channelId);
      if (channel?.channelKey === 'wecom') {
        return botUser;
      }
    }
    return null;
  }

  private buildSdkOptions(
    workspace: Workspace,
    session: ChatSession,
    isBotSession?: boolean,
    botUserId?: string,
    provider?: Provider,
  ): import('@anthropic-ai/claude-agent-sdk').Options {
    const claudeSettings = loadClaudeSettings();
    let { env } = buildClaudeEnv(claudeSettings);

    // One scheduling system (KTD-3): Claude Code's built-in session-scoped
    // cron (CronCreate/CronList/CronDelete and /loop) lives in the project's
    // .claude directory — invisible to the Comate panel, unconfirmable, and
    // outside the unified execution path. Disable it for every Comate session
    // so natural-language scheduling always flows through the scheduled-task
    // MCP tools (draft -> UI confirm -> unified scheduler). Official switch:
    // https://code.claude.com/docs/en/scheduled-tasks#disable-scheduled-tasks
    env.CLAUDE_CODE_DISABLE_CRON = '1';

    // Per-runtime task capability shared identically by Claude/OpenCode via
    // subprocess env and the browser MCP header. Rebuilds rotate this kind
    // without revoking a simultaneous bot/WeCom capability.
    let taskCapabilityToken: string | undefined;
    if (!isBotSession) {
      const capability = sessionCapabilityService.mintForSession({
        sessionId: session.id,
        workspaceId: workspace.id,
        botId: null,
        kind: 'task',
        audiences: ['browser-mcp', 'api-broker'],
        runtimeGeneration: randomUUID(),
      });
      taskCapabilityToken = capability.token;
      env[SESSION_TOKEN_ENV] = capability.token;
    }

    // Resolve active provider: session -> default, when not already provided.
    const resolvedProvider = provider ?? (session.providerId
      ? workspaceStore.getProvider(session.providerId)
      : workspaceStore.getDefaultProvider());

    if (!resolvedProvider) {
      throw new ChatError(
        'No LLM provider configured. Add a provider in Settings.',
        'PROVIDER_NOT_FOUND',
        500,
      );
    }

    // Build flag-settings env so provider credentials survive upstream
    // settings reloads (applyConfigEnvironmentVariables overwrites process.env).
    const settingsEnv: Record<string, string> = {};
    settingsEnv.ANTHROPIC_BASE_URL = resolvedProvider.baseUrl;
    settingsEnv.ANTHROPIC_API_KEY = resolvedProvider.authToken;
    settingsEnv.ANTHROPIC_AUTH_TOKEN = resolvedProvider.authToken;
    if (resolvedProvider.model) {
      settingsEnv.ANTHROPIC_MODEL = resolvedProvider.model;
    }
    if (resolvedProvider.defaultOpusModel) {
      settingsEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = resolvedProvider.defaultOpusModel;
    }
    if (resolvedProvider.defaultSonnetModel) {
      settingsEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = resolvedProvider.defaultSonnetModel;
    }
    if (resolvedProvider.defaultHaikuModel) {
      settingsEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = resolvedProvider.defaultHaikuModel;
    }
    if (resolvedProvider.subagentModel) {
      settingsEnv.CLAUDE_CODE_SUBAGENT_MODEL = resolvedProvider.subagentModel;
    }
    if (resolvedProvider.effortLevel) {
      settingsEnv.CLAUDE_CODE_EFFORT_LEVEL = resolvedProvider.effortLevel;
    }
    if (resolvedProvider.customEnvVars) {
      for (const [key, value] of Object.entries(resolvedProvider.customEnvVars)) {
        settingsEnv[key] = value;
      }
    }

    // Diagnostic: log Windows home-dir env vars
    sidecarLog(`[ChatService.buildSdkOptions] USERPROFILE=${process.env.USERPROFILE}`);
    sidecarLog(`[ChatService.buildSdkOptions] HOME=${process.env.HOME}`);
    sidecarLog(`[ChatService.buildSdkOptions] HOMEDRIVE=${process.env.HOMEDRIVE}`);
    sidecarLog(`[ChatService.buildSdkOptions] HOMEPATH=${process.env.HOMEPATH}`);
    sidecarLog(`[ChatService.buildSdkOptions] homedir=${homedir()}`);
    sidecarLog(`[ChatService.buildSdkOptions] CLAUDE_CONFIG_DIR=${env.CLAUDE_CONFIG_DIR}`);
    sidecarLog(`[ChatService.buildSdkOptions] CLAUDE_SECURESTORAGE_CONFIG_DIR=${env.CLAUDE_SECURESTORAGE_CONFIG_DIR}`);

    // Log provider env vars passed via flag settings for diagnostics
    for (const key of Object.keys(settingsEnv)) {
      sidecarLog(`[ChatService.buildSdkOptions] settings.env.${key}=<set>`);
    }

    const wecomCliPath = resolveWecomCliPath();
    if (wecomCliPath) {
      const cliDir = path.dirname(wecomCliPath);
      prependEnvPath(env, cliDir);
      env.WECOM_CLI_PATH = wecomCliPath;
      sidecarLog(`[ChatService.buildSdkOptions] injected wecom CLI dir into PATH: ${cliDir}`);
      sidecarLog(`[ChatService.buildSdkOptions] set WECOM_CLI_PATH=${wecomCliPath}`);
    }

    if (!isBotSession) {
      const comateCliPath = resolveComateCliPath();
      if (comateCliPath) {
        prependEnvPath(env, path.dirname(comateCliPath));
        env.COMATE_CLI_PATH = comateCliPath;
        env.COMATE_SERVER_URL = getSidecarBaseUrl();
        env.COMATE_WORKSPACE_ROOT = workspace.folderPath;
        sidecarLog(`[ChatService.buildSdkOptions] set COMATE_CLI_PATH=${comateCliPath}`);
      }
    }

    const pathKey = getPathEnvKey(env);
    sidecarLog(`[ChatService.buildSdkOptions] enriched PATH=${env[pathKey]}`);

    const mcpServers: Record<string, import('@anthropic-ai/claude-agent-sdk').McpServerConfig> = {};
    for (const mcp of workspace.mcpServers) {
      mcpServers[mcp.name] = {
        type: 'stdio',
        command: mcp.command,
        args: mcp.args,
      };
    }

    // Merge plugin MCP servers (workspace-defined servers override plugin-defined)
    try {
      const pluginMcpServers = this.loadPluginMcpServers(workspace.folderPath);
      for (const [name, config] of Object.entries(pluginMcpServers)) {
        if (!mcpServers[name]) {
          mcpServers[name] = config;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sidecarLog(`[ChatService.buildSdkOptions] Plugin MCP merge failed: ${message}`);
    }

    // Embedded browser MCP server (U3, KTD-3): GUI sessions only — bot
    // sessions never get the browser tool surface (KTD-4 ③: the injection
    // condition itself is the first line of bot defense). The instance is
    // keyed by sessionId; the browser process outlives it via browserService.
    if (!isBotSession) {
      // U6 (KTD-6): the browser MCP surface is served by the sidecar over
      // HTTP so both backends consume it; the per-session URL binds tools to
      // this session's embedded browser.
      mcpServers[BROWSER_MCP_SERVER_KEY] = {
        type: 'http',
        url: `${getSidecarBaseUrl()}/mcp/browser/${session.id}`,
        headers: { Authorization: `Bearer ${taskCapabilityToken}` },
      } as import('@anthropic-ai/claude-agent-sdk').McpServerConfig;
      // Submit/handoff handler approval round-trips can wait on a human far
      // past the 60s SDK default — per-session env, never process-global.
      env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = BROWSER_STREAM_CLOSE_TIMEOUT_MS;
    }

    // Scheduled-task MCP tools (U7, KTD-5 分级): local GUI sessions get the
    // full tool set (draft/list/pause/resume/run-now); bot sessions get the
    // draft tool only (their drafts always need UI confirmation); scheduled
    // run sessions get none — confirm/edit/delete are never exposed as tools.
    if (session.source !== 'scheduled') {
      mcpServers[SCHEDULED_TASKS_MCP_KEY] = {
        type: 'http',
        url: `${getSidecarBaseUrl()}/mcp/scheduled-tasks/${session.id}`,
        headers: { Authorization: `Bearer ${getScheduledTasksMcpToken()}` },
      } as import('@anthropic-ai/claude-agent-sdk').McpServerConfig;
    }

    const claudePath = resolveSdkBinary();
    const normalizedCwd = normalizeWindowsPath(workspace.folderPath);
    sidecarLog(`[ChatService.buildSdkOptions] pathToClaudeCodeExecutable=${claudePath}`);
    sidecarLog(`[ChatService.buildSdkOptions] cwd=${normalizedCwd} (raw=${workspace.folderPath})`);
    sidecarLog(`[ChatService.buildSdkOptions] provider=${resolvedProvider.name} model=${resolvedProvider.model || 'default'}`);
    sidecarLog(`[ChatService.buildSdkOptions] sessionId=${session.id} isDraft=${!!session.isDraft}`);
    sidecarLog(`[ChatService.buildSdkOptions] platform=${process.platform} arch=${process.arch}`);

    const providerSupportsFastMode = resolvedProvider.supportsFastMode !== false;
    const fastMode = session.fastMode === true && providerSupportsFastMode;
    sidecarLog(`[ChatService.buildSdkOptions] fastMode=${fastMode}`);

    const options: import('@anthropic-ai/claude-agent-sdk').Options = {
      cwd: normalizedCwd,
      env,
      settings: { env: settingsEnv, fastMode },
      mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
      model: resolvedProvider.model || (isBotSession ? BOT_SESSION_PINNED_MODEL : undefined),
      includePartialMessages: false,
      pathToClaudeCodeExecutable: claudePath,
      stderr: (data) => {
        const trimmed = data.trim();
        if (trimmed) sidecarLog(`[ChatService.claude.stderr] ${trimmed}`);
      },
    };

    if (isBotSession) {
      // Sanitize the child process environment for bot sessions: remove WeCom
      // and non-Anthropic cloud credentials. Anthropic provider keys are kept
      // because the SDK child needs them to call the API.
      env = sanitizeBotEnv(env);

      // buildSdkOptions() already constructed an options object with the
      // original env reference, but sanitizeBotEnv() returns a new object above.
      // Ensure the returned options point to the sanitized env.
      options.env = env;

      // Resolve the canonical channel identity for this session.
      const channel = session.source === 'wecom' || session.source === 'feishu' ? session.source : undefined;
      let channelUserId: string | undefined;
      if (channel === 'wecom') {
        const wecomBotUser = this.getWecomBotUserForSession(session.id);
        channelUserId = wecomBotUser?.plaintextUserId ?? wecomBotUser?.channelUserId;
      } else if (channel === 'feishu') {
        channelUserId = botUserId;
      }

      let pathContext: import('./bot-path-policy.js').PathPolicyContext | undefined;

      if (session.botId) {
        // Dynamic bot-level policy: role is resolved at call time so membership
        // and role changes take effect on the next tool use without restarting
        // the runtime. See plan KTD3.
        const bot = botService.getBot(session.botId);
        if (bot) {
          // Channel settings are a pure read — fetch once per spawn (both the
          // wecom context write and the sandbox derivation below need them).
          const channelSettings = botService.getChannelSettings(bot.id);

          // Resolve the member role ONCE at spawn (reused by the persona seam,
          // the path context, and the U3 derivation — never re-resolved here).
          const spawnRole: BotRoleKey | null = channel && channelUserId
            ? botService.getMemberRole(bot.id, channel, channelUserId)
            : null;
          const roleForPersona: BotRoleKey | undefined = channel && channelUserId
            ? spawnRole ?? 'normal'
            : undefined;
          const persona = roleForPersona
            ? botService.getRolePersona(bot.id, roleForPersona) ?? bot.persona
            : bot.persona;

          const isAdminOrOwnerForContext = isOwnerOrAdmin(spawnRole);

          const userDirName = channelUserId ?? 'anonymous';
          // The sandbox-model gate never consults knownUserDirNames (KTD-6: it
          // denies the data/ parent instead), so the user-dir enumeration is
          // skipped here — the legacy kill-switch branch below rebuilds the
          // context WITH it (its validateToolInput cross-user check needs it).
          pathContext = createPathPolicyContext(
            workspace,
            userDirName,
            [],
            isAdminOrOwnerForContext,
            workspace.settings.sensitiveFileDenylist ?? [],
          );

          // U12 (KTD-28): per-session capability material. Minted per runtime
          // creation (rotation on rebuild — the prior token is revoked by the
          // mint), revoked on close/demote/boot. Injected AFTER env
          // sanitization AND after the access derivation so the token is
          // never swept into the sandbox credentials.envVars deny set — the
          // sandboxed wecom CLI must be able to read its own credential.
          // Fail-soft: a mint/context failure degrades the CLI surface, never
          // the session itself.
          try {
            const capability = sessionCapabilityService.mintForSession({
              sessionId: session.id,
              workspaceId: workspace.id,
              botId: bot.id,
              kind: 'wecom',
              audiences: ['wecom-cli'],
              runtimeGeneration: randomUUID(),
            });
            env[SESSION_TOKEN_ENV] = capability.token;
            // U6 (KTD-22, U12 notes): token lifecycle audit. The token value
            // itself is never logged (the 48-hex shape auto-redacts anyway).
            botAuditLogger.logCapabilityTokenMinted(bot.id, { type: 'system' }, {
              sessionId: session.id,
              workspaceId: workspace.id,
              expiresAt: capability.expiresAt,
            });
          } catch (err) {
            diagLog(
              `[ChatService] capability token mint failed for session=${session.id}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }

          // Context relocation (U12): the wecom CLI context now lives in the
          // session user's `.runtime/` dir, passed via env — the legacy
          // workspace-root file and upward-walk discovery are gone, so a
          // planted `.claude/wecom-context.json` cannot win.
          if (channel === 'wecom' && channelUserId) {
            try {
              const identity = validateUserDirName(channelUserId);
              if (channelSettings.wecom?.enabled && identity.ok) {
                const contextPath = writeSessionWecomContext({
                  workspaceFolder: workspace.folderPath,
                  userDirName: identity.userDirName,
                  workspaceId: workspace.id,
                  botId: bot.id,
                  serverUrl: getSidecarBaseUrl(),
                });
                env[WECOM_CONTEXT_FILE_ENV] = contextPath;
              }
            } catch (err) {
              diagLog(
                `[ChatService] wecom session context write failed for session=${session.id}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }

          if (workspace.settings.botPermissionSandboxDisabled === true) {
            // ==============================================================
            // LEGACY permission model (runtime kill switch, U3 Operational
            // Notes): prior behavior preserved verbatim for canary rollback.
            // ==============================================================
            // The legacy cross-user read check enumerates the workspace's
            // known user dirs — rebuild the path context with them (the
            // sandbox model never runs these queries).
            const knownUserDirNames: string[] = [];
            if (channel === 'wecom') {
              for (const u of botService.listChannelUsersForWorkspace(workspace.id, 'wecom')) {
                knownUserDirNames.push(u.plaintextUserId ?? u.channelUserId);
              }
            } else if (channel === 'feishu') {
              for (const u of botService.listChannelUsersForWorkspace(workspace.id, 'feishu')) {
                knownUserDirNames.push(u.plaintextUserId ?? u.channelUserId);
              }
            }
            pathContext = createPathPolicyContext(
              workspace,
              userDirName,
              knownUserDirNames,
              isAdminOrOwnerForContext,
              workspace.settings.sensitiveFileDenylist ?? [],
            );

            if (persona) {
              if (persona.mode === 'append') {
                options.systemPrompt = {
                  type: 'preset',
                  preset: 'claude_code',
                  append: persona.prompt,
                };
              } else {
                options.systemPrompt = persona.prompt;
              }
            }

            options.canUseTool = async (
              toolName: string,
              input: Record<string, unknown>,
              sdkOptions: {
                signal: AbortSignal;
                suggestions?: import('../types/message.js').PermissionSuggestion[];
                title?: string;
                description?: string;
                toolUseID: string;
                decisionReasonType?: string;
              },
            ) => {
              // Browser tools never run in bot sessions — this deny must precede
              // the 'unknown' fall-through below (see denyBrowserToolInBotSession).
              const browserDeny = denyBrowserToolInBotSession(session.id, toolName, sdkOptions?.toolUseID);
              if (browserDeny) return browserDeny;

              // Resolve role dynamically on every tool use so membership/role changes
              // take effect without restarting the runtime.
              const role = channel && channelUserId
                ? botService.getMemberRole(bot.id, channel, channelUserId)
                : null;
              const rolePolicy = botService.getRolePolicy(bot.id);
              const decision = evaluateBotToolPermission(rolePolicy?.normalToolPolicy ?? SAFE_PRESET, role, toolName);
              // 'unknown' = tool not in any category (MCP, Skill, future SDK built-in
              // without a category fit). Fall through to today's allow-all behavior
              // per R10. The brainstorm explicitly defers MCP and Skills gating.
              // Identity failure = fail closed on file/Bash/Skill tools.
              if (!channelUserId && IDENTITY_SENSITIVE_TOOLS.has(toolName)) {
                diagLog(
                  `[ChatService.botDeny] session=${session.id} tool=${toolName} toolUseId=${sdkOptions?.toolUseID ?? 'none'} reason=missing-identity`,
                );
                return {
                  behavior: 'deny' as const,
                  message: "I can't do that in this workspace.",
                };
              }

              // Bash whitelist overrides the Shell category for Normal users; Owner/Admin
              // bypass the whitelist entirely. Legacy prefix matcher kept verbatim for
              // the kill switch (U4: the sandbox model uses the SDK rule engine instead).
              if (toolName === 'Bash' && typeof input.command === 'string' && channelUserId) {
                if (legacyBashWhitelistPrefixMatch(rolePolicy?.bashWhitelist ?? [], role, input.command)) {
                  return { behavior: 'allow' as const, updatedInput: input };
                }
                diagLog(
                  `[ChatService.botDeny] session=${session.id} tool=${toolName} toolUseId=${sdkOptions?.toolUseID ?? 'none'} reason=bash-whitelist`,
                );
                // U6 (KTD-22): the kill switch is the canary rollback path —
                // its bash denies need the audit trail most.
                if (channel) {
                  botAuditLogger.logBashDenied(
                    bot.id,
                    { type: channel, channelKey: channel, channelUserId },
                    {
                      sessionId: session.id,
                      command: input.command,
                      reason: 'bash-whitelist',
                    },
                  );
                }
                return {
                  behavior: 'deny' as const,
                  message: "I can't do that in this workspace.",
                };
              }

              if (decision === 'deny') {
                // Generic denial message — do NOT name the capability. Inbound bot
                // messages are an untrusted channel; naming the denied capability
                // would let an attacker probe the policy by mapping denials.
                const reason = getToolPermissionDenialReason(rolePolicy?.normalToolPolicy, toolName);
                diagLog(
                  `[ChatService.botDeny] session=${session.id} tool=${toolName} toolUseId=${sdkOptions?.toolUseID ?? 'none'} reason=${reason ?? 'deny'}`,
                );
                return {
                  behavior: 'deny' as const,
                  message: "I can't do that in this workspace.",
                };
              }

              if (FILE_TOOLS.has(toolName) && pathContext) {
                // Path context is built when the runtime starts, but role changes must
                // be respected immediately (R14). Recompute the owner/admin flag from
                // the freshly resolved role instead of the stale snapshot.
                const effectivePathContext = {
                  ...pathContext,
                  isAdminOrOwner: isOwnerOrAdmin(role),
                };
                const r = validateToolInput(effectivePathContext, toolName, input);
                if (!r.allowed) {
                  diagLog(
                    `[ChatService.botDeny] session=${session.id} tool=${toolName} toolUseId=${sdkOptions?.toolUseID ?? 'none'} reason=${r.reason ?? 'path-denied'}`,
                  );
                  if (session.botId && channel && channelUserId) {
                    botAuditLogger.logFileAccessDenied(
                      session.botId,
                      { type: channel, channelKey: channel, channelUserId },
                      {
                        sessionId: session.id,
                        toolName,
                        reason: r.reason ?? 'path-denied',
                        path: auditPathFromToolInput(input),
                      },
                    );
                  }
                  return {
                    behavior: 'deny' as const,
                    message: "I can't do that in this workspace.",
                  };
                }
              }

              if (toolName === 'Skill') {
                const r = evaluateBotSkill(rolePolicy ?? createDefaultBotRolePolicy('normal'), role, toolName, input);
                if (!r.allowed) {
                  diagLog(
                    `[ChatService.botDeny] session=${session.id} tool=${toolName} toolUseId=${sdkOptions?.toolUseID ?? 'none'} reason=${r.reason ?? 'skill-denied'}`,
                  );
                  return {
                    behavior: 'deny' as const,
                    message: "I can't do that in this workspace.",
                  };
                }
              }

              // AskUserQuestion always requires user input, regardless of policy
              if (toolName === 'AskUserQuestion') {
                const runtime = this.runtimes.get(session.id);
                if (!runtime) {
                  diagLog(
                    `[ChatService.botDeny] session=${session.id} tool=${toolName} toolUseId=${sdkOptions?.toolUseID ?? 'none'} reason=missing-runtime`,
                  );
                  return {
                    behavior: 'deny' as const,
                    message: "I can't do that in this workspace.",
                  };
                }
                const questions = mapAskUserQuestionInput(input);
                const timeout = extractToolTimeout(input);
                return runtime.requestToolQuestion(sdkOptions.toolUseID, questions, input, {
                  timeout,
                  signal: sdkOptions.signal,
                });
              }

              if (decision === 'ask') {
                const runtime = this.runtimes.get(session.id);
                if (!runtime) {
                  diagLog(
                    `[ChatService.botDeny] session=${session.id} tool=${toolName} toolUseId=${sdkOptions?.toolUseID ?? 'none'} reason=missing-runtime`,
                  );
                  return {
                    behavior: 'deny' as const,
                    message: "I can't do that in this workspace.",
                  };
                }
                const timeout = extractToolTimeout(input);
                return runtime.requestToolApproval(sdkOptions.toolUseID, toolName, sdkOptions.toolUseID, input, {
                  title: sdkOptions.title,
                  description: sdkOptions.description,
                  suggestions: sdkOptions.suggestions,
                  timeout,
                  signal: sdkOptions.signal,
                  decisionReasonType: sdkOptions.decisionReasonType,
                });
              }

              return { behavior: 'allow' as const, updatedInput: input };
            };
          } else {
            // ==============================================================
            // Sandbox permission model (U3): the derived sandbox + structural
            // rules are the enforcement layer; the gate keeps canUseTool as
            // the single permission authority and fails closed for non-owner
            // roles (KTD-1).
            // ==============================================================

            // KTD-11: record the spawn-frozen role so the gate can detect a
            // demotion on any later call and force an immediate rebuild.
            this.sessionSpawnRoles.set(session.id, spawnRole);

            const rolePolicy = botService.getRolePolicy(bot.id) ?? createDefaultBotRolePolicy('normal');
            const derivation: BotAccessDerivation = deriveBotAccess(
              bot,
              { roleKey: spawnRole ?? 'normal', channelUserId: channelUserId ?? null },
              rolePolicy,
              workspace.folderPath,
              {
                sensitiveFileDenylist: workspace.settings.sensitiveFileDenylist ?? [],
                settingsEnv,
                providerEnv: resolvedProvider.customEnvVars,
                childEnv: env,
                wecomEnabled: channel === 'wecom' && (channelSettings.wecom?.enabled ?? false),
              },
            );

            // KTD-24: the probe state machine owns failIfUnavailable. Probe
            // pass → true (a sandbox that cannot start errors rather than
            // running bare); probe fail → degraded posture (structural rules
            // + role-routed gate) + false + audit.
            const sandboxDegraded = isSandboxDegraded();
            options.sandbox = { ...derivation.sandbox, failIfUnavailable: !sandboxDegraded };
            if (sandboxDegraded) {
              diagLog(
                `[ChatService] session=${session.id} bot=${bot.id} sandbox probe degraded at spawn — failIfUnavailable=false, gate role-routes unmatched bash`,
              );
            }

            // Inline settings object only — Options.sandbox and a settings
            // FILE PATH must not both be set (SDK throws; KTD-2).
            //
            // U5 (R8/KTD-14): bot-level disabled skills compile into explicit
            // deny rules — deny evaluates before allow/canUseTool in the SDK
            // permission pipeline, so a disabled skill stays blocked even when
            // it is also mounted (deny takes precedence over mount). The
            // gate's evaluateSkillDisabled is the in-gate backstop; both
            // layers share the same normalization and the KTD-14 unrestricted
            // set, so they cannot disagree.
            const skillDenyRules = compileSkillDenyRules(rolePolicy.disabledSkills ?? []);
            (options.settings as { permissions?: BotAccessDerivation['permissionRules'] }).permissions =
              skillDenyRules.length > 0
                ? { ...derivation.permissionRules, deny: [...skillDenyRules, ...derivation.permissionRules.deny] }
                : derivation.permissionRules;

            // U5 (R8/KTD-14): SDK skill context filter — unlisted skills are
            // hidden from the model and rejected by the Skill tool (a context
            // filter, not a sandbox). Three-state semantics: absent = every
            // discovered skill mounts (zero-config default, AE4); an array =
            // closed mounted set ([] hides everything). Bot-level: the filter
            // binds every role equally — it is a capability surface, not a
            // permission. compileSkillFilter unions the unrestricted
            // send-capable wecom skills so the bot's reply path always stays
            // mounted.
            if (rolePolicy.skills !== undefined) {
              options.skills = compileSkillFilter(rolePolicy.skills);
            }

            // KTD-3: pin SDK isolation mode. Any user-writable settings
            // source (workspace .claude/settings.json, ~/.claude/settings.json)
            // would short-circuit the gate and widen the sandbox boundary.
            options.settingSources = [];

            // KTD-3 re-attachment: the bot's plugin set (incl. bundled wecom)
            // comes through Options.plugins, not any settings file.
            if (derivation.plugins.length > 0) {
              options.plugins = derivation.plugins;
            }

            // KTD-12: capability preamble, concatenated with the persona.
            options.systemPrompt = composeBotSystemPrompt(persona, derivation.preamble);

            // KTD-1: PreToolUse audit hook — sees every tool call (incl.
            // builtin read-only commands that never reach canUseTool).
            const existingHooks = options.hooks ?? {};
            options.hooks = {
              ...existingHooks,
              PreToolUse: [
                ...(existingHooks.PreToolUse ?? []),
                { hooks: [makeBotPreToolUseAuditHook(session.id, bot.id)] },
              ],
            };

            const gatePathContext = pathContext;

            // U9 (KTD-20): the session's configured MCP server names
            // disambiguate `mcp__<server>__<tool>` splits (server names may
            // contain single underscores).
            const mcpServerNames = Object.keys(mcpServers);

            options.canUseTool = async (
              toolName: string,
              input: Record<string, unknown>,
              sdkOptions: {
                signal: AbortSignal;
                suggestions?: import('../types/message.js').PermissionSuggestion[];
                title?: string;
                description?: string;
                toolUseID: string;
                decisionReasonType?: string;
              },
            ) => {
              const browserDeny = denyBrowserToolInBotSession(session.id, toolName, sdkOptions?.toolUseID);
              if (browserDeny) return browserDeny;

              const denyRouted = (routingClass: BotDenialClass, reason: string) => {
                diagLog(
                  `[ChatService.botDeny] session=${session.id} tool=${toolName} toolUseId=${sdkOptions?.toolUseID ?? 'none'} reason=${reason} class=${routingClass}`,
                );
                return { behavior: 'deny' as const, message: botDenialMessage(routingClass) };
              };

              // The SDK always supplies toolUseID in production; the fallback
              // keeps direct/test invocations of the closure well-formed.
              const toolRequestId = sdkOptions?.toolUseID ?? randomUUID();

              const askHuman = (overrides?: { timeout?: number; audience?: 'self' | 'admins' }) => {
                const runtime = this.runtimes.get(session.id);
                if (!runtime) {
                  return Promise.resolve(denyRouted('final', 'missing-runtime'));
                }
                const timeout = overrides?.timeout ?? extractToolTimeout(input);
                return runtime.requestToolApproval(toolRequestId, toolName, toolRequestId, input, {
                  title: sdkOptions?.title,
                  description: sdkOptions?.description,
                  suggestions: sdkOptions?.suggestions,
                  timeout,
                  signal: sdkOptions?.signal,
                  decisionReasonType: sdkOptions?.decisionReasonType,
                  ...(overrides?.audience !== undefined && { audience: overrides.audience }),
                });
              };

              // Role is resolved fresh on every call so membership changes
              // take effect without waiting for the rebuild.
              const freshRole: BotRoleKey | null = channel && channelUserId
                ? botService.getMemberRole(bot.id, channel, channelUserId)
                : null;

              // KTD-11: demotion window. The spawn-frozen sandbox/rules are
              // wider than the fresh role — deny identity-sensitive tools
              // with the policy-rebuilding class and rebuild NOW (the in-turn
              // deferral is bypassed for demotions; promotions stay lazy).
              const frozenRole = this.sessionSpawnRoles.get(session.id) ?? null;
              if (botRoleRank(freshRole) < botRoleRank(frozenRole)) {
                this.triggerDemotionRebuild(session.id);
                if (IDENTITY_SENSITIVE_TOOLS.has(toolName)) {
                  return denyRouted('policy-rebuilding', 'role-demotion-rebuild');
                }
              }

              if (!channelUserId && IDENTITY_SENSITIVE_TOOLS.has(toolName)) {
                return denyRouted('final', 'missing-identity');
              }

              // ---- Escalation helpers (U11, KTD-15/KTD-18/KTD-19/KTD-21) ----
              // Shared by the Bash escape branch now; U9's network/MCP-write
              // classification calls the same route (reason plumbed through).

              /** Per-turn override-deny counter (KTD-19 retry-loop breaker). */
              const recordOverrideDeny = (): void => {
                this.sessionOverrideDenies.set(session.id, (this.sessionOverrideDenies.get(session.id) ?? 0) + 1);
              };

              /**
               * Post-resolution bookkeeping for an escalation ask (shared by
               * the self-ask and remote-approval routes): decision audit, the
               * ledger's terminal transition (first-writer-wins — a card click
               * may already have settled), and the U11 terminal notification
               * fan-out for admins-audience rows.
               */
              const settleEscapeAfterAsk = (
                escapeActor: BotActor,
                escapeResult: PermissionResult,
                escalationEntry: BotEscalationEntry | null,
                command: string,
              ): void => {
                const requester = {
                  channel: escapeActor.channelKey ?? 'unknown',
                  channelUserId: escapeActor.channelUserId ?? '',
                  role: freshRole,
                };
                // `?.`: partial runtime test doubles may not implement the
                // provenance channel; absence = phase-1 default.
                const provenance = this.runtimes.get(session.id)?.consumeResolutionProvenance?.(toolRequestId);
                if (escapeResult.behavior === 'allow') {
                  const approver = provenanceApprover(provenance, escapeActor);
                  const source = provenance?.source ?? 'self-approval';
                  botAuditLogger.logSandboxEscapeApproved(bot.id, approver, {
                    sessionId: session.id,
                    command,
                    requester,
                    source,
                  });
                  if (escalationEntry) {
                    botEscalationLedger.settle(escalationEntry.id, 'approved', {
                      approver: provenance?.approver ?? escapeActor,
                      decision: 'allow',
                      source,
                    });
                  }
                } else if (escapeResult.message === APPROVAL_TIMEOUT_DENY_MESSAGE) {
                  recordOverrideDeny();
                  botAuditLogger.logSandboxEscapeExpired(bot.id, { type: 'system' }, {
                    sessionId: session.id,
                    command,
                    requester,
                    source: 'timeout',
                    requestId: toolRequestId,
                  });
                  if (escalationEntry) {
                    botEscalationLedger.expire(escalationEntry.id, {
                      approver: { type: 'system' },
                      decision: 'expired',
                      source: 'timeout',
                    });
                  }
                } else {
                  recordOverrideDeny();
                  const approver = provenanceApprover(provenance, escapeActor);
                  const source = provenance?.source ?? 'self-approval';
                  botAuditLogger.logSandboxEscapeDenied(bot.id, approver, {
                    sessionId: session.id,
                    command,
                    requester,
                    reason: 'approver-denied',
                  });
                  if (escalationEntry) {
                    botEscalationLedger.settle(escalationEntry.id, 'denied', {
                      approver: provenance?.approver ?? escapeActor,
                      decision: 'deny',
                      source,
                    });
                  }
                }
                // U11 (KTD-15): admins-audience resolutions fan out terminal
                // notification cards (requester + non-clicking recipients).
                if (escalationEntry?.audience === 'admins') {
                  const settledEntry = botEscalationLedger.get(escalationEntry.id);
                  if (settledEntry && settledEntry.state !== 'pending') {
                    notifyEscalationResolved(settledEntry);
                  }
                }
              };

              /**
               * Self-ask route (KTD-15 self audience): the requester is an
               * owner or admin, so their own approval IS supervision. Used by
               * U9's MCP write/unknown classification for owner/admin
               * requesters. `command` is absent for MCP calls.
               */
              const askSelfRoute = async (
                escapeActor: BotActor,
                command?: string,
              ): Promise<PermissionResult> => {
                const runtime = this.runtimes.get(session.id);
                if (!runtime) {
                  return denyRouted('final', 'missing-runtime');
                }
                // U8 (KTD-15/KTD-16): register the escalation in the ledger
                // BEFORE the ask — the row is the durable record boot recovery
                // expires when the process dies mid-approval. Self audience
                // (the ledger re-asserts the invariant fail-safe). The ask
                // carries the ledger TTL when the tool input has no timeout of
                // its own, so the pending Promise is always bounded (KTD-17).
                const toolTimeout = extractToolTimeout(input);
                const escalationEntry = botEscalationLedger.createPending({
                  requestId: toolRequestId,
                  botId: bot.id,
                  sessionId: session.id,
                  audience: 'self',
                  requester: {
                    channel: escapeActor.channelKey ?? 'unknown',
                    channelUserId: escapeActor.channelUserId ?? '',
                    role: freshRole,
                  },
                  recipients: [{ userId: escapeActor.channelUserId ?? '', taskId: toolRequestId }],
                  rulePayload: {
                    toolName,
                    ...(command !== undefined && { command }),
                    ...(sdkOptions?.decisionReasonType !== undefined && {
                      decisionReasonType: sdkOptions.decisionReasonType,
                    }),
                  },
                  ...(toolTimeout !== undefined && { ttlMs: toolTimeout }),
                });
                const escapeResult = await askHuman({
                  timeout: toolTimeout ?? escalationApprovalTtlMs(),
                  audience: 'self',
                });
                settleEscapeAfterAsk(escapeActor, escapeResult, escalationEntry, command ?? '');
                return escapeResult;
              };

              /**
               * Remote-approval route (U11, KTD-15): register an admins-audience
               * pending with anti-spam bounds (KTD-19), card the approvers, and
               * await the decision. `reason` is 'escape' today; U9 routes
               * 'network'/'mcp-write' through the same path.
               */
              const escalateRemotely = async (
                escapeActor: BotActor,
                escalation: { reason: BotEscalationReason; recipientRoles: ReadonlySet<BotRoleKey> },
              ): Promise<PermissionResult> => {
                const runtime = this.runtimes.get(session.id);
                if (!runtime) {
                  return denyRouted('final', 'missing-runtime');
                }
                const command = typeof input.command === 'string' ? input.command : undefined;
                const requester = {
                  channel: escapeActor.channelKey ?? 'unknown',
                  channelUserId: escapeActor.channelUserId ?? '',
                  role: freshRole,
                };
                const denyImmediate = (reason: string, message: string): PermissionResult => {
                  recordOverrideDeny();
                  botAuditLogger.logSandboxEscapeDenied(bot.id, { type: 'system' }, {
                    sessionId: session.id,
                    command: command ?? '',
                    requester,
                    reason,
                  });
                  diagLog(
                    `[ChatService.botDeny] session=${session.id} tool=${toolName} toolUseId=${sdkOptions?.toolUseID ?? 'none'} reason=${reason} class=escalatable`,
                  );
                  return { behavior: 'deny', message };
                };

                // KTD-19 anti-spam, in order: generalized-signature dedupe →
                // per-user hourly cap → per-bot global pending cap → approvers.
                const signature = generalizedEscalationSignature({ reason: escalation.reason, toolName, command });
                if (botEscalationLedger.findPendingBySignature(bot.id, signature)) {
                  return denyImmediate(
                    'escalation-dedupe-pending',
                    'Denied (routing: escalatable). An approval request for this kind of command is already pending with a channel owner or admin. Do not retry; tell the user the request is awaiting approval.',
                  );
                }
                const hourly = botEscalationLedger.countCreatedSince(
                  bot.id,
                  escapeActor.channelUserId ?? '',
                  new Date(Date.now() - ESCALATION_USER_CAP_WINDOW_MS).toISOString(),
                );
                if (hourly >= ESCALATION_PER_USER_HOURLY_CAP) {
                  return denyImmediate(
                    'escalation-user-cap',
                    'Denied (routing: escalatable). Too many approval requests were sent for this user recently. Do not retry; tell the user to wait for the pending approvals or try again later.',
                  );
                }
                if (botEscalationLedger.countPending(bot.id) >= ESCALATION_GLOBAL_PENDING_CAP) {
                  return denyImmediate(
                    'escalation-global-cap',
                    'Denied (routing: escalatable). Too many approval requests are pending for this bot right now. Do not retry; tell the user to wait for the pending approvals.',
                  );
                }
                const recipients = botService
                  .listMembers(bot.id)
                  .filter((m) => m.channelKey === channel && escalation.recipientRoles.has(m.roleKey))
                  .map((m) => ({ userId: m.channelUserId, taskId: toolRequestId }));
                if (recipients.length === 0) {
                  return denyImmediate(
                    'escalation-no-approvers',
                    'Denied (routing: escalatable). This action needs a channel owner or admin to approve it, but this channel has none. Tell the user a desktop administrator must appoint one first.',
                  );
                }

                // KTD-18: exact-match always-allow rules, computed once and
                // pinned into the ledger payload — the card shows exactly
                // what "始终允许" would persist. Suppressed suggestion types
                // (setMode/addDirectories/replaceRules) hide the button and
                // are logged (they are dropped, never applied).
                const alwaysAllow = computeAlwaysAllowRules({
                  toolName,
                  command,
                  suggestions: sdkOptions?.suggestions,
                });
                if (alwaysAllow.suppressedReason) {
                  diagLog(
                    `[ChatService] always-allow suppressed session=${session.id} requestId=${toolRequestId} reason=${alwaysAllow.suppressedReason}`,
                  );
                }
                const toolTimeout = extractToolTimeout(input);
                // No durable ledger row → no remote approval (fail closed):
                // boot recovery could not expire a card-less approval.
                const escalationEntry = botEscalationLedger.createPending({
                  requestId: toolRequestId,
                  botId: bot.id,
                  sessionId: session.id,
                  audience: 'admins',
                  requester,
                  recipients,
                  rulePayload: {
                    toolName,
                    ...(command !== undefined && { command }),
                    ...(sdkOptions?.decisionReasonType !== undefined && {
                      decisionReasonType: sdkOptions.decisionReasonType,
                    }),
                    dedupeSignature: signature,
                    alwaysAllowRules: alwaysAllow.rules,
                  },
                  ...(toolTimeout !== undefined && { ttlMs: toolTimeout }),
                });
                if (!escalationEntry) {
                  return denyImmediate('escalation-ledger-write-failed', botDenialMessage('final'));
                }
                // Cards to the approvers (fire-and-forget; the ask is the authority).
                notifyEscalationPending(escalationEntry);
                const escapeResult = await askHuman({
                  timeout: toolTimeout ?? escalationApprovalTtlMs(),
                  audience: 'admins',
                });
                settleEscapeAfterAsk(escapeActor, escapeResult, escalationEntry, command ?? '');
                return escapeResult;
              };

              // ---- Bash: sandbox default-allow + escape routing (KTD-10) ----
              if (toolName === 'Bash' && typeof input.command === 'string' && channelUserId) {
                if (input.dangerouslyDisableSandbox === true) {
                  // Out-of-sandbox request (F2). Passlist hits never reach
                  // this branch: the passlist is compiled into
                  // settings.permissions.allow (U4) and the SDK structural
                  // rule engine auto-allows matching escape requests upstream
                  // (proven against the real CLI in sdk-rule-contract.test).
                  // Routing (U11): owner/admin bypass approval; regular
                  // members escalate to the channel's owner/admin cards.
                  // Feishu stays on phase-1 behavior until the card flow is
                  // aligned (Scope Boundaries).
                  //
                  // U6 (KTD-22): the escape-routing decision is an audit
                  // decision point — requested fires for every escape request;
                  // the resolution event depends on the route.
                  const escapeActor = channel
                    ? { type: channel, channelKey: channel, channelUserId } as const
                    : null;
                  if (escapeActor) {
                    botAuditLogger.logSandboxEscapeRequested(bot.id, escapeActor, {
                      sessionId: session.id,
                      command: input.command,
                      role: freshRole,
                    });
                  }
                  if (escapeActor && isOwnerOrAdmin(freshRole)) {
                    botAuditLogger.logSandboxEscapeApproved(bot.id, escapeActor, {
                      sessionId: session.id,
                      command: input.command,
                      requester: {
                        channel: escapeActor.channelKey ?? 'unknown',
                        channelUserId: escapeActor.channelUserId ?? '',
                        role: freshRole,
                      },
                      source: 'role-bypass',
                    });
                    return { behavior: 'allow' as const, updatedInput: input };
                  }
                  // KTD-19: the per-turn override-deny cap short-circuits
                  // BEFORE any new pending/ask — the model gets an explicit
                  // stop-retry instruction.
                  if ((this.sessionOverrideDenies.get(session.id) ?? 0) >= OVERRIDE_DENY_CAP_PER_TURN) {
                    recordOverrideDeny();
                    if (escapeActor) {
                      botAuditLogger.logBashDenied(bot.id, escapeActor, {
                        sessionId: session.id,
                        command: input.command,
                        reason: 'override-deny-cap',
                        routingClass: 'escalatable',
                      });
                    }
                    diagLog(
                      `[ChatService.botDeny] session=${session.id} tool=${toolName} toolUseId=${sdkOptions?.toolUseID ?? 'none'} reason=override-deny-cap class=escalatable`,
                    );
                    return {
                      behavior: 'deny' as const,
                      message:
                        'STOP. This turn has reached the limit of out-of-sandbox requests. Do NOT retry this command or any variant of it with a sandbox override. Tell the user which actions still need owner/admin approval and wait for their decision.',
                    };
                  }
                  // Regular members (and unknown roles): escalate to the
                  // channel's owner/admin on WeCom; other channels keep the
                  // phase-1 deny until their card flow is aligned.
                  if (channel !== 'wecom') {
                    if (escapeActor) {
                      botAuditLogger.logSandboxEscapeDenied(bot.id, { type: 'system' }, {
                        sessionId: session.id,
                        command: input.command,
                        requester: { channel: escapeActor.channelKey, channelUserId, role: freshRole },
                        reason: 'out-of-sandbox-normal',
                      });
                    }
                    return denyRouted('escalatable', 'out-of-sandbox-normal');
                  }
                  return escalateRemotely(escapeActor as BotActor, {
                    reason: 'escape',
                    recipientRoles: new Set<BotRoleKey>(['owner', 'admin']),
                  });
                }
                // Sandboxed bash: default-allow when the probe passed (the
                // sandbox is the containment, R2); on a degraded host the
                // unmatched command is role-routed (R5/F3/AE5).
                if (!isSandboxDegraded()) {
                  return { behavior: 'allow' as const, updatedInput: input };
                }
                if (isOwnerOrAdmin(freshRole)) {
                  return { behavior: 'allow' as const, updatedInput: input };
                }
                if (channel) {
                  botAuditLogger.logBashDenied(
                    bot.id,
                    { type: channel, channelKey: channel, channelUserId },
                    {
                      sessionId: session.id,
                      command: input.command,
                      reason: 'degraded-platform-bash',
                      routingClass: 'sandbox-unavailable',
                    },
                  );
                }
                return denyRouted('sandbox-unavailable', 'degraded-platform-bash');
              }

              const rolePolicyFresh = botService.getRolePolicy(bot.id);

              // ---- File tools: realpath verification layer (KTD-5), ----
              // ---- fail-closed for non-owner roles (KTD-1)            ----
              if (FILE_TOOLS.has(toolName) && gatePathContext) {
                const verdict = verifyBotFileToolAccess(
                  gatePathContext,
                  toolName,
                  input,
                  isOwnerOrAdmin(freshRole),
                );
                if (!verdict.allowed) {
                  if (channel && channelUserId) {
                    botAuditLogger.logFileAccessDenied(
                      bot.id,
                      { type: channel, channelKey: channel, channelUserId },
                      {
                        sessionId: session.id,
                        toolName,
                        reason: verdict.reason ?? 'path-denied',
                        path: auditPathFromToolInput(input),
                      },
                    );
                  }
                  return denyRouted('final', verdict.reason ?? 'path-denied');
                }
                // U9 (R11/KTD-29): the admin write boundary inside `.claude`
                // is the CLOSED capability-dir set (skills/, agents/). The
                // derived sandbox enforces it for bash, but the Edit/Write
                // tools run in the CLI process — the gate itself must deny
                // admin `.claude` writes outside the closed set (plugins/,
                // hooks, .mcp.json, settings files). The owner stays
                // unrestricted; normal members never reach here (the
                // verification layer denies their .claude writes upstream).
                // Reads are unaffected — the closed set bounds writes only.
                if (CAPABILITY_WRITE_TOOLS.has(toolName)) {
                  const rawPath = typeof input.file_path === 'string'
                    ? input.file_path
                    : typeof input.notebook_path === 'string'
                      ? input.notebook_path
                      : undefined;
                  if (rawPath) {
                    const canonical = verdict.canonical ?? canonicalizeBotPath(gatePathContext.workspaceFolder, rawPath);
                    const capabilityDir = capabilityDirForPath(gatePathContext.workspaceFolder, canonical);
                    const claudeRoot = path.join(gatePathContext.workspaceFolder, '.claude') + path.sep;
                    if (freshRole === 'admin' && canonical.startsWith(claudeRoot) && !capabilityDir) {
                      if (channel && channelUserId) {
                        botAuditLogger.logFileAccessDenied(
                          bot.id,
                          { type: channel, channelKey: channel, channelUserId },
                          {
                            sessionId: session.id,
                            toolName,
                            reason: 'admin-capability-dir-closed',
                            path: canonical,
                          },
                        );
                      }
                      return denyRouted('final', 'admin-capability-dir-closed');
                    }
                    // U6 (KTD-22/KTD-29): an ALLOWED write into a workspace
                    // capability dir (`.claude/skills`, `.claude/agents`) is a
                    // capability-surface change — audit it (the desktop banner
                    // surface rides this event; only admin/owner verdicts can
                    // reach this point inside `.claude`).
                    if (channel && channelUserId && capabilityDir) {
                      botAuditLogger.logCapabilityDirWrite(
                        bot.id,
                        { type: channel, channelKey: channel, channelUserId },
                        {
                          sessionId: session.id,
                          toolName,
                          path: canonical,
                          capabilityDir,
                          role: freshRole,
                        },
                      );
                    }
                  }
                }
              }

              // ---- Skill: bot-level config (R8/KTD-14). The SDK context  ----
              // ---- filter (U5) hides unmounted skills upstream; this     ----
              // ---- gate check is the backstop for the explicit deny     ----
              // ---- rules compiled at spawn. Unmounted-but-not-disabled  ----
              // ---- skills are allowed here — hiding is the filter's job ----
              // ---- (no double-negative between the layers).             ----
              if (toolName === 'Skill') {
                const skillCheck = evaluateSkillDisabled(rolePolicyFresh?.disabledSkills ?? [], input);
                if (!skillCheck.skillName) {
                  return denyRouted('final', 'missing-skill-name');
                }
                if (skillCheck.disabled) {
                  return denyRouted('final', 'skill-disabled');
                }
              }

              // AskUserQuestion always requires user input, regardless of policy
              if (toolName === 'AskUserQuestion') {
                const runtime = this.runtimes.get(session.id);
                if (!runtime) {
                  return denyRouted('final', 'missing-runtime');
                }
                const questions = mapAskUserQuestionInput(input);
                const timeout = extractToolTimeout(input);
                return runtime.requestToolQuestion(sdkOptions.toolUseID, questions, input, {
                  timeout,
                  signal: sdkOptions.signal,
                });
              }

              // ---- MCP tools: classification gating (U9, R10/KTD-20). ------
              // MCP server processes run OUTSIDE the session sandbox, so this
              // gate is the only boundary. Read-class tools fall through to
              // the category policy below; write-class and unknown-class
              // enter the escalation path (unknown is never allow-all — the
              // pre-U9 fall-through is gone). Routing mirrors KTD-15: normal
              // → admins-audience cards (WeCom); owner/admin → self-ask;
              // Feishu keeps the phase-1 deny until its card flow is aligned
              // (Scope Boundaries deferral).
              const mcpTool = parseMcpToolName(toolName, mcpServerNames);
              if (mcpTool) {
                const annotations = await this.getSessionMcpToolAnnotations(session.id);
                const mcpClass = classifyMcpTool({
                  tool: mcpTool.tool,
                  annotations: annotations.get(toolName),
                  override: rolePolicyFresh?.mcpClassification?.[mcpTool.server],
                });
                if (mcpClass !== 'read') {
                  const mcpActor = channel && channelUserId
                    ? { type: channel, channelKey: channel, channelUserId } as const
                    : null;
                  if (mcpActor) {
                    botAuditLogger.logSandboxEscapeRequested(bot.id, mcpActor, {
                      sessionId: session.id,
                      command: toolName,
                      role: freshRole,
                    });
                  }
                  if (freshRole === 'owner' || freshRole === 'admin') {
                    // freshRole requires channel + channelUserId, so the actor
                    // is non-null here (KTD-15 self-audience invariant).
                    return askSelfRoute(mcpActor as BotActor, undefined);
                  }
                  if (!mcpActor) {
                    return denyRouted('final', 'missing-identity');
                  }
                  if (channel !== 'wecom') {
                    botAuditLogger.logSandboxEscapeDenied(bot.id, { type: 'system' }, {
                      sessionId: session.id,
                      command: toolName,
                      requester: { channel: mcpActor.channelKey ?? 'unknown', channelUserId: mcpActor.channelUserId ?? '', role: freshRole },
                      reason: 'mcp-write-channel-deferred',
                    });
                    return denyRouted('escalatable', 'mcp-write-channel-deferred');
                  }
                  return escalateRemotely(mcpActor as BotActor, {
                    reason: 'mcp-write',
                    recipientRoles: new Set<BotRoleKey>(['owner', 'admin']),
                  });
                }
                // read-class: fall through to the category policy tail below.
              }

              // Category policy still governs non-Bash, non-file tools
              // (network / subagents / read-class MCP — U9 routes write and
              // unknown MCP classes above).
              // File tools are owned by the derived rules + verification
              // layer above: the legacy category defaults (e.g. SAFE's
              // fileWrite deny) must not re-deny what the derived surface
              // allows (R1 — regular members write inside their own data dir).
              if (!FILE_TOOLS.has(toolName)) {
                const decision = evaluateBotToolPermission(
                  rolePolicyFresh?.normalToolPolicy ?? SAFE_PRESET,
                  freshRole,
                  toolName,
                );
                if (decision === 'deny') {
                  const reason = getToolPermissionDenialReason(rolePolicyFresh?.normalToolPolicy, toolName);
                  return denyRouted('final', reason ?? 'deny');
                }
                if (decision === 'ask') {
                  return askHuman();
                }
              }

              return { behavior: 'allow' as const, updatedInput: input };
            };
          }
        } else {
          // Fail-closed (R16/AE7): the session is bound to a bot that no longer
          // exists. Deny every tool call instead of falling through to the
          // legacy workspace-scoped fallback, which would leave the session
          // unrestricted. Generic denial message, same as other bot denials.
          diagLog(
            `[ChatService.botDeny] session=${session.id} botId=${session.botId} reason=dangling-bot-id`,
          );
          options.canUseTool = async (
            toolName: string,
            _input: Record<string, unknown>,
            sdkOptions?: { toolUseID?: string },
          ) => {
            diagLog(
              `[ChatService.botDeny] session=${session.id} tool=${toolName} toolUseId=${sdkOptions?.toolUseID ?? 'none'} reason=dangling-bot-id`,
            );
            return {
              behavior: 'deny' as const,
              message: "I can't do that in this workspace.",
            };
          };
        }
      }

      // Legacy workspace-scoped fallback for bot sessions created before migration
      // or without an explicit bot binding.
      if (!options.canUseTool) {
        const resolved = resolveEffectivePolicy(workspace);
        const policy = resolved.policy;
        const wecomBotUser = this.getWecomBotUserForSession(session.id);
        const canonicalUserId = botUserId
          ?? (wecomBotUser?.plaintextUserId ?? wecomBotUser?.channelUserId);

        let skillContext: import('./bot-skill-policy.js').SkillPolicyContext | undefined;

        if (canonicalUserId) {
          const userDirName = canonicalUserId;
          const wsUsers = botService.listChannelUsersForWorkspace(workspace.id, 'wecom');
          const knownUserDirNames = wsUsers.map((u) => u.plaintextUserId ?? u.channelUserId);

          pathContext = createPathPolicyContext(
            workspace,
            userDirName,
            knownUserDirNames,
            false,
            workspace.settings.sensitiveFileDenylist ?? [],
          );
          const isolation = workspace.settings.wecomBotIsolation;
          const isAdmin = isolation?.adminUserIds?.includes(canonicalUserId) ?? false;
          pathContext = {
            ...pathContext,
            isAdminOrOwner: isAdmin,
          };
          const skillPolicy: BotRolePolicy = {
            ...createDefaultBotRolePolicy('normal'),
            skillAllowlist: isolation?.defaultAllowedSkills ?? [],
          };
          skillContext = { policy: skillPolicy, isAdminOrOwner: isAdmin };
        }

        options.canUseTool = async (
          toolName: string,
          input: Record<string, unknown>,
          sdkOptions: {
            signal: AbortSignal;
            suggestions?: import('@anthropic-ai/claude-agent-sdk').PermissionUpdate[];
            title?: string;
            description?: string;
            toolUseID: string;
            decisionReasonType?: string;
          },
        ) => {
          // Browser tools never run in bot sessions — this deny must precede
          // the policy evaluation and the 'unknown' fall-through below.
          const browserDeny = denyBrowserToolInBotSession(session.id, toolName, sdkOptions?.toolUseID);
          if (browserDeny) return browserDeny;

          const decision = evaluateToolPermission(policy, toolName, pathContext?.isAdminOrOwner ?? false);
          if (decision === 'deny') {
            const reason = getToolPermissionDenialReason(policy, toolName);
            diagLog(
              `[ChatService.botDeny] session=${session.id} tool=${toolName} toolUseId=${sdkOptions?.toolUseID ?? 'none'} reason=${reason ?? 'deny'}`,
            );
            return {
              behavior: 'deny' as const,
              message: "I can't do that in this workspace.",
            };
          }

          if (!canonicalUserId && IDENTITY_SENSITIVE_TOOLS.has(toolName)) {
            diagLog(
              `[ChatService.botDeny] session=${session.id} tool=${toolName} toolUseId=${sdkOptions?.toolUseID ?? 'none'} reason=missing-identity`,
            );
            return {
              behavior: 'deny' as const,
              message: "I can't do that in this workspace.",
            };
          }

          if (FILE_TOOLS.has(toolName) && pathContext) {
            const r = validateToolInput(pathContext, toolName, input);
            if (!r.allowed) {
              diagLog(
                `[ChatService.botDeny] session=${session.id} tool=${toolName} toolUseId=${sdkOptions?.toolUseID ?? 'none'} reason=${r.reason ?? 'path-denied'}`,
              );
              if (session.botId && canonicalUserId && (session.source === 'wecom' || session.source === 'feishu')) {
                botAuditLogger.logFileAccessDenied(
                  session.botId,
                  { type: session.source, channelKey: session.source, channelUserId: canonicalUserId },
                  {
                    sessionId: session.id,
                    toolName,
                    reason: r.reason ?? 'path-denied',
                    path: auditPathFromToolInput(input),
                  },
                );
              }
              return {
                behavior: 'deny' as const,
                message: "I can't do that in this workspace.",
              };
            }
          }

          if (toolName === 'Skill' && skillContext) {
            const r = evaluateSkill(skillContext, toolName, input);
            if (!r.allowed) {
              diagLog(
                `[ChatService.botDeny] session=${session.id} tool=${toolName} toolUseId=${sdkOptions?.toolUseID ?? 'none'} reason=${r.reason ?? 'skill-denied'}`,
              );
              return {
                behavior: 'deny' as const,
                message: "I can't do that in this workspace.",
              };
            }
          }

          if (toolName === 'AskUserQuestion') {
            const runtime = this.runtimes.get(session.id);
            if (!runtime) {
              diagLog(
                `[ChatService.botDeny] session=${session.id} tool=${toolName} toolUseId=${sdkOptions?.toolUseID ?? 'none'} reason=missing-runtime`,
              );
              return {
                behavior: 'deny' as const,
                message: "I can't do that in this workspace.",
              };
            }
            const questions = mapAskUserQuestionInput(input);
            const timeout = extractToolTimeout(input);
            return runtime.requestToolQuestion(sdkOptions.toolUseID, questions, input, {
              timeout,
              signal: sdkOptions.signal,
            });
          }

          if (decision === 'ask') {
            const runtime = this.runtimes.get(session.id);
            if (!runtime) {
              diagLog(
                `[ChatService.botDeny] session=${session.id} tool=${toolName} toolUseId=${sdkOptions?.toolUseID ?? 'none'} reason=missing-runtime`,
              );
              return {
                behavior: 'deny' as const,
                message: "I can't do that in this workspace.",
              };
            }
            const timeout = extractToolTimeout(input);
            return runtime.requestToolApproval(sdkOptions.toolUseID, toolName, sdkOptions.toolUseID, input, {
              title: sdkOptions.title,
              description: sdkOptions.description,
              suggestions: sdkOptions.suggestions,
              timeout,
              signal: sdkOptions.signal,
              decisionReasonType: sdkOptions.decisionReasonType,
            });
          }

          return { behavior: 'allow' as const, updatedInput: input };
        };
      }
    }

    if (session.isDraft) {
      // First message to a draft session — create a new SDK session with our ID
      options.sessionId = session.id;
      options.title = session.name;
    } else {
      // Resume existing SDK session
      options.resume = session.id;
    }

    return options;
  }

  private async *wrapStream(
    stream: AsyncGenerator<SDKMessage>,
  ): AsyncGenerator<SDKMessage> {
    for await (const msg of stream) {
      yield msg;
    }
  }

  private mapSdkSessionInfo(sdkSession: SDKSessionInfo, workspaceId: string): ChatSession {
    return {
      id: sdkSession.sessionId,
      workspaceId,
      name: sdkSession.customTitle || sdkSession.summary || 'Untitled Session',
      isDraft: false,
      createdAt: sdkSession.createdAt ? new Date(sdkSession.createdAt).toISOString() : new Date().toISOString(),
      updatedAt: sdkSession.lastModified ? new Date(sdkSession.lastModified).toISOString() : new Date().toISOString(),
      summary: sdkSession.summary,
      lastModified: sdkSession.lastModified,
      firstPrompt: sdkSession.firstPrompt,
      gitBranch: sdkSession.gitBranch,
      customTitle: sdkSession.customTitle,
    };
  }
}

export class ChatError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = 'ChatError';
  }
}

export const chatService = new ChatService();
