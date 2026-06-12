/**
 * Skills API routes.
 *
 * Express router mounted at `/api/skills` (see `src/server/index.ts`).
 * Mirrors the shape of `routes/plugins.ts`: try/catch per handler, validation
 * via `assertSkillScope`, status codes per U5 plan (200/201/400/404/409/422/500),
 * logging via `sidecarLog`.
 *
 * Endpoints:
 *   GET    /api/skills/installed?workspaceId=
 *   GET    /api/skills/search?q=
 *   POST   /api/skills/resolve              { source, workspaceId? }
 *   POST   /api/skills/install              { source, skills[], scope, workspaceId?, force? }
 *   POST   /api/skills/uninstall            { skillName, scope, workspaceId? }
 *   POST   /api/skills/update               { skillName, scope, workspaceId? }
 *   POST   /api/skills/update-all           { workspaceId? }
 *
 * doc-review Coherence #1: install responds 201 on success (created resource).
 * doc-review Coherence #4: route group named /api/skills (NOT /plugins/skills).
 */

import { Router, type Response } from 'express';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { skillsService, assertSkillScope } from '../services/skills-service.js';
import { sidecarLog } from '../utils/sidecar-logger.js';
import type { SkillScope } from '../services/skills-service.js';

const router = Router();

/**
 * Resolve a workspaceId to its on-disk folderPath.
 * Returns undefined when the workspace does not exist or no id was passed.
 */
async function getWorkspacePath(workspaceId?: string): Promise<string | undefined> {
  if (!workspaceId) return undefined;
  const workspace = await workspaceStore.get(workspaceId);
  return workspace?.folderPath;
}

/**
 * Validate and resolve workspace path for a given scope. Project scope
 * requires a workspace; global scope does not.
 *
 * Sends a 404 response and returns undefined if a required workspace is missing.
 */
async function requireWorkspacePath(
  scope: SkillScope,
  workspaceId: string | undefined,
  res: Response
): Promise<string | undefined> {
  if (scope === 'global') {
    // Global installs do not need a workspace, but we still resolve one if
    // provided so the sandbox check has a workspace root to honor.
    return getWorkspacePath(workspaceId);
  }
  // scope === 'project'
  const workspacePath = await getWorkspacePath(workspaceId);
  if (!workspacePath) {
    res.status(404).json({ error: 'Workspace not found' });
    return undefined;
  }
  return workspacePath;
}

// GET /api/skills/installed?workspaceId=
router.get('/installed', async (req, res) => {
  try {
    const workspaceId = req.query.workspaceId as string | undefined;
    const workspacePath = await getWorkspacePath(workspaceId);

    const skills = await skillsService.listInstalled(workspacePath);
    res.json({ skills });
  } catch (error) {
    console.error('Failed to list installed skills:', error);
    res.status(500).json({ error: 'Failed to list installed skills' });
  }
});

// GET /api/skills/search?q=
router.get('/search', async (req, res) => {
  try {
    const query = (req.query.q as string | undefined) ?? '';
    const results = await skillsService.search(query);
    res.json({ skills: results });
  } catch (error) {
    console.error('Failed to search skills:', error);
    res.status(500).json({ error: 'Failed to search skills' });
  }
});

// POST /api/skills/resolve
// Body: { source: string, workspaceId?: string }
// Returns: { skills: DiscoveredSkill[] }
router.post('/resolve', async (req, res) => {
  try {
    const { source, workspaceId } = req.body as { source?: string; workspaceId?: string };

    if (!source || typeof source !== 'string') {
      res.status(400).json({ error: 'source is required' });
      return;
    }

    const workspacePath = await getWorkspacePath(workspaceId);
    const discovered = await skillsService.resolveSource({ source, workspacePath });

    sidecarLog(`[Skills API] Resolved source "${source}": ${discovered.length} skill(s) discovered`);
    res.json({ skills: discovered });
  } catch (error) {
    const message = (error as Error).message;
    console.error('Failed to resolve skill source:', message);
    // Source-resolution errors are usually user-facing (path does not exist,
    // path outside sandbox, clone failed) — surface as 400 with the message.
    res.status(400).json({ error: message });
  }
});

