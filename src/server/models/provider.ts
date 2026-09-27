export type ProviderProtocol = 'anthropic' | 'openai-responses';
export type ProviderOpenAiFormat = 'openai-responses' | 'openai-chat-completions';
export type ProviderOpenCodeProtocol = 'anthropic' | 'openai';

export interface ProviderEndpoint {
  enabled: boolean;
  baseUrl: string;
}

export interface ProviderOpenAiEndpoint extends ProviderEndpoint {
  format: ProviderOpenAiFormat;
}

export interface ProviderAgentModels {
  claudeCode?: string;
  codex?: string;
  openCode?: string;
}

export interface ProviderClaudeOptions {
  defaultOpusModel?: string;
  defaultSonnetModel?: string;
  defaultHaikuModel?: string;
  subagentModel?: string;
  effortLevel?: string;
  customEnvVars?: Record<string, string>;
}

export type ProviderCodexEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export type ProviderPromptCacheRouting = 'auto' | 'unsupported';
export type ProviderThinkingSupport = 'required' | 'supported' | 'unsupported' | 'unknown';

export type ProviderReasoningSummary = 'auto' | 'concise' | 'detailed' | 'none';
export type ProviderVerbosity = 'low' | 'medium' | 'high';
export type ProviderOpenCodeReasoningField = 'reasoning' | 'reasoning_content' | 'reasoning_details';

export interface ProviderCodexModelProfile {
  contextWindow?: number;
  autoCompactTokenLimit?: number;
  promptCacheRouting?: ProviderPromptCacheRouting;
  thinking?: ProviderThinkingSupport;
  supportedEfforts?: ProviderCodexEffort[];
  effortWireMapping?: Partial<Record<ProviderCodexEffort, string>>;
  reasoningSummary?: ProviderReasoningSummary;
  supportsReasoningSummaries?: boolean;
  verbosity?: ProviderVerbosity;
}

export interface ProviderOpenCodeVariant {
  reasoningEffort?: string;
  reasoningSummary?: ProviderReasoningSummary;
  thinkingBudgetTokens?: number;
}

export interface ProviderOpenCodeModelProfile {
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: boolean;
  toolCall?: boolean;
  inputModalities?: Array<'text' | 'image'>;
  outputModalities?: Array<'text'>;
  reasoningField?: ProviderOpenCodeReasoningField;
  variants?: Record<string, ProviderOpenCodeVariant>;
}

export interface ProviderCodexCapabilities {
  modelProfiles?: Record<string, ProviderCodexModelProfile>;
  /** Legacy read input; normalization folds this into modelProfiles. */
  promptCacheRouting?: ProviderPromptCacheRouting;
  /** Legacy read input; normalization folds this into modelProfiles. */
  thinking?: ProviderThinkingSupport;
  /** Legacy read input; normalization folds this into modelProfiles. */
  effortByModel?: Record<string, ProviderCodexEffort[]>;
  /** Legacy read input; normalization folds this into modelProfiles. */
  effortWireMappingByModel?: Record<string, Partial<Record<ProviderCodexEffort, string>>>;
}

export interface ProviderPresetProvenance {
  id: string;
  version: number;
}

/** The only authoritative persisted Provider configuration. */
export interface ProviderConfigurationV1 {
  schemaVersion: 1;
  endpoints: {
    anthropic?: ProviderEndpoint;
    openai?: ProviderOpenAiEndpoint;
  };
  models: ProviderAgentModels;
  openCode: {
    protocol: ProviderOpenCodeProtocol;
    modelProfiles?: Record<string, ProviderOpenCodeModelProfile>;
  };
  claude: ProviderClaudeOptions;
  codex: ProviderCodexCapabilities;
  preset?: ProviderPresetProvenance;
}

export interface Provider {
  id: string;
  name: string;
  /** Present for every persisted Provider; optional only for legacy in-memory test doubles. */
  configuration?: ProviderConfigurationV1;
  /** Compatibility projection; the nested configuration remains authoritative. */
  baseUrl: string;
  authToken: string;
  protocol?: ProviderProtocol;
  model?: string;
  isDefault: boolean;
  defaultOpusModel?: string;
  defaultSonnetModel?: string;
  defaultHaikuModel?: string;
  subagentModel?: string;
  effortLevel?: string;
  customEnvVars?: Record<string, string>;
  supportsFastMode?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProviderInput {
  name: string;
  configuration?: ProviderConfigurationV1;
  baseUrl?: string;
  authToken: string;
  protocol?: ProviderProtocol;
  model?: string;
  isDefault?: boolean;
  defaultOpusModel?: string;
  defaultSonnetModel?: string;
  defaultHaikuModel?: string;
  subagentModel?: string;
  effortLevel?: string;
  customEnvVars?: Record<string, string>;
  skipHealthCheck?: boolean;
}

export interface UpdateProviderInput {
  name?: string;
  configuration?: ProviderConfigurationV1;
  baseUrl?: string;
  authToken?: string;
  protocol?: ProviderProtocol;
  model?: string;
  isDefault?: boolean;
  defaultOpusModel?: string;
  defaultSonnetModel?: string;
  defaultHaikuModel?: string;
  subagentModel?: string;
  effortLevel?: string;
  customEnvVars?: Record<string, string>;
  skipHealthCheck?: boolean;
}
