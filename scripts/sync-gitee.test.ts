import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildRepositoryPayload,
  deleteRelease,
  parseReleaseEvent,
  planAssetChanges,
  readLocalAssets,
  releaseNeedsUpdate,
  syncRelease,
} from './sync-gitee.mjs';

function createEventFile(release: Record<string, unknown>) {
  const directory = mkdtempSync(join(tmpdir(), 'sync-gitee-test-'));
  const eventPath = join(directory, 'event.json');
  writeFileSync(
    eventPath,
    JSON.stringify({ repository: { default_branch: 'main' }, release }),
    'utf8',
  );
  return eventPath;
}

test('buildRepositoryPayload creates a non-initialized mirror repository', () => {
  assert.deepEqual(
    buildRepositoryPayload({
      GITEE_REPO: 'comate',
      GITEE_REPOSITORY_DESCRIPTION: 'Desktop agent workspace',
      GITEE_REPOSITORY_HOMEPAGE: 'https://github.com/ai-dvps/comate',
      GITEE_REPOSITORY_PRIVATE: 'false',
    }),
    {
      name: 'comate',
      path: 'comate',
      description: 'Desktop agent workspace',
      homepage: 'https://github.com/ai-dvps/comate',
      private: false,
      auto_init: false,
      has_issues: true,
      has_wiki: true,
    },
  );
});

test('parseReleaseEvent preserves published metadata for create and update', () => {
  const parsed = parseReleaseEvent({
    repository: { default_branch: 'main' },
    release: {
      tag_name: 'v1.2.3',
      name: 'Comate 1.2.3',
      body: 'Release notes',
      prerelease: true,
      target_commitish: 'release-branch',
    },
  });

  assert.deepEqual(parsed.createPayload, {
    tag_name: 'v1.2.3',
    name: 'Comate 1.2.3',
    body: 'Release notes',
    prerelease: true,
    target_commitish: 'release-branch',
  });
  assert.deepEqual(parsed.updatePayload, {
    tag_name: 'v1.2.3',
    name: 'Comate 1.2.3',
    body: 'Release notes',
    prerelease: true,
  });
});

test('planAssetChanges can replace matching names when content identity is unavailable', () => {
  const local = [
    { name: 'Comate.dmg', path: '/tmp/Comate.dmg', size: 100 },
    { name: 'Comate.exe', path: '/tmp/Comate.exe', size: 200 },
  ];
  const remote = [
    { id: 1, name: 'Comate.dmg', size: 100 },
    { id: 2, name: 'obsolete.zip', size: 10 },
  ];

  const conservativePlan = planAssetChanges(local, remote, { replaceMatches: true });
  assert.deepEqual(
    conservativePlan.deletions.map((asset: { id: number }) => asset.id),
    [1, 2],
  );
  assert.deepEqual(
    conservativePlan.uploads.map((asset: { name: string }) => asset.name),
    ['Comate.dmg', 'Comate.exe'],
  );

  const verificationPlan = planAssetChanges(local, [remote[0]]);
  assert.deepEqual(verificationPlan, { deletions: [], uploads: [local[1]] });
});

test('readLocalAssets uploads small updater metadata before large packages', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sync-gitee-assets-'));
  writeFileSync(join(directory, 'Comate.exe'), Buffer.alloc(200));
  writeFileSync(join(directory, 'latest.yml'), Buffer.alloc(10));
  writeFileSync(join(directory, 'Comate.exe.blockmap'), Buffer.alloc(20));

  assert.deepEqual(
    readLocalAssets(directory).map((asset) => asset.name),
    ['latest.yml', 'Comate.exe.blockmap', 'Comate.exe'],
  );
});

test('parseReleaseEvent rejects non-release payloads', () => {
  assert.throws(() => parseReleaseEvent({}), /release\.tag_name/);
});

test('releaseNeedsUpdate skips no-op release edits', () => {
  const release = {
    tag_name: 'v1.2.3',
    name: 'Comate 1.2.3',
    body: 'Release notes',
    prerelease: false,
  };

  assert.equal(releaseNeedsUpdate(release, { ...release }), false);
  assert.equal(releaseNeedsUpdate(release, { ...release, body: 'New notes' }), true);
});

test('syncRelease reconciles paginated stale assets and conservatively replaces matches', async (t) => {
  t.mock.method(console, 'log', () => {});
  const eventPath = createEventFile({
    tag_name: 'v1.2.3',
    name: 'Comate 1.2.3',
    body: 'Release notes',
    prerelease: false,
  });
  const release = {
    id: 7,
    tag_name: 'v1.2.3',
    name: 'Comate 1.2.3',
    body: 'Release notes',
    prerelease: false,
  };
  let nextAssetId = 200;
  let assets = [
    { id: 1, name: 'Comate.dmg', size: 100 },
    ...Array.from({ length: 100 }, (_, index) => ({
      id: index + 2,
      name: `stale-${index}.zip`,
      size: 10,
    })),
  ];
  const calls: Array<{ path: string; method: string }> = [];
  const client = {
    owner: 'ai-dvps',
    repo: 'comate',
    async request(
      path: string,
      options: { method?: string; body?: unknown; allowNotFound?: boolean } = {},
    ) {
      const method = options.method || 'GET';
      calls.push({ path, method });
      if (path.endsWith('/releases/tags/v1.2.3')) return release;
      if (path.includes('/attach_files?')) {
        const page = Number(new URL(`https://gitee.test${path}`).searchParams.get('page'));
        return assets.slice((page - 1) * 100, page * 100);
      }
      const deletion = path.match(/\/attach_files\/(\d+)$/);
      if (method === 'DELETE' && deletion) {
        assets = assets.filter((asset) => asset.id !== Number(deletion[1]));
        return null;
      }
      throw new Error(`Unexpected ${method} ${path}`);
    },
  };

  await syncRelease(
    '/unused',
    { GITHUB_EVENT_PATH: eventPath },
    {
      client,
      readLocalAssets: () => [{ name: 'Comate.dmg', path: '/tmp/Comate.dmg', size: 100 }],
      uploadAsset: async (_client: unknown, _releaseId: number, asset: { name: string; size: number }) => {
        assets.push({ id: nextAssetId, name: asset.name, size: asset.size });
        nextAssetId += 1;
      },
    },
  );

  assert.deepEqual(assets, [{ id: 200, name: 'Comate.dmg', size: 100 }]);
  assert.equal(calls.filter((call) => call.method === 'DELETE').length, 101);
  assert.ok(calls.some((call) => call.path.includes('page=2')));
  assert.equal(calls.some((call) => call.method === 'PATCH'), false);
});

