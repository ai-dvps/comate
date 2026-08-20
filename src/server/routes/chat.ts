import { Router } from 'express';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { chatService, ChatError } from '../services/chat-service.js';
import { store } from '../storage/sqlite-store.js';
import { botService } from '../services/bot-service.js';
import { browserService } from '../services/browser-service.js';
import { BROWSER_TOOL_NAMES } from '../services/browser-tool-names.js';
import { clearBrowserGateSession } from '../services/browser-gate-state.js';
import { diagLog } from '../utils/diag-logger.js';
import { getLoopbackAuth } from '../services/security/loopback-auth.js';
import type { BotUser } from '../models/bot-user.js';
import { loadWorkflowState, listWorkflowRunIds } from '../services/workflow-loader.js';
import { validateQuestionAnswers } from '../utils/question-answer-validation.js';
import { deriveFallbackSessionTitle } from '../utils/session-title.js';

const router = Router({ mergeParams: true });

/**
 * Output styles are an open set (CLI 2.1.237 built-ins: default, explanatory,
 * learning, concise — plus workspace/user custom styles), so validate shape
 * only: non-empty, reasonably bounded identifier.
 */
function isValidOutputStyle(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 64;
}
const WORKFLOW_ID_RE = /^[a-zA-Z0-9_-]+$/;
diagLog('[Route] chat module loaded');

