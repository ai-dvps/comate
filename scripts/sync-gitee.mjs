import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DEFAULT_API_BASE = 'https://gitee.com/api/v5';

function requiredEnvironment(name, environment = process.env) {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function buildRepositoryPayload(environment = process.env) {
  const repo = requiredEnvironment('GITEE_REPO', environment);
  return {
    name: repo,
    path: repo,
    description: environment.GITEE_REPOSITORY_DESCRIPTION || '',
    homepage: environment.GITEE_REPOSITORY_HOMEPAGE || '',
    private: environment.GITEE_REPOSITORY_PRIVATE === 'true',
    auto_init: false,
    has_issues: true,
    has_wiki: true,
  };
}

export function parseReleaseEvent(event) {
  const release = event?.release;
  if (!release?.tag_name) {
    throw new Error('GitHub release event is missing release.tag_name');
  }

  const updatePayload = {
    tag_name: release.tag_name,
    name: release.name || release.tag_name,
    body: release.body || '',
    prerelease: Boolean(release.prerelease),
  };
  return {
    tagName: release.tag_name,
    createPayload: {
      ...updatePayload,
      target_commitish: release.target_commitish || event.repository?.default_branch || 'main',
    },
    updatePayload,
  };
}

export function releaseNeedsUpdate(release, updatePayload) {
  return ['tag_name', 'name', 'body', 'prerelease'].some(
    (field) => release[field] !== updatePayload[field],
  );
}

export function planAssetChanges(localAssets, remoteAssets, { replaceMatches = false } = {}) {
  const localByName = new Map(localAssets.map((asset) => [asset.name, asset]));
  const remoteByName = new Map();
  for (const asset of remoteAssets) {
    const matches = remoteByName.get(asset.name) || [];
    matches.push(asset);
    remoteByName.set(asset.name, matches);
  }

  const deletions = [];
  const uploads = [];

  for (const [name, matches] of remoteByName) {
    const local = localByName.get(name);
    const exactMatch =
      !replaceMatches &&
      local &&
      matches.length === 1 &&
      Number(matches[0].size) === local.size;
    if (!exactMatch) {
      deletions.push(...matches);
    }
    if (local && !exactMatch) {
      uploads.push(local);
    }
    localByName.delete(name);
  }

  uploads.push(...localByName.values());
  return { deletions, uploads };
}

function createClient(environment = process.env) {
  const token = requiredEnvironment('GITEE_TOKEN', environment);
  const owner = requiredEnvironment('GITEE_OWNER', environment);
  const repo = requiredEnvironment('GITEE_REPO', environment);
  const baseUrl = environment.GITEE_API_BASE || DEFAULT_API_BASE;

  async function request(path, { method = 'GET', body, allowNotFound = false } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });

    if (allowNotFound && response.status === 404) {
      return null;
    }

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${method} ${path} failed (${response.status}): ${text.slice(0, 1_000)}`);
    }
    return text ? JSON.parse(text) : null;
  }

  return { token, owner, repo, baseUrl, request };
}

async function ensureRepository(environment = process.env, dependencies = {}) {
  const client = dependencies.client || createClient(environment);
  const repoPath = `/repos/${encodeURIComponent(client.owner)}/${encodeURIComponent(client.repo)}`;
  const existing = await client.request(repoPath, { allowNotFound: true });
  if (existing) {
    console.log(`Gitee repository ${client.owner}/${client.repo} already exists`);
    return existing;
  }

  const created = await client.request(`/orgs/${encodeURIComponent(client.owner)}/repos`, {
    method: 'POST',
    body: buildRepositoryPayload(environment),
  });
  console.log(`Created Gitee repository ${client.owner}/${client.repo}`);
  return created;
}

function readLocalAssets(assetDirectory) {
  return readdirSync(assetDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(assetDirectory, entry.name);
      return { name: entry.name, path, size: statSync(path).size };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function listRemoteAssets(client, releaseId) {
  const assets = [];
  for (let page = 1; ; page += 1) {
    const batch = await client.request(
      `/repos/${encodeURIComponent(client.owner)}/${encodeURIComponent(client.repo)}` +
        `/releases/${releaseId}/attach_files?page=${page}&per_page=100&direction=asc`,
    );
    assets.push(...batch);
    if (batch.length < 100) return assets;
  }
}

function uploadAsset(client, releaseId, asset) {
  const url =
    `${client.baseUrl}/repos/${encodeURIComponent(client.owner)}/${encodeURIComponent(client.repo)}` +
    `/releases/${releaseId}/attach_files`;
  const result = spawnSync(
    'curl',
    [
      '--fail-with-body',
      '--silent',
      '--show-error',
      '--connect-timeout',
      '30',
      '--max-time',
      '1800',
      '--request',
      'POST',
      '--header',
      `Authorization: Bearer ${client.token}`,
      '--form',
      `file=@${asset.path}`,
      url,
    ],
    { encoding: 'utf8' },
  );

  if (result.status !== 0) {
    throw new Error(`Uploading ${asset.name} failed: ${result.stderr || result.stdout}`);
  }
  console.log(`Uploaded ${asset.name} (${asset.size} bytes)`);
}

export async function syncRelease(assetDirectory, environment = process.env, dependencies = {}) {
  const client = dependencies.client || createClient(environment);
  const eventPath =
    environment.GITEE_RELEASE_EVENT_PATH?.trim() ||
    requiredEnvironment('GITHUB_EVENT_PATH', environment);
  const event = JSON.parse(readFileSync(eventPath, 'utf8'));
  const { tagName, createPayload, updatePayload } = parseReleaseEvent(event);
  const repositoryPath = `/repos/${encodeURIComponent(client.owner)}/${encodeURIComponent(client.repo)}`;
  const releasePath = `${repositoryPath}/releases/tags/${encodeURIComponent(tagName)}`;

  let release = await client.request(releasePath, { allowNotFound: true });
  if (release) {
    if (releaseNeedsUpdate(release, updatePayload)) {
      release = await client.request(`${repositoryPath}/releases/${release.id}`, {
        method: 'PATCH',
        body: updatePayload,
      });
      console.log(`Updated Gitee release ${tagName}`);
    } else {
      console.log(`Gitee release ${tagName} metadata is unchanged`);
    }
  } else {
    release = await client.request(`${repositoryPath}/releases`, {
      method: 'POST',
      body: createPayload,
    });
    console.log(`Created Gitee release ${tagName}`);
  }

  const localAssets = (dependencies.readLocalAssets || readLocalAssets)(assetDirectory);
  const remoteAssets = await listRemoteAssets(client, release.id);
  const { deletions, uploads } = planAssetChanges(localAssets, remoteAssets, {
    replaceMatches: true,
  });

  for (const asset of deletions) {
    await client.request(`${repositoryPath}/releases/${release.id}/attach_files/${asset.id}`, {
      method: 'DELETE',
    });
    console.log(`Removed stale Gitee asset ${asset.name}`);
  }
  for (const asset of uploads) {
    await (dependencies.uploadAsset || uploadAsset)(client, release.id, asset);
  }

  const finalAssets = await listRemoteAssets(client, release.id);
  const remaining = planAssetChanges(localAssets, finalAssets);
  if (remaining.deletions.length || remaining.uploads.length) {
    throw new Error('Gitee release assets do not match the GitHub release after synchronization');
  }
  console.log(`Gitee release ${tagName} is synchronized with ${localAssets.length} asset(s)`);
}

export async function deleteRelease(environment = process.env, dependencies = {}) {
  const client = dependencies.client || createClient(environment);
  const eventPath = requiredEnvironment('GITHUB_EVENT_PATH', environment);
  const event = JSON.parse(readFileSync(eventPath, 'utf8'));
  const { tagName } = parseReleaseEvent(event);
  const repositoryPath = `/repos/${encodeURIComponent(client.owner)}/${encodeURIComponent(client.repo)}`;
  const release = await client.request(
    `${repositoryPath}/releases/tags/${encodeURIComponent(tagName)}`,
    { allowNotFound: true },
  );

  if (!release) {
    console.log(`Gitee release ${tagName} is already absent`);
    return;
  }

  await client.request(`${repositoryPath}/releases/${release.id}`, { method: 'DELETE' });
  console.log(`Deleted Gitee release ${tagName}`);
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  if (command === 'ensure-repository') {
    await ensureRepository();
    return;
  }
  if (command === 'sync-release') {
    if (!argument) throw new Error('sync-release requires an asset directory');
    await syncRelease(argument);
    return;
  }
  if (command === 'delete-release') {
    await deleteRelease();
    return;
  }
  throw new Error(
    'Usage: sync-gitee.mjs <ensure-repository|sync-release|delete-release> [asset-directory]',
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
