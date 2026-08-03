import { parseFrontmatter } from './frontmatter.js';
import {
  fetchSkillHubJson,
  getSkillHubSkill,
  isSkillHubCoordinate,
  skillHubLimits,
  skillHubNumber,
  SkillHubProviderError,
  skillHubRecord,
  skillHubText,
} from './skillhub.js';
import type {
  ExpertPackageChild,
  ExpertPackageDetail,
  ExpertPackageSummary,
} from './types.js';

const MAX_ORCHESTRATION_BYTES = 256 * 1024;
const MAX_PACKAGE_CHILDREN = 64;
const MAX_PAGE_SIZE = 200;
const CHILD_HYDRATION_CONCURRENCY = 6;
export const EXPERT_PACKAGE_SCENES = [
  'academic', 'content-creation', 'design', 'ecommerce', 'education', 'finance',
  'healthcare', 'hr', 'legal', 'lifestyle', 'marketing', 'media', 'mysticism', 'tech',
] as const;

export function isExpertPackageScene(value: unknown): value is typeof EXPERT_PACKAGE_SCENES[number] {
  return typeof value === 'string' && (EXPERT_PACKAGE_SCENES as readonly string[]).includes(value);
}

export function isExpertPackageCoordinate(value: unknown): value is string {
  return isSkillHubCoordinate(value);
}

export interface ExpertPackageDefinition {
  summary: ExpertPackageSummary;
  content: string;
  contentEn?: string;
  coordinates: Array<{ namespace: string; slug: string }>;
  structurallyComplete: boolean;
}

export { SkillHubProviderError as ExpertPackageProviderError } from './skillhub.js';

const record = skillHubRecord;
const text = skillHubText;
const number = skillHubNumber;

function assertCoordinate(value: string, label: string): void {
  if (!isExpertPackageCoordinate(value)) {
    throw new SkillHubProviderError(`Invalid ${label}`, 'invalid-input');
  }
}
const fetchJson = fetchSkillHubJson;

function normalizeSummary(value: unknown): ExpertPackageSummary | null {
  const item = record(value);
  if (!item) return null;
  const slug = text(item.slug);
  if (!isExpertPackageCoordinate(slug)) return null;
  const skills = Array.isArray(item.skills) ? item.skills : [];
  return {
    slug,
    displayName: text(item.displayName) || slug,
    ...(text(item.displayNameEn) ? { displayNameEn: text(item.displayNameEn) } : {}),
    summary: text(item.summary),
    ...(text(item.summaryEn) ? { summaryEn: text(item.summaryEn) } : {}),
    scene: text(item.scene),
    ...(text(item.subScene) ? { subScene: text(item.subScene) } : {}),
    skillCount: number(item.skillCount) || skills.length,
    source: 'skillhub.cn',
  };
}

export async function listExpertPackages(input: {
  keyword?: string;
  scene?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<{ packages: ExpertPackageSummary[]; total: number }> {
  const page = Math.max(1, Math.floor(input.page || 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(input.pageSize || 20)));
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (input.keyword?.trim()) params.set('keyword', input.keyword.trim());
  if (input.scene?.trim()) params.set('scene', input.scene.trim());
  const body = record(await fetchJson(`/api/v1/skillsets?${params.toString()}`));
  if (!body || !Array.isArray(body.skillSets)) {
    throw new SkillHubProviderError('SkillHub package list is malformed', 'invalid-response');
  }
  return {
    packages: body.skillSets.map(normalizeSummary).filter((item): item is ExpertPackageSummary => Boolean(item)),
    total: number(body.total),
  };
}

export const getExpertSkill = getSkillHubSkill;

async function hydrateChildren(
  coordinates: Array<{ namespace: string; slug: string }>,
): Promise<ExpertPackageChild[]> {
  const results: ExpertPackageChild[] = [];
  for (let index = 0; index < coordinates.length; index += CHILD_HYDRATION_CONCURRENCY) {
    const chunk = coordinates.slice(index, index + CHILD_HYDRATION_CONCURRENCY);
    results.push(...await Promise.all(chunk.map(async ({ namespace, slug }) => {
      try {
        const skill = await getExpertSkill(namespace, slug);
        return {
          namespace,
          slug,
          displayName: skill.displayName,
          summary: skill.summary,
          available: true,
          source: skill.source,
          securityReports: skill.securityReports,
        };
      } catch {
        return {
          namespace,
          slug,
          displayName: slug,
          summary: '',
          available: false,
          source: `skillhub-cn:${namespace}/${slug}`,
          securityReports: [],
        };
      }
    })));
  }
  return results;
}

export async function getExpertPackageDefinition(slug: string): Promise<ExpertPackageDefinition> {
  assertCoordinate(slug, 'package slug');
  const body = record(await fetchJson(`/api/v1/skillsets/${encodeURIComponent(slug)}`));
  const summary = normalizeSummary(body);
  if (!body || !summary || summary.slug !== slug) {
    throw new SkillHubProviderError('SkillHub package response is malformed', 'invalid-response');
  }
  const content = typeof body.content === 'string' ? body.content : '';
  const contentEn = typeof body.contentEn === 'string' ? body.contentEn : '';
  const contentBytes = new TextEncoder().encode(content).byteLength;
  const contentEnBytes = new TextEncoder().encode(contentEn).byteLength;
  const rawSkills = Array.isArray(body.skills) ? body.skills : [];
  if (
    rawSkills.length > MAX_PACKAGE_CHILDREN
    || contentBytes > MAX_ORCHESTRATION_BYTES
    || contentEnBytes > MAX_ORCHESTRATION_BYTES
  ) {
    throw new SkillHubProviderError('SkillHub package exceeds safety limits', 'invalid-response');
  }
  const coordinates = rawSkills.flatMap((raw) => {
    const child = record(raw);
    const namespace = text(child?.namespace);
    const childSlug = text(child?.slug);
    return isExpertPackageCoordinate(namespace) && isExpertPackageCoordinate(childSlug)
      ? [{ namespace, slug: childSlug }]
      : [];
  });
  const frontmatterName = text(parseFrontmatter(content).data.name);
  const installNames = coordinates.map((coordinate) => coordinate.slug);
  const hasInstallNameCollision = new Set(installNames).size !== installNames.length
    || installNames.includes(slug);
  const structurallyComplete = Boolean(
    content &&
    frontmatterName === slug &&
    coordinates.length > 0 &&
    coordinates.length === rawSkills.length &&
    !hasInstallNameCollision,
  );
  return {
    summary,
    content,
    ...(contentEn ? { contentEn } : {}),
    coordinates,
    structurallyComplete,
  };
}

export async function getExpertPackage(slug: string): Promise<ExpertPackageDetail> {
  const definition = await getExpertPackageDefinition(slug);
  const children = await hydrateChildren(definition.coordinates);
  const complete = definition.structurallyComplete && children.every((child) => child.available);
  return {
    ...definition.summary,
    skillCount: definition.coordinates.length,
    content: definition.content,
    ...(definition.contentEn ? { contentEn: definition.contentEn } : {}),
    children,
    complete,
    ...(!complete ? { unavailableReason: 'Package orchestration or included Skills did not pass validation.' } : {}),
  };
}

export const expertPackageLimits = {
  maxJsonBytes: skillHubLimits.maxJsonBytes,
  maxOrchestrationBytes: MAX_ORCHESTRATION_BYTES,
  maxPackageChildren: MAX_PACKAGE_CHILDREN,
  maxPageSize: MAX_PAGE_SIZE,
};
