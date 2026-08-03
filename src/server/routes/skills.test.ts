import '../test-utils/test-env.js';
/**
 * Tests for the Skills API route handlers.
 *
 * Run via: `npx tsx --test src/server/routes/skills.test.ts`
 *
 * Mirrors the test pattern in `wecom-queue.test.ts`: dynamically import the
 * router, extract handlers from the Express stack, invoke with mock req/res.
 *
 * Test scenarios (U5 plan):
 *   - Happy: GET /installed returns 200 with { skills: [...] }
 *   - Happy: GET /search?q= returns 200
 *   - Happy: POST /install returns 201 on success (Coherence #1)
 *   - Error: POST /install missing source returns 400
 *   - Error: POST /install invalid scope returns 400
 *   - Error: POST /install missing skills array returns 400
 *   - Edge: POST /install when all already-installed returns 409 (AE3)
 *   - Error: POST /install when all error returns 422
 *   - Error: POST /uninstall on not-found returns 404
 *   - Error: POST /uninstall on symlinked legacy returns 409
 *   - Error: POST /update on error returns 422
 *   - Integration: project scope without workspace returns 404
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { skillsService } from '../services/skills-service.js';
import type { InstallResult } from '../services/skills/types.js';

/**
 * Mock Express Response. Provides the methods the route handlers call:
 * status (chainable), json, send.
 */
function createMockRes(): {
  statusCode: number;
  jsonBody: unknown;
  status(code: number): ReturnType<typeof createMockRes>;
  json(body: unknown): void;
  send(): void;
} {
  const res = {
    statusCode: 200,
    jsonBody: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.jsonBody = body;
    },
    send() {
      // no-op
    },
  };
  return res;
}

/**
 * Extract route handlers from the Express router's internal stack.
 * Returns a map: { [path]: { [method]: handler } }.
 */
async function importRouteHandlers(): Promise<
  Record<string, Record<string, (req: unknown, res: unknown) => Promise<void>>>
> {
  const mod = await import('./skills.js');
  const router = mod.default;
  const layers = (
    router as unknown as {
      stack: Array<{
        route?: {
          methods: Record<string, boolean>;
          path: string;
          stack: Array<{ handle: (req: unknown, res: unknown) => Promise<void> }>;
        };
      }>;
    }
  ).stack;
  const handlers: Record<string, Record<string, (req: unknown, res: unknown) => Promise<void>>> = {};
  for (const layer of layers) {
    if (!layer.route) continue;
    const path = layer.route.path;
    const methods = Object.keys(layer.route.methods);
    if (!handlers[path]) handlers[path] = {};
    for (const method of methods) {
      handlers[path][method] = layer.route.stack[0]!.handle;
    }
  }
  return handlers;
}

