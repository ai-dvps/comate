import { execFile } from 'child_process';
import { mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { getExpertPackageDefinition, isExpertPackageCoordinate } from './expert-packages.js';
import { readBoundedResponse } from './bounded-response.js';

const execFileAsync = promisify(execFile);
const XFYUN_API_BASE = process.env.XFYUN_SKILLS_API_URL || 'https://skill.xfyun.cn/api/v1';
const SKILLHUB_API_BASE = process.env.SKILLHUB_CN_API_URL || 'https://api.skillhub.cn';
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 1_000;
const MAX_EXPANDED_BYTES = 100 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_ORCHESTRATION_BYTES = 256 * 1024;

export type RegistrySourceKind = 'skill' | 'expert-package-orchestrator';

export type RegistrySource = {
  source: string;
  kind: RegistrySourceKind;
  label: string;
  namespace?: string;
  slug?: string;
  packageSlug?: string;
};

const SEGMENT = '[A-Za-z0-9._-]+';

export function parseRegistrySource(source: string): RegistrySource | null {
  let match = new RegExp(`^xfyun:(${SEGMENT})$`).exec(source);
  if (match && isExpertPackageCoordinate(match[1])) {
    return { source, kind: 'skill', label: 'iFlytek', slug: match[1] };
  }
  match = new RegExp(`^skillhub-cn:(${SEGMENT})/(${SEGMENT})$`).exec(source);
  if (match && isExpertPackageCoordinate(match[1]) && isExpertPackageCoordinate(match[2])) {
    return {
      source,
      kind: 'skill',
      label: 'Tencent SkillHub',
      namespace: match[1],
      slug: match[2],
    };
  }
  match = new RegExp(`^skillhub-package:(${SEGMENT})$`).exec(source);
  if (match && isExpertPackageCoordinate(match[1])) {
    return {
      source,
      kind: 'expert-package-orchestrator',
      label: 'SkillHub Expert Package',
      packageSlug: match[1],
    };
  }
  return null;
}

export function registrySourceUrl(source: RegistrySource): string {
  if (source.packageSlug) {
    return `${SKILLHUB_API_BASE}/api/v1/skillsets/${encodeURIComponent(source.packageSlug)}`;
  }
  if (source.namespace && source.slug) {
    const params = new URLSearchParams({ slug: source.slug, namespace: source.namespace });
    return `${SKILLHUB_API_BASE}/api/v1/download?${params.toString()}`;
  }
  if (source.slug) {
    return `${XFYUN_API_BASE}/download/${encodeURIComponent(source.slug)}`;
  }
  throw new Error(`Unsupported registry source: ${source.source}`);
}

export function validateArchiveEntries(entries: string[]): void {
  if (entries.length === 0 || entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error(`Registry archive has an invalid entry count: ${entries.length}`);
  }
  for (const rawName of entries) {
    const name = rawName.replace(/\\/g, '/');
    const segments = name.split('/');
    if (!name || name.startsWith('/') || /^[A-Za-z]:\//.test(name) || name.includes('\0') || segments.includes('..')) {
      throw new Error(`Registry archive contains an unsafe path: ${rawName}`);
    }
  }
}

function validateZipInfo(output: string): void {
  let expandedBytes = 0;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^l[rwx-]{9}\s/.test(trimmed)) throw new Error('Registry archive contains a symbolic link');
    const match = /^[dl-][rwx-]{9}\s+\S+\s+\S+\s+(\d+)\s/.exec(trimmed);
    if (!match) continue;
    const size = Number(match[1]);
    if (size > MAX_SINGLE_FILE_BYTES) throw new Error('Registry archive contains an oversized file');
    expandedBytes += size;
    if (expandedBytes > MAX_EXPANDED_BYTES) throw new Error('Registry archive expands beyond the allowed size');
  }
}

async function downloadArchive(source: RegistrySource, destination: string): Promise<void> {
  const response = await fetch(registrySourceUrl(source), {
    headers: { Accept: 'application/zip, application/octet-stream' },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Failed to download ${source.label} skill: ${response.status}`);
  const bytes = Buffer.from(await readBoundedResponse(
    response,
    MAX_ARCHIVE_BYTES,
    'Registry archive is too large',
  ));

  const archivePath = join(destination, 'skill.zip');
  writeFileSync(archivePath, bytes, { mode: 0o600 });
  const [{ stdout: entryOutput }, { stdout: zipInfoOutput }] = await Promise.all([
    execFileAsync('unzip', ['-Z1', archivePath], { timeout: DOWNLOAD_TIMEOUT_MS }),
    execFileAsync('unzip', ['-Z', '-l', archivePath], { timeout: DOWNLOAD_TIMEOUT_MS }),
  ]);
  validateArchiveEntries(entryOutput.split(/\r?\n/).filter(Boolean));
  validateZipInfo(zipInfoOutput);
  await execFileAsync('unzip', ['-q', archivePath, '-d', destination], { timeout: DOWNLOAD_TIMEOUT_MS });
  unlinkSync(archivePath);
}

function writeExpertPackageOrchestration(
  source: RegistrySource,
  content: string,
  destination: string,
): void {
  const packageSlug = source.packageSlug!;
  if (!isExpertPackageCoordinate(packageSlug)) {
    throw new Error('Expert Package orchestration has an unsafe package slug');
  }
  if (new TextEncoder().encode(content).byteLength > MAX_ORCHESTRATION_BYTES) {
    throw new Error('Expert Package orchestration exceeds the size limit');
  }
  const skillDir = join(destination, packageSlug);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), content, { mode: 0o600 });
}

export async function materializeRegistrySource(
  source: RegistrySource,
  destination: string,
  options: { packageOrchestrationContent?: string } = {},
): Promise<void> {
  if (source.kind === 'expert-package-orchestrator') {
    if (options.packageOrchestrationContent !== undefined) {
      writeExpertPackageOrchestration(source, options.packageOrchestrationContent, destination);
      return;
    }
    const detail = await getExpertPackageDefinition(source.packageSlug!);
    writeExpertPackageOrchestration(source, detail.content, destination);
    return;
  }
  await downloadArchive(source, destination);
}

export const registryArchiveLimits = {
  maxArchiveBytes: MAX_ARCHIVE_BYTES,
  maxArchiveEntries: MAX_ARCHIVE_ENTRIES,
  maxExpandedBytes: MAX_EXPANDED_BYTES,
  maxSingleFileBytes: MAX_SINGLE_FILE_BYTES,
};
