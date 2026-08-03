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
import {
  SkillHubProviderError,
  enterpriseZoneLimits,
  expertPackageLimits,
  isEnterpriseIndustry,
  isEnterpriseSkillSort,
  isExpertPackageCoordinate,
  isExpertPackageScene,
  isSkillHubCoordinate,
  isSkillScene,
  isSkillSort,
  type SkillSearchQuery,
} from '../services/skills/index.js';

const router = Router();

function sendSkillHubError(
  error: unknown,
  res: Response,
  label: 'Expert Package' | 'Enterprise Zone',
  includeCause = false,
): void {
  if (error instanceof SkillHubProviderError) {
    const status = error.code === 'not-found' ? 404
      : error.code === 'invalid-input' ? 400
      : error.code === 'unavailable' ? 503
      : 502;
    res.status(status).json({ error: error.message, code: error.code });
    return;
  }
  if (includeCause) console.error(`${label} request failed:`, error);
  else console.error(`${label} request failed`);
  res.status(500).json({ error: `${label} request failed` });
}

function sendExpertPackageError(error: unknown, res: Response): void {
  sendSkillHubError(error, res, 'Expert Package', true);
}

function sendEnterpriseZoneError(error: unknown, res: Response): void {
  sendSkillHubError(error, res, 'Enterprise Zone');
}

function parseEnterprisePage(value: unknown): number | null {
  if (value === undefined) return 1;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const page = Number(value);
  return Number.isSafeInteger(page) && page >= 1 && page <= enterpriseZoneLimits.maxPage ? page : null;
}

function parseEnterpriseKeyword(value: unknown): string | null {
  if (value === undefined) return '';
  if (typeof value !== 'string') return null;
  const keyword = value.trim();
  return keyword.length <= enterpriseZoneLimits.maxQueryLength ? keyword : null;
}

function hasInvalidEnterprisePageSize(value: unknown): boolean {
  return value !== undefined && value !== String(enterpriseZoneLimits.pageSize);
}

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

// GET /api/skills/search?q=&scene=&preferChinese=&noApiKey=&sort=
router.get('/search', async (req, res) => {
  try {
    const scene = req.query.scene;
    const sort = req.query.sort;
    if (scene !== undefined && !isSkillScene(scene)) {
      res.status(400).json({ error: 'Invalid scene' });
      return;
    }
    if (sort !== undefined && !isSkillSort(sort)) {
      res.status(400).json({ error: 'Invalid sort' });
      return;
    }
    const query: SkillSearchQuery = {
      keyword: typeof req.query.q === 'string' ? req.query.q : '',
      ...(typeof scene === 'string' ? { scene } : {}),
      ...(req.query.preferChinese === 'true' ? { preferChinese: true } : {}),
      ...(req.query.noApiKey === 'true' ? { noApiKey: true } : {}),
      ...(typeof sort === 'string' ? { sort } : {}),
    };
    const results = await skillsService.search(query);
    res.json({ skills: results });
  } catch (error) {
    console.error('Failed to search skills:', error);
    res.status(500).json({ error: 'Failed to search skills' });
  }
});

// GET /api/skills/enterprise-zone/industries
router.get('/enterprise-zone/industries', async (_req, res) => {
  try {
    res.json({ industries: await skillsService.listEnterpriseIndustries() });
  } catch (error) {
    sendEnterpriseZoneError(error, res);
  }
});

// GET /api/skills/enterprise-zone/enterprises?keyword=&industry=&page=
router.get('/enterprise-zone/enterprises', async (req, res) => {
  const keyword = parseEnterpriseKeyword(req.query.keyword);
  const industry = req.query.industry;
  const page = parseEnterprisePage(req.query.page);
  if (
    keyword === null
    || page === null
    || hasInvalidEnterprisePageSize(req.query.pageSize)
    || (industry !== undefined && !isEnterpriseIndustry(industry))
  ) {
    res.status(400).json({ error: 'Invalid Enterprise query' });
    return;
  }
  try {
    res.json(await skillsService.listEnterprises({
      ...(keyword ? { keyword } : {}),
      ...(typeof industry === 'string' ? { industry } : {}),
      page,
    }));
  } catch (error) {
    sendEnterpriseZoneError(error, res);
  }
});