describe('skills routes', () => {
  let tmpWorkspace: string;
  let originalStoreGet: typeof workspaceStore.get;
  let originalSearch: typeof skillsService.search;
  let originalResolveSource: typeof skillsService.resolveSource;
  let originalInstall: typeof skillsService.install;
  let originalListInstalled: typeof skillsService.listInstalled;
  let originalRemove: typeof skillsService.remove;
  let originalUpdate: typeof skillsService.update;
  let originalUpdateAll: typeof skillsService.updateAll;
  let originalListExpertPackages: typeof skillsService.listExpertPackages;
  let originalGetExpertPackage: typeof skillsService.getExpertPackage;
  let originalGetExpertSkillDetail: typeof skillsService.getExpertSkillDetail;
  let originalIsExpertSkillInPackage: typeof skillsService.isExpertSkillInPackage;
  let originalInstallExpertPackage: typeof skillsService.installExpertPackage;

  beforeEach(() => {
    tmpWorkspace = mkdtempSync(join(tmpdir(), 'skills-routes-ws-'));
    originalStoreGet = workspaceStore.get.bind(workspaceStore);
    originalSearch = skillsService.search.bind(skillsService);
    originalResolveSource = skillsService.resolveSource.bind(skillsService);
    originalInstall = skillsService.install.bind(skillsService);
    originalListInstalled = skillsService.listInstalled.bind(skillsService);
    originalRemove = skillsService.remove.bind(skillsService);
    originalUpdate = skillsService.update.bind(skillsService);
    originalUpdateAll = skillsService.updateAll.bind(skillsService);
    originalListExpertPackages = skillsService.listExpertPackages.bind(skillsService);
    originalGetExpertPackage = skillsService.getExpertPackage.bind(skillsService);
    originalGetExpertSkillDetail = skillsService.getExpertSkillDetail.bind(skillsService);
    originalIsExpertSkillInPackage = skillsService.isExpertSkillInPackage.bind(skillsService);
    originalInstallExpertPackage = skillsService.installExpertPackage.bind(skillsService);
  });

  afterEach(() => {
    workspaceStore.get = originalStoreGet;
    skillsService.search = originalSearch;
    skillsService.resolveSource = originalResolveSource;
    skillsService.install = originalInstall;
    skillsService.listInstalled = originalListInstalled;
    skillsService.remove = originalRemove;
    skillsService.update = originalUpdate;
    skillsService.updateAll = originalUpdateAll;
    skillsService.listExpertPackages = originalListExpertPackages;
    skillsService.getExpertPackage = originalGetExpertPackage;
    skillsService.getExpertSkillDetail = originalGetExpertSkillDetail;
    skillsService.isExpertSkillInPackage = originalIsExpertSkillInPackage;
    skillsService.installExpertPackage = originalInstallExpertPackage;
    rmSync(tmpWorkspace, { recursive: true, force: true });
  });

  describe('GET /installed', () => {
    it('returns 200 with the installed skills list', async () => {
      const handlers = await importRouteHandlers();
      skillsService.listInstalled = async () => [
        {
          name: 'demo',
          scope: 'project',
          source: 'a/b',
          installPath: '/x/demo',
          isLegacySymlink: false,
        },
      ];

      const req = { query: {} };
      const res = createMockRes();
      await handlers['/installed'].get(req, res);

      assert.strictEqual(res.statusCode, 200);
      const body = res.jsonBody as { skills: Array<{ name: string }> };
      assert.strictEqual(body.skills.length, 1);
      assert.strictEqual(body.skills[0]!.name, 'demo');
    });

    it('returns 500 when service throws', async () => {
      const handlers = await importRouteHandlers();
      skillsService.listInstalled = async () => {
        throw new Error('disk exploded');
      };

      const req = { query: {} };
      const res = createMockRes();
      await handlers['/installed'].get(req, res);

      assert.strictEqual(res.statusCode, 500);
    });
  });

  describe('GET /search', () => {
    it('returns 200 with results, delegating the query to the service', async () => {
      const handlers = await importRouteHandlers();
      let capturedQuery: { keyword: string; scene?: string; preferChinese?: boolean; noApiKey?: boolean; sort?: string } | undefined;
      skillsService.search = async (q) => {
        capturedQuery = q;
        return [{
          id: 'demo',
          name: 'demo',
          slug: 'demo',
          source: 'a/b',
          installSource: 'a/b',
          sourceKind: 'skills.sh',
          description: '',
          installs: 5,
        }];
      };

      const req = { query: { q: 'design', scene: 'development', preferChinese: 'true', noApiKey: 'true', sort: 'downloads' } };
      const res = createMockRes();
      await handlers['/search'].get(req, res);

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(capturedQuery, {
        keyword: 'design', scene: 'development', preferChinese: true, noApiKey: true, sort: 'downloads',
      });
      const body = res.jsonBody as { skills: Array<{ name: string; slug: string; installSource: string }> };
      assert.strictEqual(body.skills[0]!.name, 'demo');
      assert.strictEqual(body.skills[0]!.slug, 'demo');
      assert.strictEqual(body.skills[0]!.installSource, 'a/b');
    });

    it('defaults q to empty string when not provided', async () => {
      const handlers = await importRouteHandlers();
      let capturedQuery: { keyword: string } | undefined;
      skillsService.search = async (q) => {
        capturedQuery = q;
        return [];
      };

      const req = { query: {} };
      const res = createMockRes();
      await handlers['/search'].get(req, res);

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(capturedQuery, { keyword: '' });
    });

    it('rejects unknown structured filter values', async () => {
      const handlers = await importRouteHandlers();
      const res = createMockRes();
      await handlers['/search'].get({ query: { q: 'design', scene: 'unknown' } }, res);

      assert.strictEqual(res.statusCode, 400);
      assert.deepStrictEqual(res.jsonBody, { error: 'Invalid scene' });
    });
  });

  describe('Expert Packages', () => {
    it('forwards combined list filters and pagination', async () => {
      const handlers = await importRouteHandlers();
      let captured: unknown;
      skillsService.listExpertPackages = async (input) => {
        captured = input;
        return { packages: [], total: 0 };
      };
      const res = createMockRes();
      await handlers['/expert-packages'].get({
        query: { keyword: ' test ', scene: 'tech', page: '2', pageSize: '40' },
      }, res);
      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(captured, { keyword: 'test', scene: 'tech', page: 2, pageSize: 40 });
    });

    it('rejects an unknown package scene before calling the provider', async () => {
      const handlers = await importRouteHandlers();
      let called = false;
      skillsService.listExpertPackages = async () => {
        called = true;
        return { packages: [], total: 0 };
      };
      const res = createMockRes();
      await handlers['/expert-packages'].get({ query: { scene: 'unknown' } }, res);
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(called, false);
    });

    it('returns normalized package detail and rejects malformed slugs', async () => {
      const handlers = await importRouteHandlers();
      let requestedSlug = '';
      skillsService.getExpertPackage = async (slug) => {
        requestedSlug = slug;
        return {
          slug,
          displayName: 'Test Package',
          summary: 'A package',
          scene: 'tech',
          skillCount: 1,
          source: 'skillhub.cn',
          content: '# Workflow',
          children: [],
          complete: false,
        };
      };

      const valid = createMockRes();
      await handlers['/expert-packages/:slug'].get({ params: { slug: 'test-package' } }, valid);
      assert.strictEqual(valid.statusCode, 200);
      assert.strictEqual(requestedSlug, 'test-package');
      assert.strictEqual((valid.jsonBody as { package: { slug: string } }).package.slug, 'test-package');

      const invalid = createMockRes();
      await handlers['/expert-packages/:slug'].get({ params: { slug: 'bad/slug' } }, invalid);
      assert.strictEqual(invalid.statusCode, 400);
      assert.strictEqual(requestedSlug, 'test-package');
    });

    it('loads only Skills that belong to the requested package', async () => {
      const handlers = await importRouteHandlers();
      let detailCalls = 0;
      skillsService.getExpertSkillDetail = async (namespace, slug) => {
        detailCalls += 1;
        return {
          namespace,
          slug,
          displayName: 'Child',
          summary: 'Child summary',
          category: 'tech',
          owner: { handle: namespace, displayName: 'Owner' },
          version: '1.0.0',
          stats: { downloads: 1, installs: 1 },
          securityReports: [],
          source: `skillhub-cn:${namespace}/${slug}`,
        };
      };
      skillsService.isExpertSkillInPackage = async () => false;

      const missing = createMockRes();
      await handlers['/expert-packages/:packageSlug/skills/:namespace/:slug'].get({
        params: { packageSlug: 'test-package', namespace: 'owner', slug: 'child' },
      }, missing);
      assert.strictEqual(missing.statusCode, 404);
      assert.strictEqual(detailCalls, 0);

      skillsService.isExpertSkillInPackage = async () => true;
      const included = createMockRes();
      await handlers['/expert-packages/:packageSlug/skills/:namespace/:slug'].get({
        params: { packageSlug: 'test-package', namespace: 'owner', slug: 'child' },
      }, included);
      assert.strictEqual(included.statusCode, 200);
      assert.strictEqual(detailCalls, 1);
      assert.strictEqual((included.jsonBody as { skill: { slug: string } }).skill.slug, 'child');
    });

    it('preserves mixed package install results and retry ids', async () => {
      const handlers = await importRouteHandlers();
      let capturedItemIds: string[] | undefined;
      skillsService.installExpertPackage = async (args) => {
        capturedItemIds = args.itemIds;
        return [
          { id: 'skill:a/ok', kind: 'skill', source: 'skillhub-cn:a/ok', name: 'ok', status: 'installed' },
          { id: 'skill:a/bad', kind: 'skill', source: 'skillhub-cn:a/bad', name: 'bad', status: 'error', error: 'download failed' },
        ];
      };
      const res = createMockRes();
      await handlers['/expert-packages/:slug/install'].post({
        params: { slug: 'tech-test' },
        body: { scope: 'global', itemIds: ['skill:a/bad'] },
      }, res);
      assert.strictEqual(res.statusCode, 201);
      assert.deepStrictEqual(capturedItemIds, ['skill:a/bad']);
      const body = res.jsonBody as { results: unknown[]; summary: { failed: number } };
      assert.strictEqual(body.results.length, 2);
      assert.strictEqual(body.summary.failed, 1);
    });

    it('rejects malformed retry item input without installation', async () => {
      const handlers = await importRouteHandlers();
      let called = false;
      skillsService.installExpertPackage = async () => {
        called = true;
        return [];
      };
      const res = createMockRes();
      await handlers['/expert-packages/:slug/install'].post({
        params: { slug: 'tech-test' },
        body: { scope: 'global', itemIds: [] },
      }, res);
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(called, false);
    });

    it('rejects dot-only package slugs without installation', async () => {
      const handlers = await importRouteHandlers();
      let called = false;
      skillsService.installExpertPackage = async () => {
        called = true;
        return [];
      };
      const res = createMockRes();
      await handlers['/expert-packages/:slug/install'].post({
        params: { slug: '..' },
        body: { scope: 'global' },
      }, res);
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(called, false);
    });

    it('preserves all failed package results in the error response', async () => {
      const handlers = await importRouteHandlers();
      skillsService.installExpertPackage = async () => [{
        id: 'skill:a/bad',
        kind: 'skill',
        source: 'skillhub-cn:a/bad',
        name: 'bad',
        status: 'error',
        error: 'download failed',
      }];
      const res = createMockRes();
      await handlers['/expert-packages/:slug/install'].post({
        params: { slug: 'test-package' },
        body: { scope: 'global' },
      }, res);
      assert.strictEqual(res.statusCode, 422);
      assert.strictEqual((res.jsonBody as { results: unknown[] }).results.length, 1);
    });
  });

  describe('POST /resolve', () => {
    it('returns 200 with discovered skills', async () => {
      const handlers = await importRouteHandlers();
      skillsService.resolveSource = async () => [
        { name: 'alpha', description: 'alpha', skillPath: 'skills/alpha/SKILL.md' },
      ];

      const req = { body: { source: 'a/b' }, query: {} };
      const res = createMockRes();
      await handlers['/resolve'].post(req, res);

      assert.strictEqual(res.statusCode, 200);
      const body = res.jsonBody as { skills: Array<{ name: string }> };
      assert.strictEqual(body.skills[0]!.name, 'alpha');
    });

    it('returns 400 when source is missing', async () => {
      const handlers = await importRouteHandlers();
      const req = { body: {}, query: {} };
      const res = createMockRes();
      await handlers['/resolve'].post(req, res);
      assert.strictEqual(res.statusCode, 400);
    });

    it('returns 400 when service throws (sandbox, missing path, etc.)', async () => {
      const handlers = await importRouteHandlers();
      skillsService.resolveSource = async () => {
        throw new Error('outside the workspace and user home directory');
      };

      const req = { body: { source: '/etc/passwd' }, query: {} };
      const res = createMockRes();
      await handlers['/resolve'].post(req, res);

      assert.strictEqual(res.statusCode, 400);
      assert.match(
        (res.jsonBody as { error: string }).error,
        /outside the workspace/
      );
    });
  });

  describe('POST /install', () => {
    it('returns 201 with InstallResult[] on success (Coherence #1)', async () => {
      const handlers = await importRouteHandlers();
      workspaceStore.get = async () => ({ id: 'ws-1', folderPath: tmpWorkspace } as never);
      const results: InstallResult[] = [
        { skillName: 'demo', status: 'installed', path: '/x/demo/SKILL.md' },
      ];
      skillsService.install = async () => results;

      const req = {
        body: {
          source: 'a/b',
          skills: ['demo'],
          scope: 'project',
          workspaceId: 'ws-1',
        },
      };
      const res = createMockRes();
      await handlers['/install'].post(req, res);

      assert.strictEqual(res.statusCode, 201);
      const body = res.jsonBody as { results: InstallResult[] };
      assert.strictEqual(body.results.length, 1);
      assert.strictEqual(body.results[0]!.status, 'installed');
    });

    it('returns 400 when source is missing', async () => {
      const handlers = await importRouteHandlers();
      const req = { body: { skills: ['x'], scope: 'project' } };
      const res = createMockRes();
      await handlers['/install'].post(req, res);
      assert.strictEqual(res.statusCode, 400);
    });

    it('returns 400 when skills is not a non-empty string array', async () => {
      const handlers = await importRouteHandlers();
      const cases = [
        { skills: [] },
        { skills: 'demo' },
        { skills: [1, 2, 3] },
        {},
      ];
      for (const body of cases) {
        const req = { body: { source: 'a/b', scope: 'project', ...body } };
        const res = createMockRes();
        await handlers['/install'].post(req, res);
        assert.strictEqual(
          res.statusCode,
          400,
          `expected 400 for body ${JSON.stringify(body)}`
        );
      }
    });

    it('returns 400 when scope is invalid', async () => {
      const handlers = await importRouteHandlers();
      const req = {
        body: { source: 'a/b', skills: ['x'], scope: 'local' },
      };
      const res = createMockRes();
      await handlers['/install'].post(req, res);
      assert.strictEqual(res.statusCode, 400);
      assert.match(
        (res.jsonBody as { error: string }).error,
        /Skills page does not support "local"/
      );
    });

    it('returns 404 when project scope lacks a workspace', async () => {
      const handlers = await importRouteHandlers();
      workspaceStore.get = async () => undefined;

      const req = {
        body: {
          source: 'a/b',
          skills: ['x'],
          scope: 'project',
          workspaceId: 'missing',
        },
      };
      const res = createMockRes();
      await handlers['/install'].post(req, res);
      assert.strictEqual(res.statusCode, 404);
    });

    it('returns 409 when every requested skill was already installed (AE3)', async () => {
      const handlers = await importRouteHandlers();
      workspaceStore.get = async () => ({ id: 'ws-1', folderPath: tmpWorkspace } as never);
      skillsService.install = async () => [
        { skillName: 'demo', status: 'already-installed', path: '/x/demo/SKILL.md' },
      ];

      const req = {
        body: {
          source: 'a/b',
          skills: ['demo'],
          scope: 'project',
          workspaceId: 'ws-1',
        },
      };
      const res = createMockRes();
      await handlers['/install'].post(req, res);

      assert.strictEqual(res.statusCode, 409);
    });

    it('returns 422 when every requested skill errored', async () => {
      const handlers = await importRouteHandlers();
      workspaceStore.get = async () => ({ id: 'ws-1', folderPath: tmpWorkspace } as never);
      skillsService.install = async () => [
        { skillName: 'demo', status: 'error', error: 'clone failed' },
      ];

      const req = {
        body: {
          source: 'a/b',
          skills: ['demo'],
          scope: 'project',
          workspaceId: 'ws-1',
        },
      };
      const res = createMockRes();
      await handlers['/install'].post(req, res);

      assert.strictEqual(res.statusCode, 422);
    });

    it('returns 201 even when some succeed and some fail (partial success)', async () => {
      const handlers = await importRouteHandlers();
      workspaceStore.get = async () => ({ id: 'ws-1', folderPath: tmpWorkspace } as never);
      skillsService.install = async () => [
        { skillName: 'a', status: 'installed', path: '/x/a/SKILL.md' },
        { skillName: 'b', status: 'error', error: 'not found' },
      ];

      const req = {
        body: {
          source: 'a/b',
          skills: ['a', 'b'],
          scope: 'project',
          workspaceId: 'ws-1',
        },
      };
      const res = createMockRes();
      await handlers['/install'].post(req, res);

      assert.strictEqual(res.statusCode, 201);
      const body = res.jsonBody as { results: InstallResult[] };
      assert.strictEqual(body.results.length, 2);
    });

    it('global scope does not require a workspace', async () => {
      const handlers = await importRouteHandlers();
      skillsService.install = async () => [
        { skillName: 'g', status: 'installed', path: '/x/g/SKILL.md' },
      ];

      const req = {
        body: { source: 'a/b', skills: ['g'], scope: 'global' },
      };
      const res = createMockRes();
      await handlers['/install'].post(req, res);

      assert.strictEqual(res.statusCode, 201);
    });
  });

  describe('POST /uninstall', () => {
    it('returns 200 when the skill is removed', async () => {
      const handlers = await importRouteHandlers();
      workspaceStore.get = async () => ({ id: 'ws-1', folderPath: tmpWorkspace } as never);
      skillsService.remove = async () => ({ skillName: 'demo', status: 'removed' });

      const req = {
        body: { skillName: 'demo', scope: 'project', workspaceId: 'ws-1' },
      };
      const res = createMockRes();
      await handlers['/uninstall'].post(req, res);

      assert.strictEqual(res.statusCode, 200);
    });

    it('returns 404 when skill was not installed', async () => {
      const handlers = await importRouteHandlers();
      workspaceStore.get = async () => ({ id: 'ws-1', folderPath: tmpWorkspace } as never);
      skillsService.remove = async () => ({ skillName: 'demo', status: 'not-found' });

      const req = {
        body: { skillName: 'demo', scope: 'project', workspaceId: 'ws-1' },
      };
      const res = createMockRes();
      await handlers['/uninstall'].post(req, res);

      assert.strictEqual(res.statusCode, 404);
    });

    it('returns 409 when remove refuses (symlinked legacy)', async () => {
      const handlers = await importRouteHandlers();
      workspaceStore.get = async () => ({ id: 'ws-1', folderPath: tmpWorkspace } as never);
      skillsService.remove = async () => ({
        skillName: 'demo',
        status: 'error',
        error: 'Cannot remove symlinked legacy skill',
      });

      const req = {
        body: { skillName: 'demo', scope: 'project', workspaceId: 'ws-1' },
      };
      const res = createMockRes();
      await handlers['/uninstall'].post(req, res);

      assert.strictEqual(res.statusCode, 409);
    });

    it('returns 400 when skillName is missing', async () => {
      const handlers = await importRouteHandlers();
      const req = { body: { scope: 'project' } };
      const res = createMockRes();
      await handlers['/uninstall'].post(req, res);
      assert.strictEqual(res.statusCode, 400);
    });
  });

  describe('POST /update', () => {
    it('returns 200 on successful update', async () => {
      const handlers = await importRouteHandlers();
      workspaceStore.get = async () => ({ id: 'ws-1', folderPath: tmpWorkspace } as never);
      skillsService.update = async () => ({
        skillName: 'demo',
        status: 'installed',
        path: '/x/demo/SKILL.md',
      });

      const req = {
        body: { skillName: 'demo', scope: 'project', workspaceId: 'ws-1' },
      };
      const res = createMockRes();
      await handlers['/update'].post(req, res);

      assert.strictEqual(res.statusCode, 200);
    });

    it('returns 422 when update errors (symlink, missing, etc.)', async () => {
      const handlers = await importRouteHandlers();
      workspaceStore.get = async () => ({ id: 'ws-1', folderPath: tmpWorkspace } as never);
      skillsService.update = async () => ({
        skillName: 'demo',
        status: 'error',
        error: 'Cannot update symlinked legacy skill',
      });

      const req = {
        body: { skillName: 'demo', scope: 'project', workspaceId: 'ws-1' },
      };
      const res = createMockRes();
      await handlers['/update'].post(req, res);

      assert.strictEqual(res.statusCode, 422);
    });

    it('returns 400 when skillName is missing', async () => {
      const handlers = await importRouteHandlers();
      const req = { body: { scope: 'project' } };
      const res = createMockRes();
      await handlers['/update'].post(req, res);
      assert.strictEqual(res.statusCode, 400);
    });
  });

  describe('POST /update-all', () => {
    it('returns 200 with results array', async () => {
      const handlers = await importRouteHandlers();
      skillsService.updateAll = async () => [
        { skillName: 'a', scope: 'project', status: 'updated' },
      ];

      const req = { body: {} };
      const res = createMockRes();
      await handlers['/update-all'].post(req, res);

      assert.strictEqual(res.statusCode, 200);
      const body = res.jsonBody as { results: Array<{ status: string }> };
      assert.strictEqual(body.results.length, 1);
    });
  });
});
