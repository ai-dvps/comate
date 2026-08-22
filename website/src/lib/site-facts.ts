export const siteLocales = ['zh', 'en'] as const;
export type SiteLocale = (typeof siteLocales)[number];
export type LocalizedText = Readonly<Record<SiteLocale, string>>;

type LocalizedFact<Key extends string> = Readonly<{
  key: Key;
  label: LocalizedText;
}>;

export type PlatformKey = 'macos' | 'windows' | 'linux';

export const platformFacts = [
  {
    key: 'macos',
    label: { zh: 'macOS', en: 'macOS' },
    requirement: {
      zh: '选择与你的 Apple 芯片或 Intel Mac 匹配的安装包；具体系统要求见版本说明。',
      en: 'Choose the installer for your Apple silicon or Intel Mac; see the release notes for current system requirements.',
    },
    artifactKinds: ['dmg', 'zip'],
  },
  {
    key: 'windows',
    label: { zh: 'Windows', en: 'Windows' },
    requirement: {
      zh: '需要受支持的 64 位 Windows 系统；具体系统要求见版本说明。',
      en: 'Requires a supported 64-bit Windows system; see the release notes for current system requirements.',
    },
    artifactKinds: ['nsis'],
  },
  {
    key: 'linux',
    label: { zh: 'Linux', en: 'Linux' },
    requirement: {
      zh: '提供 x64 AppImage 和 Debian 软件包；具体兼容性见版本说明。',
      en: 'Available as x64 AppImage and Debian packages; see the release notes for current compatibility.',
    },
    artifactKinds: ['AppImage', 'deb'],
  },
] as const satisfies readonly (LocalizedFact<PlatformKey> & {
  requirement: LocalizedText;
  artifactKinds: readonly string[];
})[];

export const releaseDestination = {
  kind: 'official-releases',
  url: 'https://github.com/ai-dvps/comate/releases',
  owner: 'ai-dvps',
  repository: 'comate',
} as const;

export const providerPrerequisite = {
  workspaceAndDraftSessionAllowedWithoutProvider: true,
  agentExecutionRequiresConfiguredProvider: true,
  freeInferenceIncluded: false,
  disclosure: {
    zh: '你可以先创建工作区和草稿会话；运行 Agent 并完成任务前，需要提供模型凭据或配置 Provider。Comate 不附带免费推理服务。',
    en: 'You can create a Workspace and draft Session first; running an Agent and completing a task requires model credentials or a configured Provider. Comate does not include free inference.',
  },
} as const satisfies Readonly<{
  workspaceAndDraftSessionAllowedWithoutProvider: true;
  agentExecutionRequiresConfiguredProvider: true;
  freeInferenceIncluded: false;
  disclosure: LocalizedText;
}>;

export type ControlPillarKey =
  | 'workspace-ownership'
  | 'agent-and-model-choice'
  | 'transparent-permissions'
  | 'skills-and-mcp-extensibility'
  | 'enterprise-environment-fit';

export const controlPillars = [
  {
    key: 'workspace-ownership',
    label: { zh: '工作区由你管理', en: 'Workspace ownership' },
  },
  {
    key: 'agent-and-model-choice',
    label: { zh: '选择 Agent 后端与模型', en: 'Agent backend and model choice' },
  },
  {
    key: 'transparent-permissions',
    label: { zh: '透明的权限控制', en: 'Transparent permissions' },
  },
  {
    key: 'skills-and-mcp-extensibility',
    label: { zh: '通过 Skills 与 MCP 扩展', en: 'Skills and MCP extensibility' },
  },
  {
    key: 'enterprise-environment-fit',
    label: { zh: '适配企业模型、IM 与 Skill Market', en: 'Enterprise models, IM, and Skill Market fit' },
  },
] as const satisfies readonly LocalizedFact<ControlPillarKey>[];

export type FinanceScenarioStageKey =
  | 'request-through-im'
  | 'acknowledge-with-task-id'
  | 'use-approved-intelligence'
  | 'collect-and-analyze'
  | 'request-permission-or-attention'
  | 'publish-finished-report'
  | 'notify-with-status-and-link';

export const financeScenarioStages = [
  {
    key: 'request-through-im',
    label: { zh: '通过获批的 IM 发起请求', en: 'Request through an approved IM channel' },
  },
  {
    key: 'acknowledge-with-task-id',
    label: { zh: '即时确认并返回任务 ID', en: 'Acknowledge immediately with a task ID' },
  },
  {
    key: 'use-approved-intelligence',
    label: { zh: '调用企业内部模型与 Skills', en: 'Use internal models and approved Skills' },
  },
  {
    key: 'collect-and-analyze',
    label: { zh: '收集并分析财务数据', en: 'Collect and analyze finance data' },
  },
  {
    key: 'request-permission-or-attention',
    label: { zh: '需要时请求权限或人工关注', en: 'Request permission or human attention when needed' },
  },
  {
    key: 'publish-finished-report',
    label: { zh: '把完成的报告发布回工作场景', en: 'Publish the finished report back to the work context' },
  },
  {
    key: 'notify-with-status-and-link',
    label: { zh: '通过 IM 通知最终状态与报告链接', en: 'Send final status and report link through IM' },
  },
] as const satisfies readonly LocalizedFact<FinanceScenarioStageKey>[];

export type PrimaryCtaSlotKey = 'home-primary' | 'home-closing' | 'download-primary';

export const primaryCtaSlots = [
  { key: 'home-primary', label: { zh: '首页主下载入口', en: 'Home primary download' } },
  { key: 'home-closing', label: { zh: '首页收尾下载入口', en: 'Home closing download' } },
  { key: 'download-primary', label: { zh: '下载页主入口', en: 'Download page primary action' } },
] as const satisfies readonly LocalizedFact<PrimaryCtaSlotKey>[];

export type CanonicalVocabularyKey =
  | 'product-category'
  | 'workspace'
  | 'session'
  | 'agent'
  | 'agent-backend'
  | 'provider'
  | 'skills'
  | 'mcp';

export const canonicalVocabulary = [
  {
    key: 'product-category',
    label: { zh: '通用 Agent 任务工作区', en: 'general-purpose Agent task workspace' },
  },
  { key: 'workspace', label: { zh: '工作区', en: 'Workspace' } },
  { key: 'session', label: { zh: '会话', en: 'Session' } },
  { key: 'agent', label: { zh: 'Agent', en: 'Agent' } },
  {
    key: 'agent-backend',
    label: { zh: 'Agent 后端（任务执行引擎）', en: 'Agent backend (task execution engine)' },
  },
  {
    key: 'provider',
    label: { zh: 'Provider（模型服务配置）', en: 'Provider (model service configuration)' },
  },
  { key: 'skills', label: { zh: 'Skills', en: 'Skills' } },
  { key: 'mcp', label: { zh: 'MCP', en: 'MCP' } },
] as const satisfies readonly LocalizedFact<CanonicalVocabularyKey>[];

/** Website-owned projection; root packaging config and workflows remain upstream authority. */
export const siteFacts = {
  locales: siteLocales,
  platforms: platformFacts,
  releaseDestination,
  providerPrerequisite,
  controlPillars,
  financeScenarioStages,
  primaryCtaSlots,
  canonicalVocabulary,
} as const;