test('syncRelease creates a missing release and accepts an empty asset set', async (t) => {
  t.mock.method(console, 'log', () => {});
  const eventPath = createEventFile({ tag_name: 'v2.0.0', name: '', body: '', prerelease: false });
  const calls: Array<{ path: string; method: string }> = [];
  const client = {
    owner: 'ai-dvps',
    repo: 'comate',
    async request(
      path: string,
      options: { method?: string; body?: unknown; allowNotFound?: boolean } = {},
    ) {
      const method = options.method || 'GET';
      calls.push({ path, method });
      if (path.endsWith('/releases/tags/v2.0.0')) return null;
      if (method === 'POST' && path.endsWith('/releases')) return { id: 8 };
      if (path.includes('/attach_files?')) return [];
      throw new Error(`Unexpected ${method} ${path}`);
    },
  };

  await syncRelease('/unused', { GITHUB_EVENT_PATH: eventPath }, {
    client,
    readLocalAssets: () => [],
  });

  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
});

test('deleteRelease removes a withdrawn release and treats absence as success', async (t) => {
  t.mock.method(console, 'log', () => {});
  const eventPath = createEventFile({ tag_name: 'v1.0.0' });
  let present = true;
  const client = {
    owner: 'ai-dvps',
    repo: 'comate',
    async request(path: string, options: { method?: string } = {}) {
      if (path.endsWith('/releases/tags/v1.0.0')) return present ? { id: 9 } : null;
      if (path.endsWith('/releases/9') && options.method === 'DELETE') {
        present = false;
        return null;
      }
      throw new Error(`Unexpected ${options.method || 'GET'} ${path}`);
    },
  };

  await deleteRelease({ GITHUB_EVENT_PATH: eventPath }, { client });
  await deleteRelease({ GITHUB_EVENT_PATH: eventPath }, { client });
  assert.equal(present, false);
});

test('workflow passes release tags through an environment variable', () => {
  const workflow = readFileSync('.github/workflows/sync-gitee.yml', 'utf8');
  assert.match(workflow, /release_tag:\n\s+description:/);
  assert.match(
    workflow,
    /RELEASE_TAG: \$\{\{ github\.event\.release\.tag_name \|\| inputs\.release_tag \}\}/,
  );
  assert.match(
    workflow,
    /github\.event_name == 'workflow_dispatch' && inputs\.release_tag != ''/,
  );
  assert.match(
    workflow,
    /GITHUB_EVENT_NAME" == "workflow_dispatch" && -n "\$RELEASE_TAG"/,
  );
  assert.match(workflow, /GITEE_RELEASE_EVENT_PATH=/);
  assert.match(workflow, /name: Resolve current release metadata/);
  assert.doesNotMatch(
    workflow,
    /name: Resolve current release metadata\n\s+if:/,
  );
  assert.match(workflow, /jq -r '\.release\.assets \| length' "\$release_event_path"/);
  assert.doesNotMatch(workflow, /gh release view/);
  assert.match(workflow, /gh release download "\$RELEASE_TAG"/);
  assert.doesNotMatch(workflow, /gh release download "\$\{\{/);
  assert.match(readFileSync('scripts/sync-gitee.mjs', 'utf8'), /'7200'/);
});

test('syncRelease accepts a resolved release event path for manual backfills', async (t) => {
  t.mock.method(console, 'log', () => {});
  const dispatchEventPath = createEventFile({});
  const resolvedEventPath = createEventFile({
    tag_name: 'v3.0.0',
    name: '3.0.0',
    body: 'Backfilled release',
    prerelease: false,
  });
  const client = {
    owner: 'ai-dvps',
    repo: 'comate',
    async request(path: string, options: { method?: string } = {}) {
      if (path.endsWith('/releases/tags/v3.0.0')) return null;
      if (options.method === 'POST' && path.endsWith('/releases')) return { id: 30 };
      if (path.includes('/attach_files?')) return [];
      throw new Error(`Unexpected ${options.method || 'GET'} ${path}`);
    },
  };

  await syncRelease(
    '/unused',
    {
      GITHUB_EVENT_PATH: dispatchEventPath,
      GITEE_RELEASE_EVENT_PATH: resolvedEventPath,
    },
    { client, readLocalAssets: () => [] },
  );
});
