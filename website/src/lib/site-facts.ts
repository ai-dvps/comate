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
    description: {
      zh: '工作区与本地上下文由你选择和维护。',
      en: 'You choose and maintain the Workspace and its local context.',
    },
  },
  {
    key: 'agent-and-model-choice',
    label: { zh: '选择 Agent 后端与模型', en: 'Agent backend and model choice' },
    description: {
      zh: '按团队技术栈选择任务执行引擎与模型服务。',
      en: 'Select a task execution engine and model service for your stack.',
    },
  },
  {
    key: 'transparent-permissions',
    label: { zh: '透明的权限控制', en: 'Transparent permissions' },
    description: {
      zh: '敏感操作在执行前清楚展示并等待授权。',
      en: 'Sensitive actions stay visible and wait for approval before execution.',
    },
  },
  {
    key: 'skills-and-mcp-extensibility',
    label: { zh: '通过 Skills 与 MCP 扩展', en: 'Skills and MCP extensibility' },
    description: {
      zh: '通过受控的 Skills 与 MCP 连接专业工具。',
      en: 'Connect specialist tools through governed Skills and MCP.',
    },
  },
  {
    key: 'enterprise-environment-fit',
    label: { zh: '适配企业模型、IM 与 Skill Market', en: 'Enterprise models, IM, and Skill Market fit' },
    description: {
      zh: '接入企业内部模型、IM 与 Skill Market。',
      en: 'Fit internal models, IM, and a Skill Market into existing boundaries.',
    },
  },
] as const satisfies readonly (LocalizedFact<ControlPillarKey> & { description: LocalizedText })[];

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
    detail: {
      zh: '“汇总本月各区域收入与费用，分析偏差并发布财务简报。”',
      en: '“Consolidate monthly revenue and costs by region, analyze variance, and publish a finance brief.”',
    },
  },
  {
    key: 'acknowledge-with-task-id',
    label: { zh: '即时确认并返回任务 ID', en: 'Acknowledge immediately with a task ID' },
    detail: {
      zh: 'IM 立即返回：任务 FIN-042 已创建，可随时查看进度。',
      en: 'IM responds immediately: task FIN-042 is created and its progress is available.',
    },
    status: { zh: 'FIN-042 · 已接收', en: 'FIN-042 · acknowledged' },
  },
  {
    key: 'use-approved-intelligence',
    label: { zh: '调用企业内部模型与 Skills', en: 'Use internal models and approved Skills' },
    detail: {
      zh: '仅调用已批准的内部模型、财务数据 Skill 与目录权限。',
      en: 'Only approved internal models, finance-data Skills, and directory access are used.',
    },
  },
  {
    key: 'collect-and-analyze',
    label: { zh: '收集并分析财务数据', en: 'Collect and analyze finance data' },
    detail: {
      zh: 'Agent 在后台收集数据、核对口径、分析异常并生成报告草稿。',
      en: 'The Agent collects data, reconciles definitions, analyzes anomalies, and drafts the report in the background.',
    },
  },
  {
    key: 'request-permission-or-attention',
    label: { zh: '需要时请求权限或人工关注', en: 'Request permission or human attention when needed' },
    detail: {
      zh: '遇到受限数据时暂停，并在 IM 中请求审批或补充信息。',
      en: 'If restricted data is needed, the task pauses and asks for approval or clarification in IM.',
    },
    status: { zh: '等待批准', en: 'approval required' },
  },
  {
    key: 'publish-finished-report',
    label: { zh: '把完成的报告发布回工作场景', en: 'Publish the finished report back to the work context' },
    detail: {
      zh: '审批后将定稿发布到获批的内部报告目录。',
      en: 'After approval, the final report is published to an approved internal destination.',
    },
  },
  {
    key: 'notify-with-status-and-link',
    label: { zh: '通过 IM 通知最终状态与报告链接', en: 'Send final status and report link through IM' },
    detail: {
      zh: 'IM 返回完成状态、摘要和内部报告链接。',
      en: 'IM returns the completion status, a concise summary, and the internal report link.',
    },
    status: { zh: 'FIN-042 · 已完成', en: 'FIN-042 · completed' },
  },
] as const satisfies readonly (LocalizedFact<FinanceScenarioStageKey> & {
  detail: LocalizedText;
  status?: LocalizedText;
})[];

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
