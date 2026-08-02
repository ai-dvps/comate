import '../test-utils/test-env.js';
/**
 * Tests for SkillsService business logic.
 *
 * Run via: `npx tsx --test src/server/services/skills-service.test.ts`
 *
 * Uses local-source fixtures (no real git) so tests are deterministic and fast.
 * Source repos live INSIDE the workspace so they pass the local-path sandbox
 * check (`assertLocalPathSafe` from source-resolver.ts).
 *
 * Mirrors U4 test scenarios:
 *   - Happy path (F2): install creates real file + lock entry
 *   - Happy path (AE4): listInstalled reads existing CLI-format lock file
 *   - Edge case (AE3): install already-installed returns 'already-installed'
 *   - Happy path (F3): remove deletes dir + lock entry
 *   - Happy path (F4): update re-fetches source, overwrites local files
 *   - Edge case: listInstalled detects symlinked-legacy skills
 *   - Edge case: update on symlinked-legacy skill refuses
 *   - Integration: install -> list -> remove cycle leaves no trace
 *   - Global scope: install writes to ~/.claude/skills/ + global lock
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  symlinkSync,
  readFileSync,
  statSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { skillsService, assertSkillScope } from './skills-service.js';
import {
  writeProjectLock,
  writeGlobalLock,
  readProjectLock,
  readGlobalLock,
} from '../utils/skills-lock.js';
import type { LocalSkillLockFile } from './skills/types.js';

let tmpRoot: string;
let tmpHome: string;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalFetch = global.fetch;

/**
 * Build a fake source repository INSIDE the workspace so it passes the
 * local-path sandbox check. Created at `<workspace>/.test-src/<name>/`.
 */