// POST /api/skills/install
// Body: { source: string, skills: string[], scope: SkillScope, workspaceId?: string, force?: boolean }
// Returns: 201 with { results: InstallResult[] } (Coherence #1 + #3)
router.post('/install', async (req, res) => {
  try {
    const { source, skills, scope, workspaceId, force } = req.body as {
      source?: string;
      skills?: unknown;
      scope?: string;
      workspaceId?: string;
      force?: boolean;
    };

    if (!source || typeof source !== 'string') {
      res.status(400).json({ error: 'source is required' });
      return;
    }
    if (!Array.isArray(skills) || !skills.every((s) => typeof s === 'string')) {
      res.status(400).json({ error: 'skills must be an array of strings' });
      return;
    }
    if (skills.length === 0) {
      res.status(400).json({ error: 'skills must contain at least one skill name' });
      return;
    }
    try {
      assertSkillScope(scope ?? '');
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }

    const workspacePath = await requireWorkspacePath(scope as SkillScope, workspaceId, res);
    if (workspacePath === undefined && scope !== 'global') {
      return; // 404 already sent
    }

    const results = await skillsService.install({
      source,
      skills,
      scope: scope as SkillScope,
      workspacePath,
      force: force === true,
    });

    const installedCount = results.filter((r) => r.status === 'installed').length;
    const alreadyCount = results.filter((r) => r.status === 'already-installed').length;
    const errorCount = results.filter((r) => r.status === 'error').length;

    sidecarLog(
      `[Skills API] Install from "${source}": ${installedCount} installed, ${alreadyCount} already, ${errorCount} error(s)`
    );

    // Per Coherence #1: 201 Created when at least one skill was newly installed.
    // Per AE3: if every requested skill was already installed (no errors), 409 Conflict.
    // Per the install contract: if every requested skill errored, 422.
    if (errorCount === results.length) {
      res.status(422).json({ error: 'All requested skills failed to install', results });
      return;
    }
    if (installedCount === 0 && alreadyCount === results.length) {
      res.status(409).json({ error: 'All skills already installed', results });
      return;
    }
    res.status(201).json({ results });
  } catch (error) {
    console.error('Failed to install skill(s):', error);
    res.status(500).json({ error: 'Failed to install skill(s)' });
  }
});

// POST /api/skills/uninstall
// Body: { skillName: string, scope: SkillScope, workspaceId?: string }
router.post('/uninstall', async (req, res) => {
  try {
    const { skillName, scope, workspaceId } = req.body as {
      skillName?: string;
      scope?: string;
      workspaceId?: string;
    };

    if (!skillName || typeof skillName !== 'string') {
      res.status(400).json({ error: 'skillName is required' });
      return;
    }
    try {
      assertSkillScope(scope ?? '');
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }

    const workspacePath = await requireWorkspacePath(scope as SkillScope, workspaceId, res);
    if (workspacePath === undefined && scope !== 'global') {
      return; // 404 already sent
    }

    const result = await skillsService.remove({
      skillName,
      scope: scope as SkillScope,
      workspacePath,
    });

    if (result.status === 'not-found') {
      res.status(404).json({ error: `Skill "${skillName}" is not installed` });
      return;
    }
    if (result.status === 'error') {
      // Typically symlink-refusal — surface as 409 (conflict with legacy install).
      res.status(409).json({ error: result.error });
      return;
    }

    sidecarLog(`[Skills API] Uninstalled ${skillName} from ${scope}`);
    res.json({ ok: true });
  } catch (error) {
    console.error('Failed to uninstall skill:', error);
    res.status(500).json({ error: 'Failed to uninstall skill' });
  }
});

// POST /api/skills/update
// Body: { skillName: string, scope: SkillScope, workspaceId?: string }
router.post('/update', async (req, res) => {
  try {
    const { skillName, scope, workspaceId } = req.body as {
      skillName?: string;
      scope?: string;
      workspaceId?: string;
    };

    if (!skillName || typeof skillName !== 'string') {
      res.status(400).json({ error: 'skillName is required' });
      return;
    }
    try {
      assertSkillScope(scope ?? '');
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }

    const workspacePath = await requireWorkspacePath(scope as SkillScope, workspaceId, res);
    if (workspacePath === undefined && scope !== 'global') {
      return; // 404 already sent
    }

    const result = await skillsService.update({
      skillName,
      scope: scope as SkillScope,
      workspacePath,
    });

    if (result.status === 'error') {
      // Errors here are typically: skill not in lock file, symlinked legacy
      // skill, or source fetch failure. Surface the message so the UI can
      // instruct the user.
      res.status(422).json({ error: result.error });
      return;
    }

    sidecarLog(`[Skills API] Updated ${skillName} in ${scope}`);
    res.json({ result });
  } catch (error) {
    console.error('Failed to update skill:', error);
    res.status(500).json({ error: 'Failed to update skill' });
  }
});

// POST /api/skills/update-all
// Body: { workspaceId?: string }
router.post('/update-all', async (req, res) => {
  try {
    const { workspaceId } = req.body as { workspaceId?: string };
    const workspacePath = await getWorkspacePath(workspaceId);

    const results = await skillsService.updateAll({ workspacePath });

    const updatedCount = results.filter((r) => r.status === 'updated').length;
    const errorCount = results.filter((r) => r.status === 'error').length;
    sidecarLog(
      `[Skills API] Update-all: ${updatedCount} updated, ${errorCount} error(s)`
    );

    res.json({ results });
  } catch (error) {
    console.error('Failed to update all skills:', error);
    res.status(500).json({ error: 'Failed to update all skills' });
  }
});

export default router;