// GET /api/skills/enterprise-zone/enterprises/:orgId
router.get('/enterprise-zone/enterprises/:orgId', async (req, res) => {
  const { orgId } = req.params;
  if (!isSkillHubCoordinate(orgId)) {
    res.status(400).json({ error: 'Invalid enterprise organization' });
    return;
  }
  try {
    res.json({ enterprise: await skillsService.getEnterprise(orgId) });
  } catch (error) {
    sendEnterpriseZoneError(error, res);
  }
});

// GET /api/skills/enterprise-zone/enterprises/:orgId/skills?keyword=&sort=&page=
router.get('/enterprise-zone/enterprises/:orgId/skills', async (req, res) => {
  const { orgId } = req.params;
  const keyword = parseEnterpriseKeyword(req.query.keyword);
  const sort = req.query.sort ?? 'downloads';
  const page = parseEnterprisePage(req.query.page);
  if (
    !isSkillHubCoordinate(orgId)
    || keyword === null
    || page === null
    || hasInvalidEnterprisePageSize(req.query.pageSize)
    || !isEnterpriseSkillSort(sort)
  ) {
    res.status(400).json({ error: 'Invalid Enterprise Skill query' });
    return;
  }
  try {
    res.json(await skillsService.listEnterpriseSkills(orgId, {
      ...(keyword ? { keyword } : {}),
      sort,
      page,
    }));
  } catch (error) {
    sendEnterpriseZoneError(error, res);
  }
});

// GET /api/skills/enterprise-zone/enterprises/:orgId/skills/:namespace/:slug
router.get('/enterprise-zone/enterprises/:orgId/skills/:namespace/:slug', async (req, res) => {
  const { orgId, namespace, slug } = req.params;
  if (![orgId, namespace, slug].every(isSkillHubCoordinate)) {
    res.status(400).json({ error: 'Invalid Enterprise Skill coordinate' });
    return;
  }
  try {
    res.json({ skill: await skillsService.getEnterpriseSkillDetail(orgId, namespace, slug) });
  } catch (error) {
    sendEnterpriseZoneError(error, res);
  }
});

// GET /api/skills/expert-packages?keyword=&scene=&page=&pageSize=
router.get('/expert-packages', async (req, res) => {
  try {
    const scene = req.query.scene;
    if (scene !== undefined && !isExpertPackageScene(scene)) {
      res.status(400).json({ error: 'Invalid Expert Package scene' });
      return;
    }
    const page = req.query.page === undefined ? 1 : Number(req.query.page);
    const pageSize = req.query.pageSize === undefined ? 20 : Number(req.query.pageSize);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
      res.status(400).json({ error: 'page and pageSize are invalid' });
      return;
    }
    const result = await skillsService.listExpertPackages({
      ...(typeof req.query.keyword === 'string' && req.query.keyword.trim()
        ? { keyword: req.query.keyword.trim() }
        : {}),
      ...(typeof scene === 'string' ? { scene } : {}),
      page,
      pageSize,
    });
    res.json(result);
  } catch (error) {
    sendExpertPackageError(error, res);
  }
});

// GET /api/skills/expert-packages/:slug
router.get('/expert-packages/:slug', async (req, res) => {
  const slug = req.params.slug;
  if (!isExpertPackageCoordinate(slug)) {
    res.status(400).json({ error: 'Invalid Expert Package slug' });
    return;
  }
  try {
    res.json({ package: await skillsService.getExpertPackage(slug) });
  } catch (error) {
    sendExpertPackageError(error, res);
  }
});

