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

export interface ProviderCodexCapabilities {
  effortByModel?: Record<string, ProviderCodexEffort[]>;
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
  openCode: { protocol: ProviderOpenCodeProtocol };
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
