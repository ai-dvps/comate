/**
 * Provider-neutral query model for the federated skill search.
 *
 * The UI only needs to understand these stable fields. Each registry adapter
 * translates them to its own URL parameters or natural-language prompt.
 */
export const SKILL_SCENES = [
  'ai-agent',
  'office-efficiency',
  'development',
  'content-creation',
  'knowledge-management',
  'professional',
  'design-media',
] as const;

export type SkillScene = (typeof SKILL_SCENES)[number];
export type SkillSort = 'score' | 'downloads' | 'newest';

export interface SkillSearchQuery {
  keyword: string;
  scene?: SkillScene;
  preferChinese?: boolean;
  noApiKey?: boolean;
  sort?: SkillSort;
}

export type SkillSearchInput = string | SkillSearchQuery;

export const SCENE_LABELS: Record<SkillScene, { zh: string; en: string }> = {
  'ai-agent': { zh: 'AI Agent', en: 'AI agent' },
  'office-efficiency': { zh: '办公效率', en: 'office productivity' },
  development: { zh: '开发编程', en: 'software development' },
  'content-creation': { zh: '内容创作', en: 'content creation' },
  'knowledge-management': { zh: '知识管理', en: 'knowledge management' },
  professional: { zh: '行业专业', en: 'professional work' },
  'design-media': { zh: '设计多媒体', en: 'design and multimedia' },
};

export function isSkillScene(value: unknown): value is SkillScene {
  return typeof value === 'string' && (SKILL_SCENES as readonly string[]).includes(value);
}

export function isSkillSort(value: unknown): value is SkillSort {
  return value === 'score' || value === 'downloads' || value === 'newest';
}

export function normalizeSkillSearchQuery(input: SkillSearchInput): SkillSearchQuery {
  if (typeof input === 'string') return { keyword: input.trim(), sort: 'score' };

  return {
    keyword: input.keyword.trim(),
    ...(input.scene ? { scene: input.scene } : {}),
    ...(input.preferChinese ? { preferChinese: true } : {}),
    ...(input.noApiKey ? { noApiKey: true } : {}),
    sort: input.sort || 'score',
  };
}

/** Natural-language query for registries that do not expose structured filters. */
export function toNaturalLanguageTask(query: SkillSearchQuery, language: 'zh' | 'en'): string {
  const scene = query.scene ? SCENE_LABELS[query.scene][language] : '';
  const requirements = language === 'zh'
    ? [scene && `场景：${scene}`, query.preferChinese && '优先中文内容', query.noApiKey && '不需要 API Key']
    : [scene && `Use case: ${scene}`, query.preferChinese && 'Prefer Chinese-language content', query.noApiKey && 'Does not require an API key'];
  const suffix = requirements.filter(Boolean).join(language === 'zh' ? '；' : '. ');
  return suffix ? `${query.keyword}；${suffix}` : query.keyword;
}