// GET /api/skills/expert-packages/:packageSlug/skills/:namespace/:slug
router.get('/expert-packages/:packageSlug/skills/:namespace/:slug', async (req, res) => {
  const { packageSlug, namespace, slug } = req.params;
  if (![packageSlug, namespace, slug].every(isExpertPackageCoordinate)) {
    res.status(400).json({ error: 'Invalid Expert Package Skill coordinate' });
    return;
  }
  try {
    if (!await skillsService.isExpertSkillInPackage(packageSlug, namespace, slug)) {
      res.status(404).json({ error: 'Skill is not included in this Expert Package' });
      return;
    }
    res.json({ skill: await skillsService.getExpertSkillDetail(namespace, slug) });
  } catch (error) {
    sendExpertPackageError(error, res);
  }
});

// POST /api/skills/expert-packages/:slug/install
router.post('/expert-packages/:slug/install', async (req, res) => {
  const packageSlug = req.params.slug;
  if (!isExpertPackageCoordinate(packageSlug)) {
    res.status(400).json({ error: 'Invalid Expert Package slug' });
    return;
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { scope, workspaceId, itemIds, force } = body as {
    scope?: string;
    workspaceId?: string;
    itemIds?: unknown;
    force?: unknown;
  };
  try {
    assertSkillScope(scope ?? '');
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
    return;
  }
  if (itemIds !== undefined && (
    !Array.isArray(itemIds) ||
    itemIds.length === 0 ||
    itemIds.length > expertPackageLimits.maxPackageChildren + 1 ||
    !itemIds.every((id) => typeof id === 'string')
  )) {
    res.status(400).json({
      error: `itemIds must be a non-empty array of at most ${expertPackageLimits.maxPackageChildren + 1} strings`,
    });
    return;
  }
  if (workspaceId !== undefined && typeof workspaceId !== 'string') {
    res.status(400).json({ error: 'workspaceId must be a string' });
    return;
  }
  if (force !== undefined && typeof force !== 'boolean') {
    res.status(400).json({ error: 'force must be a boolean' });
    return;
  }
  const workspacePath = await requireWorkspacePath(scope as SkillScope, workspaceId, res);
  if (workspacePath === undefined && scope !== 'global') return;

  try {
    const results = await skillsService.installExpertPackage({
      packageSlug,
      scope: scope as SkillScope,
      workspacePath,
      ...(itemIds ? { itemIds: itemIds as string[] } : {}),
      ...(force === true ? { force: true } : {}),
    });
    const installedCount = results.filter((result) => result.status === 'installed').length;
    const alreadyCount = results.filter((result) => result.status === 'already-installed').length;
    const failedCount = results.filter((result) => result.status === 'error').length;
    if (failedCount === results.length) {
      res.status(422).json({ error: 'All Expert Package items failed to install', results });
      return;
    }
    res.status(installedCount > 0 ? 201 : 200).json({
      results,
      summary: { installed: installedCount, alreadyInstalled: alreadyCount, failed: failedCount },
    });
  } catch (error) {
    const message = (error as Error).message;
    if (/does not belong|non-empty unique|incomplete|unavailable/i.test(message)) {
      res.status(422).json({ error: message });
      return;
    }
    sendExpertPackageError(error, res);
  }
});

// POST /api/skills/expert-packages/:slug/uninstall
router.post('/expert-packages/:slug/uninstall', async (req, res) => {
  const packageSlug = req.params.slug;
  if (!isExpertPackageCoordinate(packageSlug)) {
    res.status(400).json({ error: 'Invalid Expert Package slug' });
    return;
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { scope, workspaceId } = body as { scope?: string; workspaceId?: string };
  try {
    assertSkillScope(scope ?? '');
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
    return;
  }
  if (workspaceId !== undefined && typeof workspaceId !== 'string') {
    res.status(400).json({ error: 'workspaceId must be a string' });
    return;
  }
  const workspacePath = await requireWorkspacePath(scope as SkillScope, workspaceId, res);
  if (workspacePath === undefined && scope !== 'global') return;

  try {
    const results = await skillsService.removeExpertPackage({
      packageSlug,
      scope: scope as SkillScope,
      workspacePath,
    });
    const failures = results.filter((result) => result.status === 'error');
    if (failures.length === results.length) {
      res.status(422).json({ error: 'Unable to uninstall Expert Package', results });
      return;
    }
    res.json({ results });
  } catch (error) {
    sendExpertPackageError(error, res);
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