function buildSourceRepoInWorkspace(
  workspace: string,
  repoName: string,
  skills: Array<{ name: string; description: string }>
): string {
  const repoRoot = join(workspace, '.test-src', repoName);
  for (const skill of skills) {
    const skillDir = join(repoRoot, 'skills', skill.name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: ${skill.name}
description: ${skill.description}
---

# ${skill.name}

Skill body.
`,
      'utf-8'
    );
  }
  return repoRoot;
}

function expertPackageFetch(zipBytes: Uint8Array, options?: { childAvailable?: boolean }): typeof fetch {
  const childAvailable = options?.childAvailable ?? true;
  return async (input) => {
    const url = String(input);
    if (url.includes('/api/v1/skillsets/test-package')) {
      return Response.json({
        slug: 'test-package', displayName: 'Test Package', summary: 'A package', scene: 'tech',
        content: '---\nname: test-package\ndescription: Test orchestration\n---\n# Workflow\n',
        skills: [{ namespace: 'owner', slug: 'child-skill' }], skillCount: 1,
      });
    }
    if (url.includes('/api/v1/skills/child-skill')) {
      if (!childAvailable) return new Response('', { status: 404 });
      return Response.json({
        slug: 'child-skill',
        namespace: { handle: 'owner' }, owner: { handle: 'owner', displayName: 'Owner' },
        latestVersion: { version: '1.0.0' },
        skill: { displayName: 'Child Skill', summary: 'Child summary', category: 'tech', stats: {} },
        securityReports: {},
      });
    }
    if (url.includes('/api/v1/download')) {
      return new Response(zipBytes, { status: 200, headers: { 'Content-Type': 'application/zip' } });
    }
    return new Response('', { status: 404 });
  };
}

function buildSkillArchive(root: string, slug: string): Uint8Array {
  const fixture = join(root, `.test-src/${slug}-zip`);
  mkdirSync(fixture, { recursive: true });
  writeFileSync(join(fixture, 'SKILL.md'), `---\nname: ${slug}\ndescription: ${slug}\n---\n# ${slug}\n`);
  const archivePath = join(root, `${slug}.zip`);
  execFileSync('zip', ['-q', archivePath, 'SKILL.md'], { cwd: fixture });
  return new Uint8Array(readFileSync(archivePath));
}

describe('SkillsService', () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'skills-svc-root-'));
    tmpHome = mkdtempSync(join(tmpdir(), 'skills-svc-home-'));
    process.env.HOME = tmpHome;
    delete process.env.USERPROFILE;
    delete process.env.XDG_STATE_HOME;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.HOME = originalHome;
    if (originalUserProfile !== undefined) {
      process.env.USERPROFILE = originalUserProfile;
    } else {
      delete process.env.USERPROFILE;
    }
    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(tmpHome, { recursive: true, force: true });
  });

  describe('resolveSource', () => {
    it('discovers skills in a local source directory', async () => {
      const sourceRepo = buildSourceRepoInWorkspace(tmpRoot, 'multi-skill', [
        { name: 'alpha-skill', description: 'Alpha skill' },
        { name: 'beta-skill', description: 'Beta skill' },
      ]);

      const discovered = await skillsService.resolveSource({
        source: sourceRepo,
        workspacePath: tmpRoot,
      });

      assert.strictEqual(discovered.length, 2);
      const names = discovered.map((d) => d.name).sort();
      assert.deepStrictEqual(names, ['alpha-skill', 'beta-skill']);
    });

    it('throws when local source path does not exist', async () => {
      await assert.rejects(
        () => skillsService.resolveSource({
          source: join(tmpRoot, 'nonexistent'),
          workspacePath: tmpRoot,
        }),
        /does not exist/
      );
    });

    it('rejects local source outside workspace + home (Security #1)', async () => {
      await assert.rejects(
        () => skillsService.resolveSource({
          source: '/etc/passwd',
          workspacePath: tmpRoot,
        }),
        /outside the workspace and user home directory/
      );
    });
  });

  describe('install + listInstalled + remove (full cycle)', () => {
    it('install creates real files (not symlinks) and writes project lock entry', async () => {
      const sourceRepo = buildSourceRepoInWorkspace(tmpRoot, 'install-basic', [
        { name: 'web-design-guidelines', description: 'Web design guidelines' },
      ]);

      const results = await skillsService.install({
        source: sourceRepo,
        skills: ['web-design-guidelines'],
        scope: 'project',
        workspacePath: tmpRoot,
      });

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0]!.status, 'installed');
      assert.strictEqual(results[0]!.skillName, 'web-design-guidelines');

      // Verify the installed file exists and is a real file (not symlink)
      const skillFile = join(tmpRoot, '.claude', 'skills', 'web-design-guidelines', 'SKILL.md');
      assert.ok(existsSync(skillFile), 'SKILL.md should exist');
      const lst = statSync(skillFile);
      assert.ok(lst.isFile(), 'SKILL.md should be a regular file (not symlink)');

      // Verify lock entry
      const lock = await readProjectLock(tmpRoot);
      assert.ok(lock.skills['web-design-guidelines'], 'lock entry should exist');
      assert.strictEqual(lock.skills['web-design-guidelines']!.sourceType, 'local');
      assert.ok(lock.skills['web-design-guidelines']!.computedHash.length > 0);
    });

    it('install with multiple skills returns per-skill InstallResult[] (Coherence #3)', async () => {
      const sourceRepo = buildSourceRepoInWorkspace(tmpRoot, 'install-multi', [
        { name: 'skill-a', description: 'a' },
        { name: 'skill-b', description: 'b' },
      ]);

      const results = await skillsService.install({
        source: sourceRepo,
        skills: ['skill-a', 'skill-b', 'skill-missing'],
        scope: 'project',
        workspacePath: tmpRoot,
      });

      assert.strictEqual(results.length, 3);
      const statuses = results.map((r) => r.status).sort();
      assert.deepStrictEqual(statuses, ['error', 'installed', 'installed']);

      const errorResult = results.find((r) => r.status === 'error')!;
      assert.match(errorResult.error!, /not found/);
    });

    it('install on already-installed skill returns already-installed (AE3)', async () => {
      const sourceRepo = buildSourceRepoInWorkspace(tmpRoot, 'install-already', [
        { name: 'foo', description: 'foo skill' },
      ]);

      await skillsService.install({
        source: sourceRepo,
        skills: ['foo'],
        scope: 'project',
        workspacePath: tmpRoot,
      });

      // Second install (no force) — should report already-installed
      const results = await skillsService.install({
        source: sourceRepo,
        skills: ['foo'],
        scope: 'project',
        workspacePath: tmpRoot,
      });

      assert.strictEqual(results[0]!.status, 'already-installed');
    });

    it('install with force=true overwrites existing copy (R8 reinstall)', async () => {
      const sourceRepo = buildSourceRepoInWorkspace(tmpRoot, 'install-force', [
        { name: 'bar', description: 'bar skill' },
      ]);

      await skillsService.install({
        source: sourceRepo,
        skills: ['bar'],
        scope: 'project',
        workspacePath: tmpRoot,
      });

      const results = await skillsService.install({
        source: sourceRepo,
        skills: ['bar'],
        scope: 'project',
        workspacePath: tmpRoot,
        force: true,
      });

      assert.strictEqual(results[0]!.status, 'installed');
    });

    it('listInstalled reads pre-existing project lock (AE4)', async () => {
      const existingLock: LocalSkillLockFile = {
        version: 1,
        skills: {
          'legacy-skill': {
            source: 'some/repo',
            sourceType: 'github',
            computedHash: 'abc123',
            skillPath: 'skills/legacy-skill/SKILL.md',
          },
        },
      };
      await writeProjectLock(tmpRoot, existingLock);

      const installed = await skillsService.listInstalled(tmpRoot);
      assert.strictEqual(installed.length, 1);
      assert.strictEqual(installed[0]!.name, 'legacy-skill');
      assert.strictEqual(installed[0]!.scope, 'project');
      assert.strictEqual(installed[0]!.source, 'some/repo');
      assert.strictEqual(installed[0]!.computedHash, 'abc123');
    });

    it('listInstalled includes the local SKILL.md description when it exists', async () => {
      const sourceRepo = buildSourceRepoInWorkspace(tmpRoot, 'description-list', [
        { name: 'described-skill', description: 'A concise local skill description.' },
      ]);
      await skillsService.install({
        source: sourceRepo,
        skills: ['described-skill'],
        scope: 'project',
        workspacePath: tmpRoot,
      });

      const installed = await skillsService.listInstalled(tmpRoot);
      assert.strictEqual(
        installed.find((skill) => skill.name === 'described-skill')?.description,
        'A concise local skill description.'
      );
    });

    it('listInstalled merges project + global entries', async () => {
      await writeProjectLock(tmpRoot, {
        version: 1,
        skills: {
          'proj-skill': {
            source: 'a/b', sourceType: 'github', computedHash: 'p-hash',
          },
        },
      });

      await writeGlobalLock({
        version: 3,
        skills: {
          'global-skill': {
            source: 'c/d', sourceType: 'github', sourceUrl: 'https://github.com/c/d.git',
            skillFolderHash: 'g-hash', installedAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-02T00:00:00Z',
          },
        },
      });

      const installed = await skillsService.listInstalled(tmpRoot);
      assert.strictEqual(installed.length, 2);
      const projSkill = installed.find((s) => s.scope === 'project');
      const globalSkill = installed.find((s) => s.scope === 'global');
      assert.ok(projSkill);
      assert.ok(globalSkill);
      assert.strictEqual(projSkill!.name, 'proj-skill');
      assert.strictEqual(globalSkill!.name, 'global-skill');
      assert.strictEqual(globalSkill!.installedAt, '2024-01-01T00:00:00Z');
    });

    it('listInstalled marks existing symlinked skills as isLegacySymlink', async () => {
      const realTarget = join(tmpRoot, 'some-real-dir');
      mkdirSync(realTarget, { recursive: true });
      writeFileSync(join(realTarget, 'SKILL.md'), `---\nname: legacy\ndescription: x\n---\n`);

      const skillsDir = join(tmpRoot, '.claude', 'skills');
      mkdirSync(skillsDir, { recursive: true });
      symlinkSync(realTarget, join(skillsDir, 'legacy-skill'), 'dir');

      await writeProjectLock(tmpRoot, {
        version: 1,
        skills: {
          'legacy-skill': {
            source: 'a/b', sourceType: 'github', computedHash: 'x',
          },
        },
      });

      const installed = await skillsService.listInstalled(tmpRoot);
      const legacy = installed.find((s) => s.name === 'legacy-skill');
      assert.ok(legacy);
      assert.strictEqual(legacy!.isLegacySymlink, true);
    });

    it('remove deletes files and lock entry (F3)', async () => {
      const sourceRepo = buildSourceRepoInWorkspace(tmpRoot, 'remove-basic', [
        { name: 'remove-me', description: 'rm' },
      ]);

      await skillsService.install({
        source: sourceRepo,
        skills: ['remove-me'],
        scope: 'project',
        workspacePath: tmpRoot,
      });

      const skillPath = join(tmpRoot, '.claude', 'skills', 'remove-me');
      assert.ok(existsSync(skillPath));

      const result = await skillsService.remove({
        skillName: 'remove-me',
        scope: 'project',
        workspacePath: tmpRoot,
      });

      assert.strictEqual(result.status, 'removed');
      assert.ok(!existsSync(skillPath), 'skill directory should be deleted');

      const lock = await readProjectLock(tmpRoot);
      assert.ok(!lock.skills['remove-me'], 'lock entry should be removed');
    });

    it('remove on a non-existent skill returns not-found', async () => {
      const result = await skillsService.remove({
        skillName: 'never-installed',
        scope: 'project',
        workspacePath: tmpRoot,
      });
      assert.strictEqual(result.status, 'not-found');
    });

    it('remove on symlinked legacy skill refuses and preserves lock entry', async () => {
      // The lock file is the source of truth — if remove fails on the
      // filesystem (symlink refusal), we must NOT remove the lock entry,
      // otherwise the UI would show the skill as gone while it's still
      // symlinked on disk.
      const realTarget = join(tmpRoot, 'real');
      mkdirSync(realTarget, { recursive: true });
      const skillsDir = join(tmpRoot, '.claude', 'skills');
      mkdirSync(skillsDir, { recursive: true });
      symlinkSync(realTarget, join(skillsDir, 'legacy'), 'dir');

      await writeProjectLock(tmpRoot, {
        version: 1,
        skills: {
          'legacy': {
            source: 'a/b', sourceType: 'github', computedHash: 'x',
          },
        },
      });

      const result = await skillsService.remove({
        skillName: 'legacy',
        scope: 'project',
        workspacePath: tmpRoot,
      });

      assert.strictEqual(result.status, 'error');
      assert.match(result.error!, /legacy skill/i);

      // Lock entry MUST be preserved (remove failed)
      const lock = await readProjectLock(tmpRoot);
      assert.ok(lock.skills['legacy'], 'lock entry should be preserved when remove fails');
    });

    it('integration: install -> list -> remove leaves no trace', async () => {
      const sourceRepo = buildSourceRepoInWorkspace(tmpRoot, 'integration', [
        { name: 'integration-test', description: 'it' },
      ]);

      await skillsService.install({
        source: sourceRepo,
        skills: ['integration-test'],
        scope: 'project',
        workspacePath: tmpRoot,
      });

      const installed = await skillsService.listInstalled(tmpRoot);
      assert.strictEqual(installed.length, 1);

      await skillsService.remove({
        skillName: 'integration-test',
        scope: 'project',
        workspacePath: tmpRoot,
      });

      const installedAfter = await skillsService.listInstalled(tmpRoot);
      assert.strictEqual(installedAfter.length, 0);

      const lockAfter = await readProjectLock(tmpRoot);
      assert.strictEqual(Object.keys(lockAfter.skills).length, 0);
    });
  });

  describe('update', () => {
    it('update re-fetches source and overwrites local files (F4)', async () => {
      const sourceRepo = buildSourceRepoInWorkspace(tmpRoot, 'update-basic', [
        { name: 'update-target', description: 'original description' },
      ]);

      await skillsService.install({
        source: sourceRepo,
        skills: ['update-target'],
        scope: 'project',
        workspacePath: tmpRoot,
      });

      // Mutate the source — change the SKILL.md body
      writeFileSync(
        join(sourceRepo, 'skills', 'update-target', 'SKILL.md'),
        `---\nname: update-target\ndescription: original description\n---\n\nUpdated body.\n`,
        'utf-8'
      );

      const result = await skillsService.update({
        skillName: 'update-target',
        scope: 'project',
        workspacePath: tmpRoot,
      });

      assert.strictEqual(result.status, 'installed');

      const installedContent = readFileSync(
        join(tmpRoot, '.claude', 'skills', 'update-target', 'SKILL.md'),
        'utf-8'
      );
      assert.ok(installedContent.includes('Updated body.'));
    });

    it('update on symlinked-legacy skill refuses', async () => {
      const realTarget = join(tmpRoot, 'real-update-target');
      mkdirSync(realTarget, { recursive: true });
      writeFileSync(join(realTarget, 'SKILL.md'), `---\nname: legacy-update\ndescription: x\n---\n`);

      const skillsDir = join(tmpRoot, '.claude', 'skills');
      mkdirSync(skillsDir, { recursive: true });
      symlinkSync(realTarget, join(skillsDir, 'legacy-update'), 'dir');

      await writeProjectLock(tmpRoot, {
        version: 1,
        skills: {
          'legacy-update': {
            source: 'a/b', sourceType: 'github', computedHash: 'x',
          },
        },
      });

      const result = await skillsService.update({
        skillName: 'legacy-update',
        scope: 'project',
        workspacePath: tmpRoot,
      });

      assert.strictEqual(result.status, 'error');
      assert.match(result.error!, /legacy skill/i);
    });

    it('update on a skill not in the lock file returns error', async () => {
      const result = await skillsService.update({
        skillName: 'not-locked',
        scope: 'project',
        workspacePath: tmpRoot,
      });

      assert.strictEqual(result.status, 'error');
      assert.match(result.error!, /not in the project lock file/);
    });
  });

  describe('global scope', () => {
    it('install to global scope writes to ~/.claude/skills/ and global lock', async () => {
      // Source repo lives inside tmpRoot for sandbox compliance.
      const sourceRepo = buildSourceRepoInWorkspace(tmpRoot, 'global-source', [
        { name: 'global-skill', description: 'global' },
      ]);

      const results = await skillsService.install({
        source: sourceRepo,
        skills: ['global-skill'],
        scope: 'global',
        // workspacePath is required for sandbox even when installing globally
        workspacePath: tmpRoot,
      });

      assert.strictEqual(results[0]!.status, 'installed');

      const skillFile = join(tmpHome, '.claude', 'skills', 'global-skill', 'SKILL.md');
      assert.ok(existsSync(skillFile));

      const globalLock = await readGlobalLock();
      assert.ok(globalLock.skills['global-skill']);
      assert.strictEqual(globalLock.skills['global-skill']!.sourceType, 'local');
    });
  });

  describe('Expert Package install', () => {
    it('installs orchestration and child with durable kinds and excludes the transport archive', async () => {
      const fixture = join(tmpRoot, '.test-src', 'expert-package-zip');
      mkdirSync(fixture, { recursive: true });
      writeFileSync(join(fixture, 'SKILL.md'), '---\nname: child-skill\ndescription: Child skill\n---\n# Child\n');
      const archivePath = join(tmpRoot, 'child.zip');
      execFileSync('zip', ['-q', archivePath, 'SKILL.md'], { cwd: fixture });
      const upstreamFetch = expertPackageFetch(new Uint8Array(readFileSync(archivePath)));
      let packageDefinitionRequests = 0;
      global.fetch = (async (input, init) => {
        if (String(input).includes('/api/v1/skillsets/test-package')) packageDefinitionRequests += 1;
        return upstreamFetch(input, init);
      }) as typeof fetch;

      const results = await skillsService.installExpertPackage({
        packageSlug: 'test-package', scope: 'project', workspacePath: tmpRoot,
      });

      assert.deepStrictEqual(results.map((result) => [result.id, result.status]), [
        ['orchestrator:test-package', 'installed'],
        ['skill:owner/child-skill', 'installed'],
      ]);
      const installed = await skillsService.listInstalled(tmpRoot);
      assert.strictEqual(installed.find((item) => item.name === 'test-package')?.kind, 'expert-package-orchestrator');
      assert.strictEqual(installed.find((item) => item.name === 'child-skill')?.kind, 'skill');
      assert.strictEqual(existsSync(join(tmpRoot, '.claude', 'skills', 'child-skill', 'skill.zip')), false);
      assert.strictEqual(packageDefinitionRequests, 1);
    });

    it('rejects an incomplete package before any filesystem mutation', async () => {
      global.fetch = expertPackageFetch(new Uint8Array(), { childAvailable: false });
      await assert.rejects(
        () => skillsService.installExpertPackage({
          packageSlug: 'test-package', scope: 'project', workspacePath: tmpRoot,
        }),
        /unavailable/i,
      );
      assert.strictEqual(existsSync(join(tmpRoot, '.claude', 'skills', 'test-package')), false);
    });

    it('rejects retry ids outside the canonical package before installation', async () => {
      global.fetch = expertPackageFetch(new Uint8Array());
      await assert.rejects(
        () => skillsService.installExpertPackage({
          packageSlug: 'test-package', scope: 'project', workspacePath: tmpRoot,
          itemIds: ['skill:other/not-owned'],
        }),
        /does not belong/,
      );
      assert.strictEqual(existsSync(join(tmpRoot, '.claude', 'skills', 'test-package')), false);
    });

    it('does not treat a same-name Skill from another source as package orchestration', async () => {
      const existingSource = buildSourceRepoInWorkspace(tmpRoot, 'name-collision', [
        { name: 'test-package', description: 'Unrelated standard Skill' },
      ]);
      await skillsService.install({
        source: existingSource,
        skills: ['test-package'],
        scope: 'project',
        workspacePath: tmpRoot,
      });

      const fixture = join(tmpRoot, '.test-src', 'collision-child-zip');
      mkdirSync(fixture, { recursive: true });
      writeFileSync(join(fixture, 'SKILL.md'), '---\nname: child-skill\ndescription: Child skill\n---\n');
      const archivePath = join(tmpRoot, 'collision-child.zip');
      execFileSync('zip', ['-q', archivePath, 'SKILL.md'], { cwd: fixture });
      global.fetch = expertPackageFetch(new Uint8Array(readFileSync(archivePath)));

      const results = await skillsService.installExpertPackage({
        packageSlug: 'test-package', scope: 'project', workspacePath: tmpRoot,
      });

      assert.strictEqual(results[0]?.status, 'error');
      assert.match(results[0]?.error || '', /another source/);
      const lock = await readProjectLock(tmpRoot);
      assert.strictEqual(lock.skills['test-package']?.source, existingSource);
    });

    it('preserves successful items and retries only the failed child', async () => {
      const archives = new Map([
        ['child-one', buildSkillArchive(tmpRoot, 'child-one')],
        ['child-two', buildSkillArchive(tmpRoot, 'child-two')],
      ]);
      const downloadCounts = new Map<string, number>();
      let failChildTwo = true;
      global.fetch = (async (input) => {
        const url = new URL(String(input));
        if (url.pathname.includes('/api/v1/skillsets/test-package')) {
          return Response.json({
            slug: 'test-package', displayName: 'Test Package', summary: 'A package', scene: 'tech',
            content: '---\nname: test-package\ndescription: Test orchestration\n---\n# Workflow\n',
            skills: [
              { namespace: 'owner', slug: 'child-one' },
              { namespace: 'owner', slug: 'child-two' },
            ],
            skillCount: 2,
          });
        }
        if (url.pathname.includes('/api/v1/skills/')) {
          const slug = url.pathname.split('/').at(-1)!;
          return Response.json({
            slug,
            namespace: { handle: 'owner' }, owner: { handle: 'owner', displayName: 'Owner' },
            latestVersion: { version: '1.0.0' },
            skill: { displayName: slug, summary: `${slug} summary`, category: 'tech', stats: {} },
            securityReports: {},
          });
        }
        if (url.pathname.includes('/api/v1/download')) {
          const slug = url.searchParams.get('slug')!;
          downloadCounts.set(slug, (downloadCounts.get(slug) ?? 0) + 1);
          if (slug === 'child-two' && failChildTwo) return new Response('', { status: 503 });
          return new Response(archives.get(slug), {
            status: 200,
            headers: { 'Content-Type': 'application/zip' },
          });
        }
        return new Response('', { status: 404 });
      }) as typeof fetch;

      const first = await skillsService.installExpertPackage({
        packageSlug: 'test-package', scope: 'project', workspacePath: tmpRoot,
      });
      assert.deepStrictEqual(first.map((result) => [result.id, result.status]), [
        ['orchestrator:test-package', 'installed'],
        ['skill:owner/child-one', 'installed'],
        ['skill:owner/child-two', 'error'],
      ]);
      assert.strictEqual(existsSync(join(tmpRoot, '.claude', 'skills', 'child-one', 'SKILL.md')), true);

      failChildTwo = false;
      const retry = await skillsService.installExpertPackage({
        packageSlug: 'test-package', scope: 'project', workspacePath: tmpRoot,
        itemIds: ['skill:owner/child-two'],
      });
      assert.deepStrictEqual(retry.map((result) => [result.id, result.status]), [
        ['skill:owner/child-two', 'installed'],
      ]);
      assert.strictEqual(downloadCounts.get('child-one'), 1);
      assert.strictEqual(downloadCounts.get('child-two'), 2);
    });

    it('writes Expert Package items only to the selected global lock', async () => {
      global.fetch = expertPackageFetch(buildSkillArchive(tmpRoot, 'child-skill'));

      const results = await skillsService.installExpertPackage({
        packageSlug: 'test-package', scope: 'global', workspacePath: tmpRoot,
      });

      assert.deepStrictEqual(results.map((result) => result.status), ['installed', 'installed']);
      const globalLock = await readGlobalLock();
      const projectLock = await readProjectLock(tmpRoot);
      assert.strictEqual(globalLock.skills['test-package']?.source, 'skillhub-package:test-package');
      assert.strictEqual(globalLock.skills['child-skill']?.source, 'skillhub-cn:owner/child-skill');
      assert.deepStrictEqual(projectLock.skills, {});
    });
  });

  describe('assertSkillScope', () => {
    it('accepts project and global', () => {
      assert.doesNotThrow(() => assertSkillScope('project'));
      assert.doesNotThrow(() => assertSkillScope('global'));
    });

    it('rejects local (Skills page does not support local scope)', () => {
      assert.throws(
        () => assertSkillScope('local'),
        /Skills page does not support "local"/
      );
    });

    it('rejects unknown scopes', () => {
      assert.throws(
        () => assertSkillScope('user'),
        /Invalid skill scope/
      );
    });
  });
});