// GET /api/workspaces/:id/sessions
router.get('/sessions', async (req, res) => {
  try {
    const workspaceId = (req.params as { id: string }).id;
    const rawThreshold = req.query.archive_threshold_days;
    const parsedThreshold = typeof rawThreshold === 'string' && rawThreshold !== ''
      ? parseInt(rawThreshold, 10)
      : NaN;
    const archiveThresholdDays = !isNaN(parsedThreshold) && parsedThreshold > 0
      ? parsedThreshold
      : undefined;

    const sessions = await chatService.listSessions(workspaceId, { archiveThresholdDays });
    res.json({ sessions });
  } catch (error) {
    console.error('Failed to list sessions:', error);
    if (error instanceof ChatError) {
      res.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// POST /api/workspaces/:id/sessions
router.post('/sessions', async (req, res) => {
  try {
    const workspaceId = (req.params as { id: string }).id;
    const { name, prompt, approvalMode, providerId, backend, fastMode, outputStyle } = req.body;

    const hasName = typeof name === 'string' && name.trim() !== '';
    const hasPrompt = typeof prompt === 'string' && prompt.trim() !== '';
    if (!hasName && !hasPrompt) {
      res.status(400).json({ error: 'name or prompt is required' });
      return;
    }

    if (approvalMode !== undefined && !['auto', 'readonly', 'manual'].includes(approvalMode)) {
      res.status(400).json({ error: 'approvalMode must be one of: auto, readonly, manual' });
      return;
    }
    if (backend !== undefined && !['claude', 'opencode'].includes(backend)) {
      res.status(400).json({ error: 'backend must be one of: claude, opencode' });
      return;
    }
    if (fastMode !== undefined && typeof fastMode !== 'boolean') {
      res.status(400).json({ error: 'fastMode must be a boolean' });
      return;
    }
    if (outputStyle !== undefined && !isValidOutputStyle(outputStyle)) {
      res.status(400).json({ error: 'outputStyle must be a non-empty string of at most 64 characters' });
      return;
    }

    const session = await chatService.createSession({
      workspaceId,
      name: hasName ? name.trim() : deriveFallbackSessionTitle(prompt as string),
      approvalMode,
      providerId,
      backend,
      fastMode,
      ...(outputStyle !== undefined && { outputStyle }),
      source: 'gui',
    });
    res.status(201).json(session);
  } catch (error) {
    console.error('Failed to create session:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// PUT /api/workspaces/:id/sessions/:sessionId
router.put('/sessions/:sessionId', async (req, res) => {
  try {
    const workspaceId = (req.params as unknown as { id: string }).id;
    const sessionId = req.params.sessionId;
    const { name, isWip, providerId, isArchived, fastMode, backend, outputStyle } = req.body;

    const hasName = name !== undefined && typeof name === 'string' && name.trim() !== '';
    const hasWip = isWip !== undefined && typeof isWip === 'boolean';
    const hasProviderId = providerId !== undefined;
    const hasArchived = isArchived !== undefined && typeof isArchived === 'boolean';
    const hasFastMode = fastMode !== undefined && typeof fastMode === 'boolean';
    const hasBackend = backend !== undefined;
    const hasOutputStyle = outputStyle !== undefined;
    if (hasOutputStyle && outputStyle !== null && !isValidOutputStyle(outputStyle)) {
      res.status(400).json({ error: 'outputStyle must be a non-empty string of at most 64 characters' });
      return;
    }

    if (!hasName && !hasWip && !hasProviderId && !hasArchived && !hasFastMode && !hasBackend && !hasOutputStyle) {
      res.status(400).json({ error: 'name, isWip, providerId, isArchived, fastMode, outputStyle, or backend is required' });
      return;
    }

    const input: { name?: string; isWip?: boolean; providerId?: string; isArchived?: boolean; fastMode?: boolean; outputStyle?: string | null; backend?: string } = {};
    if (hasName) input.name = name.trim();
    if (hasWip) input.isWip = isWip;
    if (hasProviderId) input.providerId = providerId;
    if (hasArchived) input.isArchived = isArchived;
    if (hasFastMode) input.fastMode = fastMode;
    if (hasOutputStyle) input.outputStyle = outputStyle === null ? null : (outputStyle as string);
    if (hasBackend) input.backend = backend;

    const session = await chatService.updateSession(sessionId, input, workspaceId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    res.json(session);
  } catch (error) {
    console.error('Failed to update session:', error);
    if (error instanceof ChatError) {
      res.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
    res.status(500).json({ error: 'Failed to update session' });
  }
});

// DELETE /api/workspaces/:id/sessions/:sessionId
router.delete('/sessions/:sessionId', async (req, res) => {
  try {
    const workspaceId = (req.params as unknown as { id: string }).id;
    const sessionId = req.params.sessionId;
    // Unlink any todo tied to this session before deleting
    store.unlinkTodoBySessionId(sessionId);
    const success = await chatService.deleteSession(sessionId, workspaceId);
    if (!success) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    // Browser teardown path 1 (KTD-1): the per-session browser view and the
    // U4 gate state die with the chat session (the on-disk shell partition is
    // wiped here — remembered login survives only via the workspace's
    // value-only-in browserSiteAuth store, U8).
    clearBrowserGateSession(sessionId);
    await browserService.teardownSession(sessionId);
    res.json({ ok: true });
  } catch (error) {
    console.error('Failed to delete session:', error);
    if (error instanceof ChatError) {
      res.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

// POST /api/workspaces/:id/sessions/:sessionId/fork
// Fork an existing session into a new branched session
router.post('/sessions/:sessionId/fork', async (req, res) => {
  try {
    const workspaceId = (req.params as unknown as { id: string }).id;
    const sessionId = req.params.sessionId;
    const result = await chatService.forkSession(sessionId, workspaceId);
    res.status(201).json(result);
  } catch (error) {
    console.error('Failed to fork session:', error);
    if (error instanceof ChatError) {
      res.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
    res.status(500).json({ error: 'Failed to fork session' });
  }
});

// GET /api/workspaces/:id/sessions/:sessionId/wecom-user
// Returns WeCom user info for bot sessions
router.get('/sessions/:sessionId/wecom-user', async (req, res) => {
  try {
    const workspaceId = (req.params as unknown as { id: string }).id;
    const sessionId = req.params.sessionId;
    // U12 (KTD-28): the middleware already enforces token↔session binding for
    // session capability tokens; this is the in-handler backstop. Desktop
    // credential callers (ChatPanel) may query any session.
    const auth = getLoopbackAuth(req);
    if (auth?.kind === 'session' && auth.sessionId !== sessionId) {
      res.status(403).json({ error: 'session_mismatch', message: 'Token is not valid for this session.' });
      return;
    }
    const user = findChannelUserForSession(workspaceId, 'wecom', sessionId);
    if (!user) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json({
      userId: user.plaintextUserId ?? user.channelUserId,
    });
  } catch (error) {
    console.error('Failed to get WeCom user:', error);
    if (error instanceof ChatError) {
      res.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
    res.status(500).json({ error: 'Failed to get WeCom user' });
  }
});

// GET /api/workspaces/:id/sessions/:sessionId/feishu-user
// Returns Feishu user info for bot sessions
router.get('/sessions/:sessionId/feishu-user', async (req, res) => {
  try {
    const workspaceId = (req.params as unknown as { id: string }).id;
    const sessionId = req.params.sessionId;
    const user = findChannelUserForSession(workspaceId, 'feishu', sessionId);
    if (!user) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json({
      userId: user.plaintextUserId ?? user.channelUserId,
      name: user.plaintextUserId ?? null,
    });
  } catch (error) {
    console.error('Failed to get Feishu user:', error);
    if (error instanceof ChatError) {
      res.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
    res.status(500).json({ error: 'Failed to get Feishu user' });
  }
});

function findChannelUserForSession(
  workspaceId: string,
  channelKey: 'wecom' | 'feishu',
  sessionId: string,
): BotUser | null {
  const users = botService.listChannelUsersForWorkspace(workspaceId, channelKey);
  for (const user of users) {
    const sessions = store.listUserSessionsByUser(user.id);
    if (sessions.some((s) => s.sessionId === sessionId)) {
      return user;
    }
  }
  return null;
}

// POST /api/workspaces/:id/sessions/:sessionId/approvals/:requestId
// Resolve a pending approval or question
router.post('/sessions/:sessionId/approvals/:requestId', async (req, res) => {
  const sessionId = req.params.sessionId;
  const requestId = req.params.requestId;
  const { behavior, updatedPermissions, answers } = req.body;

  if (!behavior || (behavior !== 'allow' && behavior !== 'deny' && behavior !== 'later')) {
    res.status(400).json({ error: "behavior must be 'allow', 'deny', or 'later'" });
    return;
  }

  try {
    // U8 (KTD-15): never spawn a runtime to resolve an approval — a pending
    // approval cannot exist without a live runtime, so a missing runtime
    // means the approval is already gone (timeout/stop/close). The desktop
    // funnel shares the gate's provenance writer with the card flow: the
    // resolution carries its source and the gate writes the same-shaped
    // audit row either way.
    const runtime = chatService.getRuntimeIfExists(sessionId);
    if (!runtime) {
      res.status(404).json({ error: 'No active approval for this session', code: 'APPROVAL_NOT_FOUND' });
      return;
    }
    const pending = runtime.getPendingCardState(requestId);
    if (!pending) {
      res.status(409).json({ error: 'Approval is no longer pending', code: 'APPROVAL_NOT_FOUND' });
      return;
    }
    if (
      behavior === 'later'
      && (pending.type !== 'approval' || pending.toolName !== BROWSER_TOOL_NAMES.setDeclaration)
    ) {
      res.status(400).json({ error: 'Decide later is only available for declaration approvals' });
      return;
    }

    let result: PermissionResult;
    if (behavior === 'allow') {
      if (pending.type === 'question') {
        const validation = validateQuestionAnswers(pending.questions, answers);
        if (!validation.valid) {
          res.status(400).json({ error: validation.error });
          return;
        }
        // AskUserQuestion response
        result = {
          behavior: 'allow',
          updatedInput: { questions: pending.questions, answers: validation.answers },
        };
      } else {
        result = { behavior: 'allow', updatedPermissions };
      }
    } else {
      result = {
        behavior: 'deny',
        message: req.body.message || (behavior === 'later' ? 'User decided later.' : 'User denied this tool call.'),
      };
    }

    diagLog(`[Route] resolveApproval ${requestId} behavior=${behavior} source=desktop`);
    const resolved = runtime.resolveApproval(requestId, result, {
      source: 'desktop', ...(behavior === 'later' ? { decision: 'later' as const } : behavior === 'deny' ? { decision: 'deny' as const } : {}),
      approver: { type: 'user' },
    });
    if (!resolved) {
      res.status(409).json({ error: 'Approval is no longer pending', code: 'APPROVAL_NOT_FOUND' });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('Failed to resolve approval:', error);
    if (error instanceof ChatError) {
      res.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
    res.status(500).json({ error: 'Failed to resolve approval' });
  }
});

// POST /api/workspaces/:id/sessions/:sessionId/interrupt
// One-click clear-all: interrupt the in-flight turn (if any) and stop every
// tracked background task. A missing runtime means nothing is running —
// stopping nothing is success, and a stale stop must never spawn a fresh
// Claude process (hence getRuntimeIfExists, not getOrCreateRuntime).
router.post('/sessions/:sessionId/interrupt', async (req, res) => {
  const sessionId = req.params.sessionId;

  try {
    const runtime = chatService.getRuntimeIfExists(sessionId);
    if (!runtime) {
      res.json({ ok: true });
      return;
    }
    await runtime.stopAll();
    res.json({ ok: true });
  } catch (error) {
    console.error('Failed to interrupt:', error);
    if (error instanceof ChatError) {
      res.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
    res.status(500).json({ error: 'Failed to interrupt' });
  }
});

// POST /api/workspaces/:id/sessions/:sessionId/tasks/:taskId/stop
// Stop one Claude SDK background task without interrupting the foreground turn
// or activating the Session-wide Stop fence.
router.post('/sessions/:sessionId/tasks/:taskId/stop', async (req, res) => {
  const workspaceId = (req.params as unknown as { id: string }).id;
  const { sessionId, taskId } = req.params;

  try {
    const runtime = chatService.getRuntimeIfExists(sessionId);
    if (!runtime) {
      res.json({ ok: true, stopped: false });
      return;
    }
    if (runtime.getStatus().workspaceId !== workspaceId) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (runtime.getBackendId() !== 'claude') {
      res.status(409).json({
        error: 'Individual background task stopping is only supported for Claude Code sessions',
        code: 'TASK_STOP_UNSUPPORTED',
      });
      return;
    }

    const stopped = await runtime.stopBackgroundTask(taskId);
    res.json({ ok: true, stopped });
  } catch (error) {
    diagLog(
      `[Route] Failed to stop background task session=${sessionId} task=${taskId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    res.status(500).json({ error: 'Failed to stop background task' });
  }
});

// POST /api/workspaces/:id/sessions/:sessionId/approval-mode
// Change the approval mode for a session (mid-session or persist for next start)
router.post('/sessions/:sessionId/approval-mode', async (req, res) => {
  const sessionId = req.params.sessionId;
  const { approvalMode } = req.body;

  if (!approvalMode || !['auto', 'readonly', 'manual'].includes(approvalMode)) {
    res.status(400).json({ error: 'approvalMode must be one of: auto, readonly, manual' });
    return;
  }

  try {
    // Persist to store so it survives restart
    store.updateLocalSession(sessionId, { approvalMode });

    // If runtime is active, update it in-memory
    const runtime = chatService.getRuntimeIfExists(sessionId);
    const active = !!runtime;
    if (runtime) {
      runtime.setApprovalMode(approvalMode);
    }

    diagLog(`[Route] setApprovalMode sessionId=${sessionId} mode=${approvalMode} active=${active}`);
    res.json({ ok: true, active });
  } catch (error) {
    console.error('Failed to set approval mode:', error);
    res.status(500).json({ error: 'Failed to set approval mode' });
  }
});

// GET /api/workspaces/:id/sessions/:sessionId/workflows
// List workflow runIds that have on-disk state for this session.
router.get('/sessions/:sessionId/workflows', async (req, res) => {
  try {
    const workspaceId = (req.params as unknown as { id: string }).id;
    const sessionId = req.params.sessionId;
    const workspace = await store.get(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    if (!WORKFLOW_ID_RE.test(sessionId)) {
      res.status(400).json({ error: 'Invalid sessionId' });
      return;
    }
    const localSession = store.getLocalSession(sessionId);
    if (!localSession || localSession.workspaceId !== workspaceId) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const runIds = await listWorkflowRunIds(workspace.folderPath, sessionId);
    res.json({ runIds });
  } catch (error) {
    console.error('Failed to list workflows:', error);
    res.status(500).json({ error: 'Failed to list workflows' });
  }
});

// GET /api/workspaces/:id/sessions/:sessionId/workflows/:runId
// Read the on-disk workflow state for a specific run.
router.get('/sessions/:sessionId/workflows/:runId', async (req, res) => {
  try {
    const workspaceId = (req.params as unknown as { id: string }).id;
    const sessionId = req.params.sessionId;
    const runId = req.params.runId;
    const workspace = await store.get(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    if (!WORKFLOW_ID_RE.test(sessionId) || !WORKFLOW_ID_RE.test(runId)) {
      res.status(400).json({ error: 'Invalid sessionId or runId' });
      return;
    }
    const localSession = store.getLocalSession(sessionId);
    if (!localSession || localSession.workspaceId !== workspaceId) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const workflow = await loadWorkflowState({ folderPath: workspace.folderPath, sessionId, runId });
    if (!workflow) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }
    res.json({ workflow });
  } catch (error) {
    console.error('Failed to load workflow:', error);
    res.status(500).json({ error: 'Failed to load workflow' });
  }
});

export default router;
